/**
 * src/mission/MissionSystem.js — objectives, nav points, spawning, flow.
 *
 * Priority 400 (ARCHITECTURE §3): after damage has resolved this frame's kills,
 * before world/vfx/cockpit read the results. That ordering is the reason an
 * objective can complete and its `objective:update` can reach the HUD inside the
 * same frame the last bandit died.
 *
 * ```js
 * const mission = createMissionSystem(engine);
 * engine.registerSystem(mission);
 * mission.load('m1-perimeter');
 * mission.start();
 * ```
 *
 * ## What it owns
 *
 *   format.js       the declarative schema + static analysis
 *   missions.js     four hand-authored missions (data only)
 *   skirmish.js     the seeded procedural generator
 *   triggers.js     condition evaluator + trigger graph
 *   objectives.js   the objective board and `objective:update`
 *   navigation.js   the nav course and the NAV LOCKED rule
 *   spawns.js       group placement maths (three.js-free)
 *   campaign.js     persistence, kills, rank
 *   wingmen.js      the named roster
 *
 * ## What it publishes
 *
 *   game.mission.nav        `{ name, position, index, total, distance }` — the
 *                           shape `cockpit/state.js` already reads.
 *   game.mission.objectives `[{ id, kind, label, state, progress }]`
 *   game.basePosition       where `ai/wingmen.js` sends "return to base".
 *   game.isHostile(a, b)    the faction rule `flight/Autopilot.js` delegates to —
 *                           without it a civilian freighter you are escorting
 *                           counts as "a different faction", and the player's
 *                           autopilot refuses to engage next to his own convoy.
 *
 * ## Events emitted
 *
 *   objective:update   see objectives.js for the full payload
 *   comms:message      { from, text, tone, priority, kind:'mission', t }
 *   mission:loaded     { mission }
 *   mission:start      { mission, objectives, navs }
 *   mission:complete   { mission, result, debrief }
 *   mission:failed     { mission, result, reason, debrief }
 *   mission:aborted    { mission }
 *   nav:arrive         { nav, index, total, position }
 *   nav:changed        { nav, index, total, position }
 *   nav:locked         { reason, message, range, nav }
 *   mission:spawn      { group, faction, ships, count }
 *   campaign:promotion { from, to, rank }
 *
 * Every cross-module call in this file is optional-chained. `ui`, `ai`, `flight`
 * and `combat` may each be absent; a mission with none of them still runs its
 * trigger graph to completion, which is exactly what `__selftest.mjs` exploits.
 */

import * as THREE from 'three';
import { makeRng, hashSeed } from '../core/Rand.js';
import { normalizeMission, analyzeMission, dist } from './format.js';
import { TriggerMachine, evalCond } from './triggers.js';
import { ObjectiveBook } from './objectives.js';
import { NavCourse } from './navigation.js';
import { MISSIONS, CAMPAIGN, missionList } from './missions.js';
import { generateSkirmish } from './skirmish.js';
import { createCampaign } from './campaign.js';
import { resolveWingman, wingmanAIConfig } from './wingmen.js';
import { placeGroup, add } from './spawns.js';

/** Hostiles inside this range refuse autopilot. Matches the cockpit's readout. */
const NAV_LOCK_RANGE = 6000;
/** Seconds a wreck stays in the world before the mission reaps it. */
const WRECK_LINGER = 9;
/** Engine seconds of idling before autostart gives up waiting for a UI. */
const AUTOSTART_GRACE = 3;

const ALLIED = {
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

function factionsHostile(fa = 'confed', fb = 'confed') {
  if (fa === 'neutral' || fb === 'neutral') return false;
  const set = ALLIED[fa];
  return set ? !set.has(fb) : fa !== fb;
}

const alive = (s) => !!s && s.alive !== false;
const posOf = (s) => s?.body?.position ?? s?.group?.position ?? null;
const hullOf = (s) => (typeof s?.hullFrac === 'number' ? s.hullFrac : 1);

export function createMissionSystem(engine, opts = {}) {
  const game = engine?.game ?? null;
  const events = engine?.events ?? null;
  const seed = (game?.seed ?? opts.seed ?? 1337) >>> 0;

  const campaign = createCampaign({ seed, storage: opts.storage ?? null });

  // ------------------------------------------------------------------ state
  let def = null;                 // normalized definition, or null
  let analysis = null;
  let warnings = [];
  let state = 'idle';             // idle | ready | active | complete | failed | aborted
  let elapsed = 0;
  let idleTime = 0;
  let rng = makeRng(seed);
  let book = null;                // ObjectiveBook
  let course = null;              // NavCourse
  let machine = null;             // TriggerMachine
  let result = null;
  let autostartChecked = false;
  let fireDepth = 0;

  const flags = new Map();
  /** groupId -> { def, spawned, planned, ships[] } */
  const groups = new Map();
  /** tag -> ship[] (group tags, wingman callsigns, 'wingmen') */
  const tagIndex = new Map();
  /** every ship this mission put in the world -> { ship, deadAt } */
  const owned = new Map();
  const commsQueue = [];
  const scenery = { planets: [], fields: [] };

  let playerShip = null;
  let wingShips = [];

  const stats = {
    kills: 0, playerKills: 0, losses: [], killsByClass: {}, killsByFaction: {},
    spawned: 0, navsVisited: 0,
  };

  /** Published nav block — the object `cockpit/state.js` reads every frame. */
  const navPub = {
    id: null, name: 'NAV 1', index: 1, total: 1,
    position: new THREE.Vector3(), distance: 0, visited: false, locked: false, lockReason: '',
  };

  // ------------------------------------------------------------ event wiring
  const offs = [];
  const prevIsHostile = game ? game.isHostile : undefined;
  if (game) {
    // flight/Autopilot.js and ai/threat.js both delegate here when it exists.
    game.isHostile = (a, b) => {
      if (!a || !b || a === b) return false;
      return factionsHostile(a.faction ?? 'confed', b.faction ?? 'confed');
    };
  }

  if (events) {
    offs.push(events.on('ship:destroyed', onDestroyed));
    offs.push(events.on('autopilot:abort', onAutopilotAbort));
    offs.push(events.on('autopilot:engaged', onAutopilotEngaged));
  }

  function onDestroyed(payload) {
    const ship = payload?.ship;
    if (!ship) return;
    const rec = owned.get(ship);
    if (rec && rec.deadAt < 0) rec.deadAt = elapsed;
    if (state !== 'active') return;

    stats.kills++;
    const byPlayer = payload.byPlayer === true || (playerShip && payload.killer === playerShip);
    if (byPlayer && playerShip && factionsHostile(playerShip.faction ?? 'confed', ship.faction ?? 'confed')) {
      stats.playerKills++;
      const cls = ship.classId ?? 'unknown';
      stats.killsByClass[cls] = (stats.killsByClass[cls] ?? 0) + 1;
      const f = ship.faction ?? 'unknown';
      stats.killsByFaction[f] = (stats.killsByFaction[f] ?? 0) + 1;
    }
    if (wingShips.includes(ship)) {
      const call = ship.callsign ?? ship.name ?? 'Wingman';
      if (!stats.losses.includes(call)) stats.losses.push(call);
    }
    // A protected ship dying is the loudest thing that can happen in a mission.
    for (const g of groups.values()) {
      if (!g.def?.protect || !g.ships.includes(ship)) continue;
      say({
        from: 'Talon Control',
        text: `${ship.name || 'The ship you were covering'} is gone. Confirm, ${ship.name || 'target'} is destroyed.`,
        tone: 'grim', priority: 3,
      });
    }
  }

  /**
   * The player's autopilot actually engaged — from the mission API, or from the
   * `N` key, which goes through `flight/Autopilot.js: findNavTarget` and never
   * touches this module's API at all. Both paths land here, so the radio call and
   * the wing following along are written once.
   */
  function onAutopilotEngaged(payload) {
    if (state !== 'active' || !playerShip || payload?.ship !== playerShip) return;
    const target = course?.active;
    if (!target) return;
    say({ from: 'Flight Computer', text: `Autopilot engaged. ${target.name}.`, tone: 'calm', priority: 2, voice: 'autopilot engaged' });
    engageWing(target);
    updateEscortRoutes(true);
  }

  /** Send the wing to the same nav, fanned out so three ships do not converge. */
  function engageWing(target) {
    for (let i = 0; i < wingShips.length; i++) {
      const w = wingShips[i];
      if (!alive(w)) continue;
      const side = i % 2 === 0 ? -1 : 1;
      const rank = Math.floor(i / 2) + 1;
      const spot = add(target.position, { x: side * rank * 260, y: -30 * rank, z: 180 * rank });
      try { game?.flight?.engageAutopilot?.(w, spot); } catch { /* flight optional */ }
    }
  }

  function onAutopilotAbort(payload) {
    if (state !== 'active' || !playerShip || payload?.ship !== playerShip) return;
    say({ from: 'Flight Computer', text: 'Autopilot disengaged — hostiles in the area.', tone: 'urgent', priority: 3, voice: 'autopilot disengaged' });
  }

  // ------------------------------------------------------------------ comms
  function say(msg, delay = 0) {
    const payload = {
      from: msg.from ?? 'Talon Control',
      pilotName: msg.pilotName ?? null,
      text: String(msg.text ?? ''),
      tone: msg.tone ?? 'calm',
      priority: msg.priority ?? 2,
      kind: msg.kind ?? 'mission',
      ship: null,
      faction: msg.faction ?? 'confed',
      voice: msg.voice ?? null,
      t: elapsed,
    };
    if (!payload.text) return;
    if (delay > 0) { commsQueue.push({ at: elapsed + delay, payload }); return; }
    events?.emit?.('comms:message', payload);
  }

  function flushComms() {
    for (let i = commsQueue.length - 1; i >= 0; i--) {
      if (commsQueue[i].at > elapsed) continue;
      const { payload } = commsQueue[i];
      commsQueue.splice(i, 1);
      payload.t = elapsed;
      events?.emit?.('comms:message', payload);
    }
  }

  // ------------------------------------------------------- ship bookkeeping
  function shipsForTag(tag) {
    if (!tag) return [];
    if (tag === 'player') return playerShip ? [playerShip] : [];
    const g = groups.get(tag);
    if (g) return g.ships;
    return tagIndex.get(tag) ?? [];
  }

  function aliveCount(list) {
    let n = 0;
    for (const s of list) if (alive(s)) n++;
    return n;
  }

  function totalAliveShips() {
    let n = 0;
    for (const s of game?.ships ?? []) if (alive(s)) n++;
    return n;
  }

  function resolvePoint(ref) {
    if (!ref) return null;
    if (Array.isArray(ref)) return { x: ref[0] ?? 0, y: ref[1] ?? 0, z: ref[2] ?? 0 };
    if (typeof ref === 'object') return { x: ref.x ?? 0, y: ref.y ?? 0, z: ref.z ?? 0 };
    if (typeof ref !== 'string') return null;
    if (ref === 'player') return posOf(playerShip);
    if (ref.startsWith('nav:')) return course?.byId(ref.slice(4))?.position ?? null;
    const nav = course?.byId(ref);
    if (nav) return nav.position;
    const ships = shipsForTag(ref);
    for (const s of ships) if (alive(s)) return posOf(s);
    // A destroyed anchor still has a last known position — spawning "where the
    // freighter used to be" is a legitimate thing for a designer to want.
    for (const s of ships) if (posOf(s)) return posOf(s);
    return null;
  }

  // ----------------------------------------------------- the trigger context
  const ctx = {
    elapsed: () => elapsed,
    navVisited: (id) => !!course?.visited(id),
    activeNavId: () => course?.active?.id ?? null,
    navIndex: () => course?.index ?? 0,
    allNavsVisited: () => !!course?.allVisited(),

    groupSpawned: (id) => !!groups.get(id)?.spawned,
    /**
     * Survivors in a group. An *unspawned* group reports its planned strength
     * rather than zero — otherwise `groupAlive: {lte:1}` fires on the first frame
     * of every mission, before the ships it is asking about exist.
     */
    groupAlive: (id) => {
      const g = groups.get(id);
      if (!g) return 0;
      return g.spawned ? aliveCount(g.ships) : g.planned;
    },
    groupTotal: (id) => groups.get(id)?.planned ?? 0,

    tagAlive: (tag) => shipsForTag(tag).some(alive),
    tagDestroyed: (tag) => {
      const list = shipsForTag(tag);
      return list.length > 0 && !list.some(alive);
    },
    tagHull: (tag) => {
      const list = shipsForTag(tag);
      if (!list.length) return 1;
      let min = 1;
      for (const s of list) min = Math.min(min, alive(s) ? hullOf(s) : 0);
      return min;
    },

    playerHull: () => (playerShip ? (alive(playerShip) ? hullOf(playerShip) : 0) : 1),
    playerKills: () => stats.playerKills,
    kills: () => stats.kills,

    distance: (a, b) => {
      const pa = resolvePoint(a);
      const pb = resolvePoint(b);
      if (!pa || !pb) return null;
      return dist(pa, pb);
    },

    objectiveState: (id) => book?.state(id) ?? 'pending',
    objectivesComplete: (kind) => !!book?.allComplete(kind ?? 'primary'),
    objectivesFailed: (kind) => !!book?.anyFailed(kind ?? 'primary'),
    flag: (name) => flags.get(name) ?? false,
  };

  // --------------------------------------------------------------- spawning
  function spawnGroup(id, { silent = false } = {}) {
    const g = groups.get(id);
    if (!g || g.spawned) return g?.ships ?? [];
    g.spawned = true;

    if (!game?.spawnShip) return g.ships;

    // Frame budget (ARCHITECTURE §1 rule 8): a wave may be trimmed, but never to
    // nothing. A group that spawns zero ships reads as "destroyed" the instant it
    // is asked, which hands the player an objective he never fought for.
    const budget = Math.max(0, (def.limits.maxShips ?? 16) - totalAliveShips());
    const count = Math.max(1, Math.min(g.planned, budget));
    if (count < g.planned) {
      console.warn(`[mission] ship budget trimmed group "${id}" from ${g.planned} to ${count}`);
    }

    const anchor = resolvePoint(g.def.at) ?? { x: 0, y: 0, z: 0 };
    const facing = g.def.facing === 'nav' ? (course?.active?.id ? `nav:${course.active.id}` : 'player') : g.def.facing;
    const facePos = facing === 'none' ? null : (resolvePoint(facing) ?? resolvePoint('player') ?? null);
    const grng = makeRng((hashSeed(`${def.id}:${id}`) ^ seed) >>> 0);
    const places = placeGroup(g.def, anchor, facePos, grng, count);

    for (let i = 0; i < count; i++) {
      const name = g.def.names?.[i % (g.def.names?.length || 1)] ?? `${g.def.squadron} ${i + 1}`;
      const aiCfg = {
        squadron: g.def.squadron,
        formation: g.def.formation,
        role: i === 0 ? 'leader' : 'wing',
        slot: i,
        ...(g.def.skill ? { skill: g.def.skill } : {}),
        ...(g.def.temperament ? { temperament: g.def.temperament } : {}),
        ...(g.def.role === 'transport' ? { freeEngage: false, holdFire: true } : {}),
        ...g.def.ai,
      };
      let ship = null;
      try {
        ship = game.spawnShip(g.def.ship, {
          faction: g.def.faction,
          position: places[i].position,
          quaternion: places[i].quaternion,
          name,
          seed: ((g.def.seed ?? hashSeed(`${def.id}:${id}:${i}`)) ^ seed) >>> 0,
          ai: aiCfg,
        });
      } catch (err) {
        console.error(`[mission] spawn failed for group "${id}":`, err);
      }
      if (!ship) continue;
      ship.missionGroup = id;
      ship.missionTag = g.def.tag;
      g.ships.push(ship);
      owned.set(ship, { ship, deadAt: -1 });
      stats.spawned++;
      if (g.def.static) game.flight?.setStatic?.(ship, true);
      if (g.def.escortRoute) retaskShip(ship, course?.active?.position ?? null);
    }

    const list = tagIndex.get(g.def.tag) ?? [];
    tagIndex.set(g.def.tag, list.concat(g.ships));

    if (!silent) {
      events?.emit?.('mission:spawn', {
        group: id, faction: g.def.faction, ships: g.ships.slice(), count: g.ships.length,
        ship: g.def.ship,
      });
    }
    return g.ships;
  }

  /** Point a ship's AI at a world position (ai/maneuvers.js `patrolTurn`). */
  function retaskShip(ship, point) {
    if (!ship || !point) return;
    const pilot = ship.pilot;
    // TODO(contract): would rather call `ai.setWaypoint(ship, v)` — `pilot.waypoint`
    // is the documented mechanism but reaching for it here is one level too deep.
    if (!pilot) return;
    if (pilot.waypoint?.set) pilot.waypoint.set(point.x, point.y, point.z);
    else pilot.waypoint = new THREE.Vector3(point.x, point.y, point.z);
  }

  function retaskGroup(id, point) {
    const g = groups.get(id);
    if (!g || !point) return;
    for (const s of g.ships) if (alive(s)) retaskShip(s, point);
  }

  // ------------------------------------------------------------ nav + course
  function playerPos() { return posOf(playerShip); }

  function nearestHostileRange() {
    const p = playerPos();
    if (!p || !game?.ships) return Infinity;
    const pf = playerShip?.faction ?? 'confed';
    let best = Infinity;
    for (const s of game.ships) {
      if (!alive(s) || s === playerShip) continue;
      if (!factionsHostile(pf, s.faction ?? 'confed')) continue;
      const q = posOf(s);
      if (!q) continue;
      const d = dist(p, q);
      if (d < best) best = d;
    }
    return best;
  }

  const navProbe = {
    hostileRange: nearestHostileRange,
    objectiveComplete: (id) => book?.state(id) === 'complete',
  };

  function publishNav() {
    const view = course?.view();
    if (!view) { navPub.id = null; navPub.name = ''; navPub.distance = 0; return; }
    const nav = course.active;
    navPub.id = view.id;
    navPub.name = view.name;
    navPub.index = view.index;
    navPub.total = view.total;
    navPub.visited = view.visited;
    navPub.position.set(nav.position.x, nav.position.y, nav.position.z);
    const p = playerPos();
    navPub.distance = p ? dist(nav.position, p) : 0;
    const check = course.canAdvance(navProbe);
    navPub.locked = !check.ok;
    navPub.lockReason = check.message;
  }

  function onNavArrive(nav) {
    stats.navsVisited++;
    events?.emit?.('nav:arrive', {
      nav: { id: nav.id, name: nav.name, index: nav.index + 1, total: course.total },
      index: nav.index + 1, total: course.total,
      position: new THREE.Vector3(nav.position.x, nav.position.y, nav.position.z),
    });
    if (nav.arrivalComms) say(typeof nav.arrivalComms === 'string' ? { text: nav.arrivalComms } : nav.arrivalComms);

    // Groups keyed to this nav point.
    for (const [id, g] of groups) {
      if (g.def.spawn === 'nav' && g.def.atNav === nav.id) spawnGroup(id);
    }
    // Convoys plod on to wherever the course points next.
    updateEscortRoutes(true);
  }

  function updateEscortRoutes(force = false) {
    const target = course?.active;
    if (!target) return;
    for (const g of groups.values()) {
      if (!g.def.escortRoute || !g.spawned) continue;
      for (const s of g.ships) {
        if (!alive(s)) continue;
        if (force || !s.pilot?.waypoint) retaskShip(s, target.position);
      }
    }
  }

  // ----------------------------------------------------------- trigger runner
  function runTrigger(tdef) {
    if (fireDepth > 8) {
      console.warn(`[mission] trigger chain too deep at "${tdef.id}" — stopping`);
      return;
    }
    fireDepth++;
    try {
      for (const act of tdef.do) runAction(act, tdef);
    } finally {
      fireDepth--;
    }
  }

  function runAction(act, tdef) {
    if (!act || typeof act !== 'object') return;

    if (act.spawn) {
      const ids = Array.isArray(act.spawn) ? act.spawn : [act.spawn];
      for (const id of ids) spawnGroup(id);
    }
    if (act.objective) {
      book?.set(act.objective, act.state ?? 'complete', {
        reason: 'trigger', detail: act.detail ?? null, t: elapsed, mission: missionMeta(),
      });
    }
    if (act.comms) {
      const msg = typeof act.comms === 'string' ? { text: act.comms, from: act.from } : act.comms;
      say(msg, act.delay ?? msg.delay ?? 0);
    }
    if (act.flag) flags.set(act.flag, act.value !== false);
    if (act.setNav) {
      const nav = course?.setActive(act.setNav);
      if (nav) emitNavChanged(nav);
    }
    if (act.unlockNav) {
      const nav = course?.byId(act.unlockNav);
      if (nav) nav.requires = [];
    }
    if (act.fire) machine?.force(act.fire, runTrigger);
    if (act.arm) machine?.arm(act.arm, true);
    if (act.disarm) machine?.arm(act.disarm, false);
    if (act.order) {
      try { game?.ai?.wingmen?.issue?.(act.order, { to: act.to ?? 'all' }); } catch { /* ai optional */ }
    }
    if (act.waypoint) {
      const point = resolvePoint(act.waypoint.nav ? `nav:${act.waypoint.nav}` : act.waypoint.to);
      retaskGroup(act.waypoint.group, point);
    }
    if (act.succeed) finish('complete', typeof act.succeed === 'string' ? act.succeed : `trigger:${tdef?.id ?? '?'}`);
    if (act.fail) finish('failed', typeof act.fail === 'string' ? act.fail : `trigger:${tdef?.id ?? '?'}`);
  }

  function emitNavChanged(nav) {
    publishNav();
    events?.emit?.('nav:changed', {
      nav: { id: nav.id, name: nav.name, index: nav.index + 1, total: course.total },
      index: nav.index + 1, total: course.total,
      position: new THREE.Vector3(nav.position.x, nav.position.y, nav.position.z),
    });
  }

  // ------------------------------------------------------------- objectives
  function updateObjectives() {
    if (!book) return;
    const meta = missionMeta();
    for (const o of book.list) {
      if (o.state === 'complete' || o.state === 'failed') continue;
      if (o.failIf && evalCond(o.failIf, ctx)) {
        book.set(o.id, 'failed', { reason: 'failIf', t: elapsed, mission: meta });
        continue;
      }
      if (o.auto && evalCond(o.auto, ctx)) {
        book.set(o.id, 'complete', { reason: 'auto', t: elapsed, mission: meta });
      }
    }
    updateProgress(meta);
  }

  function updateProgress(meta) {
    if (!book) return;
    for (const o of book.list) {
      const spec = o.progressSpec;
      if (!spec) continue;
      if (spec.of === 'navs') {
        book.setProgress(o.id, course?.navs.filter((n) => n.visited).length ?? 0, course?.total ?? 0, { t: elapsed, mission: meta });
      } else if (spec.of === 'groups') {
        let total = 0, dead = 0;
        for (const gid of spec.groups ?? []) {
          const g = groups.get(gid);
          if (!g) continue;
          total += g.planned;
          dead += g.spawned ? g.planned - aliveCount(g.ships) : 0;
        }
        book.setProgress(o.id, dead, total, { t: elapsed, mission: meta });
      }
    }
  }

  // ------------------------------------------------------------- end states
  function checkEnd() {
    if (state !== 'active') return;

    if (playerShip && !alive(playerShip)) { finish('failed', 'Pilot killed in action'); return; }
    if (def.limits.time > 0 && elapsed > def.limits.time) { finish('failed', 'Out of time'); return; }

    // Type-driven default: losing a ship the mission marked `protect` ends it.
    // escort → the convoy was the mission; defend → the station was the mission.
    for (const g of groups.values()) {
      if (!g.def.protect || !g.spawned) continue;
      if (g.ships.length && !g.ships.some(alive)) {
        finish('failed', `${g.def.names?.[0] ?? g.def.tag} destroyed`);
        return;
      }
    }
    for (const c of def.failure) {
      if (evalCond(c, ctx)) { finish('failed', 'Mission failure condition met'); return; }
    }
    if (book?.anyFailed('primary')) { finish('failed', 'Primary objective failed'); return; }

    if (def.success.length && def.success.every((c) => evalCond(c, ctx))) finish('complete', 'Objectives complete');
  }

  function finish(outcome, reason) {
    if (state !== 'active') return;
    state = outcome;
    book?.closeOut(outcome, { t: elapsed, mission: missionMeta() });

    const objectiveView = book?.view() ?? [];
    const perfect = outcome === 'complete' && objectiveView.every((o) => o.state === 'complete');
    result = {
      id: def.id,
      title: def.title,
      type: def.type,
      outcome,
      reason,
      elapsed: +elapsed.toFixed(2),
      kills: stats.kills,
      playerKills: stats.playerKills,
      killsByClass: { ...stats.killsByClass },
      killsByFaction: { ...stats.killsByFaction },
      losses: stats.losses.slice(),
      objectives: objectiveView,
      perfect,
      next: def.next,
      flags: Object.fromEntries(flags),
      at: Date.now(),
    };

    let record = { promotion: null, rank: campaign.rank };
    try { record = campaign.recordResult(result); } catch (err) { console.warn('[mission] campaign record failed —', err?.message ?? err); }
    result.rank = record.rank?.name ?? null;

    const debrief = (def.debrief?.[outcome === 'complete' ? 'success' : 'failure']) ?? [];
    events?.emit?.(outcome === 'complete' ? 'mission:complete' : 'mission:failed', {
      mission: missionMeta(), result, reason, debrief: debrief.slice(),
    });
    for (const line of debrief) say({ from: 'Talon Control', text: line, tone: outcome === 'complete' ? 'calm' : 'grim', priority: 3 }, 1.2);

    if (record.promotion) {
      events?.emit?.('campaign:promotion', record.promotion);
      say({ from: 'Talon Control', text: `Field promotion, ${record.promotion.to}. It is in the log.`, tone: 'calm', priority: 3 }, 3.2);
    }
  }

  // ------------------------------------------------------------ world set-up
  function clearScenery() {
    const world = game?.world;
    if (!world) return;
    // The world module exposes `planets`/`fields` and a dispose on each; there is
    // no removal API yet, so a mission cleans up exactly what it added and never
    // touches scenery it did not create.
    // TODO(contract): `world.removePlanet(p)` / `world.removeField(f)`.
    for (const p of scenery.planets) {
      try {
        const i = world.planets.indexOf(p);
        if (i >= 0) world.planets.splice(i, 1);
        engine.scene.remove(p.object3D);
        p.dispose?.();
      } catch { /* already gone */ }
    }
    for (const f of scenery.fields) {
      try {
        const i = world.fields.indexOf(f);
        if (i >= 0) world.fields.splice(i, 1);
        engine.scene.remove(f.object3D);
        f.dispose?.();
      } catch { /* already gone */ }
    }
    scenery.planets.length = 0;
    scenery.fields.length = 0;
  }

  function applyWorld() {
    const world = game?.world;
    if (!world || !def.world) return;
    try {
      if (def.world.preset) world.setPreset(def.world.preset);
      for (const p of def.world.planets ?? []) {
        scenery.planets.push(world.addPlanet({
          type: p.type ?? 'rocky',
          position: new THREE.Vector3(...(p.position ?? [0, 0, -100000])),
          radius: p.radius ?? 20000,
          rings: p.rings === true,
          seed: (hashSeed(`${def.id}:planet:${scenery.planets.length}`) ^ seed) >>> 0,
        }));
      }
      const a = def.world.asteroids;
      if (a) {
        scenery.fields.push(world.addAsteroidField({
          center: new THREE.Vector3(...(a.center ?? [0, 0, 0])),
          radius: a.radius ?? 6000,
          count: Math.min(700, a.count ?? 480),
          seed: (hashSeed(`${def.id}:rocks`) ^ seed) >>> 0,
        }));
      }
    } catch (err) {
      console.warn('[mission] world set-up failed —', err?.message ?? err);
    }
  }

  // --------------------------------------------------------------- lifecycle
  function despawnAll() {
    for (const { ship } of owned.values()) despawn(ship);
    owned.clear();
    groups.clear();
    tagIndex.clear();
    wingShips = [];
  }

  function despawn(ship) {
    if (!ship) return;
    try {
      if (ship.group) engine.scene.remove(ship.group);
      game?.flight?.detach?.(ship);
      game?.combat?.detach?.(ship);
      game?.ai?.detach?.(ship);
      const i = game?.ships?.indexOf(ship) ?? -1;
      if (i >= 0) game.ships.splice(i, 1);
      // Clear the player slot too. Leaving `game.player` pointing at a hull that
      // has been detached from flight and combat means the *next* mission happily
      // "reuses" a ship no system is integrating any more, and the player spawns
      // into a world he cannot fly in.
      if (game && game.player === ship) { game.player = null; engine.player = null; }
      ship.alive = false;
      // Geometry and materials are registry-cached and shared between instances —
      // disposing them here would blank every other ship of the same class.
    } catch (err) {
      console.warn('[mission] despawn failed —', err?.message ?? err);
    }
  }

  function reapWrecks() {
    if (owned.size === 0) return;
    for (const [ship, rec] of owned) {
      if (rec.deadAt < 0) continue;
      if (elapsed - rec.deadAt < WRECK_LINGER) continue;
      if (ship === playerShip) continue; // the player's wreck is the camera's problem
      // The record stays in its group with `alive === false`: `groupDestroyed`
      // must keep reading true long after the hull has left the scene.
      despawn(ship);
      owned.delete(ship);
    }
  }

  function ensurePlayer() {
    if (!game) return null;
    if (game.player) {
      playerShip = game.player;
      const p = def.player.position;
      const body = playerShip.body;
      if (body?.position?.set && (p.x || p.y || p.z)) {
        body.position.set(p.x, p.y, p.z);
        body.velocity?.set?.(0, 0, 0);
        playerShip.group?.position?.set?.(p.x, p.y, p.z);
      }
      return playerShip;
    }
    playerShip = game.spawnShip?.(def.player.ship, {
      faction: 'confed',
      isPlayer: true,
      position: def.player.position,
      name: def.player.callsign ?? 'Lead',
      seed: (hashSeed(`${def.id}:player`) ^ seed) >>> 0,
    }) ?? null;
    if (playerShip) owned.set(playerShip, { ship: playerShip, deadAt: -1 });
    return playerShip;
  }

  function spawnWing() {
    wingShips = [];
    if (!game?.spawnShip || !playerShip) return;
    const anchor = posOf(playerShip) ?? { x: 0, y: 0, z: 0 };
    const list = def.wingmen.map(resolveWingman).filter(Boolean);
    for (let i = 0; i < list.length; i++) {
      const w = list[i];
      const side = i % 2 === 0 ? -1 : 1;
      const rank = Math.floor(i / 2) + 1;
      const offset = { x: side * rank * 110, y: -8 * rank, z: 70 * rank };
      let ship = null;
      try {
        ship = game.spawnShip(w.ship, {
          faction: 'confed',
          position: add(anchor, offset),
          quaternion: playerShip.group?.quaternion ?? { x: 0, y: 0, z: 0, w: 1 },
          name: w.callsign,
          seed: (hashSeed(`${def.id}:wing:${w.key}`) ^ seed) >>> 0,
          ai: wingmanAIConfig(w, i, { wing: def.player.wing }),
        });
      } catch (err) {
        console.error('[mission] wingman spawn failed —', err);
      }
      if (!ship) continue;
      ship.wingman = true;
      ship.callsign = w.callsign;
      ship.missionTag = w.key;
      wingShips.push(ship);
      owned.set(ship, { ship, deadAt: -1 });
      tagIndex.set(w.key, [ship]);
      tagIndex.set(String(w.callsign).toLowerCase(), [ship]);
      try { if (ship.pilot) game.ai?.bindToPlayerWing?.(ship.pilot); } catch { /* ai optional */ }
    }
    // Registered as a pseudo-group so conditions can say `groupAlive: {group:'wingmen'}`.
    groups.set('wingmen', {
      def: { id: 'wingmen', tag: 'wingmen', protect: false, escortRoute: false, static: false, spawn: 'immediate' },
      spawned: true, planned: wingShips.length, ships: wingShips,
    });
    tagIndex.set('wingmen', wingShips);
  }

  /**
   * Load a mission by id. Accepts a campaign id, `'@skirmish'` (or `'skirmish'`),
   * or a raw definition object for a designer iterating in the console.
   */
  function load(missionId, loadOpts = {}) {
    unload();

    let raw = null;
    if (missionId && typeof missionId === 'object') raw = missionId;
    else if (!missionId || missionId === '@skirmish' || missionId === 'skirmish') {
      raw = generateSkirmish(seed, loadOpts);
    } else if (MISSIONS[missionId]) {
      raw = MISSIONS[missionId];
    } else if (String(missionId).startsWith('skirmish')) {
      raw = generateSkirmish(seed, loadOpts);
    } else {
      console.warn(`[mission] unknown mission "${missionId}" — falling back to a skirmish`);
      raw = generateSkirmish(seed, loadOpts);
    }

    warnings = [];
    def = normalizeMission(raw, { warnings });
    analysis = analyzeMission(def);
    for (const w of warnings) console.warn(`[mission] ${w}`);
    if (analysis.deadlocked.length) {
      console.warn(`[mission] ${def.id}: objectives with no route to a terminal state: ${analysis.deadlocked.join(', ')}`);
    }
    if (!analysis.canSucceed) console.warn(`[mission] ${def.id}: no reachable success path`);

    rng = makeRng((hashSeed(def.id) ^ seed) >>> 0);
    elapsed = 0;
    flags.clear();
    commsQueue.length = 0;
    result = null;
    stats.kills = 0; stats.playerKills = 0; stats.spawned = 0; stats.navsVisited = 0;
    stats.losses = []; stats.killsByClass = {}; stats.killsByFaction = {};

    course = new NavCourse(def.navs, { lockRange: opts.lockRange ?? NAV_LOCK_RANGE });
    book = new ObjectiveBook(def.objectives, (payload) => events?.emit?.('objective:update', payload));
    machine = new TriggerMachine(def.triggers, ctx);

    for (const [id, g] of Object.entries(def.groups)) {
      groups.set(id, { def: g, spawned: false, planned: g.count, ships: [] });
    }

    state = 'ready';
    publishNav();
    events?.emit?.('mission:loaded', { mission: missionMeta(), briefing: def.briefing.slice(), objectives: book.view(), navs: course.list() });
    return api;
  }

  /** Put the mission in the world and start the clock. */
  function start() {
    if (!def) load(campaign.nextMission(CAMPAIGN) ?? '@skirmish');
    if (state === 'active') return api;

    applyWorld();
    ensurePlayer();
    spawnWing();

    if (game) {
      const base = def.base ?? def.player.position;
      game.basePosition = new THREE.Vector3(base.x, base.y, base.z);
    }

    for (const [id, g] of groups) {
      if (g.def.spawn === 'immediate' && id !== 'wingmen') spawnGroup(id, { silent: true });
    }

    state = 'active';
    elapsed = 0;
    publishNav();
    events?.emit?.('mission:start', {
      mission: missionMeta(),
      briefing: def.briefing.slice(),
      objectives: book.view(),
      navs: course.list(),
      wingmen: wingShips.map((s) => ({ callsign: s.callsign, name: s.name, classId: s.classId })),
    });
    for (const o of book.list) {
      // Republish the opening board so a UI attaching after `mission:start` still
      // gets one `objective:update` per objective.
      if (o.state === 'active') {
        events?.emit?.('objective:update', {
          id: o.id, state: o.state, previous: 'pending', kind: o.kind, label: o.label,
          detail: o.detail, progress: o.progress, reason: 'start',
          objective: { id: o.id, kind: o.kind, label: o.label, detail: o.detail, state: o.state, progress: o.progress, nav: o.nav },
          objectives: book.view(), mission: missionMeta(), t: 0,
        });
      }
    }
    return api;
  }

  function abort() {
    if (state === 'idle') return api;
    const meta = missionMeta();
    if (state === 'active') {
      state = 'aborted';
      try { campaign.recordResult({ id: def.id, outcome: 'aborted', elapsed, playerKills: stats.playerKills }); } catch { /* storage optional */ }
    }
    events?.emit?.('mission:aborted', { mission: meta });
    unload();
    return api;
  }

  function unload() {
    despawnAll();
    clearScenery();
    commsQueue.length = 0;
    def = null; book = null; course = null; machine = null; analysis = null;
    state = 'idle';
    elapsed = 0;
    idleTime = 0;
    playerShip = null;
    navPub.id = null;
    navPub.name = '';
    navPub.distance = 0;
  }

  function missionMeta() {
    if (!def) return null;
    return {
      id: def.id, title: def.title, type: def.type, act: def.act,
      difficulty: def.difficulty, state, elapsed: +elapsed.toFixed(2), next: def.next,
    };
  }

  // ------------------------------------------------------------------ autopilot
  function navLocked(check) {
    events?.emit?.('nav:locked', {
      reason: check.reason, message: check.message, range: check.range ?? null,
      nav: course?.view() ?? null, objective: check.objective ?? null,
    });
    if (check.reason === 'hostiles') {
      say({ from: 'Flight Computer', text: 'Autopilot unavailable — hostile contacts in the area.', tone: 'urgent', priority: 3, voice: 'autopilot disengaged' });
    } else if (check.reason === 'objective') {
      const o = book?.get(check.objective);
      say({ from: 'Talon Control', text: `Negative on autopilot. ${o?.label ?? 'Your objective'} is not complete.`, tone: 'calm', priority: 3 });
    } else if (check.reason === 'end') {
      say({ from: 'Talon Control', text: 'That is the last nav point on the plan, Talon lead.', tone: 'calm', priority: 2 });
    }
    return false;
  }

  /**
   * Autopilot, from a UI button or a mission script. Shares its gate with the
   * `N` key by going through the same `getNavTarget()` — there is exactly one
   * implementation of "may the player leave this nav point", and both callers use
   * it. The radio call, the wing forming up and the convoy being retasked all
   * hang off the resulting `autopilot:engaged` event, for the same reason.
   * @returns {boolean} whether autopilot actually engaged.
   */
  function engageAutopilot() {
    if (state !== 'active' || !course) return false;
    const player = playerShip ?? game?.player;
    if (!player) return false;

    const target = getNavTarget(player);
    if (!target) return false; // getNavTarget already published the refusal

    const ok = game?.flight?.engageAutopilot?.(player, target) ?? false;
    if (!ok) {
      // The flight system runs its own immediate hostile scan; if it refuses, the
      // reason is the same one the HUD is already showing.
      return navLocked({ reason: 'hostiles', message: 'NAV LOCKED · HOSTILES IN THE AREA', range: nearestHostileRange() });
    }
    return true;
  }

  /** Manual course advance (a UI nav-map click, or a debug key). */
  function nextNav(force = false) {
    if (!course) return null;
    if (!force) {
      const check = course.canAdvance(navProbe);
      if (!check.ok) { navLocked(check); return course.view(); }
    }
    const nav = course.advance();
    if (nav) emitNavChanged(nav);
    return course.view();
  }

  /**
   * `flight/Autopilot.js: findNavTarget` calls this when the player presses the
   * autopilot key, and then engages its own autopilot with whatever comes back.
   * That is the *only* hook the flight system offers, so the entire NAV LOCKED
   * gate has to live behind it: returning a position here is this module saying
   * "yes, you may go". Refusing returns null, and the player's key does nothing
   * except put the reason on the radio.
   *
   * Called once per key press, never per frame — which is what makes advancing
   * the course from inside it defensible.
   */
  function getNavTarget(ship = null) {
    if (state !== 'active' || !course?.active) return null;
    const player = playerShip ?? game?.player;
    // A wingman or another system asking just wants the current point.
    if (ship && player && ship !== player) {
      const q = course.active.position;
      return new THREE.Vector3(q.x, q.y, q.z);
    }

    const check = course.canAdvance(navProbe);
    if (!check.ok) { navLocked(check); return null; }
    if (course.active.visited) {
      const next = course.advance();
      if (!next) { navLocked({ reason: 'end', message: 'NAV COURSE COMPLETE' }); return null; }
      emitNavChanged(next);
    }
    const p = course.active.position;
    return new THREE.Vector3(p.x, p.y, p.z);
  }

  // --------------------------------------------------------------- autostart
  function readParams() {
    try {
      if (typeof location === 'undefined' || !location.search) return null;
      return new URLSearchParams(location.search);
    } catch { return null; }
  }

  function maybeAutostart(dt) {
    if (autostartChecked || opts.autostart === false) return;
    idleTime += dt;
    const params = readParams();
    const wanted = params?.get('mission') ?? (params?.has('skirmish') ? '@skirmish' : null);
    // The capture harness composes its own scene; a mission spawning ships behind
    // it would poison every screenshot in the critic run.
    if (params?.get('shot')) { autostartChecked = true; return; }
    if (wanted === 'none') { autostartChecked = true; return; }
    // With `src/ui/` present, mission flow belongs to it: it loads at briefing and
    // starts on the player's go order. Autostarting behind a main menu would spawn
    // a mission the player has not accepted and then throw it away when he does.
    if (!wanted && game?.modules?.ui) { autostartChecked = true; return; }
    // No UI (or not built yet): fly the campaign anyway after a short grace, so
    // `npm run dev` is a game rather than an empty starfield.
    if (!wanted && idleTime < AUTOSTART_GRACE) return;
    autostartChecked = true;
    const id = wanted ?? campaign.nextMission(CAMPAIGN) ?? '@skirmish';
    try {
      load(id);
      start();
    } catch (err) {
      console.error('[mission] autostart failed —', err);
    }
  }

  // ------------------------------------------------------------------- frame
  function update(dt, eng) {
    if (!(dt >= 0)) return;
    if (state === 'idle') { maybeAutostart(dt); return; }
    if (state !== 'active') { flushComms(); return; }

    elapsed += dt;
    if (!playerShip) playerShip = game?.player ?? null;

    const p = playerPos();
    if (p) {
      const arrived = course.checkArrival(p);
      if (arrived) onNavArrive(arrived);
    }

    machine.update(dt, runTrigger);
    updateObjectives();
    checkEnd();
    publishNav();
    flushComms();
    updateEscortRoutes(false);
    reapWrecks();
  }

  function dispose() {
    for (const off of offs) { try { off(); } catch { /* already detached */ } }
    offs.length = 0;
    despawnAll();
    clearScenery();
    if (game && prevIsHostile === undefined) delete game.isHostile;
    else if (game) game.isHostile = prevIsHostile;
    def = null; book = null; course = null; machine = null;
    state = 'idle';
  }

  // --------------------------------------------------------------------- api
  const api = {
    name: 'mission',
    priority: 400,
    update,
    dispose,

    // ---- flow ------------------------------------------------------------
    load,
    start,
    abort,
    restart() { const id = def?.id; unload(); if (id) { load(id); start(); } return api; },
    loadSkirmish(o = {}) { return load('@skirmish', o); },

    // ---- required surface -------------------------------------------------
    get current() { return missionMeta(); },
    get objectives() { return book?.view() ?? []; },
    get navPoints() { return course?.list() ?? []; },
    get activeNav() {
      if (!course?.active) return null;
      return {
        ...course.view(),
        position: navPub.position.clone(),
        distance: navPub.distance,
        locked: navPub.locked,
        lockReason: navPub.lockReason,
      };
    },
    nextNav,
    engageAutopilot,

    // ---- published contracts ---------------------------------------------
    /** `cockpit/state.js` reads this every frame: { name, position, index, total }. */
    get nav() { return course?.active ? navPub : null; },
    get currentNav() { return course?.active ? navPub : null; },
    getNavTarget,

    // ---- introspection ----------------------------------------------------
    get state() { return state; },
    get elapsed() { return elapsed; },
    get definition() { return def; },
    get analysis() { return analysis; },
    get warnings() { return warnings.slice(); },
    get result() { return result; },
    get stats() { return { ...stats }; },
    get wingmen() { return wingShips.map((s) => ({ callsign: s.callsign, name: s.name, classId: s.classId, alive: alive(s), hull: hullOf(s) })); },
    get campaign() { return campaign; },
    missions: missionList,
    campaignOrder: CAMPAIGN.slice(),
    flag: (name) => flags.get(name) ?? false,
    setFlag: (name, v = true) => { flags.set(name, v); },
    /** Test/debug hook: fire a trigger by id regardless of its condition. */
    fireTrigger: (id) => !!machine?.force(id, runTrigger),
    triggerLog: () => machine?.log.slice() ?? [],
    snapshot() {
      return {
        mission: missionMeta(),
        state,
        elapsed: +elapsed.toFixed(2),
        nav: course?.view() ?? null,
        navLocked: navPub.locked,
        objectives: book?.view() ?? [],
        groups: [...groups.entries()].map(([id, g]) => ({ id, spawned: g.spawned, planned: g.planned, alive: aliveCount(g.ships) })),
        triggers: machine?.snapshot() ?? [],
        flags: Object.fromEntries(flags),
        stats: { ...stats },
      };
    },
  };

  return api;
}

export default createMissionSystem;
