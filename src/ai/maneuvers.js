/**
 * src/ai/maneuvers.js — Basic Fighter Manoeuvres.
 *
 * A manoeuvre is a *committed, time-boxed intent generator*. It runs for at least
 * `min` seconds (commitment is what makes a pilot read as a person rather than a
 * gradient-follower) and at most `max` seconds, then hands control back to the
 * state machine. It writes into `ctx.intent`:
 *
 *   intent.aim         world-space unit direction to put the nose on
 *   intent.throttle    0..1
 *   intent.ab          0..1 afterburner
 *   intent.brake       0..1
 *   intent.strafeX/Y   −1..1 lateral thrusters
 *   intent.planeHint   which way to break when the aim is exactly astern
 *   intent.rollOffset  extra roll goal (π = fly it inverted)
 *   intent.tauScale    steering crispness multiplier (>1 = lazier)
 *   intent.levelWeight how hard to hold wings level when not turning
 *   intent.gunOk       may the trigger be pulled during this manoeuvre
 *   intent.label       debug string
 *
 * Selection is by *geometry*, never by dice: range, angle-off, aspect angle,
 * closure and energy state pick the manoeuvre. Personality only breaks ties and
 * gates whether a pilot knows the move at all (see personality.repertoire).
 *
 * Geometry glossary used throughout:
 *   angleOff  angle between MY nose and the line of sight to the target
 *   aspect    angle between the TARGET's nose and the line of sight back to me
 *             (0 = they are pointing right at me, π = pure tail chase)
 *   closure   +ve when the range is shrinking, m/s
 *   overtake  my speed − their speed, m/s
 */
import * as THREE from 'three';
import {
  clamp, clamp01, clamp11, lerp, smoothRange, fbm1, hash01, perpendicular, DEG,
} from './aimath.js';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _aim = new THREE.Vector3();

/** Point the nose at a world position. */
export function aimAt(ctx, point) {
  ctx.intent.aim.copy(point).sub(ctx.pos);
  const l = ctx.intent.aim.length();
  if (l < 1e-6) ctx.intent.aim.copy(ctx.fwd);
  else ctx.intent.aim.multiplyScalar(1 / l);
  return ctx.intent.aim;
}

/** Point the nose along a world direction. */
export function aimDir(ctx, dir) {
  ctx.intent.aim.copy(dir);
  const l = ctx.intent.aim.length();
  if (l < 1e-6) ctx.intent.aim.copy(ctx.fwd);
  else ctx.intent.aim.multiplyScalar(1 / l);
  return ctx.intent.aim;
}

/**
 * Rotate `from` about `axis` by `ang`, writing a unit vector into out.
 * The workhorse for every "turn N degrees out of plane" manoeuvre.
 */
function rotAbout(from, axis, ang, out) {
  out.copy(from);
  _axis.copy(axis);
  if (_axis.lengthSq() < 1e-12) return out.normalize();
  _axis.normalize();
  out.applyAxisAngle(_axis, ang);
  return out.normalize();
}

/**
 * A stable turn axis for defensive work: perpendicular to both the threat line
 * and our velocity, so the resulting turn is a maximum-rate turn *across* the
 * attacker's line of sight. Degenerates gracefully when the threat is dead ahead
 * or dead astern, using the pilot's instinctive break direction.
 */
function breakAxis(ctx, threatDir, out) {
  out.copy(threatDir).cross(ctx.fwd);
  if (out.lengthSq() < 1e-6) {
    // Threat is on the nose or the tail: pick the plane from the pilot's habit.
    perpendicular(threatDir, ctx.pilot.profile.planeHint, out);
    out.cross(threatDir);
  }
  out.normalize().multiplyScalar(ctx.pilot.profile.breakBias);
  return out;
}

/**
 * Throttle policy. Good pilots fly *energy*: they do not sit at 100% while
 * turning (it widens the turn circle) and they do not coast when they need to
 * close. `want` is a target speed fraction; the pilot's `energy` skill decides
 * how closely they honour it.
 */
function setThrottle(ctx, want, { ab = 0, brake = 0 } = {}) {
  const e = ctx.pilot.profile.energy;
  // A low-energy-discipline pilot drifts toward full throttle regardless.
  const t = lerp(clamp01(want * 0.55 + 0.45), clamp01(want), e);
  ctx.intent.throttle = t;
  ctx.intent.ab = clamp01(ab) * ctx.pilot.abAvailable;
  ctx.intent.brake = clamp01(brake);
}

/** Lead / pure / lag aim point. `bias` −1 = lag, 0 = pure, +1 = full lead. */
export function pursuitPoint(ctx, bias, out) {
  const s = ctx.sense;
  out.copy(ctx.tgtPos);
  if (bias > 0 && ctx.leadTime > 0) {
    // Lead: sit on the gun solution, scaled by how much this pilot predicts.
    _a.copy(s.tgtVel).sub(s.myVel).multiplyScalar(ctx.leadTime * bias * ctx.pilot.profile.predict);
    out.add(_a);
  } else if (bias < 0) {
    // Lag: aim behind their tail. Bleeds angles instead of overshooting, and it
    // is the single most "trained pilot" looking thing the AI does.
    const lagDist = clamp(s.range * 0.42, 90, 750) * -bias;
    _a.copy(s.tgtFwd).multiplyScalar(-lagDist);
    out.add(_a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The manoeuvre table
// ---------------------------------------------------------------------------

export const MANEUVERS = {
  // ------------------------------------------------------------ offensive
  purePursuit: {
    label: 'pure pursuit',
    min: 0.6,
    max: 4.0,
    update(ctx) {
      aimAt(ctx, pursuitPoint(ctx, 0, _c));
      const s = ctx.sense;
      const want = s.range > 1600 ? 1 : smoothRange(s.range, 240, 1400) * 0.55 + 0.45;
      setThrottle(ctx, want, { ab: s.range > 2600 ? 0.8 : 0 });
      ctx.intent.gunOk = true;
      ctx.intent.label = 'pure';
    },
  },

  leadPursuit: {
    label: 'lead pursuit',
    min: 0.5,
    max: 5.0,
    update(ctx) {
      aimAt(ctx, pursuitPoint(ctx, 1, _c));
      const s = ctx.sense;
      // Match speed once in the saddle — hosing past a target you have solved is
      // the classic rookie error, so throttle backs off with closure.
      const want = clamp01(1 - smoothRange(s.closure, 40, 260) * 0.65) * smoothRange(s.range, 160, 900) * 0.6 + 0.4;
      setThrottle(ctx, want, { ab: s.range > 2200 && s.closure < 80 ? 0.7 : 0 });
      ctx.intent.gunOk = true;
      ctx.intent.tauScale = 0.85; // crisper tracking while shooting
      ctx.intent.label = 'lead';
    },
  },

  lagPursuit: {
    label: 'lag pursuit',
    min: 0.9,
    max: 4.5,
    update(ctx) {
      aimAt(ctx, pursuitPoint(ctx, -1, _c));
      const s = ctx.sense;
      setThrottle(ctx, clamp01(0.45 + smoothRange(s.range, 300, 1500) * 0.4), { brake: s.closure > 220 ? 0.35 : 0 });
      ctx.intent.gunOk = false; // deliberately not shooting — rebuilding the angle
      ctx.intent.label = 'lag';
    },
    done(ctx) {
      // Finished when the overshoot risk is gone and we can pull back to lead.
      return ctx.sense.closure < 60 && ctx.sense.angleOff < 35 * DEG;
    },
  },

  /**
   * High yo-yo — the answer to "I am closing too fast inside his turn circle".
   * Pull out of plane, trade airspeed for position, then roll back down onto him.
   * Phase 0: climb out of plane. Phase 1: come down into lead.
   */
  highYoyo: {
    label: 'high yo-yo',
    min: 1.4,
    max: 5.0,
    enter(ctx) {
      ctx.mv.phase = 0;
      ctx.mv.data.up = new THREE.Vector3();
      // The "up" for the yo-yo is out of the fight plane, on the side the target
      // is turning toward — that is what puts us inside his circle on the way down.
      ctx.mv.data.up.copy(ctx.sense.los).cross(ctx.sense.tgtFwd);
      if (ctx.mv.data.up.lengthSq() < 1e-6) ctx.mv.data.up.copy(ctx.up);
      ctx.mv.data.up.normalize();
      if (ctx.mv.data.up.dot(ctx.up) < 0) ctx.mv.data.up.negate();
    },
    update(ctx, dt) {
      const s = ctx.sense;
      if (ctx.mv.phase === 0) {
        // Climb: aim 45–65° out of the pursuit plane and unload the throttle.
        const ang = lerp(45, 68, clamp01(s.closure / 320)) * DEG;
        rotAbout(s.los, _b.copy(s.los).cross(ctx.mv.data.up).normalize(), -ang, _aim);
        aimDir(ctx, _aim);
        setThrottle(ctx, 0.35, { brake: 0.25 });
        ctx.intent.gunOk = false;
        ctx.intent.label = 'high yo-yo ↑';
        if (s.closure < 30 || ctx.mv.t > 2.2 || s.range > 900) ctx.mv.phase = 1;
      } else {
        // Descend: back onto the lead solution with the energy we banked.
        aimAt(ctx, pursuitPoint(ctx, 1, _c));
        setThrottle(ctx, 0.85, { ab: s.range > 1100 ? 0.5 : 0 });
        ctx.intent.gunOk = true;
        ctx.intent.label = 'high yo-yo ↓';
      }
    },
    done(ctx) {
      return ctx.mv.phase === 1 && ctx.sense.angleOff < 22 * DEG && ctx.sense.range < 1100;
    },
  },

  /**
   * Low yo-yo — the opposite problem: he is far and turning, I am slow.
   * Drop the nose below the line, accelerate, and cut the corner from underneath.
   */
  lowYoyo: {
    label: 'low yo-yo',
    min: 1.2,
    max: 4.5,
    enter(ctx) {
      ctx.mv.phase = 0;
      ctx.mv.data.dn = new THREE.Vector3().copy(ctx.up).negate();
    },
    update(ctx) {
      const s = ctx.sense;
      if (ctx.mv.phase === 0) {
        rotAbout(s.los, _b.copy(s.los).cross(ctx.mv.data.dn).normalize(), -32 * DEG, _aim);
        aimDir(ctx, _aim);
        setThrottle(ctx, 1, { ab: 0.85 });
        ctx.intent.gunOk = false;
        ctx.intent.label = 'low yo-yo ↓';
        if (s.overtake > 90 || ctx.mv.t > 2.0) ctx.mv.phase = 1;
      } else {
        aimAt(ctx, pursuitPoint(ctx, 1, _c));
        setThrottle(ctx, 1, { ab: 0.4 });
        ctx.intent.gunOk = true;
        ctx.intent.label = 'low yo-yo ↑';
      }
    },
    done(ctx) {
      return ctx.mv.phase === 1 && ctx.sense.angleOff < 20 * DEG;
    },
  },

  /**
   * Head-on merge with a chicken game. Both ships are nose-to-nose; whoever
   * flinches first gives away the angles. `mergeCommit` (metres) comes straight
   * from aggression — a reckless pilot holds to 170 m and sometimes dies of it.
   */
  headOnMerge: {
    label: 'head-on merge',
    min: 0.8,
    max: 6.0,
    enter(ctx) {
      ctx.mv.phase = 0;
      ctx.mv.data.broke = false;
      ctx.ai?.radio.say(ctx.pilot, 'merge', { target: ctx.target });
    },
    update(ctx) {
      const s = ctx.sense;
      const commit = ctx.pilot.profile.mergeCommit;
      if (ctx.mv.phase === 0 && s.range > commit) {
        aimAt(ctx, pursuitPoint(ctx, 1, _c));
        setThrottle(ctx, 1, { ab: 0.3 });
        ctx.intent.gunOk = true;
        ctx.intent.tauScale = 0.8;
        ctx.intent.label = 'merge (committed)';
      } else {
        // Break out of the merge. Clean, one direction, full authority — the
        // half-hearted break is what gets pilots killed on the second pass.
        if (ctx.mv.phase === 0) ctx.mv.phase = 1;
        breakAxis(ctx, s.los, _b);
        rotAbout(ctx.fwd, _b, 78 * DEG, _aim);
        aimDir(ctx, _aim);
        setThrottle(ctx, 1, { ab: 0.9 });
        ctx.intent.gunOk = false;
        ctx.intent.label = 'merge break';
      }
    },
    done(ctx) {
      return ctx.mv.phase === 1 && ctx.sense.range > 700;
    },
  },

  // ------------------------------------------------------------ defensive
  /**
   * Break turn — the fundamental defensive move. Maximum-rate turn across the
   * attacker's line of sight to drive his angle-off past his gun envelope.
   * Nose low-ish and no afterburner: burning into a break just widens the circle
   * (rookies do it anyway, which is what `energy` models).
   */
  breakTurn: {
    label: 'break turn',
    min: 1.1,
    max: 3.6,
    enter(ctx) {
      ctx.mv.data.dir = ctx.pilot.profile.breakBias;
      ctx.mv.data.jitter = hash01(ctx.pilot.id, Math.floor(ctx.time * 3)) * 0.4;
    },
    update(ctx) {
      const th = ctx.threatDir ?? ctx.sense.los;
      breakAxis(ctx, th, _b);
      const hard = lerp(88, 112, ctx.mv.data.jitter) * DEG;
      rotAbout(th, _b, hard, _aim);
      aimDir(ctx, _aim);
      const e = ctx.pilot.profile.energy;
      setThrottle(ctx, lerp(1, 0.72, e), { ab: lerp(0.75, 0.05, e), brake: 0 });
      ctx.intent.tauScale = 0.75; // pull as hard as the airframe allows
      ctx.intent.gunOk = false;
      ctx.intent.label = 'break';
    },
  },

  /**
   * Jink — irregular evasion under fire.
   *
   * Deliberately NOT a sine wave. The driver is a random-hold process: a new
   * lateral direction every `dwell` seconds, with `dwell` drawn from a hashed
   * exponential-ish distribution, blended by a critically damped follower so the
   * transitions are snappy but not instantaneous. A slow fbm ripple rides on top.
   * The result has no period a human can lock onto.
   */
  jink: {
    label: 'jink',
    min: 0.9,
    max: 5.0,
    enter(ctx) {
      ctx.mv.data.dir = new THREE.Vector3();
      ctx.mv.data.cur = new THREE.Vector3();
      ctx.mv.data.next = 0;
      ctx.mv.data.n = 0;
    },
    update(ctx, dt) {
      const d = ctx.mv.data;
      const s = ctx.sense;
      const base = ctx.velDir.lengthSq() > 0.1 ? ctx.velDir : ctx.fwd;

      if (ctx.mv.t >= d.next) {
        d.n++;
        const u = hash01(ctx.pilot.id * 7919, d.n);
        const v = hash01(ctx.pilot.id * 104729 + 5, d.n);
        // Exponential-ish dwell: mostly short, occasionally a long hold. The long
        // holds are what make it unreadable — a player times the rhythm, then the
        // pilot simply does not turn back.
        d.next = ctx.mv.t + 0.22 - Math.log(1 - u * 0.86) * 0.34;
        const cone = lerp(38, 78, v) * DEG;
        perpendicular(base, hash01(ctx.pilot.id, d.n * 31) * Math.PI * 2, _b);
        rotAbout(base, _b, cone * (hash01(ctx.pilot.id, d.n * 17) < 0.5 ? -1 : 1), d.dir);
      }
      // Critically damped follow so the nose snaps but does not teleport.
      d.cur.lerp(d.dir.lengthSq() > 0 ? d.dir : base, 1 - Math.exp(-dt * 7));
      _aim.copy(d.cur);
      // Fine ripple on incommensurate frequencies — texture, not the signal.
      const w = fbm1(ctx.pilot.id * 13 + 991, ctx.time * 1.7) * 0.14;
      perpendicular(base, ctx.time * 2.3 + ctx.pilot.id, _c);
      _aim.addScaledVector(_c, w).normalize();
      aimDir(ctx, _aim);

      // Under fire, speed is life: unload and run.
      setThrottle(ctx, 1, { ab: s.threatRange < 900 ? 0.9 : 0.4 });
      ctx.intent.gunOk = false;
      ctx.intent.strafeX = clamp11(fbm1(ctx.pilot.id + 17, ctx.time * 2.6) * 1.4);
      ctx.intent.strafeY = clamp11(fbm1(ctx.pilot.id + 23, ctx.time * 2.2) * 1.4);
      ctx.intent.label = 'jink';
    },
  },

  /**
   * Barrel-roll defence — a helix around the velocity vector, flown with the
   * throttle back, whose only purpose is to make an attacker with high closure
   * shoot past. Ends with him in front of you.
   */
  barrelRoll: {
    label: 'barrel roll',
    min: 1.3,
    max: 3.2,
    enter(ctx) {
      ctx.mv.data.phase = hash01(ctx.pilot.id, 71) * Math.PI * 2;
      ctx.mv.data.spin = ctx.pilot.profile.breakBias * lerp(2.4, 3.6, ctx.pilot.profile.flair);
    },
    update(ctx, dt) {
      const d = ctx.mv.data;
      d.phase += d.spin * dt;
      const base = ctx.velDir.lengthSq() > 0.1 ? ctx.velDir : ctx.fwd;
      perpendicular(base, d.phase, _b);
      rotAbout(base, _b.cross(base).normalize(), 42 * DEG, _aim);
      aimDir(ctx, _aim);
      setThrottle(ctx, 0.25, { brake: 0.8 });
      ctx.intent.rollOffset = 0;
      ctx.intent.gunOk = false;
      ctx.intent.label = 'barrel roll';
    },
    done(ctx) {
      // Worked: he is in front of us now.
      return ctx.threatAngleOff !== null && ctx.threatAngleOff < 60 * DEG;
    },
  },

  /**
   * Flat scissors — a series of hard reversals in the fight plane, each one
   * trying to force the other guy out in front. Reversal is triggered by the
   * geometry (his line of sight crossing ours), not a timer.
   */
  flatScissors: {
    label: 'flat scissors',
    min: 1.6,
    max: 8.0,
    enter(ctx) {
      ctx.mv.data.dir = ctx.pilot.profile.breakBias;
      ctx.mv.data.hold = 0;
      ctx.mv.data.n = 0;
    },
    update(ctx, dt) {
      const d = ctx.mv.data;
      const s = ctx.sense;
      d.hold -= dt;
      // Reverse when he crosses our nose, or when we have held long enough that
      // holding further just gives him the angle.
      const crossed = Math.sign(ctx.lateralSign) !== 0 && Math.sign(ctx.lateralSign) !== d.dir;
      if (d.hold <= 0 && (crossed || ctx.mv.t > 1.2 + d.n * 0.2)) {
        d.dir = -d.dir;
        d.n++;
        d.hold = lerp(0.55, 1.1, hash01(ctx.pilot.id, d.n));
      }
      _b.copy(s.los).cross(ctx.fwd);
      if (_b.lengthSq() < 1e-6) _b.copy(ctx.up);
      _b.normalize().multiplyScalar(d.dir);
      rotAbout(ctx.fwd, _b, 62 * DEG, _aim);
      aimDir(ctx, _aim);
      setThrottle(ctx, 0.45, { brake: 0.4 });
      ctx.intent.gunOk = s.angleOff < 25 * DEG && s.range < 900;
      ctx.intent.label = `scissors ×${d.n}`;
    },
  },

  /**
   * Rolling scissors — the vertical version. Both aircraft describe interlocking
   * helices; the winner is whoever bleeds speed better. Only aces attempt it.
   */
  rollingScissors: {
    label: 'rolling scissors',
    min: 2.0,
    max: 9.0,
    enter(ctx) {
      ctx.mv.data.phase = 0;
      ctx.mv.data.spin = ctx.pilot.profile.breakBias * 1.9;
    },
    update(ctx, dt) {
      const d = ctx.mv.data;
      const s = ctx.sense;
      // Precess the helix around the mean line between the two fighters.
      _a.copy(s.los).add(ctx.fwd).normalize();
      d.phase += d.spin * dt * lerp(0.7, 1.25, ctx.pilot.profile.flair);
      perpendicular(_a, d.phase, _b);
      rotAbout(_a, _b.cross(_a).normalize(), 55 * DEG, _aim);
      aimDir(ctx, _aim);
      setThrottle(ctx, 0.35, { brake: 0.55 });
      ctx.intent.gunOk = s.angleOff < 20 * DEG && s.range < 700;
      ctx.intent.label = 'rolling scissors';
    },
  },

  /** Immelmann — pull up through the vertical and reverse. */
  immelmann: {
    label: 'Immelmann',
    min: 1.4,
    max: 4.0,
    enter(ctx) {
      ctx.mv.data.goal = new THREE.Vector3().copy(ctx.fwd).negate();
      // If we have a target, reverse *onto him* rather than onto nothing.
      if (ctx.target) ctx.mv.data.goal.copy(ctx.sense.los);
    },
    update(ctx) {
      aimDir(ctx, ctx.mv.data.goal);
      ctx.intent.planeHint = 0; // pull up through the top
      setThrottle(ctx, 0.9, { ab: 0.25 });
      ctx.intent.tauScale = 0.8;
      ctx.intent.gunOk = false;
      ctx.intent.label = 'Immelmann';
    },
    done(ctx) {
      return ctx.fwd.dot(ctx.mv.data.goal) > 0.9;
    },
  },

  /** Split-S — roll inverted and pull down through. Faster, costs you position. */
  splitS: {
    label: 'split-S',
    min: 1.2,
    max: 3.6,
    enter(ctx) {
      ctx.mv.data.goal = new THREE.Vector3();
      if (ctx.target) ctx.mv.data.goal.copy(ctx.sense.los);
      else ctx.mv.data.goal.copy(ctx.fwd).negate();
    },
    update(ctx) {
      aimDir(ctx, ctx.mv.data.goal);
      ctx.intent.planeHint = Math.PI; // through the bottom, inverted
      ctx.intent.rollOffset = Math.PI;
      setThrottle(ctx, 1, { ab: 0.5 });
      ctx.intent.tauScale = 0.78;
      ctx.intent.gunOk = false;
      ctx.intent.label = 'split-S';
    },
    done(ctx) {
      return ctx.fwd.dot(ctx.mv.data.goal) > 0.9;
    },
  },

  /**
   * Missile break — beam the missile (turn perpendicular to its line so its
   * seeker sees minimum closure and its lead solution has to work hardest),
   * dump countermeasures at the right moment, and burn out of the basket.
   */
  missileBreak: {
    label: 'missile break',
    min: 0.6,
    max: 9.0,
    enter(ctx) {
      ctx.mv.data.popped = false;
      ctx.ai?.radio.say(ctx.pilot, 'missileInbound', {});
    },
    update(ctx) {
      const m = ctx.pilot.incoming;
      if (!m) {
        aimDir(ctx, ctx.fwd);
        setThrottle(ctx, 1, { ab: 0.6 });
        ctx.intent.label = 'missile break (clear)';
        return;
      }
      // Beam it: perpendicular to the missile's line of sight, biased slightly
      // away so we are also extending.
      _a.copy(m.dir).negate(); // from missile to us, i.e. our escape half-space
      breakAxis(ctx, m.dir, _b);
      rotAbout(m.dir, _b, 96 * DEG, _aim);
      // Good pilots also pull out of the missile's plane rather than turning flat.
      rotAbout(_aim, m.dir, ctx.pilot.profile.missileSkill * 0.5 * ctx.pilot.profile.breakBias, _aim);
      aimDir(ctx, _aim);
      setThrottle(ctx, 1, { ab: 1 });
      ctx.intent.tauScale = 0.72;
      ctx.intent.gunOk = false;
      ctx.intent.label = `missile break (${m.tti.toFixed(1)}s)`;

      // Decoys: too early and the seeker reacquires, too late and it does not
      // matter. Skill decides how close to the ideal window they get.
      const ideal = lerp(2.6, 1.25, ctx.pilot.profile.missileSkill);
      if (!ctx.mv.data.popped && m.tti < ideal && m.tti > 0) {
        ctx.mv.data.popped = true;
        ctx.pilot.wantDecoy = true;
      }
    },
    done(ctx) {
      return !ctx.pilot.incoming;
    },
  },

  /** Extend — straight-line separation with mild irregular jinks. */
  extend: {
    label: 'extend',
    min: 1.5,
    max: 8.0,
    update(ctx) {
      const th = ctx.threatDir ?? (ctx.target ? ctx.sense.los : null);
      if (th) _aim.copy(th).negate();
      else _aim.copy(ctx.fwd);
      // Never a perfectly straight line — that is a free gun solution.
      const w = fbm1(ctx.pilot.id + 401, ctx.time * 0.8) * 0.22;
      perpendicular(_aim, ctx.time * 0.9 + ctx.pilot.id, _c);
      _aim.addScaledVector(_c, w).normalize();
      aimDir(ctx, _aim);
      setThrottle(ctx, 1, { ab: 1 });
      ctx.intent.gunOk = false;
      ctx.intent.label = 'extend';
    },
    done(ctx) {
      return ctx.sense.threatRange > 2800;
    },
  },

  /** Run for it. Same as extend but committed, and no coming back. */
  flee: {
    label: 'flee',
    min: 3,
    max: 60,
    update(ctx) {
      const th = ctx.threatDir ?? (ctx.target ? ctx.sense.los : null);
      if (th) _aim.copy(th).negate();
      else _aim.copy(ctx.fwd);
      if (ctx.pilot.homeVec) _aim.lerp(ctx.pilot.homeVec, 0.4).normalize();
      const w = fbm1(ctx.pilot.id + 887, ctx.time * 1.1) * 0.3;
      perpendicular(_aim, ctx.time * 1.4 + ctx.pilot.id, _c);
      _aim.addScaledVector(_c, w).normalize();
      aimDir(ctx, _aim);
      setThrottle(ctx, 1, { ab: 1 });
      ctx.intent.gunOk = false;
      ctx.intent.label = 'fleeing';
    },
  },

  // ------------------------------------------------------------ vs capitals
  /**
   * Capital strafing run. Fighters do not dogfight a cruiser — they run in on a
   * chosen aspect, hold the trigger through the pass, and break hard at minimum
   * range before the point-defence solution matures. Then they set up again from
   * a different vector.
   */
  capitalRun: {
    label: 'strafing run',
    min: 2.0,
    max: 14.0,
    enter(ctx) {
      ctx.mv.phase = 0;
      // Choose an offset aim point on the hull so a flight of four does not all
      // fly the same line.
      const k = ctx.pilot.id * 2.399963;
      ctx.mv.data.off = new THREE.Vector3(Math.cos(k), Math.sin(k * 1.7) * 0.4, Math.sin(k))
        .normalize()
        .multiplyScalar(lerp(40, 160, hash01(ctx.pilot.id, 313)));
      ctx.ai?.radio.say(ctx.pilot, 'capitalRun', { target: ctx.target });
    },
    update(ctx) {
      const s = ctx.sense;
      const breakAt = lerp(520, 260, ctx.pilot.profile.aggression);
      if (ctx.mv.phase === 0) {
        _c.copy(ctx.tgtPos).add(ctx.mv.data.off);
        aimAt(ctx, _c);
        setThrottle(ctx, 1, { ab: s.range > 2500 ? 0.8 : 0.2 });
        ctx.intent.gunOk = s.range < 2000;
        ctx.intent.label = 'strafe run';
        if (s.range < breakAt) ctx.mv.phase = 1;
      } else {
        breakAxis(ctx, s.los, _b);
        rotAbout(s.los, _b, 120 * DEG, _aim);
        aimDir(ctx, _aim);
        setThrottle(ctx, 1, { ab: 1 });
        ctx.intent.gunOk = false;
        ctx.intent.label = 'strafe break';
        if (s.range > 2600) {
          ctx.mv.phase = 0;
          const k = ctx.pilot.id * 2.399963 + ctx.mv.t;
          ctx.mv.data.off.set(Math.cos(k), Math.sin(k * 1.7) * 0.4, Math.sin(k)).normalize().multiplyScalar(120);
        }
      }
    },
  },

  // ------------------------------------------------------------ non-combat
  /** Loiter: a lazy, slowly-precessing turn. Nothing in space flies dead straight. */
  patrolTurn: {
    label: 'patrol',
    min: 2.0,
    max: 12.0,
    update(ctx) {
      const p = ctx.pilot;
      if (p.waypoint) {
        aimAt(ctx, p.waypoint);
        setThrottle(ctx, 0.72);
      } else {
        const t = ctx.time * 0.06 + p.id * 1.7;
        _aim.set(Math.cos(t), Math.sin(t * 0.41) * 0.22, Math.sin(t)).normalize();
        aimDir(ctx, _aim);
        setThrottle(ctx, 0.55);
      }
      ctx.intent.gunOk = false;
      ctx.intent.levelWeight = 0.9;
      ctx.intent.label = 'patrol';
    },
  },

  /** Formation station keeping — the actual maths lives in formations.js. */
  formate: {
    label: 'formate',
    min: 0.3,
    max: 60,
    update(ctx, dt) {
      ctx.ai?.formations.stationKeep(ctx, dt);
      ctx.intent.gunOk = false;
      ctx.intent.label = 'formate';
    },
  },

  /** A short showboat after a kill. Pure personality; only flair pilots do it. */
  victoryRoll: {
    label: 'victory roll',
    min: 1.0,
    max: 2.2,
    update(ctx) {
      aimDir(ctx, ctx.fwd);
      ctx.intent.rollOffset = ctx.time * 4.5 * ctx.pilot.profile.breakBias;
      ctx.intent.levelWeight = 0;
      setThrottle(ctx, 0.8, { ab: 0.3 });
      ctx.intent.gunOk = false;
      ctx.intent.label = 'victory roll';
    },
  },
};

// ---------------------------------------------------------------------------
// Geometry-driven selection
// ---------------------------------------------------------------------------

/** Can this pilot fly it at all? */
export function knows(pilot, id) {
  return pilot.profile.repertoire.has(id);
}

/** First known manoeuvre from a preference list; falls back to the last entry. */
function firstKnown(pilot, list, fallback) {
  for (const id of list) if (knows(pilot, id)) return id;
  return fallback;
}

/**
 * Offensive manoeuvre selection — the "what does a real pilot do here" table.
 *
 *   overshooting (fast + close + wide)      → high yo-yo, else lag
 *   inside the saddle (close + on the nose) → lead pursuit (shoot)
 *   nose-on to each other                   → head-on merge
 *   far and slow                            → low yo-yo / pure pursuit
 *   he is behind the 3/9 line               → reversal (Immelmann or split-S)
 */
export function pickOffensive(pilot, s) {
  const p = pilot.profile;

  // Reversal: target is behind our wing line and far enough that a flat turn
  // would take forever.
  if (s.angleOff > 125 * DEG && s.range > 550) {
    // Split-S is quicker but costs energy; Immelmann keeps it. Energy decides.
    const fast = s.mySpeed > s.cornerSpeed * 1.05;
    return firstKnown(pilot, fast ? ['splitS', 'immelmann'] : ['immelmann', 'splitS'], 'purePursuit');
  }

  // High-aspect merge: both pointing at each other, closing hard.
  if (s.aspect < 38 * DEG && s.angleOff < 32 * DEG && s.closure > 120 && s.range > 260) {
    return knows(pilot, 'headOnMerge') ? 'headOnMerge' : 'leadPursuit';
  }

  // Overshoot risk: closing fast from inside his turn circle.
  const overshootRisk = s.closure > lerp(150, 260, p.patience) && s.range < 900;
  if (overshootRisk) {
    if (s.angleOff > 26 * DEG && knows(pilot, 'highYoyo')) return 'highYoyo';
    if (knows(pilot, 'lagPursuit')) return 'lagPursuit';
    return 'purePursuit';
  }

  // Slow and far, he is turning: cut the corner from below.
  if (s.range > 1400 && s.overtake < 40 && s.tgtTurn > 0.25 && knows(pilot, 'lowYoyo')) return 'lowYoyo';

  // In the saddle.
  if (s.angleOff < 34 * DEG) return knows(pilot, 'leadPursuit') ? 'leadPursuit' : 'purePursuit';

  // Wide angle at close range with low closure: this is a turning fight.
  if (s.range < 700 && s.angleOff > 55 * DEG) {
    if (knows(pilot, 'rollingScissors') && p.flair > 0.5 && s.aspect > 100 * DEG) return 'rollingScissors';
    if (knows(pilot, 'flatScissors')) return 'flatScissors';
  }

  return knows(pilot, 'leadPursuit') ? 'leadPursuit' : 'purePursuit';
}

/**
 * Defensive manoeuvre selection.
 *
 *   missile inbound                → missile break (always wins)
 *   attacker close with high closure → barrel roll to force the overshoot
 *   attacker in the gun envelope   → break turn
 *   attacker overshot, now in front → scissors
 *   attacker far                   → extend
 */
export function pickDefensive(pilot, s) {
  const p = pilot.profile;
  if (pilot.incoming && knows(pilot, 'missileBreak')) return 'missileBreak';

  const tr = s.threatRange;
  const tc = s.threatClosure;

  if (tr < 480 && tc > 160 && knows(pilot, 'barrelRoll') && p.flair > 0.35) return 'barrelRoll';
  if (s.threatAngleOff !== null && s.threatAngleOff < 55 * DEG && tr < 1200) {
    // He overshot and is out in front of us — this is now a scissors, not a run.
    if (knows(pilot, 'flatScissors') && tr < 800) return 'flatScissors';
  }
  if (tr < 1500) return knows(pilot, 'breakTurn') ? 'breakTurn' : 'jink';
  if (tr < 2600) return 'jink';
  return knows(pilot, 'extend') ? 'extend' : 'jink';
}
