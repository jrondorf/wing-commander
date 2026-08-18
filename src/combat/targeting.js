/**
 * src/combat/targeting.js — target selection and the ITTS firing solution.
 *
 * ## ITTS
 *
 * The Improved Tactical Targeting System is the lead pipper: the little floating
 * circle you actually aim at. `ittsSolution()` is the single implementation of
 * that maths in the game — the cockpit HUD draws this, the AI shoots at this,
 * and the turrets track with this. If the player's pipper and the AI's lead ever
 * disagreed, the player would correctly conclude the AI cheats, so they do not
 * get separate solvers.
 *
 *   import { ittsSolution } from '../combat/targeting.js';
 *   const sol = ittsSolution(playerShip, target, { speed: 1500 });
 *   if (sol.valid) projectToScreen(sol.point);   // <- the pipper
 *
 * The solve is done in *relative* space (target velocity minus shooter
 * velocity), which is what makes it correct for a gun whose bolts inherit the
 * firing ship's velocity — see projectiles.js.
 *
 * ## Selection
 *
 * `cycleTarget(ship, mode)` covers the whole Wing Commander target keyboard:
 * nearest enemy (R), next/previous in the radar list (T), the ship currently
 * shooting at you (A), whatever is under the reticle, and — on capital ships —
 * subsystem targeting so a torpedo run can aim for the engines or the bridge.
 */
import * as THREE from 'three';
import {
  clamp, clamp01, isHostile, isFriendly, isAlive, isCapitalShip,
  shipPosition, shipVelocity, shipForward, shipRadius, num,
} from './util.js';

const _rel = new THREE.Vector3();
const _relV = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _f = new THREE.Vector3();

// ---------------------------------------------------------------------------
// the intercept maths
// ---------------------------------------------------------------------------

/**
 * Smallest positive time at which a projectile of speed `s` fired from the
 * origin can meet a target at `rel` moving at `relVel`.
 *
 * Solves |rel + relVel·t| = s·t, i.e.
 *   (|relVel|² − s²)t² + 2(rel·relVel)t + |rel|² = 0
 *
 * @returns {number} time of flight in seconds, or −1 when no solution exists
 *          (the target is simply outrunning the shells).
 */
export function interceptTime(rel, relVel, s) {
  const a = relVel.lengthSq() - s * s;
  const b = 2 * rel.dot(relVel);
  const c = rel.lengthSq();

  if (Math.abs(a) < 1e-6) {
    // Degenerate: closing speed exactly equals muzzle speed.
    if (Math.abs(b) < 1e-9) return -1;
    const t = -c / b;
    return t > 0 ? t : -1;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  let t = -1;
  if (t1 > 0 && t2 > 0) t = Math.min(t1, t2);
  else if (t1 > 0) t = t1;
  else if (t2 > 0) t = t2;
  return Number.isFinite(t) && t > 0 ? t : -1;
}

/**
 * Raw lead point. Bit-identical in intent to `ai/aimath.js: leadPoint` — the
 * two must never diverge.
 *
 * @returns {number} time of flight, or −1 if there is no solution (in which
 *          case `out` is set to the target's present position).
 */
export function leadPoint(shooterPos, shooterVel, targetPos, targetVel, projSpeed, out) {
  _rel.copy(targetPos).sub(shooterPos);
  _relV.copy(targetVel).sub(shooterVel);
  const t = interceptTime(_rel, _relV, projSpeed);
  if (t < 0) {
    out.copy(targetPos);
    return -1;
  }
  out.copy(targetVel).multiplyScalar(t).add(targetPos);
  return t;
}

/** Reusable result object, so a per-frame HUD call allocates nothing. */
export function makeSolution() {
  return {
    valid: false,
    reason: '',
    /** World-space point to put the pipper on. */
    point: new THREE.Vector3(),
    /** Unit vector from the shooter to that point. */
    aim: new THREE.Vector3(),
    /** Seconds of flight to the intercept. */
    time: 0,
    /** Present range to the target, metres. */
    range: 0,
    /** Closing speed, m/s (positive = closing). */
    closing: 0,
    /** Angle between the shooter's nose and the aim vector, radians. */
    angleOff: 0,
    /** True when the target is inside the weapon's effective envelope. */
    inRange: false,
    /** Angular radius the target subtends — the HUD sizes the box with this. */
    angularSize: 0,
  };
}

const _shared = makeSolution();

function posOf(x, out) {
  if (!x) return null;
  if (x.isVector3) return out.copy(x);
  if (x.position?.isVector3) return out.copy(x.position);
  return shipPosition(x, out);
}

function velOf(x, out) {
  if (!x || x.isVector3) return out.set(0, 0, 0);
  if (x.velocity?.isVector3) return out.copy(x.velocity);
  return shipVelocity(x, out);
}

/**
 * The full firing solution for a gun.
 *
 * @param {object} shooter ship record, or `{position, velocity}`
 * @param {object} target  ship record, a subsystem `{position, velocity}`, or a
 *                         bare Vector3
 * @param {{speed?:number, range?:number, weapon?:object, out?:object,
 *          forward?:THREE.Vector3, requireTargeting?:boolean}} opts
 * @returns {ReturnType<makeSolution>}
 */
export function ittsSolution(shooter, target, opts = {}) {
  const out = opts.out ?? _shared;
  out.valid = false;
  out.reason = '';
  out.time = 0;
  out.range = 0;
  out.closing = 0;
  out.angleOff = Math.PI;
  out.inRange = false;
  out.angularSize = 0;

  if (!shooter || !target) { out.reason = 'no-target'; return out; }

  const weapon = opts.weapon ?? null;
  const speed = num(opts.speed, num(weapon?.speed, 1500));
  const range = num(opts.range, num(weapon?.range, 3800));

  // A destroyed targeting computer takes the pipper with it.
  if (opts.requireTargeting !== false && shooter.combat?.targetingOnline === false) {
    out.reason = 'targeting-offline';
  }

  if (!posOf(shooter, _a)) { out.reason = 'no-shooter'; return out; }
  if (!posOf(target, _b)) { out.reason = 'no-target'; return out; }
  velOf(shooter, _c);
  velOf(target, _d);

  _rel.copy(_b).sub(_a);
  out.range = _rel.length();
  _relV.copy(_d).sub(_c);
  out.closing = out.range > 1e-4 ? -_relV.dot(_rel) / out.range : 0;

  const tof = interceptTime(_rel, _relV, speed);
  if (tof < 0) {
    out.point.copy(_b);
    out.aim.copy(_rel).normalize();
    out.reason = out.reason || 'no-solution';
    out.angleOff = angleBetween(shooter, out.aim, opts.forward);
    out.angularSize = Math.atan2(targetRadius(target), Math.max(1, out.range));
    return out;
  }

  out.time = tof;
  out.point.copy(_d).multiplyScalar(tof).add(_b);
  out.aim.copy(out.point).sub(_a);
  const aimLen = out.aim.length();
  if (aimLen > 1e-6) out.aim.multiplyScalar(1 / aimLen);
  out.angleOff = angleBetween(shooter, out.aim, opts.forward);
  out.angularSize = Math.atan2(targetRadius(target), Math.max(1, out.range));
  out.inRange = out.range <= range;
  out.valid = out.reason === '';
  if (!out.valid && !out.reason) out.reason = 'unknown';
  return out;
}

function targetRadius(target) {
  if (!target || target.isVector3) return 8;
  if (typeof target.radius === 'number') return target.radius;
  return shipRadius(target);
}

function angleBetween(shooter, aim, forwardOverride) {
  const f = forwardOverride ?? shipForward(shooter, _f);
  return Math.acos(clamp(f.dot(aim), -1, 1));
}

/**
 * Convenience for the HUD: does this gun group have a shot right now?
 * Returns the *hardest* constraint that fails, so the reticle can say why.
 */
export function solutionStatus(sol, { cone = 0.09 } = {}) {
  if (!sol.valid) return sol.reason || 'no-solution';
  if (!sol.inRange) return 'out-of-range';
  if (sol.angleOff > cone) return 'off-boresight';
  return 'ok';
}

// ---------------------------------------------------------------------------
// subsystems
// ---------------------------------------------------------------------------

/**
 * Attackable subsystems on a capital ship, derived from its hardpoints.
 * Torpedo runs and "kill the turrets first" both need these.
 */
export function listSubsystems(ship) {
  if (!ship || !isCapitalShip(ship)) return [];
  const hp = ship.hardpoints ?? ship.group?.userData?.hardpoints ?? null;
  if (!hp) return [];
  const out = [];
  const engines = hp.engines ?? [];
  for (let i = 0; i < engines.length; i++) {
    out.push({ id: `engine-${i}`, label: `Engine ${i + 1}`, kind: 'engine', local: engines[i].pos, ship });
  }
  const turrets = hp.turrets ?? [];
  for (let i = 0; i < turrets.length; i++) {
    out.push({ id: `turret-${i}`, label: `Turret ${i + 1}`, kind: 'turret', local: turrets[i].pos, ship });
  }
  if (hp.cockpit) out.push({ id: 'bridge', label: 'Bridge', kind: 'bridge', local: hp.cockpit.pos, ship });
  const hangars = hp.hangars ?? [];
  for (let i = 0; i < hangars.length; i++) {
    out.push({ id: `hangar-${i}`, label: `Hangar ${i + 1}`, kind: 'hangar', local: hangars[i].pos, ship });
  }
  return out;
}

/** World-space position of a subsystem, for the pipper and for guidance. */
export function subsystemPosition(sub, out) {
  if (!sub?.ship) return out.set(0, 0, 0);
  const ship = sub.ship;
  const q = ship.body?.quaternion ?? ship.group?.quaternion;
  const p = ship.body?.position ?? ship.group?.position;
  out.copy(sub.local ?? _a.set(0, 0, 0));
  if (q) out.applyQuaternion(q);
  if (p) out.add(p);
  return out;
}

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

/**
 * Target selection over the ship list. Stateless except for the record it keeps
 * per ship, which lives on `ship.combat.targeting`.
 */
export function createTargetingComputer(engine) {
  const _p = new THREE.Vector3();
  const _tp = new THREE.Vector3();
  const _fwd = new THREE.Vector3();

  const ships = () => engine?.game?.ships ?? [];

  function recordOf(ship) {
    if (!ship) return null;
    const c = ship.combat ?? (ship.combat = {});
    return c.targeting ?? (c.targeting = { target: null, subsystem: null, subsystems: [], subIndex: -1, lastAttacker: null });
  }

  function getTarget(ship) {
    const rec = recordOf(ship);
    if (!rec) return null;
    if (rec.target && !isAlive(rec.target)) setTarget(ship, null);
    return rec.target;
  }

  function setTarget(ship, target) {
    const rec = recordOf(ship);
    if (!rec) return null;
    if (rec.target === target) return target;
    rec.target = target ?? null;
    rec.subsystem = null;
    rec.subIndex = -1;
    rec.subsystems = target ? listSubsystems(target) : [];
    // Mirror onto the ship — flight (match-speed), ai (assignment spread) and
    // the HUD all read `ship.target`.
    ship.target = rec.target;
    engine?.events?.emit('target:changed', {
      ship, target: rec.target, isPlayer: !!ship.isPlayer,
      subsystem: null,
    });
    return rec.target;
  }

  /** Candidate list: alive, not me, optionally hostiles only, inside radar. */
  function candidates(ship, { hostileOnly = true, maxRange = null } = {}) {
    const all = ships();
    const out = [];
    const radar = maxRange ?? num(ship?.stats?.radarRange, 24_000);
    shipPosition(ship, _p);
    for (let i = 0; i < all.length; i++) {
      const s = all[i];
      if (s === ship || !isAlive(s)) continue;
      if (hostileOnly && !isHostile(ship, s)) continue;
      shipPosition(s, _tp);
      if (_p.distanceTo(_tp) > radar) continue;
      out.push(s);
    }
    return out;
  }

  function nearest(ship, opts = {}) {
    const list = candidates(ship, opts);
    shipPosition(ship, _p);
    let best = null;
    let bestD = Infinity;
    for (const s of list) {
      shipPosition(s, _tp);
      const d = _p.distanceToSquared(_tp);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  /** Closest to the boresight — WC's "target what's in front of me". */
  function inReticle(ship, coneRad = 0.22) {
    const list = candidates(ship, {});
    shipPosition(ship, _p);
    shipForward(ship, _fwd);
    let best = null;
    let bestScore = Infinity;
    for (const s of list) {
      shipPosition(s, _tp).sub(_p);
      const d = _tp.length();
      if (d < 1e-3) continue;
      _tp.multiplyScalar(1 / d);
      const ang = Math.acos(clamp(_fwd.dot(_tp), -1, 1));
      if (ang > coneRad) continue;
      // Prefer near and centred; range breaks ties between two on the nose.
      const score = ang * 4000 + d * 0.05;
      if (score < bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  function attacker(ship) {
    const rec = recordOf(ship);
    const fromDamage = ship.damage?.lastAttacker ?? null;
    const cand = fromDamage ?? rec?.lastAttacker ?? null;
    return cand && isAlive(cand) && isHostile(ship, cand) ? cand : null;
  }

  /** Sorted radar list, so next/previous is stable frame to frame. */
  function sortedList(ship, hostileOnly) {
    const list = candidates(ship, { hostileOnly });
    shipPosition(ship, _p);
    list.sort((a, b) => {
      const da = shipPosition(a, _tp).distanceToSquared(_p);
      const db = shipPosition(b, _tp).distanceToSquared(_p);
      if (da !== db) return da - db;
      return (a.id ?? 0) - (b.id ?? 0);
    });
    return list;
  }

  function step(ship, dir, hostileOnly) {
    const rec = recordOf(ship);
    const list = sortedList(ship, hostileOnly);
    if (!list.length) return setTarget(ship, null);
    const i = rec.target ? list.indexOf(rec.target) : -1;
    const next = list[((i + dir) % list.length + list.length) % list.length];
    return setTarget(ship, next);
  }

  /**
   * @param {string} mode 'next' | 'prev' | 'nearest' | 'nearestEnemy' |
   *   'attacker' | 'reticle' | 'friendly' | 'capital' | 'subsystem' |
   *   'prevSubsystem' | 'clear'
   */
  function cycleTarget(ship, mode = 'next') {
    if (!ship) return null;
    const rec = recordOf(ship);
    switch (mode) {
      case 'clear': return setTarget(ship, null);
      case 'nearest':
      case 'nearestEnemy': return setTarget(ship, nearest(ship, { hostileOnly: true }));
      case 'attacker': {
        const a = attacker(ship);
        return a ? setTarget(ship, a) : rec.target;
      }
      case 'reticle': {
        const t = inReticle(ship);
        return t ? setTarget(ship, t) : rec.target;
      }
      case 'friendly': return step(ship, 1, false);
      case 'capital': {
        const caps = candidates(ship, {}).filter(isCapitalShip);
        if (!caps.length) return rec.target;
        const i = caps.indexOf(rec.target);
        return setTarget(ship, caps[(i + 1) % caps.length]);
      }
      case 'prev': return step(ship, -1, true);
      case 'subsystem':
      case 'prevSubsystem': {
        if (!rec.target) return null;
        if (!rec.subsystems.length) rec.subsystems = listSubsystems(rec.target);
        const n = rec.subsystems.length;
        if (!n) return rec.target;
        const d = mode === 'subsystem' ? 1 : -1;
        // −1 is "the hull itself", so the cycle is n+1 long.
        rec.subIndex = ((rec.subIndex + 1 + d) % (n + 1) + (n + 1)) % (n + 1) - 1;
        rec.subsystem = rec.subIndex >= 0 ? rec.subsystems[rec.subIndex] : null;
        engine?.events?.emit('target:changed', {
          ship, target: rec.target, subsystem: rec.subsystem, isPlayer: !!ship.isPlayer,
        });
        return rec.target;
      }
      case 'next':
      default: return step(ship, 1, true);
    }
  }

  /** What guidance and the pipper should actually aim at. */
  function aimPointOf(ship, out) {
    const rec = recordOf(ship);
    if (!rec?.target) return null;
    if (rec.subsystem) return subsystemPosition(rec.subsystem, out);
    return shipPosition(rec.target, out);
  }

  return {
    getTarget, setTarget, cycleTarget, aimPointOf,
    nearest, inReticle, attacker, candidates, sortedList,
    recordOf,
    subsystems: (ship) => recordOf(ship)?.subsystems ?? [],
    subsystem: (ship) => recordOf(ship)?.subsystem ?? null,
  };
}

export { isHostile, isFriendly, isCapitalShip };
