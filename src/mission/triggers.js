/**
 * src/mission/triggers.js — the condition evaluator and the trigger machine.
 *
 * Two design decisions worth stating, because both were deliberate:
 *
 * 1. **Triggers poll, they do not subscribe.** Every `on:` clause is a predicate
 *    evaluated once per mission tick against a small context interface. An event
 *    bus would be more fashionable and much worse here: a mission that misses one
 *    `ship:destroyed` because a listener attached a frame late is a mission that
 *    deadlocks in front of the player, with nothing in the log. Polling a pure
 *    predicate cannot miss an edge — the world either satisfies the condition or
 *    it does not, and it keeps being asked.
 *
 * 2. **The evaluator knows nothing about the game.** It reads a `ctx` object of
 *    ~15 accessor functions that `MissionSystem.js` implements. That is what lets
 *    `__selftest.mjs` drive the entire trigger graph of every hand-authored
 *    mission with synthetic state, headless, in milliseconds.
 *
 * Chaining: `after: 'otherTrigger'` arms a trigger only once the named one has
 * fired. `delay: n` starts a clock when `on` first goes true and fires n seconds
 * later — re-checking `if` at that moment, so a delayed reinforcement wave can be
 * cancelled by the player killing the ship that would have called it in.
 * `once: false` makes a trigger repeatable; it then fires on the rising edge of
 * `on`, or every `cooldown` seconds while `on` stays true.
 */

const isArr = Array.isArray;
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * Evaluate a condition object against the mission context.
 * An object is the AND of its keys; unknown keys are ignored (so a typo makes a
 * condition *weaker*, never accidentally true — the validator catches the typo).
 */
export function evalCond(cond, ctx) {
  if (cond == null) return true;
  if (typeof cond === 'boolean') return cond;
  if (typeof cond === 'function') return !!cond(ctx);
  if (isArr(cond)) return cond.every((c) => evalCond(c, ctx));
  if (typeof cond !== 'object') return false;

  let sawKey = false;
  const need = (v) => { sawKey = true; return v; };

  // --- boolean algebra ----------------------------------------------------
  if ('any' in cond && !need(isArr(cond.any) ? cond.any.some((c) => evalCond(c, ctx)) : false)) return false;
  if ('all' in cond && !need(isArr(cond.all) ? cond.all.every((c) => evalCond(c, ctx)) : false)) return false;
  if ('not' in cond && !need(!evalCond(cond.not, ctx))) return false;

  // --- trivial ------------------------------------------------------------
  if ('always' in cond && !need(cond.always !== false)) return false;
  if ('start' in cond && !need(cond.start !== false)) return false;
  if ('never' in cond) return false;

  // --- clock --------------------------------------------------------------
  if ('time' in cond && !need(ctx.elapsed() >= num(cond.time))) return false;
  if ('elapsed' in cond) {
    const e = ctx.elapsed();
    const w = cond.elapsed;
    if (typeof w === 'number') { if (!need(e >= w)) return false; }
    else {
      if (w.gte !== undefined && !need(e >= w.gte)) return false;
      if (w.lte !== undefined && !need(e <= w.lte)) return false;
      if (w.gt !== undefined && !need(e > w.gt)) return false;
      if (w.lt !== undefined && !need(e < w.lt)) return false;
    }
  }

  // --- navigation ---------------------------------------------------------
  if ('nav' in cond && !need(ctx.navVisited(cond.nav))) return false;
  if ('navVisited' in cond && !need(ctx.navVisited(cond.navVisited))) return false;
  if ('navActive' in cond && !need(ctx.activeNavId() === cond.navActive)) return false;
  if ('navIndexGte' in cond && !need(ctx.navIndex() >= num(cond.navIndexGte))) return false;
  if ('allNavsVisited' in cond && !need(ctx.allNavsVisited() === (cond.allNavsVisited !== false))) return false;

  // --- spawn groups -------------------------------------------------------
  if ('spawned' in cond && !need(ctx.groupSpawned(cond.spawned))) return false;
  if ('groupDestroyed' in cond) {
    const g = cond.groupDestroyed;
    if (!need(ctx.groupSpawned(g) && ctx.groupAlive(g) === 0)) return false;
  }
  if ('groupAlive' in cond) {
    const q = typeof cond.groupAlive === 'string' ? { group: cond.groupAlive, gte: 1 } : cond.groupAlive;
    const n = ctx.groupAlive(q.group);
    if (q.gte !== undefined && !need(n >= q.gte)) return false;
    if (q.lte !== undefined && !need(n <= q.lte)) return false;
    if (q.eq !== undefined && !need(n === q.eq)) return false;
    if (q.gte === undefined && q.lte === undefined && q.eq === undefined && !need(n >= 1)) return false;
  }

  // --- individual ships ---------------------------------------------------
  if ('alive' in cond && !need(ctx.tagAlive(cond.alive))) return false;
  if ('destroyed' in cond && !need(ctx.tagDestroyed(cond.destroyed))) return false;
  if ('hullBelow' in cond) {
    const q = cond.hullBelow;
    const tag = typeof q === 'string' ? q : q.ship;
    const frac = typeof q === 'string' ? 0.5 : num(q.frac, 0.5);
    if (!need(ctx.tagHull(tag) < frac)) return false;
  }
  if ('playerHullBelow' in cond && !need(ctx.playerHull() < num(cond.playerHullBelow, 0.5))) return false;
  if ('playerKillsGte' in cond && !need(ctx.playerKills() >= num(cond.playerKillsGte))) return false;
  if ('killsGte' in cond && !need(ctx.kills() >= num(cond.killsGte))) return false;
  if ('within' in cond) {
    const q = cond.within;
    const d = ctx.distance(q.of ?? 'player', q.to);
    if (!need(d !== null && d <= num(q.range, 2000))) return false;
  }

  // --- objectives ---------------------------------------------------------
  if ('objective' in cond) {
    const q = typeof cond.objective === 'string' ? { id: cond.objective, state: 'complete' } : cond.objective;
    const st = ctx.objectiveState(q.id);
    const want = q.state ?? cond.state ?? 'complete';
    const ok = isArr(want) ? want.includes(st) : st === want;
    if (!need(ok)) return false;
  }
  if ('objectivesComplete' in cond && !need(ctx.objectivesComplete(cond.objectivesComplete))) return false;
  if ('objectivesFailed' in cond && !need(ctx.objectivesFailed(cond.objectivesFailed))) return false;

  // --- designer flags -----------------------------------------------------
  if ('flag' in cond && !need(!!ctx.flag(cond.flag))) return false;
  if ('notFlag' in cond && !need(!ctx.flag(cond.notFlag))) return false;

  // An object with no keys the evaluator understands is a designer error; the
  // validator warns about it, and here it reads as false rather than as "true
  // by vacuous AND", which would silently fire every trigger in the mission.
  return sawKey;
}

// ---------------------------------------------------------------------------
// the machine
// ---------------------------------------------------------------------------

export class TriggerMachine {
  /**
   * @param {Array<object>} defs normalized trigger definitions
   * @param {object} ctx the mission context (see MissionSystem.js `makeContext`)
   */
  constructor(defs, ctx) {
    this.ctx = ctx;
    this.states = defs.map((def) => ({
      def,
      id: def.id,
      armed: def.armed,
      fired: 0,
      firedAt: -1,
      /** Wall time at which a delayed trigger becomes due, or -1. */
      due: -1,
      lastOn: false,
    }));
    this.byId = new Map(this.states.map((s) => [s.id, s]));
    /** Firing log — the self-test asserts against it and `?diag` prints it. */
    this.log = [];
  }

  get(id) { return this.byId.get(id) ?? null; }
  hasFired(id) { return (this.byId.get(id)?.fired ?? 0) > 0; }

  arm(id, on = true) {
    const s = this.byId.get(id);
    if (s) { s.armed = on; if (!on) s.due = -1; }
  }

  /** Advance the graph one tick. Returns the actions to run, in fire order. */
  update(dt, run) {
    const ctx = this.ctx;
    const now = ctx.elapsed();
    for (const s of this.states) {
      const def = s.def;
      if (!s.armed) continue;
      if (def.once && s.fired > 0) continue;
      // Chained: every named predecessor must have fired.
      if (def.after.length && !def.after.every((a) => this.hasFired(a))) { s.due = -1; continue; }

      const on = evalCond(def.on, ctx);
      const rising = on && !s.lastOn;
      s.lastOn = on;
      if (!on) { s.due = -1; continue; }

      // A repeating trigger is edge-triggered, plus an optional cooldown.
      // Without this, `once: false` on a standing condition fires sixty times a
      // second and buries the radio under one line repeated forever.
      if (!def.once && s.fired > 0) {
        const cooled = def.cooldown > 0 && (now - s.firedAt) >= def.cooldown;
        if (!rising && !cooled) continue;
      }

      if (def.delay > 0) {
        if (s.due < 0) { s.due = now + def.delay; continue; }
        if (now < s.due) continue;
      }
      if (!evalCond(def.if, ctx)) continue;

      s.fired++;
      s.firedAt = now;
      s.due = -1;
      this.log.push({ id: s.id, t: +now.toFixed(2) });
      run(def, s);
    }
  }

  /** Fire a trigger immediately, ignoring `on`/`after` (the `fire:` action). */
  force(id, run) {
    const s = this.byId.get(id);
    if (!s) return false;
    if (s.def.once && s.fired > 0) return false;
    s.fired++;
    s.firedAt = this.ctx.elapsed();
    this.log.push({ id: s.id, t: +s.firedAt.toFixed(2), forced: true });
    run(s.def, s);
    return true;
  }

  snapshot() {
    return this.states.map((s) => ({ id: s.id, armed: s.armed, fired: s.fired, due: s.due }));
  }
}

export default { evalCond, TriggerMachine };
