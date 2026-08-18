/**
 * src/mission/format.js — the mission definition schema.
 *
 * A mission is **data**, not code. Everything a designer writes lives in a plain
 * object literal: nav points, spawn groups, objectives, triggers, and the
 * conditions that end the flight. `missions.js` is nothing but four of these
 * objects; `skirmish.js` proves the format is complete by *generating* one.
 *
 * ---------------------------------------------------------------------------
 * ## Worked example
 *
 * ```js
 * export const example = {
 *   id: 'demo-escort',
 *   title: 'Escort — Ore Convoy',
 *   type: 'escort',                       // patrol | escort | strike | defend
 *   world: { preset: 'nebula-teal' },
 *   player: { ship: 'confed_vampire' },
 *   wingmen: ['Maniac'],                  // keys into wingmen.js's roster
 *
 *   navs: [
 *     { id: 'n1', name: 'NAV 1 · DEPARTURE', position: [0, 0, -18000], radius: 1400 },
 *     { id: 'n2', name: 'NAV 2 · JUMP POINT', position: [9000, 900, -46000], radius: 1600 },
 *   ],
 *
 *   groups: {
 *     convoy: {
 *       ship: 'civ_drayman', faction: 'civilian', count: 1, tag: 'freighter',
 *       at: 'player', offset: [400, -60, -900], escortRoute: true,
 *     },
 *     ambush: {
 *       ship: 'alien_manta', faction: 'nephilim', count: 3,
 *       at: 'n2', offset: [0, 400, -2600], spread: 260, facing: 'player',
 *       skill: 'veteran', spawn: 'trigger',       // held until a trigger says so
 *     },
 *   },
 *
 *   objectives: [
 *     { id: 'deliver', kind: 'primary', label: 'Escort the freighter to the jump point',
 *       auto: { navVisited: 'n2' } },
 *     { id: 'nolosses', kind: 'secondary', label: 'Freighter takes no hull damage',
 *       failIf: { hullBelow: { ship: 'freighter', frac: 0.999 } },
 *       auto: { navVisited: 'n2' } },
 *   ],
 *
 *   triggers: [
 *     { id: 'jump', on: { nav: 'n2' }, do: [
 *       { spawn: 'ambush' },
 *       { comms: { from: 'Freighter', text: 'They were waiting for us!', tone: 'panic' } },
 *     ] },
 *     { id: 'jump2', after: 'jump', delay: 22, if: { groupAlive: { group: 'ambush', gte: 1 } },
 *       do: [{ spawn: 'ambush2' }] },
 *   ],
 *
 *   failure: [{ destroyed: 'freighter' }],   // success defaults to "all primaries"
 * };
 * ```
 *
 * ---------------------------------------------------------------------------
 * ## Conditions
 *
 * One condition object is an AND of its keys. Every field below is optional.
 *
 * | key | meaning |
 * |---|---|
 * | `always: true`                   | true |
 * | `start: true`                    | true from the first tick |
 * | `time: n` / `elapsed:{gte,lte}`  | mission clock, seconds |
 * | `nav: 'id'` / `navVisited: 'id'` | the player has arrived at that nav |
 * | `navIndexGte: n`                 | current nav index (0-based) |
 * | `allNavsVisited: true`           | every nav point reached |
 * | `spawned: 'group'`               | the group exists in the world |
 * | `groupDestroyed: 'group'`        | it was spawned and nothing is left |
 * | `groupAlive: {group,gte,lte}`    | survivor count window |
 * | `alive: 'tag'` / `destroyed:'tag'` | a tagged ship (or group) |
 * | `hullBelow: {ship:'tag', frac}`  | damage threshold |
 * | `objective: {id, state}`         | objective state test |
 * | `objectivesComplete: 'primary'`  | 'primary' \| 'secondary' \| 'all' |
 * | `playerKillsGte: n`              | kills scored by the player this mission |
 * | `playerHullBelow: f`             | player damage threshold |
 * | `flag: 'name'` / `notFlag:'name'`| designer flags set by actions |
 * | `within: {of, to, range}`        | proximity: 'player' \| tag → tag \| 'nav:id' |
 * | `any: [cond, ...]`               | OR |
 * | `all: [cond, ...]`               | AND |
 * | `not: cond`                      | negation |
 *
 * ## Actions
 *
 * | key | meaning |
 * |---|---|
 * | `spawn: 'group' \| ['a','b']`      | instantiate a spawn group |
 * | `objective: 'id', state: 's'`      | drive an objective's state machine |
 * | `comms: {from,text,tone,priority,delay}` | radio line (also accepts a bare string) |
 * | `flag: 'name', value: true`        | set/clear a flag |
 * | `unlockNav: 'id'` / `setNav: 'id'` | nav course control |
 * | `fire: 'triggerId'`                | chain straight into another trigger |
 * | `arm` / `disarm: 'triggerId'`      | conditional trigger graphs |
 * | `order: 'breakAndAttack', to:'all'`| wingman order (ai/wingmen.js command id) |
 * | `waypoint: {group, nav}`           | retask a group's AI waypoint |
 * | `succeed: 'reason'` / `fail:'reason'` | end the mission |
 *
 * Nothing here reaches into another module: the runtime in `MissionSystem.js`
 * implements the small context interface these predicates and actions call.
 */

export const MISSION_TYPES = ['patrol', 'escort', 'strike', 'defend', 'skirmish'];
export const OBJECTIVE_KINDS = ['primary', 'secondary', 'bonus'];
export const OBJECTIVE_STATES = ['pending', 'active', 'complete', 'failed'];

/** Terminal states — an objective in one of these never changes again. */
export const TERMINAL_STATES = new Set(['complete', 'failed']);

const isArr = Array.isArray;
const isObj = (v) => !!v && typeof v === 'object' && !isArr(v);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Definitions carry positions as `[x,y,z]`; the runtime wants `{x,y,z}`. */
export function vec(v, fallback = null) {
  if (!v) return fallback ? { ...fallback } : { x: 0, y: 0, z: 0 };
  if (isArr(v)) return { x: num(v[0]), y: num(v[1]), z: num(v[2]) };
  if (typeof v === 'object') return { x: num(v.x), y: num(v.y), z: num(v.z) };
  return { x: 0, y: 0, z: 0 };
}

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// ---------------------------------------------------------------------------
// normalisation
// ---------------------------------------------------------------------------

/**
 * Fill in every default so the runtime never has to ask "did the designer write
 * this field?". Returns a fresh object — the source definition is never mutated,
 * which matters because a mission may be flown twice in one session.
 */
export function normalizeMission(def, { warnings = [] } = {}) {
  if (!isObj(def)) throw new Error('[mission] definition must be an object');
  const id = String(def.id ?? 'untitled');

  const navs = (def.navs ?? []).map((n, i) => ({
    id: String(n.id ?? `nav${i + 1}`),
    name: String(n.name ?? `NAV ${i + 1}`),
    position: vec(n.position),
    radius: Math.max(120, num(n.radius, 1500)),
    /** Autopilot to the *next* nav is refused until this one is cleared. */
    clear: n.clear !== false,
    /** Objective ids that must be complete before the course unlocks. */
    requires: isArr(n.requires) ? n.requires.slice() : (n.requires ? [n.requires] : []),
    arrivalComms: n.comms ?? null,
    index: i,
  }));

  const groups = {};
  for (const [key, g] of Object.entries(def.groups ?? {})) {
    groups[key] = {
      id: key,
      ship: String(g.ship ?? 'alien_manta'),
      faction: String(g.faction ?? (String(g.ship ?? '').startsWith('confed') ? 'confed' : 'nephilim')),
      count: Math.max(1, Math.round(num(g.count, 1))),
      tag: g.tag ? String(g.tag) : key,
      at: g.at ?? navs[0]?.id ?? 'player',
      offset: vec(g.offset),
      spread: num(g.spread, 180),
      facing: g.facing ?? 'nav',
      formation: g.formation ?? 'wedge',
      squadron: g.squadron ?? `${key}`,
      skill: g.skill ?? null,
      temperament: g.temperament ?? null,
      ai: isObj(g.ai) ? { ...g.ai } : {},
      role: g.role ?? 'combat',
      /** 'immediate' spawns at mission start; 'trigger' waits for a `spawn` action. */
      spawn: g.spawn === 'trigger' ? 'trigger' : (g.spawn === 'nav' ? 'nav' : 'immediate'),
      /** For `spawn:'nav'` — the nav whose arrival spawns this group. */
      atNav: g.atNav ?? (typeof g.at === 'string' ? g.at : null),
      static: g.static === true,
      /** Escort/convoy craft: follow the nav course instead of loitering. */
      escortRoute: g.escortRoute === true,
      /** Optional per-ship names, cycled if shorter than `count`. */
      names: isArr(g.names) ? g.names.slice() : null,
      seed: g.seed ?? null,
      /** Losing every ship in a `protect` group ends the mission. */
      protect: g.protect === true,
    };
  }

  const objectives = (def.objectives ?? []).map((o, i) => ({
    id: String(o.id ?? `obj${i + 1}`),
    kind: OBJECTIVE_KINDS.includes(o.kind) ? o.kind : 'primary',
    label: String(o.label ?? o.id ?? `Objective ${i + 1}`),
    detail: o.detail ? String(o.detail) : '',
    state: OBJECTIVE_STATES.includes(o.state) ? o.state : 'active',
    auto: o.auto ?? null,
    failIf: o.failIf ?? null,
    /** Optional progress readout for the UI, e.g. { of: 'group', group: 'wave1' }. */
    progress: o.progress ?? null,
    nav: o.nav ?? null,
    order: i,
  }));

  const triggers = (def.triggers ?? []).map((t, i) => ({
    id: String(t.id ?? `trg${i + 1}`),
    on: t.on ?? (t.after ? { always: true } : { start: true }),
    if: t.if ?? null,
    do: isArr(t.do) ? t.do.slice() : (t.do ? [t.do] : []),
    /** Chained triggers: armed only once the named trigger has fired. */
    after: t.after ? (isArr(t.after) ? t.after.slice() : [String(t.after)]) : [],
    delay: Math.max(0, num(t.delay, 0)),
    once: t.once !== false,
    /** Only for `once: false` — minimum seconds between repeat firings. */
    cooldown: Math.max(0, num(t.cooldown, 0)),
    /** Start disarmed; an `arm` action switches it on. */
    armed: t.armed !== false,
    order: i,
  }));

  const out = {
    id,
    title: String(def.title ?? id),
    type: MISSION_TYPES.includes(def.type) ? def.type : 'patrol',
    act: num(def.act, 1),
    next: def.next ?? null,
    difficulty: num(def.difficulty, 1),
    briefing: isArr(def.briefing) ? def.briefing.slice() : (def.briefing ? [String(def.briefing)] : []),
    debrief: isObj(def.debrief) ? { ...def.debrief } : {},
    world: isObj(def.world) ? { ...def.world } : {},
    player: {
      ship: def.player?.ship ?? 'confed_vampire',
      position: vec(def.player?.position),
      wing: def.player?.wing ?? 'Talon',
      callsign: def.player?.callsign ?? 'Lead',
    },
    wingmen: isArr(def.wingmen) ? def.wingmen.slice() : [],
    navs,
    groups,
    objectives,
    triggers,
    success: normalizeCondList(def.success, [{ objectivesComplete: 'primary' }]),
    failure: normalizeCondList(def.failure, []),
    limits: {
      time: num(def.limits?.time, 0),
      maxShips: Math.max(4, num(def.limits?.maxShips, 16)),
    },
    /** Where the AI sends ships told to return to base. */
    base: def.base ? vec(def.base) : null,
  };

  validate(out, warnings);
  return out;
}

function normalizeCondList(v, fallback) {
  if (!v) return fallback.slice();
  if (isArr(v)) return v.slice();
  return [v];
}

/** Structural problems a designer can fix. Collected, never thrown. */
function validate(m, warnings) {
  const navIds = new Set(m.navs.map((n) => n.id));
  // `wingmen` is a pseudo-group the runtime registers for the player's flight, so
  // a mission can write `groupAlive: { group: 'wingmen', lte: 1 }` without having
  // to declare the wing as a spawn group it does not control.
  const groupIds = new Set([...Object.keys(m.groups), 'wingmen']);
  const objIds = new Set(m.objectives.map((o) => o.id));
  const trgIds = new Set(m.triggers.map((t) => t.id));
  // Tags a condition may legitimately name: group tags, the player, the wing as a
  // whole, and each wingman by roster key (missions do reference them by name —
  // `destroyed: 'bishop'` is how the strike mission loses its torpedo bomber).
  const tags = new Set([
    'player', 'wingmen',
    ...Object.values(m.groups).map((g) => g.tag),
    ...m.wingmen.map((w) => String(typeof w === 'string' ? w : (w?.key ?? '')).toLowerCase()),
  ]);

  if (m.navs.length === 0) warnings.push(`${m.id}: no nav points`);
  if (m.objectives.filter((o) => o.kind === 'primary').length === 0) {
    warnings.push(`${m.id}: no primary objective`);
  }
  for (const g of Object.values(m.groups)) {
    if (typeof g.at === 'string' && g.at !== 'player' && !navIds.has(g.at) && !tags.has(g.at)) {
      warnings.push(`${m.id}: group "${g.id}" spawns at unknown anchor "${g.at}"`);
    }
  }
  const walkCond = (c, where) => {
    if (!isObj(c)) return;
    for (const sub of ['any', 'all']) if (isArr(c[sub])) c[sub].forEach((x) => walkCond(x, where));
    if (c.not) walkCond(c.not, where);
    const g = c.groupDestroyed ?? c.spawned ?? c.groupAlive?.group;
    if (g && !groupIds.has(g)) warnings.push(`${m.id}: ${where} references unknown group "${g}"`);
    const nv = c.nav ?? c.navVisited;
    if (nv && !navIds.has(nv)) warnings.push(`${m.id}: ${where} references unknown nav "${nv}"`);
    const ob = c.objective?.id;
    if (ob && !objIds.has(ob)) warnings.push(`${m.id}: ${where} references unknown objective "${ob}"`);
    const tg = c.alive ?? c.destroyed ?? c.hullBelow?.ship;
    if (tg && !tags.has(tg) && !groupIds.has(tg)) {
      warnings.push(`${m.id}: ${where} references unknown ship tag "${tg}"`);
    }
  };
  for (const t of m.triggers) {
    walkCond(t.on, `trigger "${t.id}".on`);
    walkCond(t.if, `trigger "${t.id}".if`);
    for (const a of t.after) if (!trgIds.has(a)) warnings.push(`${m.id}: trigger "${t.id}" chains off unknown "${a}"`);
    for (const act of t.do) {
      const sp = act.spawn ? (isArr(act.spawn) ? act.spawn : [act.spawn]) : [];
      for (const s of sp) if (!groupIds.has(s)) warnings.push(`${m.id}: trigger "${t.id}" spawns unknown group "${s}"`);
      if (act.objective && !objIds.has(act.objective)) {
        warnings.push(`${m.id}: trigger "${t.id}" sets unknown objective "${act.objective}"`);
      }
      for (const k of ['fire', 'arm', 'disarm']) {
        if (act[k] && !trgIds.has(act[k])) warnings.push(`${m.id}: trigger "${t.id}" ${k}s unknown trigger "${act[k]}"`);
      }
      if (act.setNav && !navIds.has(act.setNav)) warnings.push(`${m.id}: trigger "${t.id}" sets unknown nav "${act.setNav}"`);
    }
  }
  for (const o of m.objectives) { walkCond(o.auto, `objective "${o.id}".auto`); walkCond(o.failIf, `objective "${o.id}".failIf`); }
  for (const c of m.success) walkCond(c, 'success');
  for (const c of m.failure) walkCond(c, 'failure');
  return warnings;
}

// ---------------------------------------------------------------------------
// static analysis — "can this mission be finished at all?"
// ---------------------------------------------------------------------------

/**
 * Walk the definition without running it and answer the two questions that a
 * broken mission always fails: can every objective reach a terminal state, and
 * is there any path to success?
 *
 * The analysis is deliberately conservative — it reports *possible* completion,
 * not guaranteed completion, because "possible" is what unreachable means.
 */
export function analyzeMission(m) {
  const completable = new Set();
  const failable = new Set();
  const deadlocked = [];

  for (const o of m.objectives) {
    if (o.state === 'complete') completable.add(o.id);
    if (o.state === 'failed') failable.add(o.id);
    if (o.auto) completable.add(o.id);
    if (o.failIf) failable.add(o.id);
  }
  // Triggers that drive objectives, following chains (a chained trigger is only
  // reachable if the trigger it hangs off is itself reachable).
  const byId = new Map(m.triggers.map((t) => [t.id, t]));
  const reachable = new Set();
  const visit = (t, seen = new Set()) => {
    if (!t || seen.has(t.id)) return false;
    seen.add(t.id);
    if (t.after.length && !t.after.some((a) => visit(byId.get(a), seen))) return false;
    reachable.add(t.id);
    return true;
  };
  // A trigger with no `after` chain is reachable by definition; `fire` actions
  // reach otherwise-disarmed triggers too.
  for (const t of m.triggers) if (!t.after.length) reachable.add(t.id);
  for (const t of m.triggers) visit(t);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of m.triggers) {
      if (!reachable.has(t.id)) continue;
      for (const act of t.do) {
        for (const k of ['fire', 'arm']) {
          if (act[k] && !reachable.has(act[k])) { reachable.add(act[k]); grew = true; }
        }
      }
    }
  }

  let canSucceed = m.success.length === 0;
  let canFail = false;
  for (const t of m.triggers) {
    if (!reachable.has(t.id)) continue;
    for (const act of t.do) {
      if (act.objective && act.state === 'complete') completable.add(act.objective);
      if (act.objective && act.state === 'failed') failable.add(act.objective);
      if (act.succeed) canSucceed = true;
      if (act.fail) canFail = true;
    }
  }

  for (const o of m.objectives) {
    if (!completable.has(o.id) && !failable.has(o.id)) deadlocked.push(o.id);
  }

  // The default success condition is "every primary complete", so success is
  // reachable when each primary objective has some route to `complete`.
  const primaries = m.objectives.filter((o) => o.kind === 'primary');
  const defaultSuccess = m.success.some((c) => c.objectivesComplete);
  if (defaultSuccess) canSucceed = primaries.length > 0 && primaries.every((o) => completable.has(o.id));
  if (m.failure.length) canFail = true;

  return {
    completable: [...completable],
    failable: [...failable],
    unreachableTriggers: m.triggers.filter((t) => !reachable.has(t.id)).map((t) => t.id),
    deadlocked,
    canSucceed,
    canFail,
  };
}

export default { normalizeMission, analyzeMission, vec, dist, MISSION_TYPES, OBJECTIVE_STATES };
