/**
 * src/ai/gunnery.js — the firing solution, and the deliberate imperfection.
 *
 * Two halves:
 *
 * 1. **The solution.** Exactly the same intercept maths the cockpit ITTS pipper
 *    uses (`aimath.leadPoint`). If the AI's lead and the player's pipper ever
 *    disagree, the player experiences it as cheating, so both go through one
 *    function.
 *
 * 2. **The imperfection.** This is the part that decides whether enemies feel
 *    like pilots. Rules:
 *      - Error is a *slowly varying* angular offset (fbm over ~1 s), never
 *        per-frame jitter. Per-frame jitter reads as camera shake and makes
 *        tracers scintillate; slow wander reads as a human whose pipper is
 *        drifting off and being corrected.
 *      - Error grows with range, with the target's instantaneous turn rate, and
 *        with the shooter's own G loading. A veteran tracking a hard-manoeuvring
 *        bandit at 1.5 km should miss most of the burst.
 *      - Trigger discipline: bursts, gaps, a minimum range, a maximum plausible
 *        cone, no firing through a friendly, and a reaction latency before the
 *        first round leaves the barrel.
 */
import * as THREE from 'three';
import {
  clamp, clamp01, lerp, smoothRange, fbm1, hash01, leadPoint, perpendicular, DEG,
} from './aimath.js';
import { isFriendly, isCapital } from './threat.js';

const _lead = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _off = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _rel = new THREE.Vector3();

/** Muzzle velocity for this ship's primaries, however ships/ chooses to say it. */
export function gunSpeed(ship) {
  const s = ship?.stats;
  return (
    s?.gunSpeed ??
    s?.projectileSpeed ??
    s?.guns?.speed ??
    ship?.hardpoints?.guns?.[0]?.speed ??
    1400
  );
}

/** Practical gun range — beyond ~1.4 s time of flight nobody hits anything. */
export function gunRange(ship) {
  const s = ship?.stats;
  return clamp(s?.gunRange ?? gunSpeed(ship) * 1.4, 700, 3000);
}

/**
 * Compute the firing solution and decide whether to pull the trigger.
 * Writes `pilot.firing`, `pilot.aimPoint`, `pilot.solutionAngle`.
 */
export function updateGunnery(pilot, ctx, ai, dt) {
  const g = pilot.gun;
  const target = pilot.target;
  const me = ctx.body;

  g.cool -= dt;

  if (!target || target.alive === false || !me || !ctx.intent.gunOk) {
    releaseTrigger(pilot, dt);
    pilot.solutionAngle = Math.PI;
    return;
  }

  const tb = ai.bodyOf(target);
  if (!tb) {
    releaseTrigger(pilot, dt);
    return;
  }

  const speed = gunSpeed(pilot.ship);
  const range = ctx.sense.range;
  const maxR = gunRange(pilot.ship);
  const minR = pilot.profile.gunRangeMin;

  // --- the honest solution -------------------------------------------------
  const tof = leadPoint(ctx.pos, ctx.vel, tb.position, tb.velocity ?? _tmp.set(0, 0, 0), speed, _lead);
  ctx.leadTime = tof > 0 ? tof : 0;
  if (tof < 0) {
    // No solution exists — they are outrunning the shells. A good pilot knows.
    releaseTrigger(pilot, dt);
    pilot.aimPoint = null;
    pilot.solutionAngle = Math.PI;
    return;
  }

  // --- the human error -----------------------------------------------------
  // Amplitude: base skill × range × how hard the target is manoeuvring × my own G.
  const p = pilot.profile;
  const rangeMul = lerp(0.55, 2.4, smoothRange(range, 200, maxR));
  const targetMul = 1 + clamp01(ctx.sense.tgtTurn / 1.2) * lerp(2.2, 0.7, p.predict);
  const selfMul = 1 + clamp01(pilot.gLoad) * 0.9;
  const amp = p.aimError * rangeMul * targetMul * selfMul;

  // Slow 2-D wander. Two independent fbm channels on incommensurate rates give a
  // drifting pipper; the correlation time is `aimTau`, which is the whole trick.
  const t = ctx.time / Math.max(0.15, p.aimTau);
  const ex = fbm1(pilot.seed | 0, t) * amp;
  const ey = fbm1((pilot.seed | 0) + 7331, t * 0.83 + 4.1) * amp;

  _aim.copy(_lead).sub(ctx.pos);
  const dist = Math.max(1, _aim.length());
  _aim.multiplyScalar(1 / dist);
  perpendicular(_aim, 0, _off);
  _lead.addScaledVector(_off, ex * dist);
  perpendicular(_aim, Math.PI / 2, _off);
  _lead.addScaledVector(_off, ey * dist);

  pilot.aimPoint = pilot.aimPoint ?? new THREE.Vector3();
  pilot.aimPoint.copy(_lead);

  // --- trigger discipline --------------------------------------------------
  _aim.copy(_lead).sub(ctx.pos).normalize();
  const cone = Math.acos(clamp(ctx.fwd.dot(_aim), -1, 1));
  pilot.solutionAngle = cone;

  const cap = isCapital(target);
  const inRange = range < maxR * (cap ? 1.25 : 1) && range > (cap ? 90 : minR);
  const inCone = cone < p.fireCone * (cap ? 2.4 : 1);

  // Reaction latency: the solution has to have been good for `reaction` seconds
  // before the finger moves. This is why an ace snaps onto a crossing target and
  // a rookie is always a beat late.
  if (inRange && inCone) g.good += dt;
  else g.good = 0;

  const wantFire = g.good > p.reaction * lerp(1.1, 0.55, p.aggression);

  if (wantFire && !blockedByFriendly(pilot, ctx, ai, _aim, range)) {
    holdTrigger(pilot, dt, ctx);
  } else {
    releaseTrigger(pilot, dt);
  }

  updateMissiles(pilot, ctx, ai, dt);
}

/** Burst / gap state machine. */
function holdTrigger(pilot, dt, ctx) {
  const g = pilot.gun;
  const p = pilot.profile;
  if (g.firing) {
    g.t += dt;
    if (g.t >= g.burstLen) {
      g.firing = false;
      g.t = 0;
      g.gapLen = lerp(p.gap[0], p.gap[1], hash01(pilot.seed | 0, g.n * 13 + 3));
      g.n++;
    }
  } else {
    g.t += dt;
    if (g.t >= g.gapLen) {
      g.firing = true;
      g.t = 0;
      g.burstLen = lerp(p.burst[0], p.burst[1], hash01(pilot.seed | 0, g.n * 17 + 5));
      // Reckless pilots hold the trigger longer than they should.
      g.burstLen *= lerp(1, 1.7, 1 - p.discipline);
    }
  }
  pilot.firing = g.firing;
}

function releaseTrigger(pilot, dt) {
  const g = pilot.gun;
  if (g.firing) {
    g.firing = false;
    g.t = 0;
    g.gapLen = 0.25;
  } else {
    g.t += dt;
  }
  pilot.firing = false;
}

/**
 * Never shoot through a friendly. Checks any friendly closer than the target
 * whose bearing is inside the gun line. Cheap: only runs when we already want
 * to fire.
 */
function blockedByFriendly(pilot, ctx, ai, aimDir, targetRange) {
  const ships = ai.contacts;
  for (let i = 0; i < ships.length; i++) {
    const s = ships[i];
    if (s === pilot.ship || s.alive === false) continue;
    if (!isFriendly(pilot.ship, s)) continue;
    const b = ai.bodyOf(s);
    if (!b) continue;
    _rel.copy(b.position).sub(ctx.pos);
    const d = _rel.length();
    if (d > targetRange || d < 1e-3) continue;
    _rel.multiplyScalar(1 / d);
    // Angular size of a fighter at range d, plus a safety pad.
    const halfWidth = Math.atan2(28, d) + 0.02;
    if (Math.acos(clamp(aimDir.dot(_rel), -1, 1)) < halfWidth) return true;
  }
  return false;
}

/**
 * Missile employment. Missiles are scarce and a wasted one is worse than no
 * shot, so: decent aspect, inside the envelope, a lock held for a while, not
 * already two birds in the air at the same target, and a per-pilot cooldown that
 * scales with skill.
 */
function updateMissiles(pilot, ctx, ai, dt) {
  const m = pilot.missile;
  m.cool -= dt;
  const target = pilot.target;
  if (!target || target.alive === false) {
    m.lock = 0;
    return;
  }
  const s = ctx.sense;
  const cap = isCapital(target);
  const envelope = s.range > 600 && s.range < (cap ? 6000 : 3600) && s.angleOff < 18 * DEG;
  if (!envelope) {
    m.lock = Math.max(0, m.lock - dt * 2);
    return;
  }
  m.lock += dt;
  pilot.missileLock = m.lock;

  const need = lerp(2.6, 1.1, pilot.profile.missileSkill);
  if (m.lock < need || m.cool > 0 || m.count <= 0) return;

  // Do not double up unless it is a capital ship.
  if (!cap && (ai.missileTargets.get(target) ?? 0) >= 1) return;

  const combat = ai.engine.game?.combat;
  let fired = false;
  if (combat?.fireMissile) {
    try {
      fired = combat.fireMissile(pilot.ship, target) !== false;
    } catch {
      fired = false;
    }
  } else {
    // combat/ has not landed yet: announce intent so the event contract is
    // exercised and the UI/audio agents have something to build against.
    ai.engine.events?.emit('missile:launched', {
      shooter: pilot.ship,
      target,
      position: ctx.pos.clone(),
      byAI: true,
    });
    fired = true;
  }

  if (fired) {
    m.count--;
    m.cool = lerp(9, 4, pilot.profile.aggression);
    m.lock = 0;
    ai.missileTargets.set(target, (ai.missileTargets.get(target) ?? 0) + 1);
    ai.radio.say(pilot, 'missileLaunch', { target });
  }
}

/** Fresh per-pilot gunnery state. */
export function makeGunState(profile, seed) {
  return {
    firing: false,
    t: 0,
    n: 0,
    good: 0,
    cool: 0,
    burstLen: lerp(profile.burst[0], profile.burst[1], hash01(seed, 1)),
    gapLen: lerp(profile.gap[0], profile.gap[1], hash01(seed, 2)),
  };
}

export function makeMissileState(ship) {
  return {
    lock: 0,
    cool: 3,
    count: ship?.stats?.missiles ?? ship?.hardpoints?.missiles?.length ?? 4,
  };
}
