/**
 * src/ai/behaviors.js — the pilot's hierarchical state machine.
 *
 * ## Why an HSM and not a behaviour tree
 *
 * A behaviour tree re-evaluates from the root every tick. That is exactly wrong
 * for air combat, where the interesting quality is *commitment*: a pilot who
 * starts a gun run finishes it, eats the overshoot, and pays for the mistake. To
 * get that out of a BT you end up bolting on latches, cooldowns and blackboard
 * flags until you have written a state machine badly. So: an explicit HSM, with
 * commitment as a first-class concept at two levels.
 *
 *   Level 1  STATE      — intent, lasts seconds to tens of seconds
 *   Level 2  MANOEUVRE  — a committed BFM script, lasts 0.5–9 s (maneuvers.js)
 *
 * States are grouped, and the group boundary is where hysteresis gets expensive:
 *
 *   idle      patrol · formUp · regroup
 *   offense   pursue · attackRun · dogfight · strafeCapital · taunt
 *   defense   evade · breakOff · defend · flee
 *
 * Three anti-thrash mechanisms, all measured by __selftest.mjs:
 *   1. `minDwell` — a state cannot be left before it has had its say, unless the
 *      candidate transition is flagged urgent (missile, mortal damage, orders).
 *   2. `confirm` — a candidate must stay the best choice for 0.18 s within a
 *      group, 0.5 s across groups, before it takes over.
 *   3. dead-banded geometry — every range/angle test that selects a state uses a
 *      different threshold depending on the state we are already in, so a target
 *      hovering at 1500 m cannot flip pursue/attackRun at frame rate.
 */
import * as THREE from 'three';
import { clamp, clamp01, lerp, DEG, smoothRange } from './aimath.js';
import { MANEUVERS, pickOffensive, pickDefensive, knows } from './maneuvers.js';

export const GROUPS = { idle: 'idle', offense: 'offense', defense: 'defense' };

/**
 * State table. `update` chooses a manoeuvre for the current geometry; the
 * manoeuvre does the flying.
 */
export const STATES = {
  // ------------------------------------------------------------------ idle
  patrol: {
    group: 'idle',
    minDwell: 1.6,
    update(ctx, dt) {
      applyManeuver(ctx, dt, 'patrolTurn');
    },
  },

  formUp: {
    group: 'idle',
    minDwell: 1.0,
    enter(ctx) {
      ctx.ai?.radio.say(ctx.pilot, 'formUp', {});
    },
    update(ctx, dt) {
      applyManeuver(ctx, dt, 'formate');
    },
  },

  regroup: {
    group: 'idle',
    minDwell: 2.0,
    update(ctx, dt) {
      // Head back toward the element leader (or the mission anchor) at speed,
      // then hand over to formUp once we are in the neighbourhood.
      const anchor = ctx.pilot.leader?.ship ?? null;
      if (anchor && ctx.ai) {
        applyManeuver(ctx, dt, 'formate');
      } else {
        applyManeuver(ctx, dt, 'patrolTurn');
      }
      ctx.intent.label = 'regroup';
    },
  },

  // --------------------------------------------------------------- offense
  pursue: {
    group: 'offense',
    minDwell: 1.2,
    enter(ctx) {
      ctx.ai?.radio.say(ctx.pilot, 'engage', { target: ctx.target });
    },
    update(ctx, dt) {
      applyManeuver(ctx, dt, pickOffensive(ctx.pilot, ctx.sense));
    },
  },

  attackRun: {
    group: 'offense',
    minDwell: 1.8,
    enter(ctx) {
      ctx.ai?.radio.say(ctx.pilot, 'attackRun', { target: ctx.target });
    },
    update(ctx, dt) {
      applyManeuver(ctx, dt, pickOffensive(ctx.pilot, ctx.sense));
    },
  },

  dogfight: {
    group: 'offense',
    minDwell: 1.5,
    update(ctx, dt) {
      applyManeuver(ctx, dt, pickOffensive(ctx.pilot, ctx.sense));
    },
  },

  strafeCapital: {
    group: 'offense',
    minDwell: 2.5,
    update(ctx, dt) {
      applyManeuver(ctx, dt, 'capitalRun');
    },
  },

  taunt: {
    group: 'offense',
    minDwell: 1.2,
    enter(ctx) {
      ctx.ai?.radio.say(ctx.pilot, ctx.pilot.alienVoice ? 'tauntAlien' : 'taunt', { target: ctx.target });
    },
    update(ctx, dt) {
      applyManeuver(ctx, dt, 'victoryRoll');
    },
  },

  // --------------------------------------------------------------- defense
  evade: {
    group: 'defense',
    minDwell: 1.2,
    enter(ctx) {
      const p = ctx.pilot;
      // Calling for help is a *decision*: disciplined pilots do it early,
      // aggressive ones would rather die than admit it.
      if (p.profile.discipline > 0.35 || p.hullFrac < 0.5) {
        if (ctx.ai?.radio.say(p, 'help', {})) ctx.ai.squadronOf(p)?.requestHelp(p, ctx.time);
      } else {
        ctx.ai?.radio.say(p, 'hit', {});
      }
    },
    update(ctx, dt) {
      const want = pickDefensive(ctx.pilot, ctx.sense);
      applyManeuver(ctx, dt, want, ctx.pilot.incoming ? 'missileBreak' : null);
    },
  },

  breakOff: {
    group: 'defense',
    minDwell: 2.0,
    enter(ctx) {
      ctx.ai?.radio.say(ctx.pilot, 'breakOff', {});
    },
    update(ctx, dt) {
      applyManeuver(ctx, dt, 'extend');
    },
  },

  defend: {
    group: 'defense',
    minDwell: 1.5,
    enter(ctx) {
      ctx.ai?.radio.say(ctx.pilot, 'onMyWay', { wingman: ctx.pilot.protecting?.ship });
    },
    update(ctx, dt) {
      // Same offensive repertoire, but the target was chosen for us: whoever is
      // shooting our friend. Mutual support is just retargeting with urgency.
      applyManeuver(ctx, dt, ctx.target ? pickOffensive(ctx.pilot, ctx.sense) : 'patrolTurn');
      ctx.intent.label = `defend ${ctx.intent.label}`;
    },
  },

  flee: {
    group: 'defense',
    minDwell: 4.0,
    enter(ctx) {
      ctx.ai?.radio.say(ctx.pilot, 'flee', {});
    },
    update(ctx, dt) {
      applyManeuver(ctx, dt, ctx.pilot.incoming ? 'missileBreak' : 'flee');
    },
  },
};

export const STATE_IDS = Object.keys(STATES);

// ---------------------------------------------------------------------------
// Manoeuvre commitment
// ---------------------------------------------------------------------------

/**
 * Run the manoeuvre layer. `wantId` is what the geometry currently suggests;
 * `forceId` bypasses the commitment window (used for missile defence, where
 * "I am mid-yo-yo" is not an acceptable excuse).
 */
export function applyManeuver(ctx, dt, wantId, forceId = null) {
  const mv = ctx.mv;
  const cur = MANEUVERS[mv.id];
  let next = null;

  if (forceId && forceId !== mv.id) {
    next = forceId;
  } else if (!cur) {
    next = wantId;
  } else {
    const min = cur.min ?? 0.5;
    const max = cur.max ?? 5;
    const finished = mv.t >= max || (mv.t >= min && cur.done?.(ctx) === true);
    if (finished) next = wantId;
    else if (mv.t >= min && wantId !== mv.id) next = wantId;
  }

  if (next && MANEUVERS[next]) {
    if (next !== mv.id || mv.t >= (cur?.max ?? 5)) {
      mv.prev = mv.id;
      mv.id = next;
      mv.t = 0;
      mv.phase = 0;
      mv.data = {};
      mv.switches++;
      MANEUVERS[next].enter?.(ctx);
    }
  }

  const run = MANEUVERS[mv.id];
  if (run) run.update(ctx, dt);
  mv.t += dt;
  return mv.id;
}

// ---------------------------------------------------------------------------
// Transition logic
// ---------------------------------------------------------------------------

/**
 * Which state does the world say this pilot should be in?
 *
 * Returns `{ state, urgent }`. Order is a strict priority cascade: survival, then
 * orders, then mutual support, then the offensive picture, then housekeeping.
 * Every geometric test is dead-banded against the *current* state.
 */
export function desiredState(pilot, ctx) {
  const s = ctx.sense;
  const p = pilot.profile;
  const cur = pilot.state;
  const inState = (x) => cur === x;

  // --- 1. survival -------------------------------------------------------
  // Mortally hurt and someone is on us: leave. `nerve` sets the threshold, so a
  // reckless pilot fights to 5% hull and a cautious one bugs out at 55%.
  if (pilot.hullFrac <= p.fleeHull && (s.threatRange < 3500 || pilot.incoming)) {
    return { state: 'flee', urgent: true };
  }
  if (inState('flee')) {
    // Only stop running once genuinely clear — no dithering at the edge.
    if (s.threatRange > 5000 && !pilot.incoming) return { state: 'regroup', urgent: false };
    return { state: 'flee', urgent: false };
  }

  if (pilot.incoming) return { state: 'evade', urgent: true };

  // --- 2. player / mission orders ---------------------------------------
  if (pilot.order?.state) {
    // An order can be refused while defensive — that refusal is voiced in wingmen.js.
    const defensiveNow = s.threatRange < 900 && s.threatAspect < 40 * DEG;
    if (!(defensiveNow && pilot.order.yieldsToDanger)) {
      return { state: pilot.order.state, urgent: pilot.order.urgent === true };
    }
  }

  // --- 3. am I being shot at? -------------------------------------------
  // Reaction latency is real: `underAttackFor` must exceed the pilot's reaction
  // before they respond at all. This is why rookies eat the first burst.
  const beingTracked =
    pilot.underAttackFor > p.evadeDelay &&
    s.threatRange < (inState('evade') ? 2400 : 1600) &&
    s.threatAspect < (inState('evade') ? 55 * DEG : 34 * DEG);
  if (beingTracked) {
    // Aggressive pilots will trade — if their own solution is good they keep
    // shooting instead of breaking. That is a genuine, visible personality tell.
    const tradeable = s.angleOff < 22 * DEG && s.range < 1000 && p.aggression > 0.75 && pilot.hullFrac > 0.55;
    if (!tradeable) return { state: 'evade', urgent: pilot.underAttackFor > p.evadeDelay * 2.2 };
  }
  if (inState('evade')) {
    // Stay defensive until the threat has been off us for a beat.
    if (pilot.threatClearFor < 0.6 + p.evadeDelay) return { state: 'evade', urgent: false };
  }

  // --- 4. mutual support -------------------------------------------------
  // `protecting` is another *pilot* (possibly the player's virtual pilot).
  if (pilot.protecting?.ship && pilot.protecting.ship.alive !== false) {
    if (pilot.protectUntil > ctx.time && pilot.target) return { state: 'defend', urgent: false };
  }

  // --- 5. offensive picture ---------------------------------------------
  if (pilot.target && pilot.target.alive !== false) {
    if (s.targetIsCapital) return { state: 'strafeCapital', urgent: false };

    // Bad geometry for long enough: reset the fight instead of grinding.
    const stuck = pilot.offensiveFor > lerp(9, 20, p.patience) && s.angleOff > 70 * DEG && s.range < 900;
    const tooClose = s.range < p.breakOffRange && s.closure > 120;
    if (!inState('breakOff') && (stuck || tooClose)) return { state: 'breakOff', urgent: false };
    if (inState('breakOff') && s.range < 2200) return { state: 'breakOff', urgent: false };

    const closeBand = inState('dogfight') ? 1250 : 900;
    const runBand = inState('attackRun') ? 1900 : 1500;

    if (s.range < closeBand && (s.angleOff > 55 * DEG || s.aspect < 70 * DEG)) {
      return { state: 'dogfight', urgent: false };
    }
    if (s.range < runBand && s.angleOff < 60 * DEG) {
      return { state: 'attackRun', urgent: false };
    }
    return { state: 'pursue', urgent: false };
  }

  // --- 6. nothing to shoot ----------------------------------------------
  if (pilot.pendingTaunt && p.flair > 0.5) {
    pilot.pendingTaunt = false;
    return { state: 'taunt', urgent: false };
  }
  if (pilot.leader && pilot.leader.ship?.alive !== false) return { state: 'formUp', urgent: false };
  if (pilot.wasEngaged && ctx.time - pilot.lastCombatTime < 12) return { state: 'regroup', urgent: false };
  return { state: 'patrol', urgent: false };
}

const CONFIRM_SAME_GROUP = 0.18;
const CONFIRM_CROSS_GROUP = 0.5;

/**
 * Advance the state machine. Returns true when the state actually changed.
 * `pilot.transitions` counts changes so the self-test can assert on thrash.
 */
export function stepStateMachine(pilot, ctx, dt) {
  pilot.stateTime += dt;

  const want = desiredState(pilot, ctx);
  const curDef = STATES[pilot.state] ?? STATES.patrol;

  if (want.state === pilot.state) {
    pilot.pending = null;
    pilot.pendingT = 0;
    return false;
  }

  const nextDef = STATES[want.state];
  if (!nextDef) return false;

  const crossGroup = nextDef.group !== curDef.group;
  const confirmNeeded = crossGroup ? CONFIRM_CROSS_GROUP : CONFIRM_SAME_GROUP;

  if (pilot.pending === want.state) pilot.pendingT += dt;
  else {
    pilot.pending = want.state;
    pilot.pendingT = 0;
  }

  const dwellOk = pilot.stateTime >= (curDef.minDwell ?? 1) || (want.urgent && pilot.stateTime >= 0.25);
  const confirmOk = want.urgent || pilot.pendingT >= confirmNeeded;
  if (!dwellOk || !confirmOk) return false;

  return setState(pilot, want.state, ctx);
}

/** Force a state change (used by orders and by the machine above). */
export function setState(pilot, id, ctx) {
  if (!STATES[id] || pilot.state === id) return false;
  STATES[pilot.state]?.exit?.(ctx);
  pilot.prevState = pilot.state;
  pilot.state = id;
  pilot.stateTime = 0;
  pilot.pending = null;
  pilot.pendingT = 0;
  pilot.transitions++;
  // A new state gets a fresh manoeuvre slate; commitment does not leak across.
  pilot.mv.id = null;
  pilot.mv.t = 0;
  pilot.mv.data = {};
  STATES[id].enter?.(ctx);
  return true;
}

/** Run the current state's controller. */
export function runState(pilot, ctx, dt) {
  const def = STATES[pilot.state] ?? STATES.patrol;
  def.update(ctx, dt);
}

export function groupOf(stateId) {
  return STATES[stateId]?.group ?? 'idle';
}
