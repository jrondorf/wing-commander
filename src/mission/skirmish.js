/**
 * src/mission/skirmish.js — the procedural mission generator.
 *
 * Four hand-authored missions is a campaign; it is not a game you can sit down to
 * on a Tuesday. The generator exists so there is always something to fly, and it
 * is deliberately built as a *definition emitter*: it returns the same plain
 * object literal a designer would have typed, and the runtime cannot tell the
 * difference. That constraint is doing real work — anything the generator cannot
 * express is a hole in the schema, and it has found two already (per-group facing
 * anchors and `any:` trigger conditions both exist because of this file).
 *
 * Seeded from `engine.game.seed` through `makeRng`, so `?skirmish=1&seed=42` is
 * the same flight every time, on every machine — which is what makes it usable as
 * a regression fixture as well as a game mode.
 */

import { makeRng, hashSeed } from '../core/Rand.js';

const PRESETS = ['nebula-teal', 'nebula-magenta', 'nebula-ember', 'nebula-deep-blue', 'nebula-vista'];

const ENEMY_LIGHT = 'alien_manta';
const ENEMY_HEAVY = 'alien_moray';

const SYSTEM_NAMES = [
  'Ariel', 'Kestrel Reach', 'Vega Deep', 'Tamayo', 'Cygnet', 'Hollow Sept',
  'Marrow', 'Bell Drift', 'Nyx Shoal', 'Correga', 'Ashfall', 'Ptolemy Gap',
];
const SECTOR_TAGS = ['Alpha', 'Bravo', 'Cassius', 'Delta', 'Echo', 'Foxglove', 'Gamma', 'Halcyon'];

const WING_POOL = ['ripcord', 'gremlin', 'anvil', 'coldsnap', 'sundog', 'bishop', 'quill', 'wrecker'];

const TYPES = ['patrol', 'escort', 'strike', 'defend'];

/** Round to a metre so two runs of the same seed produce byte-identical numbers. */
const r1 = (v) => Math.round(v);

/**
 * Generate a skirmish mission definition.
 *
 * @param {number} seed  usually `engine.game.seed`
 * @param {object} [opts] { type, difficulty 1..5, navs, index }
 * @returns {object} an un-normalized mission definition (see format.js)
 */
export function generateSkirmish(seed = 1337, opts = {}) {
  const index = Math.max(0, Math.round(opts.index ?? 0));
  const rootSeed = (hashSeed(`skirmish:${seed}:${index}`) ^ 0) >>> 0;
  const rng = makeRng(rootSeed);

  const type = TYPES.includes(opts.type) ? opts.type : rng.pick(TYPES);
  const difficulty = Math.min(5, Math.max(1, Math.round(opts.difficulty ?? rng.int(1, 4))));
  const system = rng.pick(SYSTEM_NAMES);
  const sector = rng.pick(SECTOR_TAGS);
  const preset = rng.pick(PRESETS);

  // ---- nav course: a dogleg out and back, never a straight line -----------
  const navCount = Math.max(2, Math.min(4, Math.round(opts.navs ?? rng.int(2, 4))));
  const navs = [];
  let px = 0, py = 0, pz = 0;
  let heading = rng.range(-0.35, 0.35);
  for (let i = 0; i < navCount; i++) {
    const leg = rng.range(18000, 38000);
    heading += rng.range(-0.55, 0.55);
    px += r1(Math.sin(heading) * leg);
    pz -= r1(Math.cos(heading) * leg);
    py += r1(rng.gauss(0, 1400));
    navs.push({
      id: `n${i + 1}`,
      name: `NAV ${i + 1} · ${sector.toUpperCase()} ${(i + 1) * 3}`,
      position: [px, py, pz],
      radius: 1600,
    });
  }

  // ---- forces -------------------------------------------------------------
  const skillFor = (d) => (d <= 1 ? 'rookie' : d <= 2 ? 'veteran' : d <= 4 ? (rng.bool(0.4) ? 'ace' : 'veteran') : 'ace');
  const wingSize = Math.min(3, 1 + Math.floor(difficulty / 2));
  const wingmen = [];
  const pool = WING_POOL.slice();
  for (let i = 0; i < wingSize; i++) {
    const k = rng.int(0, pool.length - 1);
    wingmen.push(pool.splice(k, 1)[0]);
  }

  const groups = {};
  const objectives = [];
  const triggers = [];
  const failure = [];

  // Every skirmish has a fight at each nav after the first: `wave<i>`.
  const waveIds = [];
  for (let i = 1; i < navCount; i++) {
    const heavy = difficulty >= 3 && rng.bool(0.45);
    const count = Math.max(2, Math.min(5, Math.round(1 + difficulty * 0.7 + rng.range(0, 1.4))));
    const id = `wave${i}`;
    waveIds.push(id);
    groups[id] = {
      ship: heavy ? ENEMY_HEAVY : ENEMY_LIGHT,
      faction: 'nephilim',
      count: heavy ? Math.max(1, count - 2) : count,
      tag: id,
      at: navs[i].id,
      offset: [r1(rng.range(-2200, 2200)), r1(rng.range(-900, 900)), r1(rng.range(-3200, -1400))],
      spread: 320,
      facing: 'player',
      skill: skillFor(difficulty),
      temperament: rng.pick(['aggressive', 'disciplined', 'reckless', 'cautious']),
      squadron: `Bogey ${i}`,
      spawn: 'trigger',
    };
    triggers.push({
      id: `t-${id}`,
      on: { nav: navs[i].id },
      do: [
        { spawn: id },
        { comms: { from: wingCallsign(wingmen[0]), text: contactLine(rng, groups[id].count), tone: 'urgent', priority: 3 } },
      ],
    });
  }

  objectives.push({
    id: 'clear',
    kind: 'primary',
    label: 'Clear every hostile contact on the patrol route',
    auto: { all: waveIds.map((id) => ({ groupDestroyed: id })) },
    progress: { of: 'groups', groups: waveIds.slice() },
  });
  objectives.push({
    id: 'sweep',
    kind: 'primary',
    label: `Sweep all ${navCount} nav points`,
    auto: { allNavsVisited: true },
    progress: { of: 'navs' },
  });

  // ---- type flavour -------------------------------------------------------
  if (type === 'escort') {
    groups.convoy = {
      ship: 'civ_drayman', faction: 'civilian', count: difficulty >= 3 ? 2 : 1, tag: 'convoy',
      at: 'player', offset: [600, -100, -1200], spread: 800,
      escortRoute: true, protect: true, formation: 'trail',
    };
    objectives.push({
      id: 'escort', kind: 'primary', label: 'Escort the convoy to the final nav point',
      auto: { all: [{ allNavsVisited: true }, { alive: 'convoy' }] },
      failIf: { destroyed: 'convoy' },
    });
    failure.push({ destroyed: 'convoy' });
  } else if (type === 'defend') {
    groups.station = {
      ship: 'confed_carrier', faction: 'confed', count: 1, tag: 'station',
      at: navs[navs.length - 1].id, offset: [0, 0, 0], static: true, protect: true,
      names: [`TCS ${rng.pick(['Ardent', 'Sabre', 'Concord', 'Vigilant'])}`],
    };
    objectives.push({
      id: 'hold', kind: 'primary', label: 'The carrier must survive',
      auto: { objective: { id: 'clear', state: 'complete' } },
      failIf: { any: [{ destroyed: 'station' }, { hullBelow: { ship: 'station', frac: 0.3 } }] },
    });
    failure.push({ destroyed: 'station' });
  } else if (type === 'strike') {
    const last = navs[navs.length - 1];
    groups.target = {
      ship: rng.bool(0.5) ? 'alien_leviathan' : 'alien_moray',
      faction: 'nephilim', count: 1, tag: 'target',
      at: last.id, offset: [0, 0, -1600], facing: 'player',
      skill: 'ace', squadron: 'Prime', spawn: 'trigger',
    };
    triggers.push({
      id: 't-target', on: { nav: last.id },
      do: [
        { spawn: 'target' },
        { comms: { from: 'Control', text: 'That is your strike target. Weapons free.', tone: 'grim', priority: 3 } },
      ],
    });
    objectives.push({ id: 'strike', kind: 'primary', label: 'Destroy the primary target', auto: { destroyed: 'target' } });
  } else {
    // patrol: a bonus for doing it without taking real damage.
    objectives.push({
      id: 'clean', kind: 'bonus', label: 'Finish the patrol above 60% hull',
      auto: { objective: { id: 'clear', state: 'complete' } },
      failIf: { playerHullBelow: 0.6 },
    });
  }

  // A late reinforcement on the way home keeps the last leg honest.
  if (difficulty >= 2) {
    const lastNav = navs[navs.length - 1].id;
    groups.late = {
      ship: difficulty >= 4 ? ENEMY_HEAVY : ENEMY_LIGHT, faction: 'nephilim',
      count: Math.max(1, Math.round(difficulty * 0.6)), tag: 'late',
      at: 'player', offset: [r1(rng.range(-2600, 2600)), r1(rng.range(-1200, 1200)), 3200],
      spread: 300, facing: 'player', skill: skillFor(difficulty),
      temperament: 'aggressive', squadron: 'Tail', spawn: 'trigger',
    };
    triggers.push({
      id: 't-late', after: `t-${waveIds[waveIds.length - 1]}`, delay: 40, on: { nav: lastNav },
      if: { not: { objective: { id: 'clear', state: 'complete' } } },
      do: [
        { spawn: 'late' },
        { comms: { from: wingCallsign(wingmen[wingmen.length - 1]), text: 'More contacts, astern of us! They followed us in!', tone: 'urgent', priority: 3 } },
      ],
    });
    objectives[0].auto.all.push({ any: [{ not: { spawned: 'late' } }, { groupDestroyed: 'late' }] });
  }

  triggers.unshift({
    id: 'launch', on: { start: true },
    do: [{ comms: { from: 'Control', text: `${system} sector patrol. ${navCount} nav points, weapons free.`, tone: 'calm' } }],
  });

  return {
    id: `skirmish-${seed}-${index}`,
    title: `Skirmish — ${system} ${sector}`,
    type,
    difficulty,
    act: 0,
    briefing: [
      `${system}, sector ${sector}. ${navCount} nav points on the sweep.`,
      `Threat estimate: ${describeThreat(groups)}.`,
      'Nothing else out here is going to help you. Good hunting.',
    ],
    world: {
      preset,
      planets: rng.bool(0.75)
        ? [{
          type: rng.pick(['gas-giant', 'rocky', 'ice', 'terrestrial']),
          position: [r1(rng.range(-160000, 160000)), r1(rng.range(-30000, 20000)), r1(rng.range(-200000, -60000))],
          radius: r1(rng.range(16000, 46000)),
          rings: rng.bool(0.35),
        }]
        : [],
      asteroids: rng.bool(0.6)
        ? { center: navs[Math.min(1, navs.length - 1)].position.slice(), radius: 6000, count: 480 }
        : null,
    },
    player: { ship: difficulty >= 3 ? 'confed_panther' : 'confed_vampire', wing: 'Talon' },
    wingmen,
    navs,
    groups,
    objectives,
    triggers,
    failure,
    limits: { maxShips: 18 },
  };
}

function wingCallsign(key) {
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : 'Two';
}

function contactLine(rng, n) {
  const lines = [
    `Contacts, ${n} of them, dead ahead.`,
    `Tally ${n} bandits off the nav point.`,
    `They are already here — ${n} hostiles, breaking to engage.`,
    `${n} contacts, and they see us.`,
  ];
  return rng.pick(lines);
}

function describeThreat(groups) {
  let light = 0, heavy = 0, capital = 0;
  for (const g of Object.values(groups)) {
    if (g.faction !== 'nephilim') continue;
    if (g.ship === 'alien_leviathan') capital += g.count;
    else if (g.ship === ENEMY_HEAVY) heavy += g.count;
    else light += g.count;
  }
  const bits = [];
  if (light) bits.push(`${light} light fighter${light > 1 ? 's' : ''}`);
  if (heavy) bits.push(`${heavy} heavy${heavy > 1 ? ' fighters' : ' fighter'}`);
  if (capital) bits.push('one capital hull');
  return bits.length ? bits.join(', ') : 'unknown';
}

export default generateSkirmish;
