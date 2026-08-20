/**
 * CockpitState — the single defensive read of everything the cockpit displays.
 *
 * The cockpit sits at priority 800, downstream of flight/combat/ai/mission, and it
 * has to render standalone while half of those modules are still being written.
 * So nothing in here ever reaches into another module's internals: it probes a
 * documented field, then a plausible alternative, then falls back to a placeholder
 * that is *labelled* as estimated rather than faked silently.
 *
 * Everything the HUD, the MFDs and the damage schematic need is resolved exactly
 * once per frame into plain fields on this object. Two consumers asking the same
 * question twice must never produce two different answers in one frame.
 *
 * TODO(contract): once `combat/` lands it should publish, per ship:
 *     ship.shields = { fore:{v,max}, aft:{v,max}, recharge }
 *     ship.armor   = { fore:{v,max}, aft:{v,max}, left:{v,max}, right:{v,max} }
 *     ship.weapon  = { index, group:[gunIndex...], energy, maxEnergy }
 *     ship.missile = { index, lock:0..1, locked:bool, counts:[n...] }
 *     ship.incoming = [{ missile, eta, bearing }]
 *   and `mission/` should publish `game.mission.nav = { name, position, index, total }`.
 * Until then the fallbacks below stand in, driven by the event bus where possible.
 */

import * as THREE from 'three';
import { makeRng } from '../core/Rand.js';

/** Who shoots at whom. Local copy so the cockpit never hard-depends on ai/. */
const ALLIES = {
  confed: new Set(['confed', 'terran', 'civilian', 'militia']),
  terran: new Set(['confed', 'terran', 'civilian', 'militia']),
  civilian: new Set(['confed', 'terran', 'civilian', 'militia']),
  nephilim: new Set(['nephilim', 'alien', 'bug']),
  alien: new Set(['nephilim', 'alien', 'bug']),
  kilrathi: new Set(['kilrathi']),
};

export function isHostile(a, b) {
  if (!a || !b || a === b) return false;
  const fa = a.faction ?? 'confed';
  const fb = b.faction ?? 'confed';
  if (fa === 'neutral' || fb === 'neutral') return false;
  const set = ALLIES[fa];
  return set ? !set.has(fb) : fa !== fb;
}

const CAPITAL_RE = /carrier|cruiser|destroyer|corvette|frigate|dreadnought|station|transport|capital|leviathan|drayman/i;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Read a bank that may be a plain number, a {v,max} pair, or absent. */
function bank(src, key, max) {
  const raw = src?.[key];
  if (raw && typeof raw === 'object') {
    const m = num(raw.max, num(raw.maximum, max));
    return { v: Math.max(0, num(raw.v, num(raw.value, num(raw.current, m)))), max: Math.max(1e-3, m) };
  }
  if (typeof raw === 'number') return { v: Math.max(0, raw), max: Math.max(1e-3, max) };
  return null;
}

const QUADRANTS = ['fore', 'aft', 'left', 'right'];

/**
 * Fallback damage bookkeeping for one ship.
 *
 * Starts from the stat block, bleeds on `shield:impact` / `weapon:hit`, and
 * recharges the shields at the rate the stats declare. `estimated` stays true so
 * the display can be honest about where the numbers came from.
 */
class DamageModel {
  constructor(ship, seed) {
    const st = ship?.stats ?? ship?.group?.userData?.stats ?? {};
    const sh = st.shields ?? {};
    const ar = st.armor ?? {};
    this.recharge = num(sh.recharge, 40);
    this.shields = {
      fore: { v: num(sh.fore, 800), max: Math.max(1, num(sh.fore, 800)) },
      aft: { v: num(sh.aft, 800), max: Math.max(1, num(sh.aft, 800)) },
    };
    this.armor = {};
    for (const q of QUADRANTS) {
      const m = Math.max(1, num(ar[q], num(ar[q[0]], 320)));
      this.armor[q] = { v: m, max: m };
    }
    this.estimated = true;
    // A pristine ship with four identical full bars reads as a mock-up. Seed a
    // small, deterministic amount of prior wear so the gauges have shape. Any
    // real damage state published by combat/ replaces this wholesale.
    const rng = makeRng(seed >>> 0);
    this.shields.fore.v *= rng.range(0.72, 0.99);
    this.shields.aft.v *= rng.range(0.4, 0.86);
    for (const q of QUADRANTS) this.armor[q].v *= rng.range(0.68, 1.0);
  }

  hit(amount, quadrant) {
    let dmg = Math.max(0, amount);
    const q = QUADRANTS.includes(quadrant) ? quadrant : 'fore';
    const shieldBank = q === 'aft' ? this.shields.aft : this.shields.fore;
    const absorbed = Math.min(shieldBank.v, dmg);
    shieldBank.v -= absorbed;
    dmg -= absorbed;
    if (dmg > 0) this.armor[q].v = Math.max(0, this.armor[q].v - dmg);
  }

  update(dt) {
    for (const k of ['fore', 'aft']) {
      const b = this.shields[k];
      b.v = Math.min(b.max, b.v + this.recharge * dt);
    }
  }
}

/**
 * @param {import('../core/Engine.js').Engine} engine
 */
export function createCockpitState(engine, { seed = 4711 } = {}) {
  const rng = makeRng(seed);

  const st = {
    time: 0,
    /** Player ship record, or null while nothing has spawned. */
    player: null,
    body: null,
    pilotName: 'MAVERICK',
    shipName: 'F-109 VAMPIRE',
    shipRole: 'MEDIUM FIGHTER',
    classId: '',

    speed: 0,
    maxSpeed: 480,
    commanded: 0,
    throttle: 0,
    afterburner: false,
    abFuel: 1,
    gLoad: 1,
    slipAngle: 0,
    autopilotActive: false,
    autopilotReady: false,
    /** Unit world direction the hull is pointing. */
    forward: new THREE.Vector3(0, 0, -1),
    up: new THREE.Vector3(0, 1, 0),
    right: new THREE.Vector3(1, 0, 0),
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    angularVelocity: new THREE.Vector3(),
    acceleration: new THREE.Vector3(),

    shields: null,
    armor: null,
    damageEstimated: true,

    /** Currently selected gun group. */
    weapon: { name: 'PARTICLE', index: 0, count: 1, speed: 1500, range: 3800, color: '#9fd8ff', energy: 1, refire: 0.26 },
    weaponList: [],
    /** Currently selected missile type. */
    missile: { name: 'IR', index: 0, count: 4, lock: 0, locked: false, seeker: true },
    missileList: [],
    energy: 1,

    /** Locked target, or null. */
    target: null,
    /** Everything on the scope. */
    contacts: [],
    /** Seconds remaining on the incoming-missile alert; 0 = clear. */
    incoming: 0,
    incomingBearing: null,
    /** True while a hostile has a missile lock on us. */
    lockedBy: 0,
    nav: {
      name: 'NAV 1', distance: 0, index: 1, total: 4, hasNav: false,
      /**
       * World position of the active nav point, or null when the mission has not
       * published one. The HUD projects this to draw the waypoint marker, which is
       * the only thing in flight that says *which way* rather than *how far*.
       */
      position: null,
    },
    starDir: new THREE.Vector3(0.6, 0.4, -0.7).normalize(),
    starColor: new THREE.Color(0.82, 0.88, 1),

    update,
    dispose,
  };

  // ---------------------------------------------------------------- internals
  const models = new WeakMap();
  const _a = new THREE.Vector3();
  const _b = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const contactPool = [];
  const targetRec = {
    ship: null, name: '', className: '', role: '', faction: '', hostile: true, capital: false,
    position: new THREE.Vector3(), velocity: new THREE.Vector3(), dirLocal: new THREE.Vector3(),
    distance: 0, closure: 0, radius: 10, angularRadius: 0.01,
    shields: null, armor: null, estimated: true, aspect: 0,
  };

  let lockTimer = 0;
  let lastTargetShip = null;
  let weaponIndex = 0;
  let missileIndex = 0;
  const missileAmmo = new Map();

  function modelFor(ship) {
    let m = models.get(ship);
    if (!m) {
      m = new DamageModel(ship, (seed ^ (ship?.id ?? 0) * 2654435761) >>> 0);
      models.set(ship, m);
    }
    return m;
  }

  // ------------------------------------------------------------- event wiring
  const offs = [];
  const ev = engine.events;
  if (ev?.on) {
    const damage = (p) => {
      const victim = p?.ship ?? p?.target ?? p?.victim ?? null;
      if (!victim) return;
      const amount = num(p.damage, num(p.amount, 30));
      modelFor(victim).hit(amount, p.quadrant ?? p.side ?? quadrantOf(victim, p.position));
    };
    offs.push(ev.on('weapon:hit', damage));
    offs.push(ev.on('shield:impact', damage));
    offs.push(ev.on('missile:launched', (p) => {
      const tgt = p?.target ?? null;
      if (tgt && st.player && tgt === st.player) {
        st.incoming = Math.max(st.incoming, 8);
        st.incomingBearing = p?.position?.isVector3 ? p.position.clone() : null;
      }
    }));
    offs.push(ev.on('missile:lock', (p) => {
      if (p?.target && st.player && p.target === st.player) st.lockedBy = Math.max(st.lockedBy, 3);
    }));
  }

  /** Which armour facing a world-space impact landed on. */
  function quadrantOf(ship, worldPos) {
    if (!worldPos?.isVector3 || !ship?.group) return 'fore';
    _a.copy(worldPos).sub(ship.group.position);
    _q.copy(ship.group.quaternion).invert();
    _a.applyQuaternion(_q);
    if (Math.abs(_a.z) >= Math.abs(_a.x)) return _a.z < 0 ? 'fore' : 'aft';
    return _a.x < 0 ? 'left' : 'right';
  }

  // ---------------------------------------------------------------- resolvers
  function resolvePlayer() {
    const game = engine.game;
    return engine.player ?? game?.player ?? game?.ships?.find?.((s) => s?.isPlayer) ?? null;
  }

  function resolveTarget(player) {
    const game = engine.game;
    const explicit =
      player?.target ??
      game?.playerTarget ??
      game?.combat?.playerTarget ??
      game?.combat?.getPlayerTarget?.() ??
      null;
    if (explicit?.group) return explicit;
    if (explicit?.ship?.group) return explicit.ship;

    // Nothing has published a target yet — lock the nearest hostile in front of
    // us, which is what the player would have pressed R for anyway.
    const ships = game?.ships;
    if (!ships?.length || !player?.group) return null;
    let best = null;
    let bestScore = Infinity;
    for (const s of ships) {
      if (!s?.group || s === player || s.alive === false) continue;
      if (!isHostile(player, s)) continue;
      _a.copy(s.group.position).sub(player.group.position);
      const d = _a.length();
      if (d < 1e-3) continue;
      const facing = _a.dot(st.forward) / d;   // 1 = dead ahead
      const score = d * (1.6 - facing);
      if (score < bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  function damageOf(ship) {
    const live = {
      shields: {
        fore: bank(ship?.shields, 'fore', num(ship?.stats?.shields?.fore, 800)),
        aft: bank(ship?.shields, 'aft', num(ship?.stats?.shields?.aft, 800)),
      },
      armor: {},
      estimated: false,
    };
    for (const q of QUADRANTS) live.armor[q] = bank(ship?.armor, q, num(ship?.stats?.armor?.[q], 320));
    if (live.shields.fore && live.shields.aft && QUADRANTS.every((q) => live.armor[q])) return live;

    const m = modelFor(ship);
    return { shields: m.shields, armor: m.armor, estimated: true };
  }

  function shipRadius(ship) {
    const ud = ship?.group?.userData;
    return Math.max(2, num(ud?.radius, num(ud?.def?.length, num(ship?.stats?.length, 20)) * 0.5));
  }

  function displayName(ship) {
    const ud = ship?.group?.userData;
    return String(ud?.def?.name ?? ship?.name ?? ship?.classId ?? 'UNKNOWN').toUpperCase();
  }

  function roleName(ship) {
    const ud = ship?.group?.userData;
    return String(ud?.def?.role ?? (isCapitalShip(ship) ? 'capital ship' : 'fighter')).toUpperCase();
  }

  function isCapitalShip(ship) {
    const id = ship?.classId ?? ship?.group?.userData?.classId ?? '';
    return CAPITAL_RE.test(id) || num(ship?.stats?.length, 20) > 120;
  }

  // ------------------------------------------------------------------- update
  function update(dt) {
    st.time += dt;
    const game = engine.game;
    const player = resolvePlayer();
    st.player = player;

    // ---- own ship ---------------------------------------------------------
    const body = player?.body ?? null;
    st.body = body;
    if (player?.group) {
      st.position.copy(player.group.position);
      st.quaternion.copy(player.group.quaternion);
      st.forward.set(0, 0, -1).applyQuaternion(st.quaternion);
      st.up.set(0, 1, 0).applyQuaternion(st.quaternion);
      st.right.set(1, 0, 0).applyQuaternion(st.quaternion);
      st.shipName = displayName(player);
      st.shipRole = roleName(player);
      st.classId = player.classId ?? '';
    } else {
      // Standalone: the cockpit still has to draw something coherent.
      st.quaternion.copy(engine.cockpitCamera.quaternion);
      st.forward.set(0, 0, -1).applyQuaternion(st.quaternion);
      st.up.set(0, 1, 0).applyQuaternion(st.quaternion);
      st.right.set(1, 0, 0).applyQuaternion(st.quaternion);
      st.position.copy(engine.cockpitCamera.position);
    }

    if (body) {
      st.velocity.copy(body.velocity ?? _a.set(0, 0, 0));
      st.speed = num(body.speed, st.velocity.length());
      st.maxSpeed = num(body.tuning?.maxSpeed, num(player?.stats?.maxSpeed, 480));
      st.commanded = num(body.commandedSpeed, clamp01(num(body.controls?.throttle, 0)) * st.maxSpeed);
      st.throttle = clamp01(num(body.controls?.throttle, 0));
      st.afterburner = !!body.afterburner;
      st.abFuel = clamp01(num(body.fuel, 1));
      st.gLoad = num(body.gLoad, 1);
      st.slipAngle = num(body.slipAngle, 0);
      st.autopilotActive = !!body.autopilotActive;
      st.angularVelocity.copy(body.angularVelocity ?? _a.set(0, 0, 0));
      st.acceleration.copy(body.acceleration ?? _a.set(0, 0, 0));
    } else {
      st.speed += (st.maxSpeed * 0.55 - st.speed) * Math.min(1, dt * 0.7);
      st.throttle = 0.55;
      st.commanded = st.maxSpeed * 0.55;
      st.velocity.copy(st.forward).multiplyScalar(st.speed);
    }

    // ---- own damage state --------------------------------------------------
    if (player) {
      const m = models.get(player);
      if (m) m.update(dt);
      const d = damageOf(player);
      st.shields = d.shields;
      st.armor = d.armor;
      st.damageEstimated = d.estimated;
    } else if (!st.shields) {
      st.shields = { fore: { v: 812, max: 950 }, aft: { v: 540, max: 950 } };
      st.armor = {
        fore: { v: 388, max: 420 }, aft: { v: 291, max: 380 },
        left: { v: 214, max: 340 }, right: { v: 331, max: 340 },
      };
    }

    // ---- weapons -----------------------------------------------------------
    const stats = player?.stats ?? player?.group?.userData?.stats ?? null;
    const guns = Array.isArray(stats?.guns) && stats.guns.length ? stats.guns : DEFAULT_GUNS;
    st.weaponList = guns;
    if (engine.input?.pressed?.('cycleWeapon')) weaponIndex++;
    const wi = ((weaponIndex % (guns.length + 1)) + guns.length + 1) % (guns.length + 1);
    // The last slot is "FULL" — every gun at once, the WC standard.
    const full = wi === guns.length;
    const g = guns[full ? 0 : wi];
    st.weapon = {
      name: full ? 'FULL GUNS' : String(g.type ?? 'GUN').toUpperCase(),
      index: wi,
      count: full ? guns.length : 1,
      speed: num(g.speed, 1500),
      range: num(g.range, 3600),
      color: g.color ?? '#9fd8ff',
      refire: num(g.refire, 0.25),
      energy: num(g.energy, 12),
    };

    const missiles = Array.isArray(stats?.missiles) && stats.missiles.length ? stats.missiles : DEFAULT_MISSILES;
    st.missileList = missiles;
    if (engine.input?.pressed?.('cycleMissile')) missileIndex++;
    const mi = ((missileIndex % missiles.length) + missiles.length) % missiles.length;
    const mdef = missiles[mi];
    const key = `${mi}:${mdef.type}`;
    if (!missileAmmo.has(key)) missileAmmo.set(key, num(mdef.count, 4));
    const liveCounts = player?.missile?.counts ?? player?.missiles?.counts ?? null;
    const count = Array.isArray(liveCounts) ? num(liveCounts[mi], missileAmmo.get(key)) : missileAmmo.get(key);

    // Gun capacitor: drains while the trigger is down, regenerates from the plant.
    const cap = Math.max(1, num(stats?.capacitor, 420));
    const firing = !!engine.input?.held?.('fire');
    const drain = firing ? (st.weapon.energy * st.weapon.count) / Math.max(0.05, st.weapon.refire) : 0;
    const regen = num(stats?.powerPlant, 640) * 0.35;
    st.energy = clamp01(st.energy + ((regen - drain) / cap) * dt);

    // ---- target ------------------------------------------------------------
    const tShip = resolveTarget(player);
    if (tShip !== lastTargetShip) { lockTimer = 0; lastTargetShip = tShip; }

    if (tShip?.group) {
      const t = targetRec;
      t.ship = tShip;
      t.name = displayName(tShip);
      t.role = roleName(tShip);
      t.className = String(tShip.classId ?? '').toUpperCase();
      t.faction = tShip.faction ?? 'unknown';
      t.hostile = isHostile(player ?? { faction: 'confed' }, tShip);
      t.capital = isCapitalShip(tShip);
      t.position.copy(tShip.group.position);
      const tv = tShip.body?.velocity;
      t.velocity.copy(tv?.isVector3 ? tv : _a.set(0, 0, 0));
      _a.copy(t.position).sub(st.position);
      t.distance = Math.max(1e-3, _a.length());
      _b.copy(t.velocity).sub(st.velocity);
      t.closure = -_b.dot(_a) / t.distance;      // +ve = closing
      t.radius = shipRadius(tShip);
      t.angularRadius = Math.atan2(t.radius, t.distance);
      t.dirLocal.copy(_a).divideScalar(t.distance).applyQuaternion(_q.copy(st.quaternion).invert());
      // Aspect: 1 = we are looking at its tail, -1 = head-on.
      _b.set(0, 0, -1).applyQuaternion(tShip.group.quaternion);
      t.aspect = -_b.dot(_a) / t.distance;
      const d = damageOf(tShip);
      t.shields = d.shields;
      t.armor = d.armor;
      t.estimated = d.estimated;
      st.target = t;
    } else {
      st.target = null;
    }

    // ---- missile lock ------------------------------------------------------
    const liveLock = player?.missile?.lock ?? game?.combat?.missileLock ?? null;
    if (typeof liveLock === 'number') {
      lockTimer = clamp01(liveLock);
    } else if (st.target) {
      // Seekers need the target inside a ~12 deg cone and inside range.
      const cone = -st.target.dirLocal.z;
      const inRange = st.target.distance < 6000;
      const good = cone > 0.978 && inRange;
      lockTimer = clamp01(lockTimer + (good ? dt / 1.6 : -dt / 0.8));
    } else {
      lockTimer = Math.max(0, lockTimer - dt);
    }
    st.missile = {
      name: String(mdef.type ?? 'IR').toUpperCase(),
      index: mi,
      total: missiles.length,
      count,
      lock: lockTimer,
      locked: lockTimer >= 0.999,
      seeker: !/dumb/i.test(String(mdef.type ?? '')),
    };

    // ---- threats -----------------------------------------------------------
    const liveIncoming = player?.incoming ?? game?.combat?.incomingMissiles ?? null;
    if (Array.isArray(liveIncoming) && liveIncoming.length) {
      st.incoming = 6;
      const m0 = liveIncoming[0];
      st.incomingBearing = m0?.position?.isVector3 ? m0.position : (m0?.group?.position ?? null);
    } else {
      st.incoming = Math.max(0, st.incoming - dt);
    }
    st.lockedBy = Math.max(0, st.lockedBy - dt);

    // ---- contacts ----------------------------------------------------------
    // Every contact carries enough to be *drawn*, not just plotted: the HUD needs
    // a world position to project, an angular radius to size a box by, and a
    // closure rate. Resolving all of it here keeps the radar and the HUD reading
    // one set of numbers — two consumers must never disagree inside a frame.
    st.contacts.length = 0;
    const ships = game?.ships ?? [];
    _q.copy(st.quaternion).invert();
    for (let i = 0; i < ships.length; i++) {
      const s = ships[i];
      if (!s?.group || s === player) continue;
      _a.copy(s.group.position).sub(st.position);
      const d = _a.length();
      if (d < 1e-3 || d > 30000) continue;
      let c = contactPool[st.contacts.length];
      if (!c) {
        c = contactPool[st.contacts.length] = {
          ship: null, dir: new THREE.Vector3(), position: new THREE.Vector3(),
          velocity: new THREE.Vector3(), distance: 0, closure: 0, radius: 10,
          angularRadius: 0.01, hostile: false, capital: false, isTarget: false,
          wingman: false, alive: true, name: '', faction: '',
        };
      }
      c.ship = s;
      c.position.copy(s.group.position);
      c.dir.copy(_a).divideScalar(d).applyQuaternion(_q);
      c.distance = d;
      const cv = s.body?.velocity;
      c.velocity.copy(cv?.isVector3 ? cv : _b.set(0, 0, 0));
      _b.copy(c.velocity).sub(st.velocity);
      c.closure = -_b.dot(_a) / d;
      c.radius = shipRadius(s);
      c.angularRadius = Math.atan2(c.radius, d);
      c.hostile = isHostile(player ?? { faction: 'confed' }, s);
      c.capital = isCapitalShip(s);
      c.isTarget = s === tShip;
      c.wingman = !!s.wingman;
      c.name = displayName(s);
      c.faction = s.faction ?? 'unknown';
      c.alive = s.alive !== false;
      st.contacts.push(c);
    }
    // Nearest first: the HUD caps how many boxes it draws, and the ones that
    // matter in a knife fight are the close ones.
    st.contacts.sort((p, q) => p.distance - q.distance);

    // ---- nav / autopilot ---------------------------------------------------
    const nav = game?.mission?.nav ?? game?.mission?.currentNav ?? null;
    if (nav) {
      st.nav.hasNav = true;
      st.nav.name = String(nav.name ?? `NAV ${num(nav.index, 1)}`).toUpperCase();
      st.nav.index = num(nav.index, 1);
      st.nav.total = num(nav.total, 1);
      const np = nav.position;
      if (np && Number.isFinite(np.x) && Number.isFinite(np.y) && Number.isFinite(np.z)) {
        if (!st.nav.position) st.nav.position = new THREE.Vector3();
        st.nav.position.set(np.x, np.y, np.z);
        _a.copy(st.nav.position).sub(st.position);
        st.nav.distance = _a.length();
      } else {
        st.nav.position = null;
        st.nav.distance = num(nav.distance, 0);
      }
    } else {
      st.nav.hasNav = false;
      st.nav.name = 'NAV 2 · TALON RENDEZVOUS';
      st.nav.index = 2;
      st.nav.total = 4;
      st.nav.position = null;
      // A slowly closing placeholder so the readout is never a dead constant.
      st.nav.distance = 41_800 - (st.time * st.speed);
      if (st.nav.distance < 4000) st.nav.distance = 4000;
    }
    // Autopilot is offered when nothing hostile is inside knife range.
    let nearestHostile = Infinity;
    for (const c of st.contacts) if (c.hostile && c.alive) nearestHostile = Math.min(nearestHostile, c.distance);
    st.autopilotReady = nearestHostile > 6000 && st.nav.hasNav !== null;

    // ---- star (for the canopy specular streak) -----------------------------
    const star = game?.world?.star;
    if (star?.direction?.isVector3 && star.direction.lengthSq() > 0.1) {
      st.starDir.copy(star.direction).normalize();
      if (star.color?.isColor) st.starColor.copy(star.color);
    } else {
      const ud = engine.scene?.userData;
      const p = ud?.sunPosition ?? ud?.sun?.position ?? null;
      if (p?.isVector3) st.starDir.copy(p).sub(st.position).normalize();
    }

    return st;
  }

  function dispose() {
    for (const off of offs) off?.();
    offs.length = 0;
    contactPool.length = 0;
  }

  // Prime the fields so a consumer that runs before the first update never sees
  // a half-built object.
  st.shields = { fore: { v: 812, max: 950 }, aft: { v: 540, max: 950 } };
  st.armor = {
    fore: { v: 388, max: 420 }, aft: { v: 291, max: 380 },
    left: { v: 214, max: 340 }, right: { v: 331, max: 340 },
  };
  void rng;

  return st;
}

const DEFAULT_GUNS = [
  { type: 'particle', damage: 44, refire: 0.26, speed: 1500, range: 3800, energy: 13, color: '#9fd8ff' },
  { type: 'laser', damage: 26, refire: 0.18, speed: 1900, range: 3200, energy: 7, color: '#ff9a4a' },
];
const DEFAULT_MISSILES = [{ type: 'IR', count: 4 }, { type: 'FF', count: 2 }];
