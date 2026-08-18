/**
 * src/mission/objectives.js — the objective board.
 *
 * Objectives are the only part of the mission the player can actually read, so
 * the rules are strict:
 *
 *   pending ──▶ active ──▶ complete        (terminal)
 *                     └──▶ failed          (terminal)
 *
 * Terminal is terminal. A trigger that tries to re-complete a failed objective is
 * ignored rather than obeyed — otherwise a late-firing cleanup trigger can quietly
 * un-fail an escort the player watched explode, and the debrief lies.
 *
 * Every state change emits `objective:update` (ARCHITECTURE §5.6). The payload is
 * the contract agent-ui codes against:
 *
 * ```js
 * engine.events.emit('objective:update', {
 *   id: 'escort',                  // the objective that changed
 *   state: 'complete',             // its new state
 *   previous: 'active',
 *   kind: 'primary',               // primary | secondary | bonus
 *   label: 'Escort the convoy to the jump point',
 *   detail: '',                    // optional sub-line
 *   progress: { current: 2, total: 3 } | null,
 *   reason: 'trigger',             // trigger | auto | failIf | mission | cascade
 *   objective: { …the full objective record… },
 *   objectives: [ …every objective, in board order… ],
 *   mission: { id, title, type, state },
 *   t: 41.2,                       // mission clock, seconds
 * });
 * ```
 *
 * The full `objectives` array rides along on every emission so a UI that attaches
 * late, or repaints from scratch, never needs to ask the mission system for state.
 */

import { OBJECTIVE_STATES, TERMINAL_STATES } from './format.js';

export class ObjectiveBook {
  /**
   * @param {Array<object>} defs normalized objective definitions
   * @param {(payload:object)=>void} emit sink for `objective:update`
   */
  constructor(defs, emit) {
    this.emit = emit ?? (() => {});
    this.list = defs.map((d) => ({
      id: d.id,
      kind: d.kind,
      label: d.label,
      detail: d.detail,
      state: d.state,
      progress: null,
      nav: d.nav ?? null,
      order: d.order,
      auto: d.auto,
      failIf: d.failIf,
      progressSpec: d.progress ?? null,
      changedAt: 0,
    }));
    this.byId = new Map(this.list.map((o) => [o.id, o]));
    this.history = [];
  }

  get(id) { return this.byId.get(id) ?? null; }
  state(id) { return this.byId.get(id)?.state ?? 'pending'; }

  /** Public snapshot — plain data, safe to hand to the UI every frame. */
  view() {
    return this.list.map((o) => ({
      id: o.id, kind: o.kind, label: o.label, detail: o.detail,
      state: o.state, progress: o.progress ? { ...o.progress } : null, nav: o.nav,
    }));
  }

  /**
   * Drive one objective's state machine.
   * @returns {boolean} true if the state actually changed.
   */
  set(id, state, { reason = 'trigger', detail = null, t = 0, mission = null } = {}) {
    const o = this.byId.get(id);
    if (!o) return false;
    if (!OBJECTIVE_STATES.includes(state)) return false;
    if (o.state === state) return false;
    if (TERMINAL_STATES.has(o.state)) return false; // terminal is terminal
    // 'pending' is an entry state only — nothing walks an objective backwards.
    if (state === 'pending') return false;

    const previous = o.state;
    o.state = state;
    o.changedAt = t;
    if (detail !== null) o.detail = String(detail);
    this.history.push({ id, from: previous, to: state, t, reason });

    this.emit({
      id: o.id,
      state,
      previous,
      kind: o.kind,
      label: o.label,
      detail: o.detail,
      progress: o.progress ? { ...o.progress } : null,
      reason,
      objective: { id: o.id, kind: o.kind, label: o.label, detail: o.detail, state: o.state, progress: o.progress ? { ...o.progress } : null, nav: o.nav },
      objectives: this.view(),
      mission,
      t,
    });
    return true;
  }

  /** Update the "3 of 5" counter without a state change (repaint hint only). */
  setProgress(id, current, total, { t = 0, mission = null } = {}) {
    const o = this.byId.get(id);
    if (!o) return false;
    const cur = Math.max(0, Math.round(current));
    const tot = Math.max(0, Math.round(total));
    if (o.progress && o.progress.current === cur && o.progress.total === tot) return false;
    o.progress = { current: cur, total: tot };
    if (TERMINAL_STATES.has(o.state)) return false;
    this.emit({
      id: o.id, state: o.state, previous: o.state, kind: o.kind, label: o.label,
      detail: o.detail, progress: { ...o.progress }, reason: 'progress',
      objective: { id: o.id, kind: o.kind, label: o.label, detail: o.detail, state: o.state, progress: { ...o.progress }, nav: o.nav },
      objectives: this.view(), mission, t,
    });
    return true;
  }

  /** Everything still in play gets closed out when the mission ends. */
  closeOut(missionState, { t = 0, mission = null } = {}) {
    const target = missionState === 'complete' ? 'complete' : 'failed';
    for (const o of this.list) {
      if (TERMINAL_STATES.has(o.state)) continue;
      // Only primaries inherit a mission success; an unfinished bonus is simply
      // not earned, which is a failure of the bonus, not of the pilot.
      const state = missionState === 'complete' && o.kind !== 'primary' ? 'failed' : target;
      this.set(o.id, state, { reason: 'mission', t, mission });
    }
  }

  allComplete(kind = 'primary') {
    const pool = kind === 'all' ? this.list : this.list.filter((o) => o.kind === kind);
    return pool.length > 0 && pool.every((o) => o.state === 'complete');
  }

  anyFailed(kind = 'primary') {
    const pool = kind === 'all' ? this.list : this.list.filter((o) => o.kind === kind);
    return pool.some((o) => o.state === 'failed');
  }

  counts() {
    const c = { total: this.list.length, complete: 0, failed: 0, active: 0, pending: 0, primary: 0, secondary: 0, bonus: 0 };
    for (const o of this.list) { c[o.state]++; c[o.kind]++; }
    return c;
  }
}

export default ObjectiveBook;
