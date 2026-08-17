/**
 * src/ai/aimath.js — the maths every pilot runs on.
 *
 * Three responsibilities:
 *   1. Scalar/vector helpers (self-contained; this module deliberately does not
 *      import from other agents' directories so it loads before they exist).
 *   2. `solveSteering()` — the single steering law that turns "point the nose
 *      there" into normalised pitch/yaw/roll stick commands. Every manoeuvre in
 *      the game is expressed as an aim direction plus a few modifiers, so all the
 *      flying character lives in one auditable place.
 *   3. Ballistics — the intercept solver shared by AI gunnery and (contractually)
 *      the player's ITTS.
 *
 * Determinism: nothing here calls Math.random(). Noise is hash-based, so a pilot
 * seeded with the same number flies the same fight every time (ARCHITECTURE §1.3).
 *
 * Body frame convention (three.js standard): +X right, +Y up, −Z forward.
 * Control convention: +pitch = nose up, +yaw = nose right, +roll = roll right
 * (right wing down). If `flight` disagrees it can publish
 * `engine.game.flight.controlSigns = { pitch, yaw, roll }` and AISystem flips.
 */
import * as THREE from 'three';

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const TWO_PI = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const clamp11 = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);

/** Finite-or-fallback. Used on every value that leaves this module. */
export const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

export function smoothstep(t) {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** Remap v from [a,b] to a smoothed [0,1]. */
export function smoothRange(v, a, b) {
  if (b === a) return v >= b ? 1 : 0;
  return smoothstep((v - a) / (b - a));
}

/** Wrap an angle into (−π, π]. */
export function wrapPi(a) {
  let x = a % TWO_PI;
  if (x > Math.PI) x -= TWO_PI;
  else if (x <= -Math.PI) x += TWO_PI;
  return x;
}

/** Frame-rate independent exponential approach. */
export function expApproach(cur, target, tau, dt) {
  if (!(tau > 0)) return target;
  const k = 1 - Math.exp(-dt / tau);
  return cur + (target - cur) * k;
}

// ---------------------------------------------------------------- hash noise

/** 32-bit integer hash → [0,1). Deterministic, no state. */
export function hash01(a, b = 0) {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smoothed 1-D value noise in [−1,1]. */
export function noise1(seed, x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash01(seed, i) * 2 - 1;
  const b = hash01(seed, i + 1) * 2 - 1;
  return a + (b - a) * u;
}

/**
 * Three-octave noise on deliberately incommensurate frequencies. The ratios
 * (1 : 2.137 : 4.618) never line up, so the output has no audible period — which
 * is the entire point for jink and aim wander. A sine wave, or octaves at exact
 * powers of two, is readable by a human player within about two seconds.
 */
export function fbm1(seed, x) {
  return (
    noise1(seed, x) * 0.62 +
    noise1(seed + 7919, x * 2.137 + 11.3) * 0.27 +
    noise1(seed + 104729, x * 4.618 + 3.7) * 0.11
  );
}

// ------------------------------------------------------------------ vectors

const _q = new THREE.Quaternion();

/** World direction → body frame. `out` is returned. */
export function toLocal(quat, worldVec, out) {
  out.copy(worldVec);
  _q.copy(quat).conjugate();
  out.applyQuaternion(_q);
  return out;
}

/** Body direction → world. `out` is returned. */
export function toWorld(quat, localVec, out) {
  return out.copy(localVec).applyQuaternion(quat);
}

const _fwd = new THREE.Vector3();
/** Ship forward (−Z) in world space. */
export function forwardOf(quat, out) {
  return out.set(0, 0, -1).applyQuaternion(quat);
}
export function upOf(quat, out) {
  return out.set(0, 1, 0).applyQuaternion(quat);
}
export function rightOf(quat, out) {
  return out.set(1, 0, 0).applyQuaternion(quat);
}

/** Angle between two (not necessarily normalised) vectors, in radians. */
export function angleBetween(a, b) {
  const la = a.length();
  const lb = b.length();
  if (la < 1e-9 || lb < 1e-9) return 0;
  return Math.acos(clamp(a.dot(b) / (la * lb), -1, 1));
}

/**
 * Closure rate: positive when the gap is shrinking.
 * `rel` = target − me, `relVel` = targetVel − myVel.
 */
export function closureRate(rel, relVel) {
  const d = rel.length();
  if (d < 1e-6) return 0;
  return -rel.dot(relVel) / d;
}

// -------------------------------------------------------------- steering law

const _aimL = new THREE.Vector3();
const _upL = new THREE.Vector3();

/**
 * The one steering law.
 *
 * Everything reduces to: how far off the nose is the aim point (`angleOff`), and
 * in which direction around the nose does it sit (`phi`, 0 = straight up,
 * +π/2 = right). From that:
 *
 *   roll  drives φ → 0 so the target sits in the pull plane   (bank-to-turn)
 *   pitch pulls by angleOff·cos φ                             (the actual turn)
 *   yaw   nudges by angleOff·sin φ, de-authorised while banking (flat yaw)
 *
 * Pitch/yaw alone always reduce angleOff, so convergence never depends on the
 * roll gimmick — roll only makes the turn *efficient and good-looking*. That
 * property is what keeps the self-test's convergence assertion honest.
 *
 * Anti-overshoot is a phase-lead on the error (`leadTime`), not a rate term read
 * from the flight body, so this works no matter which frame `angularVelocity`
 * happens to be expressed in.
 *
 * @param {{pe:number,ye:number,re:number,init:boolean}} mem per-pilot memory
 * @returns {{pitch:number,yaw:number,roll:number,angleOff:number,phi:number}}
 */
export function solveSteering(mem, quat, aimDir, cfg, dt) {
  const {
    pitchRate = 1.4,
    yawRate = 1.1,
    rollRate = 2.6,
    tau = 0.32, // how many seconds we want to null the error in
    rollTau = 0.30,
    leadTime = 0.11, // phase-lead horizon; kills the classic PID wobble
    planeHint = 0, // which way to break when the aim is exactly astern
    rollOffset = 0, // extra roll goal (π = fly it inverted)
    bankLo = 0.13, // rad: below this, no bank-to-turn — fine tracking only
    bankHi = 0.62, // rad: above this, full bank-and-yank
    levelRef = null, // optional world "up" to hold wings level against
    levelWeight = 0.5,
    yawBleed = 0.72, // how much flat yaw is given up while banking
    authority = 1,
  } = cfg;

  toLocal(quat, aimDir, _aimL);
  const len = _aimL.length();
  if (len < 1e-9) return { pitch: 0, yaw: 0, roll: 0, angleOff: 0, phi: 0 };
  _aimL.multiplyScalar(1 / len);

  let lx = _aimL.x;
  let ly = _aimL.y;
  const lz = _aimL.z;
  const angleOff = Math.acos(clamp(-lz, -1, 1));

  // Aim exactly on (or exactly opposite) the nose leaves φ undefined. Fall back
  // to the pilot's chosen break plane so a tail-chase reversal still commits to
  // a direction instead of dithering about the singularity.
  if (Math.hypot(lx, ly) < 2e-3) {
    lx = Math.sin(planeHint) * 1e-2;
    ly = Math.cos(planeHint) * 1e-2;
  }
  const phi = Math.atan2(lx, ly);

  const bank = smoothRange(angleOff, bankLo, bankHi);

  let pitchErr = angleOff * Math.cos(phi);
  let yawErr = angleOff * Math.sin(phi);
  let rollErr = wrapPi(phi + rollOffset);

  // Wings-level bias when we are not really turning. Space has no horizon, but
  // WC pilots fly the ecliptic and a squadron that never rolls upright reads as
  // debris tumbling rather than aircraft.
  if (levelRef && bank < 0.999) {
    toLocal(quat, levelRef, _upL);
    const levelErr = Math.atan2(_upL.x, _upL.y);
    rollErr = lerp(levelErr * levelWeight, rollErr, bank);
  }

  const idt = dt > 1e-6 ? 1 / dt : 0;
  const dPitch = mem.init ? clamp((pitchErr - mem.pe) * idt, -20, 20) : 0;
  const dYaw = mem.init ? clamp((yawErr - mem.ye) * idt, -20, 20) : 0;
  const dRoll = mem.init ? clamp(wrapPi(rollErr - mem.re) * idt, -30, 30) : 0;
  mem.pe = pitchErr;
  mem.ye = yawErr;
  mem.re = rollErr;
  mem.init = true;

  pitchErr += dPitch * leadTime;
  yawErr += dYaw * leadTime;
  rollErr += dRoll * leadTime * 0.8;

  const a = clamp01(authority);
  const pitch = clamp11((pitchErr / Math.max(1e-3, pitchRate * tau)) * a);
  const yaw = clamp11((yawErr / Math.max(1e-3, yawRate * tau)) * a * (1 - yawBleed * bank));
  const roll = clamp11((rollErr / Math.max(1e-3, rollRate * rollTau)) * a);

  return {
    pitch: num(pitch),
    yaw: num(yaw),
    roll: num(roll),
    angleOff: num(angleOff),
    phi: num(phi),
  };
}

// --------------------------------------------------------------- ballistics

/**
 * Time for a projectile of speed `s` (fired from a moving shooter, inheriting
 * its velocity) to reach a target moving at constant velocity.
 *
 * Solves |rel + relV·t| = s·t. Returns −1 when no positive solution exists —
 * i.e. the target is running away faster than we can shoot, and a pilot should
 * hold fire rather than spray.
 */
export function interceptTime(rel, relVel, s) {
  const a = relVel.lengthSq() - s * s;
  const b = 2 * rel.dot(relVel);
  const c = rel.lengthSq();
  if (Math.abs(a) < 1e-6) {
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

const _rel = new THREE.Vector3();
const _relV = new THREE.Vector3();

/**
 * Gun lead point. This is the same solution the cockpit ITTS pipper should use —
 * if the two ever disagree, the player will feel it as "the AI cheats".
 * Returns the time of flight, or −1 when there is no firing solution.
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

// ------------------------------------------------------------ misc geometry

const _perpA = new THREE.Vector3();
const _perpB = new THREE.Vector3();

/**
 * A unit vector perpendicular to `axis`, rotated by `roll` about it. Used for
 * break turns (perpendicular to a missile's line) and barrel-roll defence.
 */
export function perpendicular(axis, roll, out) {
  _perpA.copy(axis).normalize();
  // Pick the world axis least aligned with `axis` so the cross never degenerates.
  const ax = Math.abs(_perpA.x);
  const ay = Math.abs(_perpA.y);
  const az = Math.abs(_perpA.z);
  if (ax <= ay && ax <= az) _perpB.set(1, 0, 0);
  else if (ay <= az) _perpB.set(0, 1, 0);
  else _perpB.set(0, 0, 1);
  const u = out.copy(_perpB).cross(_perpA).normalize();
  _perpB.copy(_perpA).cross(u); // v = axis × u, completing the basis
  const c = Math.cos(roll);
  const s = Math.sin(roll);
  return out.set(u.x * c + _perpB.x * s, u.y * c + _perpB.y * s, u.z * c + _perpB.z * s).normalize();
}

/** True when every component of every listed vector/number is finite. */
export function allFinite(...vals) {
  for (const v of vals) {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return false;
    } else if (v && typeof v === 'object' && 'x' in v) {
      if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) return false;
    }
  }
  return true;
}
