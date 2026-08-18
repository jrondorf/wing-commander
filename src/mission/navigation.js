/**
 * src/mission/navigation.js — the nav course.
 *
 * The Wing Commander loop, in one sentence: autopilot to a nav point, fight what
 * is waiting there, autopilot to the next. Everything interesting about that loop
 * lives in the refusal — **NAV LOCKED**. Autopilot that engages with bandits on
 * the board turns every mission into a cutscene with a skip button; autopilot that
 * refuses turns the same content into "clear this room to open the door", which is
 * the actual game.
 *
 * Three things can lock the course:
 *   1. a live hostile inside `lockRange` (the classic case),
 *   2. an unfinished objective the nav declares in `requires`,
 *   3. the player already standing on the last nav point.
 *
 * Plain `{x,y,z}` maths throughout, no three.js — the whole course is exercised
 * headless by `__selftest.mjs`.
 */

import { dist } from './format.js';

export const LOCK_REASONS = {
  hostiles: 'NAV LOCKED · HOSTILES IN THE AREA',
  objective: 'NAV LOCKED · OBJECTIVE INCOMPLETE',
  end: 'NAV COURSE COMPLETE',
  none: '',
};

export class NavCourse {
  /**
   * @param {Array<object>} navs normalized nav definitions
   * @param {object} [opts] { lockRange } metres — hostiles inside this refuse autopilot
   */
  constructor(navs, opts = {}) {
    this.navs = navs.map((n) => ({ ...n, position: { ...n.position }, visited: false, arrivedAt: -1 }));
    this.index = 0;
    this.lockRange = opts.lockRange ?? 6000;
    /** Nav points beyond this one are hidden from the UI until reached. */
    this.revealed = Math.min(1, this.navs.length);
    this.completed = false;
  }

  get active() { return this.navs[this.index] ?? null; }
  get total() { return this.navs.length; }
  byId(id) { return this.navs.find((n) => n.id === id) ?? null; }
  visited(id) { return !!this.byId(id)?.visited; }
  allVisited() { return this.navs.length > 0 && this.navs.every((n) => n.visited); }

  /** Distance from a world position to the active nav, or Infinity. */
  distanceTo(pos) {
    const a = this.active;
    return a && pos ? dist(a.position, pos) : Infinity;
  }

  /**
   * Arrival test. Returns the nav just reached, or null.
   * Arrival is sticky: a nav is only "arrived at" once, no matter how many times
   * the player wanders back through the sphere.
   */
  checkArrival(pos) {
    const a = this.active;
    if (!a || !pos || a.visited) return null;
    if (dist(a.position, pos) > a.radius) return null;
    a.visited = true;
    return a;
  }

  /**
   * May the course advance? `probe` answers the two questions the course cannot:
   * how far away the nearest live hostile is, and whether an objective is done.
   * @param {{hostileRange:()=>number, objectiveComplete:(id:string)=>boolean}} probe
   * @returns {{ok:boolean, reason:string, message:string, nav:object|null}}
   */
  canAdvance(probe) {
    const a = this.active;
    const hostile = probe?.hostileRange?.() ?? Infinity;
    // `clear: false` on a nav the player has already reached means "you may leave
    // this one under fire" — a fighting withdrawal, which some missions want and
    // the blanket rule would forbid.
    const needsClear = !(a && a.visited && a.clear === false);
    if (needsClear && hostile <= this.lockRange) {
      return { ok: false, reason: 'hostiles', message: LOCK_REASONS.hostiles, nav: a, range: hostile };
    }
    if (a && a.visited && a.requires.length) {
      const missing = a.requires.find((id) => !probe?.objectiveComplete?.(id));
      if (missing) return { ok: false, reason: 'objective', message: LOCK_REASONS.objective, nav: a, objective: missing };
    }
    if (a && a.visited && this.index >= this.navs.length - 1) {
      return { ok: false, reason: 'end', message: LOCK_REASONS.end, nav: a };
    }
    return { ok: true, reason: 'none', message: '', nav: a };
  }

  /**
   * Advance to the next nav point. Only meaningful once the current one has been
   * reached — until then the "next" nav *is* the active one.
   * @returns {object|null} the nav now active, or null if the course is finished.
   */
  advance() {
    const a = this.active;
    if (a && !a.visited) return a;           // still flying to this one
    if (this.index >= this.navs.length - 1) { this.completed = true; return null; }
    this.index++;
    this.revealed = Math.max(this.revealed, this.index + 1);
    return this.active;
  }

  /** Jump straight to a nav by id (the `setNav` action). */
  setActive(id) {
    const i = this.navs.findIndex((n) => n.id === id);
    if (i < 0) return null;
    this.index = i;
    this.revealed = Math.max(this.revealed, i + 1);
    return this.active;
  }

  /** Snapshot for `game.mission.nav` — the shape cockpit/state.js reads. */
  view() {
    const a = this.active;
    if (!a) return null;
    return { id: a.id, name: a.name, index: this.index + 1, total: this.navs.length, radius: a.radius, visited: a.visited };
  }

  /** Full course for a UI nav map. */
  list() {
    return this.navs.map((n, i) => ({
      id: n.id, name: n.name, index: i + 1, visited: n.visited,
      active: i === this.index, revealed: i < this.revealed,
      position: { ...n.position },
    }));
  }
}

export default NavCourse;
