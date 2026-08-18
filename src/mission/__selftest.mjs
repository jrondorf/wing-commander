/**
 * src/mission/__selftest.mjs — headless test for the mission system.
 *
 *     node src/mission/__selftest.mjs [--verbose]
 *
 * Most of what this module does is invisible in a screenshot: a trigger that
 * never arms, an objective with no route to `complete`, a failure condition that
 * fires a frame too late — all of them look exactly like a working mission until
 * the player is forty minutes in and stuck. So the real test is this one, and it
 * runs the *actual* MissionSystem against a mock engine rather than a
 * reimplementation of it: same normaliser, same trigger machine, same objective
 * board, same event payloads.
 *
 * The mock supplies just enough game to be dangerous — ships with positions and
 * hull fractions, a flight system whose autopilot refuses near hostiles, and an
 * event bus. A "pilot bot" then flies every hand-authored mission end to end:
 * kill what is in front of you, autopilot when the board is clear, repeat.
 *
 * Asserts:
 *   · every mission normalises with zero validator warnings
 *   · every objective has a reachable terminal state (no deadlock, statically)
 *   · every trigger is reachable in the trigger graph
 *   · the bot completes each mission — no runtime deadlock
 *   · terminal objective states are never revisited
 *   · escort/defend/player-death failure conditions fire, and fire *once*
 *   · NAV LOCKED refuses autopilot with a live hostile in range
 *   · `objective:update` carries every field the UI contract promises
 *   · the same seed produces a byte-identical skirmish, twice, definition and run
 */

import { Events } from '../core/Events.js';
import { createMissionSystem } from './MissionSystem.js';
import { MISSIONS, CAMPAIGN } from './missions.js';
import { normalizeMission, analyzeMission } from './format.js';
import { generateSkirmish } from './skirmish.js';
import { evalCond } from './triggers.js';
import { createCampaign } from './campaign.js';

const VERBOSE = process.argv.includes('--verbose');

// ---------------------------------------------------------------------------
// assertions
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];

function ok(cond, label, detail = '') {
  if (cond) { passed++; if (VERBOSE) console.log(`  ok   ${label}`); return true; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  return false;
}

const eq = (a, b, label) => ok(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// ---------------------------------------------------------------------------
// the mock engine
// ---------------------------------------------------------------------------

class Vec {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { return this.set(v.x, v.y, v.z); }
  clone() { return new Vec(this.x, this.y, this.z); }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
}

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

function makeMockEngine({ seed = 1337 } = {}) {
  const events = new Events();
  const scene = { children: [], add() {}, remove() {} };
  const engine = { events, scene, registry: { get: (k, f) => f() } };

  const game = {
    seed,
    ships: [],
    player: null,
    events,
    modules: {},
    spawnShip(classId, o = {}) {
      const ship = {
        id: game.ships.length,
        classId,
        faction: o.faction ?? 'confed',
        name: o.name ?? '',
        callsign: o.name ?? '',
        isPlayer: !!o.isPlayer,
        alive: true,
        hullFrac: 1,
        stats: { maxSpeed: 450 },
        body: { position: new Vec(o.position?.x ?? 0, o.position?.y ?? 0, o.position?.z ?? 0), velocity: new Vec(), controls: {} },
        group: { position: new Vec(o.position?.x ?? 0, o.position?.y ?? 0, o.position?.z ?? 0), quaternion: { x: 0, y: 0, z: 0, w: 1 } },
        pilot: { waypoint: null },
        aiConfig: o.ai ?? null,
      };
      game.ships.push(ship);
      if (o.isPlayer) { game.player = ship; engine.player = ship; }
      events.emit('ship:spawned', { ship });
      return ship;
    },
    flight: {
      lastTarget: null,
      engageAutopilot(ship, target) {
        // Mirrors flight/Autopilot.js: refuses outright with a hostile in knife range.
        const p = ship?.body?.position;
        if (!p) return false;
        for (const s of game.ships) {
          if (!s.alive || s === ship) continue;
          if (!hostile(ship.faction, s.faction)) continue;
          if (p.distanceTo(s.body.position) <= 3500) return false;
        }
        game.flight.lastTarget = { ship, target: { x: target.x, y: target.y, z: target.z } };
        events.emit('autopilot:engaged', { ship, target });
        return true;
      },
      setStatic() { return true; },
      detach() {},
    },
    combat: { detach() {} },
    ai: { detach() {}, bindToPlayerWing() {}, wingmen: { issue(id, o) { game.ai.orders.push({ id, ...o }); } }, orders: [] },
    // Enough of world/World.js's documented surface to prove the mission both
    // dresses the set and takes its own scenery away again.
    world: {
      preset: null,
      planets: [],
      fields: [],
      setPreset(n) { this.preset = n; return this; },
      addPlanet(o) { const p = { object3D: {}, opts: o, disposed: false, dispose() { p.disposed = true; } }; this.planets.push(p); return p; },
      addAsteroidField(o) { const f = { object3D: {}, opts: o, disposed: false, dispose() { f.disposed = true; } }; this.fields.push(f); return f; },
    },
  };

  engine.game = game;
  return { engine, game, events };
}

const ALLIES = {
  confed: ['confed', 'civilian', 'militia', 'terran'],
  civilian: ['confed', 'civilian', 'militia', 'terran'],
  nephilim: ['nephilim', 'alien'],
};
const hostile = (a = 'confed', b = 'confed') => !(ALLIES[a] ?? [a]).includes(b);

// ---------------------------------------------------------------------------
// the pilot bot — flies a whole mission with no renderer
// ---------------------------------------------------------------------------

function createHarness(missionId, { seed = 1337, dt = 0.25 } = {}) {
  const { engine, game, events } = makeMockEngine({ seed });
  const updates = [];
  events.on('objective:update', (p) => updates.push(p));
  const comms = [];
  events.on('comms:message', (p) => comms.push(p));
  const navLocks = [];
  events.on('nav:locked', (p) => navLocks.push(p));
  const missionEvents = [];
  for (const t of ['mission:loaded', 'mission:start', 'mission:complete', 'mission:failed', 'mission:aborted', 'nav:arrive', 'nav:changed', 'mission:spawn']) {
    events.on(t, (p) => missionEvents.push({ type: t, payload: p }));
  }

  const mission = createMissionSystem(engine, { autostart: false, storage: memoryStorage() });
  mission.load(missionId);
  mission.start();

  let t = 0;
  const step = (seconds = dt) => { mission.update(seconds, engine); t += seconds; };

  const hostiles = () => game.ships.filter((s) => s.alive && s !== game.player && hostile(game.player?.faction ?? 'confed', s.faction));
  const nearestHostileRange = () => {
    const p = game.player?.body?.position;
    if (!p) return Infinity;
    let best = Infinity;
    for (const s of hostiles()) best = Math.min(best, p.distanceTo(s.body.position));
    return best;
  };

  const kill = (ship, byPlayer = true) => {
    if (!ship || !ship.alive) return;
    ship.alive = false;
    ship.hullFrac = 0;
    events.emit('ship:destroyed', {
      ship, position: ship.body.position.clone(), killer: byPlayer ? game.player : null,
      byPlayer, cause: 'weapon', scale: 1, faction: ship.faction,
    });
  };

  const killTag = (tag, byPlayer = true) => {
    for (const s of game.ships) if (s.missionTag === tag || s.missionGroup === tag) kill(s, byPlayer);
  };

  const damageTag = (tag, frac) => {
    for (const s of game.ships) if (s.missionTag === tag || s.missionGroup === tag) s.hullFrac = frac;
  };

  const teleportToNav = () => {
    const nav = mission.activeNav;
    const p = game.player?.body?.position;
    if (!nav || !p) return false;
    p.set(nav.position.x, nav.position.y, nav.position.z);
    game.player.group.position.set(p.x, p.y, p.z);
    return true;
  };

  return {
    engine, game, events, mission,
    updates, comms, navLocks, missionEvents,
    get t() { return t; },
    step, kill, killTag, damageTag, teleportToNav, hostiles, nearestHostileRange,
  };
}

/**
 * Fly the mission: kill what is on the board, autopilot when it is clear.
 * @returns {{outcome:string, t:number, reason:string}}
 */
function flyMission(h, { limit = 900, killEvery = 1.5, log = [] } = {}) {
  let lastKill = -99;
  let lastNavTry = -99;
  while (h.mission.state === 'active' && h.t < limit) {
    h.step();
    const live = h.hostiles();
    if (live.length) {
      // Shoot one down every `killEvery` seconds — a fight, not a cheat code.
      if (h.t - lastKill >= killEvery) {
        const victim = live[0];
        log.push(`${h.t.toFixed(1)}s kill ${victim.classId} (${victim.missionGroup ?? '-'})`);
        h.kill(victim);
        lastKill = h.t;
      }
      continue;
    }
    if (h.t - lastNavTry < 2) continue;
    lastNavTry = h.t;
    const nav = h.mission.activeNav;
    if (!nav) continue;
    if (!nav.visited) { h.teleportToNav(); log.push(`${h.t.toFixed(1)}s arrive ${nav.name}`); continue; }
    if (h.mission.engageAutopilot()) {
      h.teleportToNav();
      log.push(`${h.t.toFixed(1)}s autopilot -> ${h.mission.activeNav?.name}`);
    }
  }
  return { outcome: h.mission.state, t: h.t, reason: h.mission.result?.reason ?? '' };
}

// ---------------------------------------------------------------------------
// 1. static analysis of every hand-authored mission
// ---------------------------------------------------------------------------
console.log('\n— static analysis —');
for (const id of CAMPAIGN) {
  const warnings = [];
  const def = normalizeMission(MISSIONS[id], { warnings });
  const a = analyzeMission(def);

  ok(warnings.length === 0, `${id}: definition validates`, warnings.join(' | '));
  ok(a.deadlocked.length === 0, `${id}: every objective can reach a terminal state`, a.deadlocked.join(', '));
  ok(a.unreachableTriggers.length === 0, `${id}: every trigger is reachable`, a.unreachableTriggers.join(', '));
  ok(a.canSucceed, `${id}: a success path exists`);
  ok(def.objectives.some((o) => o.kind === 'primary'), `${id}: has a primary objective`);
  ok(def.navs.length >= 2, `${id}: has a nav course`);
  const types = new Set(Object.values(def.groups).map((g) => g.ship));
  ok(types.size >= 1, `${id}: spawns something`);
  if (VERBOSE) console.log(`       ${id}: ${def.navs.length} navs, ${Object.keys(def.groups).length} groups, ${def.triggers.length} triggers, ${def.objectives.length} objectives`);
}

// Every mission type in the campaign, and escalating difficulty.
{
  const defs = CAMPAIGN.map((id) => normalizeMission(MISSIONS[id]));
  const kinds = new Set(defs.map((d) => d.type));
  for (const t of ['patrol', 'escort', 'defend', 'strike']) ok(kinds.has(t), `campaign covers the "${t}" mission type`);
  let rising = true;
  for (let i = 1; i < defs.length; i++) if (defs[i].difficulty <= defs[i - 1].difficulty) rising = false;
  ok(rising, 'campaign difficulty escalates monotonically', defs.map((d) => d.difficulty).join(' → '));
  for (let i = 0; i < defs.length - 1; i++) eq(defs[i].next, defs[i + 1].id, `${defs[i].id} chains to ${defs[i + 1].id}`);
}

// ---------------------------------------------------------------------------
// 2. fly every mission to completion
// ---------------------------------------------------------------------------
console.log('\n— happy path (no deadlocks) —');
for (const id of CAMPAIGN) {
  const h = createHarness(id);
  const log = [];
  const res = flyMission(h, { log });

  eq(res.outcome, 'complete', `${id}: mission completes`);
  if (res.outcome !== 'complete' && VERBOSE) console.log(log.join('\n'));

  const objectives = h.mission.objectives;
  const primaries = objectives.filter((o) => o.kind === 'primary');
  ok(primaries.every((o) => o.state === 'complete'), `${id}: every primary objective completed`,
    primaries.filter((o) => o.state !== 'complete').map((o) => `${o.id}:${o.state}`).join(', '));
  ok(objectives.every((o) => o.state === 'complete' || o.state === 'failed'), `${id}: no objective left dangling`);
  ok(h.t < 900, `${id}: finished inside the deadlock budget`, `${h.t.toFixed(0)}s`);

  // The trigger graph actually ran.
  const fired = h.mission.triggerLog().map((e) => e.id);
  ok(fired.length >= 3, `${id}: trigger graph fired (${fired.length} triggers)`);
  ok(h.comms.length >= 3, `${id}: mission radio traffic emitted (${h.comms.length} lines)`);
  ok(h.updates.length >= objectives.length, `${id}: objective:update emitted for the whole board`);

  // Terminal states are terminal.
  const seenTerminal = new Set();
  let regressed = null;
  for (const u of h.updates) {
    if (seenTerminal.has(u.id) && u.reason !== 'progress') regressed = `${u.id} → ${u.state}`;
    if (u.state === 'complete' || u.state === 'failed') seenTerminal.add(u.id);
  }
  ok(!regressed, `${id}: no objective leaves a terminal state`, regressed ?? '');

  // The nav course was actually flown. A mission that ends on its objectives —
  // a carrier defence, say — legitimately finishes before the last nav point, so
  // only missions that *ask* for a full sweep are held to one.
  const navs = h.mission.navPoints;
  ok(navs.some((n) => n.visited), `${id}: the nav course was flown`);
  const wantsFullSweep = JSON.stringify(h.mission.definition.objectives).includes('allNavsVisited');
  if (wantsFullSweep) {
    ok(navs.every((n) => n.visited), `${id}: whole nav course swept`, navs.filter((n) => !n.visited).map((n) => n.id).join(','));
  }

  // Campaign bookkeeping.
  const summary = h.mission.campaign.summary();
  ok(summary.completed.includes(id), `${id}: recorded in the campaign save`);
  ok(summary.kills > 0, `${id}: kills credited to the pilot record`);
}

// ---------------------------------------------------------------------------
// 3. failure conditions
// ---------------------------------------------------------------------------
console.log('\n— failure conditions —');

// escort: the thing you were protecting dies.
{
  const h = createHarness('m2-amaranth');
  h.step(1);
  ok(h.game.ships.some((s) => s.classId === 'civ_drayman'), 'escort: convoy spawned at mission start');
  h.killTag('amaranth', false);
  h.step(0.5);
  eq(h.mission.state, 'failed', 'escort: losing the convoy fails the mission');
  ok(/destroyed/i.test(h.mission.result?.reason ?? ''), 'escort: failure reason names the loss', h.mission.result?.reason);
  const deliver = h.mission.objectives.find((o) => o.id === 'deliver');
  eq(deliver.state, 'failed', 'escort: the escort objective is marked failed');
  const failedEvents = h.missionEvents.filter((e) => e.type === 'mission:failed');
  eq(failedEvents.length, 1, 'escort: mission:failed fires exactly once');
  h.step(2);
  eq(h.missionEvents.filter((e) => e.type === 'mission:failed').length, 1, 'escort: and does not fire again after the fact');
}

// escort: losing *one* freighter fails only the secondary.
{
  const h = createHarness('m2-amaranth');
  h.step(1);
  const first = h.game.ships.find((s) => s.classId === 'civ_drayman');
  h.kill(first, false);
  h.step(0.5);
  eq(h.mission.state, 'active', 'escort: one freighter lost is survivable');
  eq(h.mission.objectives.find((o) => o.id === 'intact').state, 'failed', 'escort: the "no losses" secondary fails');
  ok(h.mission.flag('lost-hauler'), 'escort: the designer flag was set by its trigger');
}

// defend: the station dies.
{
  const h = createHarness('m3-talon');
  h.step(1);
  ok(h.game.ships.some((s) => s.classId === 'confed_carrier'), 'defend: the carrier is in the world');
  h.killTag('talon', false);
  h.step(0.5);
  eq(h.mission.state, 'failed', 'defend: losing the carrier fails the mission');
  eq(h.mission.objectives.find((o) => o.id === 'hull').state, 'failed', 'defend: the survival objective fails');
}

// defend: a hull threshold fails an objective without ending the mission.
{
  const h = createHarness('m3-talon');
  h.step(1);
  h.damageTag('talon', 0.5);
  h.step(0.5);
  eq(h.mission.objectives.find((o) => o.id === 'noscratch').state, 'failed', 'defend: the 70% hull secondary fails on damage');
  eq(h.mission.state, 'active', 'defend: the mission continues at 50% hull');
  ok(h.comms.some((c) => /hull hits|forty percent/i.test(c.text)), 'defend: damage thresholds fire radio traffic');
  h.damageTag('talon', 0.3);
  h.step(0.5);
  eq(h.mission.state, 'failed', 'defend: below 35% hull the primary fails and ends it');
}

// strike: the player dies.
{
  const h = createHarness('m4-leviathan');
  h.step(1);
  h.kill(h.game.player, false);
  h.step(0.5);
  eq(h.mission.state, 'failed', 'strike: pilot death fails the mission');
  ok(/pilot/i.test(h.mission.result?.reason ?? ''), 'strike: failure reason is the pilot', h.mission.result?.reason);
}

// strike: losing the torpedo bomber fails a secondary, not the mission.
{
  const h = createHarness('m4-leviathan');
  h.step(1);
  const bishop = h.game.ships.find((s) => s.callsign === 'Bishop');
  ok(!!bishop, 'strike: the named wingman Bishop was assigned to the flight');
  ok(bishop?.aiConfig?.skill === 'ace' && bishop?.aiConfig?.temperament === 'cautious',
    'strike: Bishop carries his roster personality into ai.attach', JSON.stringify(bishop?.aiConfig));
  h.kill(bishop, false);
  h.step(0.5);
  eq(h.mission.objectives.find((o) => o.id === 'bishop').state, 'failed', 'strike: "bring Bishop home" fails');
  eq(h.mission.state, 'active', 'strike: the mission continues without him');
  ok(h.mission.flag('bishop-lost'), 'strike: the bishop-lost flag is set');
}

// timeout / limit handling on a synthetic definition.
{
  const h = createHarness({
    id: 'test-timelimit', title: 'Time', type: 'patrol',
    navs: [{ id: 'n1', position: [0, 0, -1000] }, { id: 'n2', position: [0, 0, -2000] }],
    objectives: [{ id: 'a', kind: 'primary', label: 'never', auto: { flag: 'nope' } }],
    limits: { time: 5 },
  });
  for (let i = 0; i < 40; i++) h.step(0.25);
  eq(h.mission.state, 'failed', 'time limit: running out of time fails the mission');
  ok(/time/i.test(h.mission.result?.reason ?? ''), 'time limit: reason mentions time');
}

// ---------------------------------------------------------------------------
// 4. NAV LOCKED
// ---------------------------------------------------------------------------
console.log('\n— nav lock —');
{
  const h = createHarness('m1-perimeter');
  h.step(0.5);

  // Fly to nav 1, then nav 2 where the scouts are waiting.
  h.teleportToNav(); h.step(0.5);
  ok(h.mission.engageAutopilot(), 'nav: autopilot engages with a clear board');
  h.teleportToNav(); h.step(0.5);
  ok(h.hostiles().length > 0, 'nav: arriving at nav 2 spawned the scouts');

  // Park a bandit next to the player and try again.
  const bandit = h.hostiles()[0];
  bandit.body.position.copy(h.game.player.body.position);
  bandit.body.position.z += 900;
  const before = h.navLocks.length;
  const engaged = h.mission.engageAutopilot();
  eq(engaged, false, 'nav: autopilot refuses with a hostile at 900 m');
  ok(h.navLocks.length > before, 'nav: nav:locked was emitted');
  eq(h.navLocks.at(-1).reason, 'hostiles', 'nav: the lock reason is "hostiles"');
  ok(/NAV LOCKED/.test(h.navLocks.at(-1).message), 'nav: the lock message reads NAV LOCKED', h.navLocks.at(-1).message);
  ok(h.mission.activeNav.locked, 'nav: the published nav block reports locked');
  ok(h.comms.some((c) => /autopilot/i.test(c.text)), 'nav: the refusal is spoken on the radio');

  // Clear the board and it unlocks.
  for (const s of h.hostiles()) h.kill(s);
  h.step(0.5);
  ok(!h.mission.activeNav.locked, 'nav: the course unlocks once the board is clear');
  ok(h.mission.engageAutopilot(), 'nav: autopilot engages again');
  eq(h.mission.activeNav.index, 3, 'nav: the course advanced to nav 3');
}

// The `N` key path: flight/Autopilot.js asks getNavTarget() and engages itself,
// so the whole lock has to work through that call too.
{
  const h = createHarness('m1-perimeter');
  h.step(0.5);
  const first = h.mission.getNavTarget(h.game.player);
  ok(!!first, 'getNavTarget: returns a target with a clear board');
  eq(Math.round(first.z), -21000, 'getNavTarget: and it is nav 1');

  h.teleportToNav(); h.step(0.5);
  const second = h.mission.getNavTarget(h.game.player);
  ok(!!second && Math.round(second.z) === -47000, 'getNavTarget: advances the course once nav 1 is reached');
  h.teleportToNav(); h.step(0.5);

  const bandit = h.hostiles()[0];
  bandit.body.position.copy(h.game.player.body.position);
  bandit.body.position.z += 1200;
  const before = h.navLocks.length;
  eq(h.mission.getNavTarget(h.game.player), null, 'getNavTarget: refuses with a hostile in range');
  ok(h.navLocks.length > before, 'getNavTarget: and emits nav:locked so the HUD can say why');

  const wing = h.game.ships.find((x) => x.wingman);
  ok(!!h.mission.getNavTarget(wing), 'getNavTarget: a wingman still gets the current nav point');
  eq(h.mission.activeNav.index, 2, 'getNavTarget: asking on behalf of a wingman does not advance the course');

  // Engaging autopilot takes the wing with it.
  for (const s of h.hostiles()) h.kill(s);
  h.step(0.5);
  const commsBefore = h.comms.length;
  ok(h.mission.engageAutopilot(), 'autopilot: engages once the board is clear');
  ok(h.comms.length > commsBefore, 'autopilot: the engagement is called on the radio');
  ok(h.comms.some((c) => /Autopilot engaged/i.test(c.text)), 'autopilot: with the nav point named');
}

// objective-gated nav: mission 4 will not let you leave until the target is dead.
{
  const h = createHarness('m4-leviathan');
  h.step(0.5);
  const def = h.mission.definition;
  const n4 = def.navs.find((n) => n.id === 'n4');
  eq(n4.requires.length, 1, 'nav: nav 4 declares an objective requirement');
  eq(n4.requires[0], 'kill', 'nav: and it is the strike objective');
}

// ---------------------------------------------------------------------------
// 5. the objective:update contract (agent-ui depends on these fields)
// ---------------------------------------------------------------------------
console.log('\n— objective:update contract —');
{
  const h = createHarness('m1-perimeter');
  flyMission(h);
  ok(h.updates.length > 0, 'contract: objective:update fired');
  const required = ['id', 'state', 'previous', 'kind', 'label', 'objective', 'objectives', 'mission', 't', 'reason'];
  let missing = null;
  for (const u of h.updates) {
    for (const k of required) if (!(k in u)) missing = `${u.id}: missing "${k}"`;
    if (!Array.isArray(u.objectives)) missing = `${u.id}: objectives is not an array`;
    if (u.objective && typeof u.objective.label !== 'string') missing = `${u.id}: objective.label is not a string`;
    if (u.mission && typeof u.mission.id !== 'string') missing = `${u.id}: mission.id is not a string`;
    if (!['pending', 'active', 'complete', 'failed'].includes(u.state)) missing = `${u.id}: bad state "${u.state}"`;
    if (!['primary', 'secondary', 'bonus'].includes(u.kind)) missing = `${u.id}: bad kind "${u.kind}"`;
  }
  ok(!missing, 'contract: every payload carries the documented fields', missing ?? '');

  const withProgress = h.updates.filter((u) => u.progress);
  ok(withProgress.length > 0, 'contract: progress counters are published');
  ok(withProgress.every((u) => Number.isFinite(u.progress.current) && Number.isFinite(u.progress.total)),
    'contract: progress is {current,total} numbers');

  // comms payloads match ai/chatter.js so the UI has one shape to render.
  const commsRequired = ['from', 'text', 'tone', 'priority', 'kind', 't'];
  let commsMissing = null;
  for (const c of h.comms) for (const k of commsRequired) if (!(k in c)) commsMissing = `missing ${k}`;
  ok(!commsMissing, 'contract: comms:message matches the chatter.js shape', commsMissing ?? '');
}

// ---------------------------------------------------------------------------
// 6. determinism
// ---------------------------------------------------------------------------
console.log('\n— determinism —');
{
  const a = generateSkirmish(4242);
  const b = generateSkirmish(4242);
  eq(JSON.stringify(a), JSON.stringify(b), 'skirmish: same seed produces an identical definition');

  const c = generateSkirmish(4243);
  ok(JSON.stringify(a) !== JSON.stringify(c), 'skirmish: a different seed produces a different mission');

  // …and the same seed produces the same *flight*, not just the same definition.
  const run = (seed) => {
    const h = createHarness(generateSkirmish(seed), { seed });
    flyMission(h);
    return {
      snapshot: h.mission.snapshot(),
      triggers: h.mission.triggerLog(),
      spawns: h.game.ships.map((s) => ({
        c: s.classId, f: s.faction,
        p: [Math.round(s.body.position.x), Math.round(s.body.position.y), Math.round(s.body.position.z)],
      })),
    };
  };
  const r1 = run(9001);
  const r2 = run(9001);
  eq(JSON.stringify(r1.spawns), JSON.stringify(r2.spawns), 'skirmish: identical spawn positions across runs');
  eq(JSON.stringify(r1.triggers), JSON.stringify(r2.triggers), 'skirmish: identical trigger firing order and times');
  eq(JSON.stringify(r1.snapshot.objectives), JSON.stringify(r2.snapshot.objectives), 'skirmish: identical objective outcome');

  // Every generator type is playable.
  for (const type of ['patrol', 'escort', 'strike', 'defend']) {
    for (const difficulty of [1, 3, 5]) {
      const gen = generateSkirmish(777 + difficulty, { type, difficulty });
      const warnings = [];
      const def = normalizeMission(gen, { warnings });
      const an = analyzeMission(def);
      ok(warnings.length === 0, `skirmish ${type}/d${difficulty}: validates`, warnings.join(' | '));
      ok(an.deadlocked.length === 0, `skirmish ${type}/d${difficulty}: no deadlocked objective`, an.deadlocked.join(','));
      const h = createHarness(gen);
      const res = flyMission(h, { limit: 900 });
      eq(res.outcome, 'complete', `skirmish ${type}/d${difficulty}: completes`);
      const ships = Object.values(def.groups).reduce((n, g) => n + g.count, 0);
      ok(ships <= def.limits.maxShips, `skirmish ${type}/d${difficulty}: within the ship budget (${ships}/${def.limits.maxShips})`);
    }
  }
}

// ---------------------------------------------------------------------------
// 7. condition evaluator edge cases
// ---------------------------------------------------------------------------
console.log('\n— condition evaluator —');
{
  const ctx = {
    elapsed: () => 10,
    navVisited: (id) => id === 'n1',
    activeNavId: () => 'n2',
    navIndex: () => 1,
    allNavsVisited: () => false,
    groupSpawned: (id) => id === 'a',
    groupAlive: (id) => (id === 'a' ? 0 : 3),
    groupTotal: () => 3,
    tagAlive: (t) => t === 'live',
    tagDestroyed: (t) => t === 'dead',
    tagHull: (t) => (t === 'hurt' ? 0.3 : 1),
    playerHull: () => 0.8,
    playerKills: () => 4,
    kills: () => 9,
    distance: (a, b) => (a === 'player' && b === 'near' ? 800 : 9000),
    objectiveState: (id) => (id === 'done' ? 'complete' : 'active'),
    objectivesComplete: () => false,
    objectivesFailed: () => false,
    flag: (f) => f === 'set',
  };
  ok(evalCond({ always: true }, ctx), 'cond: always');
  ok(evalCond(null, ctx), 'cond: a missing condition is true');
  ok(!evalCond({}, ctx), 'cond: an empty object is false, not vacuously true');
  ok(!evalCond({ typoKey: 1 }, ctx), 'cond: an unknown key does not fire the trigger');
  ok(evalCond({ time: 5 }, ctx) && !evalCond({ time: 50 }, ctx), 'cond: time');
  ok(evalCond({ elapsed: { gte: 5, lte: 20 } }, ctx), 'cond: elapsed window');
  ok(evalCond({ nav: 'n1' }, ctx) && !evalCond({ nav: 'n9' }, ctx), 'cond: navVisited');
  ok(evalCond({ groupDestroyed: 'a' }, ctx), 'cond: groupDestroyed needs spawned + empty');
  ok(!evalCond({ groupDestroyed: 'b' }, ctx), 'cond: an unspawned group is not "destroyed"');
  ok(evalCond({ groupAlive: { group: 'b', gte: 2 } }, ctx), 'cond: groupAlive window');
  ok(evalCond({ hullBelow: { ship: 'hurt', frac: 0.5 } }, ctx), 'cond: hullBelow');
  ok(!evalCond({ hullBelow: { ship: 'fine', frac: 0.5 } }, ctx), 'cond: hullBelow on a healthy ship');
  ok(evalCond({ within: { of: 'player', to: 'near', range: 1000 } }, ctx), 'cond: within');
  ok(!evalCond({ within: { of: 'player', to: 'far', range: 1000 } }, ctx), 'cond: within, out of range');
  ok(evalCond({ objective: { id: 'done', state: 'complete' } }, ctx), 'cond: objective state');
  ok(evalCond({ any: [{ time: 500 }, { flag: 'set' }] }, ctx), 'cond: any');
  ok(!evalCond({ all: [{ time: 5 }, { flag: 'unset' }] }, ctx), 'cond: all');
  ok(evalCond({ not: { flag: 'unset' } }, ctx), 'cond: not');
  ok(evalCond({ playerKillsGte: 4 }, ctx) && !evalCond({ playerKillsGte: 5 }, ctx), 'cond: playerKillsGte');
  ok(evalCond({ time: 5, flag: 'set' }, ctx), 'cond: keys AND together');
  ok(!evalCond({ time: 5, flag: 'unset' }, ctx), 'cond: one false key fails the whole condition');
}

// repeating triggers must not machine-gun the radio.
{
  const h = createHarness({
    id: 'test-repeat', title: 'Repeat', type: 'patrol',
    navs: [{ id: 'n1', position: [0, 0, -1000] }, { id: 'n2', position: [0, 0, -2000] }],
    objectives: [{ id: 'a', kind: 'primary', label: 'x', auto: { time: 100 } }],
    triggers: [
      { id: 'spam', once: false, on: { always: true }, do: [{ comms: { from: 'X', text: 'again' } }] },
      { id: 'ticker', once: false, cooldown: 2, on: { always: true }, do: [{ comms: { from: 'Y', text: 'tick' } }] },
    ],
  });
  for (let i = 0; i < 40; i++) h.step(0.25); // 10 seconds
  const spam = h.mission.triggerLog().filter((e) => e.id === 'spam').length;
  const tick = h.mission.triggerLog().filter((e) => e.id === 'ticker').length;
  eq(spam, 1, 'repeat: an edge-triggered repeat on a standing condition fires once');
  ok(tick >= 4 && tick <= 6, 'repeat: a cooldown repeat fires on its cooldown', `${tick} in 10 s at cooldown 2`);
}

// ---------------------------------------------------------------------------
// 8. campaign persistence
// ---------------------------------------------------------------------------
console.log('\n— campaign —');
{
  const store = memoryStorage();
  const c1 = createCampaign({ seed: 1, storage: store });
  eq(c1.rank.id, 'ens', 'campaign: a new pilot starts at the bottom');
  c1.recordResult({ id: 'm1-perimeter', outcome: 'complete', elapsed: 300, playerKills: 8, next: 'm2-amaranth', losses: [] });
  ok(c1.isComplete('m1-perimeter'), 'campaign: completion is recorded');
  eq(c1.rank.id, 'lt', 'campaign: 1 mission + 8 kills promotes to 1st Lieutenant');

  const c2 = createCampaign({ seed: 1, storage: store });
  ok(c2.isComplete('m1-perimeter'), 'campaign: state survives a reload');
  eq(c2.rank.id, 'lt', 'campaign: rank survives a reload');
  eq(c2.nextMission(CAMPAIGN), 'm2-amaranth', 'campaign: nextMission skips finished missions');

  c2.recordResult({ id: 'm2-amaranth', outcome: 'complete', elapsed: 400, playerKills: 12, losses: ['Gremlin'] });
  eq(c2.summary().losses.length, 1, 'campaign: wingman losses are remembered');
  eq(c2.rank.id, 'capt', 'campaign: 2 missions + 20 kills makes Captain');
  ok(c2.summary().kills === 20, 'campaign: kills accumulate across missions');

  // A blocked storage API must not take the mission system down with it.
  const hostile = {
    getItem() { throw new Error('SecurityError: storage is disabled'); },
    setItem() { throw new Error('SecurityError: storage is disabled'); },
    removeItem() { throw new Error('SecurityError: storage is disabled'); },
  };
  let threw = null;
  let c3 = null;
  try { c3 = createCampaign({ seed: 1, storage: hostile }); c3.recordResult({ id: 'x', outcome: 'complete', playerKills: 1 }); } catch (err) { threw = err; }
  ok(!threw, 'campaign: a throwing storage API is survived', String(threw?.message ?? ''));
  ok(c3 && !c3.persistent, 'campaign: and reports itself as non-persistent');
  ok(c3.isComplete('x'), 'campaign: still tracks state in memory');

  // No storage at all (the capture harness).
  let noStorage = null;
  try { noStorage = createCampaign({ seed: 1, storage: undefined }); } catch (err) { threw = err; }
  ok(!!noStorage, 'campaign: works with no storage object at all');
}

// ---------------------------------------------------------------------------
// 9. lifecycle: load → start → abort → reload, with no ship leaks
// ---------------------------------------------------------------------------
console.log('\n— lifecycle —');
{
  const h = createHarness('m1-perimeter');
  h.step(1);
  const afterStart = h.game.ships.length;
  ok(afterStart >= 2, 'lifecycle: the player and his wing are in the world', String(afterStart));
  ok(h.game.player, 'lifecycle: a player ship exists');
  eq(h.mission.wingmen.length, 1, 'lifecycle: one wingman assigned for mission 1');
  eq(h.mission.wingmen[0].callsign, 'Ripcord', 'lifecycle: and it is the one the mission named');

  h.mission.abort();
  eq(h.mission.state, 'idle', 'lifecycle: abort returns to idle');
  eq(h.game.ships.length, 0, 'lifecycle: abort removes every mission-spawned ship');
  ok(h.missionEvents.some((e) => e.type === 'mission:aborted'), 'lifecycle: mission:aborted emitted');

  h.mission.load('m2-amaranth');
  h.mission.start();
  h.step(1);
  ok(h.game.ships.length >= 4, 'lifecycle: a second mission loads cleanly into the same session');
  ok(h.game.player && h.game.ships.includes(h.game.player), 'lifecycle: the new player ship is registered with the game');
  eq(h.mission.current.id, 'm2-amaranth', 'lifecycle: current reports the new mission');
  ok(h.mission.navPoints.length === 3, 'lifecycle: nav course rebuilt');

  h.mission.dispose();
  eq(h.game.ships.length, 0, 'lifecycle: dispose cleans the world');
}

// scenery: the mission dresses the set, and takes its own scenery away again.
{
  const h = createHarness('m1-perimeter');
  h.step(0.5);
  eq(h.game.world.preset, 'nebula-teal', 'scenery: the mission set the nebula preset');
  eq(h.game.world.planets.length, 1, 'scenery: the mission added its planet');
  eq(h.game.world.fields.length, 1, 'scenery: the mission added its asteroid field');
  const planet = h.game.world.planets[0];
  ok(planet.opts.rings === true, 'scenery: rings are requested explicitly, not left to chance');
  ok(planet.opts.radius === 42000, 'scenery: with the authored radius');
  h.mission.abort();
  eq(h.game.world.planets.length, 0, 'scenery: abort removes the planet it added');
  ok(planet.disposed, 'scenery: and disposes it');
  eq(h.game.world.fields.length, 0, 'scenery: abort removes the asteroid field too');
}

// wingman orders reach ai/wingmen.js through its documented command ids.
{
  const h = createHarness('m3-talon');
  h.step(0.5);
  h.damageTag('talon', 0.4);
  h.step(0.5);
  ok(h.game.ai.orders.some((o) => o.id === 'breakAndAttack'), 'orders: a trigger can issue a wingman order');
  eq(h.game.ai.orders[0].to, 'all', 'orders: addressed to the whole wing');
}

// wrecks get reaped so a long mission does not grow without bound.
{
  const h = createHarness('m1-perimeter');
  h.step(0.5); h.teleportToNav(); h.step(0.5);
  h.mission.engageAutopilot(); h.teleportToNav(); h.step(0.5);
  const peak = h.game.ships.length;
  for (const s of h.hostiles()) h.kill(s);
  for (let i = 0; i < 60; i++) h.step(0.25);
  ok(h.game.ships.length < peak, 'lifecycle: wrecks are reaped out of the world', `${peak} → ${h.game.ships.length}`);
  const g = h.mission.snapshot().groups.find((x) => x.id === 'scouts');
  eq(g.alive, 0, 'lifecycle: a reaped group still reads as destroyed');
}

// ---------------------------------------------------------------------------
console.log('');
if (failures.length) {
  console.log(`FAILED — ${failures.length} assertion(s), ${passed} passed`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log(`PASSED — ${passed} assertions`);
