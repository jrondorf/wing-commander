/**
 * src/ai/threat.js — who is dangerous, and who am I shooting at.
 *
 * Target assignment is the difference between a squadron and a mob. The scoring
 * below deliberately makes a target *less* attractive the more friendlies are
 * already on it, so a flight of six spreads across the enemy formation instead
 * of forming a conga line behind one unlucky fighter. __selftest.mjs asserts
 * that spread numerically.
 *
 * Threat assessment is separate from targeting: the pilot I am shooting at and
 * the pilot who is shooting *me* are usually different aircraft, and mixing the
 * two is why naive AI never breaks off.
 */
import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothRange, DEG } from './aimath.js';

const _d = new THREE.Vector3();
const _f = new THREE.Vector3();

/** Factions that fight each other. Anything unlisted is hostile to `confed`. */
const ALLIES = {
  confed: new Set(['confed', 'militia', 'civilian', 'terran']),
  militia: new Set(['confed', 'militia', 'civilian', 'terran']),
  civilian: new Set(['confed', 'militia', 'civilian', 'terran']),
  terran: new Set(['confed', 'militia', 'civilian', 'terran']),
  nephilim: new Set(['nephilim', 'alien', 'bug']),
  alien: new Set(['nephilim', 'alien', 'bug']),
  kilrathi: new Set(['kilrathi']),
  pirate: new Set(['pirate']),
  neutral: new Set(),
};

export function isHostile(a, b) {
  if (!a || !b || a === b) return false;
  const fa = a.faction ?? 'confed';
  const fb = b.faction ?? 'confed';
  if (fa === 'neutral' || fb === 'neutral') return false;
  const set = ALLIES[fa];
  if (set) return !set.has(fb);
  return fa !== fb;
}

export function isFriendly(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return !isHostile(a, b);
}

const CAPITAL_HINTS = /carrier|cruiser|destroyer|corvette|frigate|dreadnought|station|transport|capital|cap_/i;

/** Capitals are attacked, not dogfought. Detected from whatever ships/ exposes. */
export function isCapital(ship) {
  if (!ship) return false;
  if (typeof ship.isCapital === 'boolean') return ship.isCapital;
  const s = ship.stats;
  if (s) {
    if (typeof s.isCapital === 'boolean') return s.isCapital;
    if (typeof s.mass === 'number' && s.mass > 60_000) return true;
    if (typeof s.length === 'number' && s.length > 120) return true;
  }
  if ((ship.hardpoints?.turrets?.length ?? 0) >= 4) return true;
  return CAPITAL_HINTS.test(ship.classId ?? '');
}

/** How wrecked is it? 1 = pristine. Tolerant of whatever combat/ ends up using. */
export function hullFraction(ship) {
  if (!ship) return 1;
  if (typeof ship.hullFrac === 'number') return clamp01(ship.hullFrac);
  if (typeof ship.hull === 'number') {
    const max = ship.maxHull ?? ship.stats?.hull ?? ship.stats?.armor?.f;
    if (typeof max === 'number' && max > 0) return clamp01(ship.hull / max);
    if (ship.hull <= 1) return clamp01(ship.hull);
  }
  if (typeof ship.health === 'number') {
    const max = ship.maxHealth ?? 100;
    return clamp01(ship.health / max);
  }
  return 1;
}

/**
 * Rebuild the "how many friendlies are already on this target" table. Called
 * once per frame before any pilot re-targets — cheap (one pass over pilots) and
 * it is what keeps assignment honest.
 */
export function rebuildAssignments(ai) {
  ai.assign.clear();
  for (const p of ai.pilots) {
    if (!p.target || p.ship?.alive === false) continue;
    ai.assign.set(p.target, (ai.assign.get(p.target) ?? 0) + 1);
  }
  // The player counts too: nobody should pile onto the target the player has
  // clearly committed to unless it is a capital ship.
  const pl = ai.engine.game?.player;
  if (pl?.target) ai.assign.set(pl.target, (ai.assign.get(pl.target) ?? 0) + 1);
}

/**
 * Score a candidate target for `pilot`. Higher is better. The weights are the
 * tactical doctrine of the whole game, so they are written out longhand.
 */
export function scoreTarget(pilot, cand, ai) {
  const me = ai.bodyOf(pilot.ship);
  const tb = ai.bodyOf(cand);
  if (!me || !tb) return -Infinity;

  const p = pilot.profile;
  _d.copy(tb.position).sub(me.position);
  const range = _d.length();
  if (range > p.engageRange * (isCapital(cand) ? 2.2 : 1)) return -Infinity;
  if (range > 1e-4) _d.multiplyScalar(1 / range);

  let score = 0;

  // Proximity — the dominant term. A bandit 500 m away is the problem.
  score += (1 - smoothRange(range, 250, p.engageRange)) * 100;

  // Angle-off: something already near my nose is cheap to kill.
  _f.set(0, 0, -1).applyQuaternion(me.quaternion);
  const angleOff = Math.acos(clamp(_f.dot(_d), -1, 1));
  score += (1 - smoothRange(angleOff, 15 * DEG, 130 * DEG)) * 38;

  // Aspect: if they are pointing at me, they are a threat as well as a target.
  const tf = ai.forwardOfShip(cand);
  const aspect = tf ? Math.acos(clamp(-tf.dot(_d), -1, 1)) : Math.PI / 2;
  score += (1 - smoothRange(aspect, 20 * DEG, 100 * DEG)) * 26;

  // They are actively shooting me or my leader — deal with it.
  if (pilot.threat === cand) score += 70;
  if (pilot.leader && ai.pilotOf(cand)?.target === pilot.leader.ship) score += 44;
  if (pilot.protecting && ai.pilotOf(cand)?.target === pilot.protecting.ship) score += 130;

  // Finish the wounded. Predatory, and it makes fights resolve.
  const hull = hullFraction(cand);
  score += (1 - hull) * 30 * lerp(0.4, 1.4, p.aggression);

  // Mission priority (mission/ sets ship.priority; the player is worth chasing).
  score += (cand.priority ?? 0) * 35;
  if (cand.isPlayer) score += lerp(10, 55, p.aggression);

  // Capitals: valuable but a different job. Only worth it if we are equipped or
  // ordered; otherwise fighters first.
  if (isCapital(cand)) {
    score += pilot.antiCapital ? 60 : -55;
    score -= 25;
  }

  // Spread: heavy penalty per friendly already committed. Two on a fighter is
  // a fighting pair; three is a queue.
  const taken = ai.assign.get(cand) ?? 0;
  const cap = isCapital(cand) ? 8 : 2;
  const extra = Math.max(0, taken - (pilot.target === cand ? 1 : 0));
  score -= extra * 58;
  if (extra >= cap) score -= 240;

  // Stickiness: changing targets mid-fight throws away all the angles you built.
  if (pilot.target === cand) score += lerp(18, 46, p.discipline);

  return score;
}

/**
 * Pick a target. Returns the chosen ship (possibly the current one).
 * Requires a clear margin to switch, which is the targeting-level hysteresis.
 */
export function selectTarget(pilot, ai) {
  const ships = ai.contacts;
  let best = null;
  let bestScore = -Infinity;

  for (let i = 0; i < ships.length; i++) {
    const s = ships[i];
    if (s === pilot.ship || s.alive === false) continue;
    if (!isHostile(pilot.ship, s)) continue;
    const sc = scoreTarget(pilot, s, ai);
    if (sc > bestScore) {
      bestScore = sc;
      best = s;
    }
  }

  if (!best) return null;
  if (pilot.target && pilot.target.alive !== false && best !== pilot.target) {
    const curScore = scoreTarget(pilot, pilot.target, ai);
    if (bestScore < curScore + 20) return pilot.target;
  }
  return best;
}

/**
 * Threat assessment: who is on me right now.
 *
 * Signals, in order of reliability:
 *   1. Someone actually damaged me in the last few seconds (from `weapon:hit`).
 *   2. An AI pilot whose declared target is me.
 *   3. Geometry — a hostile inside 2 km with their nose within 30° of me.
 *
 * `underAttackFor` is the integrator the state machine reads; it rises while
 * threatened and decays when clear, which is a second layer of hysteresis on the
 * most flip-prone decision in the game.
 */
export function updateThreat(pilot, ai, dt) {
  const me = ai.bodyOf(pilot.ship);
  if (!me) return;

  let best = null;
  let bestScore = 0;
  const ships = ai.contacts;

  for (let i = 0; i < ships.length; i++) {
    const s = ships[i];
    if (s === pilot.ship || s.alive === false) continue;
    if (!isHostile(pilot.ship, s)) continue;
    const sb = ai.bodyOf(s);
    if (!sb) continue;

    _d.copy(me.position).sub(sb.position);
    const range = _d.length();
    if (range > 4000) continue;
    if (range > 1e-4) _d.multiplyScalar(1 / range);

    const sf = ai.forwardOfShip(s);
    const aspect = sf ? Math.acos(clamp(sf.dot(_d), -1, 1)) : Math.PI;

    let sc = (1 - smoothRange(range, 200, 3500)) * 55 + (1 - smoothRange(aspect, 10 * DEG, 70 * DEG)) * 55;
    const op = ai.pilotOf(s);
    if (op?.target === pilot.ship) sc += 60;
    if (s.isPlayer && aspect < 40 * DEG) sc += 40;
    if (pilot.lastAttacker === s && ai.time - pilot.lastHitTime < 4) sc += 110;
    if (op?.firing && aspect < 25 * DEG) sc += 45;
    if (sc > bestScore) {
      bestScore = sc;
      best = s;
    }
  }

  pilot.threat = best;
  pilot.threatScore = bestScore;

  // Integrate "am I under attack". Rise fast, fall slow.
  const tb = best ? ai.bodyOf(best) : null;
  let pressed = false;
  if (tb) {
    _d.copy(me.position).sub(tb.position);
    const range = _d.length();
    if (range > 1e-4) _d.multiplyScalar(1 / range);
    const sf = ai.forwardOfShip(best);
    const aspect = sf ? Math.acos(clamp(sf.dot(_d), -1, 1)) : Math.PI;
    pressed = range < 1800 && aspect < 30 * DEG;
  }
  if (ai.time - pilot.lastHitTime < 1.6) pressed = true;

  if (pressed) {
    pilot.underAttackFor += dt;
    pilot.threatClearFor = 0;
  } else {
    pilot.threatClearFor += dt;
    pilot.underAttackFor = Math.max(0, pilot.underAttackFor - dt * 0.55);
  }
}
