import * as THREE from 'three';
import { clamp, clamp01, clamp11, lerp, smoothRange, tauDecay } from './util.js';

/**
 * src/flight/Autopilot.js — nav-point travel with an approach/decel profile.
 *
 * The autopilot does not teleport and does not drive the transform directly: it
 * writes `body.controls`, exactly like a human or the AI system would, so the
 * ship arrives under its own flight model with its own inertia and slip. That is
 * what keeps the arrival looking like flying rather than like a cutscene.
 *
 * Profile:
 *   ALIGN   turn onto the bearing with throttle backed off
 *   CRUISE  full throttle, afterburner past `apBurnerDistance`
 *   DECEL   commanded speed follows sqrt(2·a·d) so the ship coasts in
 *   ARRIVE  inside `apArriveRadius` and slow -> disengage
 *
 * Aborts the moment a hostile comes inside `apAbortRange` — the WC "autopilot
 * disengaged, enemies in the area" moment.
 *
 * Events: autopilot:engaged · autopilot:abort · autopilot:complete · autopilot:disengaged
 */

const _dir = new THREE.Vector3();
const _local = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _tmp = new THREE.Vector3();

/** How often the hostile scan runs, in seconds (deterministic accumulator). */
const SCAN_INTERVAL = 0.25;

export function createAutopilotState(target, opts = {}) {
  return {
    target: target.clone(),
    phase: 'align',
    elapsed: 0,
    scanTimer: 0,
    throttleSmooth: 0,
    startDistance: 0,
    abortOnHostiles: opts.abortOnHostiles !== false,
    abortRange: opts.abortRange ?? null,
    arriveRadius: opts.arriveRadius ?? null,
    useBurner: opts.useBurner !== false,
  };
}

/**
 * Advance one autopilot frame. Returns a status string for the caller to relay,
 * or null if nothing notable happened.
 */
export function updateAutopilot(body, engine, dt) {
  const ap = body.autopilot;
  if (!ap) return null;

  const T = body.tuning;
  const c = body.controls;
  ap.elapsed += dt;

  // ---- abort on hostiles ------------------------------------------------
  if (ap.abortOnHostiles) {
    ap.scanTimer -= dt;
    if (ap.scanTimer <= 0) {
      ap.scanTimer = SCAN_INTERVAL;
      const range = ap.abortRange ?? T.apAbortRange;
      const threat = nearestHostile(engine, body.ship, body.position, range);
      if (threat) {
        finish(body, engine, 'abort', { threat });
        return 'abort';
      }
    }
  }

  // ---- bearing ----------------------------------------------------------
  _dir.copy(ap.target).sub(body.position);
  const dist = _dir.length();
  const arriveRadius = ap.arriveRadius ?? T.apArriveRadius;

  if (dist < 1e-3) {
    finish(body, engine, 'complete');
    return 'complete';
  }
  _dir.multiplyScalar(1 / dist);

  if (ap.startDistance === 0) ap.startDistance = dist;

  // ---- steering: convert the bearing into stick input -------------------
  _local.copy(_dir).applyQuaternion(_q.copy(body.quaternion).invert());
  const horiz = Math.hypot(_local.x, _local.z);
  //   +local.x = target to the right   ->  +yaw
  //   +local.y = target above          ->  +pitch
  const yawErr = Math.atan2(_local.x, -_local.z);
  const pitchErr = Math.atan2(_local.y, horiz);

  c.yaw = clamp11(yawErr * T.apAlignGain);
  c.pitch = clamp11(pitchErr * T.apAlignGain);

  // Keep the horizon level so the approach reads as controlled, not tumbling.
  _tmp.copy(_up).addScaledVector(body.forward, -_up.dot(body.forward));
  if (_tmp.lengthSq() > 1e-6) {
    _tmp.normalize();
    const rollErr = -Math.atan2(body.right.dot(_tmp), body.up.dot(_tmp));
    c.roll = clamp11(-rollErr * T.apLevelGain);
  } else {
    c.roll = 0;
  }

  // ---- speed profile ----------------------------------------------------
  const align = body.forward.dot(_dir);
  const decel = Math.max(1e-3, T.decel);
  // Distance needed to bleed off the current speed, plus a safety margin.
  const stopDist = ((body.speed * body.speed) / (2 * decel)) * T.apDecelMargin + arriveRadius;

  let wantThrottle;
  let wantBurner = false;

  if (align < T.apAlignForThrust && dist > arriveRadius * 3) {
    // Off the bearing: bleed speed while the nose comes round, so the ship does
    // not carve a huge arc past the nav point.
    ap.phase = 'align';
    wantThrottle = lerp(0.18, 0.55, smoothRange(align, 0.3, T.apAlignForThrust));
  } else if (dist > stopDist) {
    ap.phase = 'cruise';
    wantThrottle = 1;
    wantBurner = ap.useBurner && dist > T.apBurnerDistance && align > 0.995 && !body.burnout;
  } else {
    ap.phase = 'decel';
    // v = sqrt(2·a·d) — the classic arrival profile, floored at the arrival speed.
    const d = Math.max(0, dist - arriveRadius);
    const v = Math.sqrt(2 * (decel / T.apDecelMargin) * d);
    wantThrottle = clamp01(Math.max(v, T.apArriveSpeed) / T.maxSpeed);
  }

  // Smooth the commanded throttle so the burner and the servo do not chatter.
  const k = tauDecay(0.35, dt);
  ap.throttleSmooth = wantThrottle + (ap.throttleSmooth - wantThrottle) * k;
  c.throttle = clamp01(ap.throttleSmooth);
  c.afterburner = wantBurner;
  c.brake = 0;
  c.strafeX = 0;
  c.strafeY = 0;

  // ---- arrival ----------------------------------------------------------
  if (dist <= arriveRadius && body.speed <= Math.max(T.apArriveSpeed * 1.5, 5)) {
    c.throttle = clamp01(T.apArriveSpeed / T.maxSpeed);
    c.afterburner = false;
    finish(body, engine, 'complete');
    return 'complete';
  }

  ap.phase = ap.phase ?? 'cruise';
  return null;
}

function finish(body, engine, reason, extra = {}) {
  const ap = body.autopilot;
  const target = ap?.target?.clone?.() ?? null;
  body.autopilotDisengage(reason);
  const c = body.controls;
  c.pitch = 0; c.yaw = 0; c.roll = 0; c.afterburner = false;
  const type = reason === 'abort' ? 'autopilot:abort'
    : reason === 'complete' ? 'autopilot:complete'
      : 'autopilot:disengaged';
  engine?.events?.emit?.(type, { ship: body.ship, target, reason, ...extra });
}

/**
 * Nearest hostile inside `range`, or null. Faction hostility is delegated to the
 * game if it exposes a rule; otherwise "different faction" is hostile enough.
 */
export function nearestHostile(engine, ship, position, range) {
  const game = engine?.game;
  const ships = game?.ships;
  if (!ships || ships.length === 0) return null;
  const r2 = range * range;
  let best = null;
  let bestD = r2;
  for (let i = 0; i < ships.length; i++) {
    const other = ships[i];
    if (!other || other === ship || other.alive === false) continue;
    if (!isHostile(game, ship, other)) continue;
    const p = other.body?.position ?? other.group?.position;
    if (!p) continue;
    const d = position.distanceToSquared(p);
    if (d < bestD) { bestD = d; best = other; }
  }
  return best;
}

export function isHostile(game, a, b) {
  if (!a || !b) return false;
  if (typeof game?.isHostile === 'function') {
    try { return !!game.isHostile(a, b); } catch { /* fall through */ }
  }
  if (!a.faction || !b.faction) return false;
  return a.faction !== b.faction;
}

/**
 * Best-effort nav target for the player's autopilot key. Reads the mission
 * module through its documented surface only; returns null when mission/ has
 * not landed yet.
 * TODO(contract): agree a single `mission.getNavTarget()` with agent-mission.
 */
export function findNavTarget(engine, ship) {
  const game = engine?.game;
  const m = game?.mission;
  const candidates = [
    () => m?.getNavTarget?.(ship),
    () => m?.currentNav?.position ?? m?.currentNav,
    () => m?.navPoint?.position ?? m?.navPoint,
    () => game?.navPoint?.position ?? game?.navPoint,
  ];
  for (const fn of candidates) {
    let v = null;
    try { v = fn(); } catch { continue; }
    if (v && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number') {
      return new THREE.Vector3(v.x, v.y, v.z);
    }
  }
  return null;
}
