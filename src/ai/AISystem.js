/**
 * src/ai/AISystem.js — pilot AI. Priority 250: runs after flight (200) has
 * integrated last frame's inputs, and writes the control inputs that flight will
 * consume next frame.
 *
 * ```js
 * const ai = createAISystem(engine);
 * engine.registerSystem(ai);
 * ai.attach(ship, { skill: 'ace', temperament: 'aggressive', squadron: 'Gold' });
 * ```
 *
 * ## Layout of the module
 *
 *   aimath.js       steering law, ballistics, deterministic noise
 *   personality.js  skill tiers, temperaments, names — all measurable
 *   behaviors.js    the hierarchical state machine (12 states, 3 groups)
 *   maneuvers.js    the BFM library (18 committed manoeuvres)
 *   gunnery.js      firing solution + the deliberate, slow-varying aim error
 *   threat.js       threat assessment and spread-aware target assignment
 *   formations.js   squadrons, slots, station keeping, mutual support
 *   wingmen.js      the player's comms menu
 *   capital.js      turret battery, point defence, capital helm
 *   chatter.js      the radio (comms:message)
 *   debug.js        optional visualiser (engine.game.debugAI = true)
 *
 * ## What this module reads and writes
 *
 * Reads (all guarded — every one of these may be absent while other agents
 * are still building):
 *   ship.body.{position,quaternion,velocity,forward,speed}   flight §5.5
 *   ship.stats.{maxSpeed,pitchRate,yawRate,rollRate,...}     ships §5.4
 *   ship.hardpoints.{guns,missiles,turrets}                  ships §5.4
 *   engine.game.{ships,player,combat,flight}
 *
 * Writes:
 *   ship.body.controls.{pitch,yaw,roll,throttle,afterburner,strafeX,strafeY,brake}
 *   ship.body.controls.fire / ship.aiFiring        (fire request, see writeFire)
 *   engine.events 'comms:message'                  (§5.6)
 */
import * as THREE from 'three';
import {
  clamp, clamp01, clamp11, lerp, num, smoothRange, solveSteering, angleBetween, DEG, hash01,
} from './aimath.js';
import { makePilotProfile } from './personality.js';
import { Radio, speciesKind } from './chatter.js';
import { Squadron, stationKeep } from './formations.js';
import {
  rebuildAssignments, selectTarget, updateThreat, isHostile, isCapital, hullFraction,
} from './threat.js';
import { updateGunnery, makeGunState, makeMissileState, gunSpeed } from './gunnery.js';
import { stepStateMachine, runState, setState, STATES, groupOf } from './behaviors.js';
import { buildTurrets, updateTurrets, updateCapitalHelm } from './capital.js';
import { WingmanCommander } from './wingmen.js';
import { createShadowBody, integrateShadow, makeControls } from './kinematicFallback.js';

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Vector3();

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

let NEXT_PILOT_ID = 1;

/** Per-pilot working context. Persistent so manoeuvres may cache into it. */
function makeCtx(ai, pilot) {
  return {
    ai,
    engine: ai.engine,
    pilot,
    ship: pilot.ship,
    body: null,
    mv: pilot.mv,
    time: 0,
    dt: 0,
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    velDir: new THREE.Vector3(0, 0, -1),
    fwd: new THREE.Vector3(0, 0, -1),
    up: new THREE.Vector3(0, 1, 0),
    right: new THREE.Vector3(1, 0, 0),
    target: null,
    tgtPos: new THREE.Vector3(),
    threatDir: null,
    threatAngleOff: null,
    lateralSign: 0,
    leadTime: 0,
    _threatDir: new THREE.Vector3(),
    sense: {
      range: 1e6, closure: 0, angleOff: Math.PI, aspect: Math.PI,
      mySpeed: 0, tgtSpeed: 0, overtake: 0, tgtTurn: 0, cornerSpeed: 260,
      threatRange: 1e6, threatClosure: 0, threatAngleOff: null, threatAspect: Math.PI,
      targetIsCapital: false, targetIsProtector: false,
      los: new THREE.Vector3(0, 0, -1),
      myVel: new THREE.Vector3(),
      tgtVel: new THREE.Vector3(),
      tgtFwd: new THREE.Vector3(0, 0, -1),
    },
    intent: {
      aim: new THREE.Vector3(0, 0, -1),
      throttle: 0.6, ab: 0, brake: 0, strafeX: 0, strafeY: 0,
      planeHint: null, rollOffset: 0, tauScale: 1, levelWeight: 0.4,
      gunOk: false, label: '',
    },
  };
}

export class AISystem {
  constructor(engine, opts = {}) {
    this.name = 'ai';
    this.priority = 250;
    this.engine = engine;
    this.events = engine?.events ?? null;
    this.enabled = true;

    this.time = 0;
    this.frame = 0;

    /** @type {Array<object>} */
    this.pilots = [];
    this.byShip = new Map();
    this.shadows = new Map();
    this.squadrons = new Map();

    this.contacts = [];
    this.assign = new Map();
    this.missiles = [];
    this.missileTargets = new Map();

    this.radio = new Radio(this.events);
    this.wingmen = new WingmanCommander(this);
    this.formations = { stationKeep };

    this.playerPilot = null;
    this.debug = null;
    this._debugPending = false;

    this.controlSigns = { pitch: 1, yaw: 1, roll: 1 };
    this.seed = opts.seed ?? engine?.game?.seed ?? 1337;
    /** Dev fallback: integrate ships that have no flight body yet. */
    this.allowShadowBodies = opts.allowShadowBodies !== false;

    this._fwd = new Map();
    this._turn = new Map();
    this._offs = [];

    this._bindEvents();
  }

  // ---------------------------------------------------------------- lifecycle

  _bindEvents() {
    const ev = this.events;
    if (!ev) return;
    this._offs.push(ev.on('ship:destroyed', (p) => this.onDestroyed(p)));
    this._offs.push(ev.on('weapon:hit', (p) => this.onHit(p)));
    this._offs.push(ev.on('shield:impact', (p) => this.onHit(p)));
    this._offs.push(ev.on('missile:launched', (p) => this.onMissileLaunched(p)));
  }

  /**
   * Attach a pilot to a ship.
   * @param {object} ship  a Game ship record
   * @param {object} [cfg] { skill, temperament, name, callsign, squadron, formation,
   *                         spacing, role, leader, aggression, waypoint, priority }
   */
  attach(ship, cfg = null) {
    if (!ship || this.byShip.has(ship)) return this.byShip.get(ship) ?? null;
    const c = cfg ?? {};
    const id = NEXT_PILOT_ID++;
    const seed =
      c.seed ??
      ((this.seed * 2654435761 + id * 40503 + (ship.id ?? 0) * 97) >>> 0);

    const cap = isCapital(ship);
    const profile = makePilotProfile({
      seed,
      skill: c.skill ?? (cap ? 'veteran' : this._defaultSkill(seed)),
      temperament: c.temperament ?? null,
      name: c.name ?? ship.pilotName ?? null,
      callsign: c.callsign ?? null,
      faction: ship.faction ?? 'confed',
      hostile: this.isHostileToPlayer(ship),
    });
    if (typeof c.aggression === 'number') profile.aggression = clamp01(c.aggression);

    const pilot = {
      id,
      seed,
      ship,
      profile,
      isCapital: cap,
      alienVoice: this.isHostileToPlayer(ship),

      state: cap ? 'patrol' : 'patrol',
      prevState: null,
      stateTime: 0,
      pending: null,
      pendingT: 0,
      transitions: 0,

      mv: { id: null, prev: null, t: 0, phase: 0, data: {}, switches: 0 },
      steerMem: { pe: 0, ye: 0, re: 0, init: false },

      target: null,
      forcedTarget: c.target ?? null,
      forcedTargetUntil: null,
      threat: null,
      threatScore: 0,
      underAttackFor: 0,
      threatClearFor: 99,
      lastAttacker: null,
      lastHitTime: -99,
      lastCombatTime: -99,
      wasEngaged: false,
      offensiveFor: 0,
      incoming: null,

      leader: null,
      squadron: null,
      slot: c.slot ?? 0,
      element: null,
      protecting: null,
      protectUntil: 0,

      order: null,
      orderTime: -99,
      holdFire: c.holdFire === true,
      freeEngage: c.freeEngage !== false,
      disengaged: false,
      antiCapital: c.antiCapital === true,
      waypoint: c.waypoint ? c.waypoint.clone?.() ?? new THREE.Vector3().copy(c.waypoint) : null,
      homeVec: null,

      gun: null,
      missile: makeMissileState(ship),
      firing: false,
      _lastFiring: false,
      lastFireTime: -99,
      solutionAngle: Math.PI,
      aimPoint: null,
      missileLock: 0,
      wantDecoy: false,

      hullFrac: 1,
      gLoad: 0,
      abFuel: 1,
      abAvailable: 1,
      maxSpeed: num(ship.stats?.maxSpeed, 430),
      thinkT: (id % 11) * 0.02,
      pendingTaunt: false,
      turrets: cap ? buildTurrets(ship, seed) : null,
      saidAt: {},
      ctx: null,
    };
    pilot.gun = makeGunState(profile, seed);
    pilot.ctx = makeCtx(this, pilot);
    ship.pilot = pilot;
    ship.pilotName = profile.name;
    ship.callsign = profile.callsign;

    this.pilots.push(pilot);
    this.byShip.set(ship, pilot);

    // Squadron membership.
    const sqId = c.squadron ?? c.wing ?? null;
    if (sqId) {
      const key = `${ship.faction ?? 'confed'}:${sqId}`;
      let sq = this.squadrons.get(key);
      if (!sq) {
        sq = new Squadron(sqId, ship.faction ?? 'confed', {
          formation: c.formation ?? 'fingerFour',
          spacing: c.spacing ?? 90,
        });
        this.squadrons.set(key, sq);
      }
      if (c.formation) sq.formation = c.formation;
      if (c.spacing) sq.spacing = c.spacing;
      sq.add(pilot);
      if (c.role === 'leader') sq.leader = pilot;
    }

    if (c.state && STATES[c.state]) pilot.state = c.state;
    return pilot;
  }

  detach(ship) {
    const pilot = this.byShip.get(ship);
    if (!pilot) return;
    pilot.squadron?.remove(pilot);
    const i = this.pilots.indexOf(pilot);
    if (i >= 0) this.pilots.splice(i, 1);
    this.byShip.delete(ship);
    this.shadows.delete(ship);
    this._fwd.delete(ship);
    this._turn.delete(ship);
    for (const p of this.pilots) {
      if (p.target === ship) p.target = null;
      if (p.forcedTarget === ship) p.forcedTarget = null;
      if (p.threat === ship) p.threat = null;
      if (p.lastAttacker === ship) p.lastAttacker = null;
      if (p.protecting === pilot) p.protecting = null;
      if (p.leader === pilot) p.leader = null;
    }
    if (ship.pilot === pilot) ship.pilot = null;
  }

  dispose() {
    for (const off of this._offs) {
      try { off(); } catch { /* handler already removed */ }
    }
    this._offs.length = 0;
    this.debug?.dispose?.();
    this.debug = null;
    this.pilots.length = 0;
    this.byShip.clear();
    this.shadows.clear();
    this.squadrons.clear();
    this.missiles.length = 0;
    this.missileTargets.clear();
    this.assign.clear();
    this._fwd.clear();
    this._turn.clear();
    this.contacts.length = 0;
  }

  _defaultSkill(seed) {
    // A believable squadron is mostly veterans with a couple of rookies and the
    // occasional ace — not twelve identical pilots.
    const r = hash01(seed, 55);
    if (r < 0.28) return 'rookie';
    if (r < 0.84) return 'veteran';
    return 'ace';
  }

  // ------------------------------------------------------------------ helpers

  pilotOf(ship) {
    return this.byShip.get(ship) ?? null;
  }

  squadronOf(pilot) {
    return pilot?.squadron ?? null;
  }

  /** The flight body if it exists, otherwise the dev shadow. */
  bodyOf(ship) {
    if (!ship) return null;
    if (ship.body) {
      if (this.shadows.has(ship)) this.shadows.delete(ship); // flight landed
      return ship.body;
    }
    if (!this.allowShadowBodies) return null;
    let sh = this.shadows.get(ship);
    if (!sh) {
      sh = createShadowBody(ship);
      this.shadows.set(ship, sh);
    }
    return sh;
  }

  /** Cached forward vector, one recompute per ship per frame. */
  forwardOfShip(ship) {
    let e = this._fwd.get(ship);
    if (!e) {
      e = { f: new THREE.Vector3(0, 0, -1), frame: -1 };
      this._fwd.set(ship, e);
    }
    if (e.frame !== this.frame) {
      const b = this.bodyOf(ship);
      if (!b) return null;
      e.f.set(0, 0, -1).applyQuaternion(b.quaternion);
      e.frame = this.frame;
    }
    return e.f;
  }

  /** Instantaneous turn rate (rad/s) of any ship, from frame-to-frame heading. */
  turnRateOf(ship) {
    return this._turn.get(ship)?.rate ?? 0;
  }

  isHostileToPlayer(ship) {
    const pl = this.engine.game?.player;
    if (!pl || !ship) return (ship?.faction ?? 'confed') !== 'confed';
    return isHostile(pl, ship);
  }

  playerTarget() {
    const pl = this.engine.game?.player;
    return pl?.target ?? this.engine.game?.playerTarget ?? null;
  }

  basePosition() {
    const g = this.engine.game;
    if (g?.basePosition) return g.basePosition.clone?.() ?? new THREE.Vector3().copy(g.basePosition);
    // Nearest friendly capital ship is a decent stand-in for "the barn".
    for (const s of this.contacts) {
      if (isCapital(s) && !this.isHostileToPlayer(s)) {
        const b = this.bodyOf(s);
        if (b) return b.position.clone();
      }
    }
    return new THREE.Vector3(0, 0, 12_000);
  }

  /** Put a wingman on the player's wing, creating the player's flight if needed. */
  bindToPlayerWing(pilot) {
    const pl = this.engine.game?.player;
    if (!pl) return;
    this._ensurePlayerPilot();
    const key = `${pl.faction ?? 'confed'}:player-wing`;
    let sq = this.squadrons.get(key);
    if (!sq) {
      sq = new Squadron('player-wing', pl.faction ?? 'confed', { formation: 'fingerFour', spacing: 95 });
      this.squadrons.set(key, sq);
    }
    sq.lockedLeader = this.playerPilot;
    pilot.squadron?.remove(pilot);
    sq.add(pilot);
    pilot.leader = this.playerPilot;
    sq.intact = true;
    sq._dirty = true;
  }

  _ensurePlayerPilot() {
    const pl = this.engine.game?.player;
    if (!pl) return null;
    if (this.playerPilot?.ship === pl) return this.playerPilot;
    this.playerPilot = {
      id: 0,
      seed: 0,
      ship: pl,
      isPlayerPilot: true,
      profile: makePilotProfile({ seed: 1, skill: 'ace', name: pl.pilotName ?? 'Player', callsign: 'Lead' }),
      state: 'patrol',
      target: null,
      threat: null,
      underAttackFor: 0,
      threatClearFor: 99,
      lastAttacker: null,
      lastHitTime: -99,
      leader: null,
      slot: 0,
      element: null,
      saidAt: {},
    };
    return this.playerPilot;
  }

  // -------------------------------------------------------------------- frame

  update(dt, engine) {
    if (!this.enabled) return;
    this.frame++;
    if (!(dt > 0)) return;
    this.time += dt;
    this.radio.update(dt);

    // The flight system is allowed to tell us which way its sticks point.
    const fs = this.engine.game?.flight?.controlSigns;
    if (fs) {
      this.controlSigns.pitch = num(fs.pitch, 1);
      this.controlSigns.yaw = num(fs.yaw, 1);
      this.controlSigns.roll = num(fs.roll, 1);
    }

    this.syncRoster();
    this.syncBodies(dt);
    this.updateTurnRates(dt);
    this.updateMissileTracks(dt);
    rebuildAssignments(this);

    this._ensurePlayerPilot();
    if (this.playerPilot) {
      this.playerPilot.target = this.playerTarget();
      updateThreat(this.playerPilot, this, dt);
    }

    for (const sq of this.squadrons.values()) sq.update(dt, this);
    this.dispatchHelp(dt);

    for (let i = 0; i < this.pilots.length; i++) {
      const pilot = this.pilots[i];
      const ship = pilot.ship;
      if (!ship || ship.alive === false) continue;
      this.updatePilot(pilot, dt);
    }

    this.wingmen.update(dt);
    this.updateDebug();
  }

  updatePilot(pilot, dt) {
    pilot.hullFrac = hullFraction(pilot.ship);
    pilot.maxSpeed = num(pilot.ship.stats?.maxSpeed, pilot.maxSpeed);

    updateThreat(pilot, this, dt);
    this.updateIncoming(pilot);

    pilot.thinkT -= dt;
    if (pilot.thinkT <= 0) {
      pilot.thinkT = 0.16 + (pilot.id % 9) * 0.015;
      this.retarget(pilot);
    }

    const ctx = this.contextFor(pilot, dt);
    if (!ctx) return;

    // Afterburner budget — models both fuel and the discipline to conserve it.
    const abUse = clamp01(ctx.intent.ab);
    pilot.abFuel = clamp01(pilot.abFuel - abUse * dt * 0.085 + (1 - abUse) * dt * 0.05);
    pilot.abAvailable = smoothRange(pilot.abFuel, 0.06, 0.3) * pilot.profile.abBudget;

    if (pilot.isCapital) {
      updateCapitalHelm(pilot, ctx, this, dt);
      this.applyIntent(pilot, ctx, dt);
      updateTurrets(pilot, ctx, this, dt);
      return;
    }

    stepStateMachine(pilot, ctx, dt);
    runState(pilot, ctx, dt);
    updateGunnery(pilot, ctx, this, dt);
    this.applyIntent(pilot, ctx, dt);
    this.writeFire(pilot, ctx);

    // Bookkeeping the state machine reads.
    const g = groupOf(pilot.state);
    if (g === 'offense') pilot.offensiveFor += dt;
    else pilot.offensiveFor = 0;
    if (g !== 'idle') {
      pilot.lastCombatTime = this.time;
      pilot.wasEngaged = true;
    }
    this.maybeNearMiss(pilot, ctx);
  }

  /** Rebuild the contact list and pick up ships nobody attached a pilot to. */
  syncRoster() {
    const game = this.engine.game;
    const ships = game?.ships ?? [];
    this.contacts.length = 0;
    for (let i = 0; i < ships.length; i++) {
      const s = ships[i];
      if (!s || s.alive === false) continue;
      this.contacts.push(s);
      if (!s.isPlayer && !this.byShip.has(s) && game.aiAutoAttach !== false) {
        this.attach(s, s.aiConfig ?? null);
      }
    }
    // Drop pilots whose ship left the world.
    for (let i = this.pilots.length - 1; i >= 0; i--) {
      const p = this.pilots[i];
      if (p.ship?.alive === false || (ships.length && !ships.includes(p.ship))) {
        this.detach(p.ship);
      }
    }
  }

  /**
   * Keep the dev shadow bodies alive. Ships we fly get integrated; ships we only
   * observe (the player, before flight lands) get their transform sampled.
   */
  syncBodies(dt) {
    if (!this.allowShadowBodies || !this.shadows.size) return;
    for (const [ship, body] of this.shadows) {
      if (ship.body) continue;
      integrateShadow(body, ship, dt, this.byShip.has(ship));
    }
  }

  updateTurnRates(dt) {
    if (dt <= 0) return;
    for (const s of this.contacts) {
      const f = this.forwardOfShip(s);
      if (!f) continue;
      let e = this._turn.get(s);
      if (!e) {
        e = { prev: f.clone(), rate: 0 };
        this._turn.set(s, e);
        continue;
      }
      const a = angleBetween(e.prev, f);
      e.rate = lerp(e.rate, a / dt, 0.25);
      e.prev.copy(f);
    }
  }

  // ------------------------------------------------------------------ sensing

  contextFor(pilot, dt) {
    const ctx = pilot.ctx;
    const body = this.bodyOf(pilot.ship);
    if (!body) return null;

    ctx.body = body;
    ctx.time = this.time;
    ctx.dt = dt;
    ctx.mv = pilot.mv;
    ctx.pos.copy(body.position);
    if (body.velocity) ctx.vel.copy(body.velocity);
    else ctx.vel.set(0, 0, 0);
    ctx.fwd.set(0, 0, -1).applyQuaternion(body.quaternion);
    ctx.up.set(0, 1, 0).applyQuaternion(body.quaternion);
    ctx.right.set(1, 0, 0).applyQuaternion(body.quaternion);
    const sp = ctx.vel.length();
    if (sp > 1e-3) ctx.velDir.copy(ctx.vel).multiplyScalar(1 / sp);
    else ctx.velDir.copy(ctx.fwd);

    const s = ctx.sense;
    s.mySpeed = sp;
    s.myVel.copy(ctx.vel);
    s.cornerSpeed = num(pilot.ship.stats?.cornerSpeed, pilot.maxSpeed * 0.62);

    // Reset the intent each frame — manoeuvres opt in to what they want.
    const it = ctx.intent;
    it.throttle = 0.6;
    it.ab = 0;
    it.brake = 0;
    it.strafeX = 0;
    it.strafeY = 0;
    it.planeHint = null;
    it.rollOffset = 0;
    it.tauScale = 1;
    it.levelWeight = 0.4;
    it.gunOk = false;
    it.label = '';

    // --- target geometry ---
    const target = pilot.target && pilot.target.alive !== false ? pilot.target : null;
    ctx.target = target;
    if (target) {
      const tb = this.bodyOf(target);
      if (tb) {
        ctx.tgtPos.copy(tb.position);
        _v.copy(tb.position).sub(ctx.pos);
        const range = _v.length();
        s.range = range;
        if (range > 1e-4) s.los.copy(_v).multiplyScalar(1 / range);
        else s.los.copy(ctx.fwd);
        if (tb.velocity) s.tgtVel.copy(tb.velocity);
        else s.tgtVel.set(0, 0, 0);
        s.tgtSpeed = s.tgtVel.length();
        s.overtake = s.mySpeed - s.tgtSpeed;
        _v2.copy(s.tgtVel).sub(ctx.vel);
        s.closure = range > 1e-4 ? -(_v.dot(_v2)) / range : 0;
        s.angleOff = Math.acos(clamp(ctx.fwd.dot(s.los), -1, 1));
        const tf = this.forwardOfShip(target);
        if (tf) s.tgtFwd.copy(tf);
        s.aspect = Math.acos(clamp(-s.tgtFwd.dot(s.los), -1, 1));
        s.tgtTurn = this.turnRateOf(target);
        s.targetIsCapital = isCapital(target);
        s.targetIsProtector = pilot.protecting?.ship === target;
        ctx.lateralSign = Math.sign(ctx.right.dot(s.los)) || 0;
        ctx.leadTime = clamp(range / Math.max(120, gunSpeed(pilot.ship)), 0, 3);
      }
    } else {
      s.range = 1e6;
      s.closure = 0;
      s.angleOff = Math.PI;
      s.aspect = Math.PI;
      s.tgtTurn = 0;
      s.targetIsCapital = false;
      s.targetIsProtector = false;
      ctx.leadTime = 0;
      ctx.lateralSign = 0;
    }

    // --- threat geometry ---
    const threat = pilot.threat && pilot.threat.alive !== false ? pilot.threat : null;
    if (threat) {
      const hb = this.bodyOf(threat);
      if (hb) {
        _v.copy(hb.position).sub(ctx.pos);
        const r = _v.length();
        s.threatRange = r;
        ctx._threatDir.copy(_v).multiplyScalar(r > 1e-4 ? 1 / r : 0);
        ctx.threatDir = ctx._threatDir;
        s.threatAngleOff = Math.acos(clamp(ctx.fwd.dot(ctx._threatDir), -1, 1));
        ctx.threatAngleOff = s.threatAngleOff;
        const hf = this.forwardOfShip(threat);
        s.threatAspect = hf ? Math.acos(clamp(-hf.dot(ctx._threatDir), -1, 1)) : Math.PI;
        _v2.copy(hb.velocity ?? ZERO).sub(ctx.vel);
        s.threatClosure = r > 1e-4 ? -(_v.dot(_v2)) / r : 0;
      }
    } else {
      s.threatRange = 1e6;
      s.threatClosure = 0;
      s.threatAngleOff = null;
      s.threatAspect = Math.PI;
      ctx.threatDir = null;
      ctx.threatAngleOff = null;
    }

    if (!pilot.homeVec) {
      const base = this.basePosition();
      pilot.homeVec = base.sub(ctx.pos).normalize();
    }

    return ctx;
  }

  /** Choose (or keep) a target, honouring orders and stand-down states. */
  retarget(pilot) {
    if (pilot.disengaged) {
      pilot.target = null;
      return;
    }
    if (pilot.forcedTarget && pilot.forcedTarget.alive !== false) {
      pilot.target = pilot.forcedTarget;
      return;
    }
    // Defending someone: go after whoever is on them.
    if (pilot.protecting && this.time < pilot.protectUntil) {
      const t = pilot.protecting.threat;
      if (t && t.alive !== false && isHostile(pilot.ship, t)) {
        pilot.target = t;
        return;
      }
    }
    if (pilot.holdFire && !pilot.underAttackFor) {
      // Weapons tight and nobody bothering us: no target, hold station.
      if (pilot.threatClearFor > 2) {
        pilot.target = null;
        return;
      }
    }
    const next = selectTarget(pilot, this);
    if (next !== pilot.target) {
      pilot.target = next;
      pilot.mv.t = Math.min(pilot.mv.t, 0.2); // let the manoeuvre re-pick soon
    }
  }

  /** Find the most pressing missile aimed at this pilot. */
  updateIncoming(pilot) {
    let best = null;
    let bestTti = Infinity;
    for (let i = 0; i < this.missiles.length; i++) {
      const m = this.missiles[i];
      if (!m.alive || m.target !== pilot.ship) continue;
      const b = this.bodyOf(pilot.ship);
      if (!b) continue;
      _v.copy(m.pos).sub(b.position);
      const r = _v.length();
      if (r > 6000) continue;
      _v2.copy(m.vel).sub(b.velocity ?? ZERO);
      const closing = r > 1e-4 ? -(_v.dot(_v2)) / r : 0;
      const tti = closing > 1 ? r / closing : Infinity;
      if (tti < bestTti) {
        bestTti = tti;
        m.range = r;
        m.tti = tti;
        if (!m.dir) m.dir = new THREE.Vector3();
        m.dir.copy(_v).multiplyScalar(r > 1e-4 ? 1 / r : 0);
        best = m;
      }
    }
    // Only react once it is actually a problem — and only after the pilot's own
    // reaction time. A rookie notices the missile late.
    pilot.incoming = best && bestTti < lerp(6, 11, pilot.profile.missileSkill) ? best : null;
  }

  // ----------------------------------------------------------------- steering

  applyIntent(pilot, ctx, dt) {
    const body = ctx.body;
    const it = ctx.intent;
    const st = pilot.ship.stats ?? {};
    const cap = pilot.isCapital;

    const pitchRate = num(st.pitchRate, cap ? 0.09 : 1.35);
    const yawRate = num(st.yawRate, cap ? 0.07 : 1.05);
    const rollRate = num(st.rollRate, cap ? 0.06 : 2.6);

    if (!(it.aim.lengthSq() > 1e-8)) it.aim.copy(ctx.fwd);

    const out = solveSteering(
      pilot.steerMem,
      body.quaternion,
      it.aim,
      {
        pitchRate,
        yawRate,
        rollRate,
        tau: pilot.profile.turnTau * (it.tauScale ?? 1) * (cap ? 5 : 1),
        rollTau: pilot.profile.turnTau * 0.9 * (cap ? 6 : 1),
        planeHint: it.planeHint ?? pilot.profile.planeHint,
        rollOffset: it.rollOffset ?? 0,
        levelRef: WORLD_UP,
        levelWeight: it.levelWeight ?? 0.4,
        bankLo: cap ? 1.2 : 0.13,
        bankHi: cap ? 2.4 : 0.62,
      },
      dt,
    );

    pilot.gLoad = clamp01(Math.hypot(out.pitch, out.yaw));

    const sg = this.controlSigns;
    const c = body.controls ?? (body.controls = makeControls());
    c.pitch = clamp11(num(out.pitch) * sg.pitch);
    c.yaw = clamp11(num(out.yaw) * sg.yaw);
    c.roll = clamp11(num(out.roll) * sg.roll);
    c.throttle = clamp01(num(it.throttle, 0.5));
    c.afterburner = clamp01(num(it.ab, 0));
    c.strafeX = clamp11(num(it.strafeX, 0));
    c.strafeY = clamp11(num(it.strafeY, 0));
    c.brake = clamp01(num(it.brake, 0));

    // Mirror onto ship.controls if flight chose to expose it there too.
    if (pilot.ship.controls && pilot.ship.controls !== c) {
      const m = pilot.ship.controls;
      m.pitch = c.pitch; m.yaw = c.yaw; m.roll = c.roll;
      m.throttle = c.throttle; m.afterburner = c.afterburner;
      m.strafeX = c.strafeX; m.strafeY = c.strafeY; m.brake = c.brake;
    }
  }

  /**
   * Publish the fire request. combat/ owns projectiles, so we only ever *ask*.
   * Several shapes are offered because the combat contract is still being
   * written; whichever one lands, this works, and the raw flags are always set.
   */
  writeFire(pilot, ctx) {
    const ship = pilot.ship;
    const firing = pilot.firing === true && pilot.holdFire !== true;
    ship.aiFiring = firing;
    ship.wantsFire = firing;
    const body = ctx.body;
    if (body?.controls) {
      body.controls.fire = firing ? 1 : 0;
      body.controls.firePrimary = firing ? 1 : 0;
    }
    if (firing) pilot.lastFireTime = this.time;

    const combat = this.engine.game?.combat;
    if (firing !== pilot._lastFiring) {
      pilot._lastFiring = firing;
      if (combat?.setFiring) {
        try { combat.setFiring(ship, firing); } catch { /* combat still landing */ }
      } else if (!combat && firing && this.events) {
        // Nothing owns projectiles yet: announce the burst so vfx/audio agents
        // have a signal to build against. Self-disables once combat/ exists.
        this.events.emit('weapon:fired', {
          ship,
          position: ctx.pos.clone(),
          direction: ctx.fwd.clone(),
          target: pilot.target ?? null,
          speed: gunSpeed(ship),
          kind: 'guns',
          byAI: true,
        });
      }
    }

    if (pilot.wantDecoy) {
      pilot.wantDecoy = false;
      if (combat?.deployCountermeasure) {
        try { combat.deployCountermeasure(ship); } catch { /* ignore */ }
      } else {
        this.events?.emit('countermeasure:deploy', { ship, position: ctx.pos.clone(), kind: 'decoy' });
      }
    }
  }

  // ------------------------------------------------------------ mutual support

  /** Hand out help requests, including spontaneous cover for the player. */
  dispatchHelp(dt) {
    for (const sq of this.squadrons.values()) {
      for (let i = sq.helpQueue.length - 1; i >= 0; i--) {
        const call = sq.helpQueue[i];
        const responder = sq.responderFor(call, this);
        if (!responder) continue;
        sq.helpQueue.splice(i, 1);
        responder.protecting = call.pilot;
        responder.protectUntil = this.time + 16;
        responder.forcedTarget = call.pilot.threat ?? null;
        responder.forcedTargetUntil = this.time + 16;
        this.radio.say(responder, 'onMyWay', { wingman: call.pilot.ship });
      }
    }

    // The player is a squadmate too: if they are pinned and nobody is helping,
    // the nearest disciplined wingman peels off. This is the moment WC players
    // remember their wingman's name.
    const pp = this.playerPilot;
    if (!pp || pp.underAttackFor < 1.4 || !pp.threat) return;
    if (this.pilots.some((p) => p.protecting === pp)) return;
    let best = null;
    let bestScore = -Infinity;
    const pb = this.bodyOf(pp.ship);
    for (const p of this.pilots) {
      if (this.isHostileToPlayer(p.ship)) continue;
      if (p.ship.alive === false || p.state === 'evade' || p.state === 'flee' || p.incoming) continue;
      const b = this.bodyOf(p.ship);
      const d = b && pb ? b.position.distanceTo(pb.position) : 9999;
      const sc = p.profile.discipline * 3000 - d;
      if (sc > bestScore) {
        bestScore = sc;
        best = p;
      }
    }
    if (best) {
      best.protecting = pp;
      best.protectUntil = this.time + 20;
      best.forcedTarget = pp.threat;
      best.forcedTargetUntil = this.time + 20;
      this.radio.say(best, 'onMyWay', { wingman: pp.ship, force: true });
    }
  }

  /** "That was close" — someone shooting at us who is not connecting. */
  maybeNearMiss(pilot, ctx) {
    const th = pilot.threat;
    if (!th || ctx.sense.threatRange > 700) return;
    if (ctx.sense.threatAspect > 8 * DEG) return;
    if (this.time - pilot.lastHitTime < 1.5) return;
    const tp = this.pilotOf(th);
    if (!tp?.firing) return;
    this.radio.say(pilot, 'nearMiss', {});
  }

  // -------------------------------------------------------------------- events

  onHit(payload) {
    if (!payload) return;
    const victim = payload.target ?? payload.ship ?? payload.victim ?? null;
    const attacker = payload.shooter ?? payload.source ?? payload.owner ?? payload.attacker ?? null;
    const pilot = victim ? this.byShip.get(victim) : null;
    if (victim === this.engine.game?.player && this.playerPilot) {
      this.playerPilot.lastHitTime = this.time;
      if (attacker) this.playerPilot.lastAttacker = attacker;
    }
    if (!pilot) return;
    pilot.lastHitTime = this.time;
    if (attacker && attacker !== pilot.ship) pilot.lastAttacker = attacker;
    // Getting hit is the strongest possible cue that you are the prey.
    pilot.underAttackFor = Math.max(pilot.underAttackFor, pilot.profile.evadeDelay * 0.9);
    this.radio.say(pilot, 'hit', {});
  }

  onMissileLaunched(payload) {
    if (!payload) return;
    const obj = payload.missile ?? payload.projectile ?? payload.obj ?? null;
    const target = payload.target ?? null;
    const shooter = payload.shooter ?? payload.source ?? payload.ship ?? null;
    if (!target) return;
    const pos = this._posOf(obj) ?? this._shipPos(shooter);
    if (!pos) return;
    this.missiles.push({
      obj,
      target,
      shooter,
      alive: true,
      born: this.time,
      pos: pos.clone(),
      vel: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      tti: Infinity,
      range: Infinity,
    });
  }

  _posOf(obj) {
    if (!obj) return null;
    if (obj.isVector3) return obj;
    return obj.position ?? obj.body?.position ?? obj.group?.position ?? null;
  }

  _shipPos(ship) {
    const b = ship ? this.bodyOf(ship) : null;
    return b?.position ?? null;
  }

  /** Track live missiles so pilots can beam them and point defence can kill them. */
  updateMissileTracks(dt) {
    if (!this.missiles.length) return;
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      const p = this._posOf(m.obj);
      const dead =
        m.obj && (m.obj.alive === false || m.obj.dead === true || m.obj.expired === true);
      if (p) {
        if (dt > 0) {
          _v.copy(p).sub(m.pos).multiplyScalar(1 / dt);
          m.vel.lerp(_v, 0.4);
        }
        m.pos.copy(p);
      } else if (m.obj) {
        // The object vanished — treat the track as spent.
        m.alive = false;
      } else {
        // No object handle (combat/ not landed): dead-reckon toward the target so
        // evasion logic still has something plausible to break against.
        const tb = this.bodyOf(m.target);
        if (tb) {
          _v.copy(tb.position).sub(m.pos);
          const d = _v.length();
          if (d > 1e-3) _v.multiplyScalar(1 / d);
          m.vel.lerp(_v.multiplyScalar(900), 0.2);
          m.pos.addScaledVector(m.vel, dt);
          if (d < 40) m.alive = false;
        }
      }
      if (dead || this.time - m.born > 30) m.alive = false;
      if (!m.alive) {
        const c = this.missileTargets.get(m.target);
        if (c != null) {
          if (c <= 1) this.missileTargets.delete(m.target);
          else this.missileTargets.set(m.target, c - 1);
        }
        const victim = this.byShip.get(m.target);
        if (victim) {
          victim.incoming = null;
          this.radio.say(victim, 'missileDefeated', {});
        }
        this.missiles.splice(i, 1);
      }
    }
  }

  onDestroyed(payload) {
    const ship = payload?.ship ?? payload?.target ?? null;
    if (!ship) return;
    const victim = this.byShip.get(ship);

    // Who claims it? Prefer an explicit credit; otherwise the nearest attacker
    // who was on this target and shooting recently.
    let killer = payload?.killer ?? payload?.by ?? payload?.source ?? payload?.shooter ?? null;
    if (!killer) {
      let best = null;
      let bestD = Infinity;
      const vb = this.bodyOf(ship);
      for (const p of this.pilots) {
        if (p.target !== ship || this.time - p.lastFireTime > 2.5) continue;
        const b = this.bodyOf(p.ship);
        const d = b && vb ? b.position.distanceToSquared(vb.position) : Infinity;
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      killer = best?.ship ?? null;
    }

    const kp = killer ? this.byShip.get(killer) : null;
    if (kp) {
      this.radio.say(kp, speciesKind('kill', kp.ship.faction), { target: ship, force: true });
      kp.pendingTaunt = kp.profile.flair > 0.55;
      kp.target = null;
    }

    if (victim) {
      // Ejection: nerve decides whether they get out in time.
      if (hash01(victim.seed, this.frame) < 0.25 + victim.profile.nerve * 0.5) {
        this.radio.say(victim, 'eject', { force: true });
      }
      // Squadmates notice.
      const sq = victim.squadron;
      if (sq) {
        for (const m of sq.alive) {
          if (m === victim) continue;
          if (this.radio.say(m, 'wingmanLost', { wingman: ship })) break;
        }
      }
      this.detach(ship);
    }

    // Clean up references held by everyone else.
    for (const p of this.pilots) {
      if (p.target === ship) p.target = null;
      if (p.forcedTarget === ship) p.forcedTarget = null;
      if (p.threat === ship) p.threat = null;
    }
    for (const m of this.missiles) {
      if (m.target === ship) m.alive = false;
    }
    this.assign.delete(ship);
    this.missileTargets.delete(ship);
  }

  // --------------------------------------------------------------------- debug

  updateDebug() {
    const want = this.engine.game?.debugAI === true;
    if (want && !this.debug && !this._debugPending) {
      this._debugPending = true;
      import('./debug.js')
        .then((m) => {
          this.debug = m.createAIDebug(this.engine);
          this._debugPending = false;
        })
        .catch(() => {
          this._debugPending = false;
        });
    }
    if (!want && this.debug) {
      this.debug.dispose?.();
      this.debug = null;
    }
    this.debug?.update(this);
  }

  // ------------------------------------------------------------------ reporting

  /** Snapshot for debug overlays and the self-test. */
  snapshot() {
    return this.pilots.map((p) => ({
      id: p.id,
      callsign: p.profile.callsign,
      skill: p.profile.skill,
      temperament: p.profile.temperament,
      state: p.state,
      maneuver: p.mv.id,
      target: p.target?.name ?? p.target?.id ?? null,
      transitions: p.transitions,
      hull: +p.hullFrac.toFixed(2),
      firing: p.firing,
    }));
  }
}

/** ARCHITECTURE §5.1 factory. */
export function createAISystem(engine, opts = {}) {
  return new AISystem(engine, opts);
}

export default createAISystem;
