/**
 * src/mission/missions.js — the hand-authored campaign.
 *
 * Four missions, one arc: a quiet perimeter patrol that turns out not to be quiet,
 * a convoy run that costs you something, a carrier defence that stops being about
 * kills and starts being about a hull number, and a torpedo strike on the thing
 * that has been eating the system.
 *
 * **There is no code in this file.** Every mission is a plain object in the schema
 * documented at the top of `format.js`, and the runtime in `MissionSystem.js`
 * never special-cases a mission id. If a designer cannot express something here,
 * the fix is a new condition or action in `triggers.js` — not an `if (mission.id
 * === 'x')` in the engine.
 *
 * Escalation, by the numbers:
 *
 * | # | mission | hostiles | classes | new mechanic |
 * |---|---|---|---|---|
 * | 1 | Perimeter patrol | 4 | manta | nav course, NAV LOCKED |
 * | 2 | Convoy escort    | 6 | manta, moray | protected ships, timed reinforcement |
 * | 3 | Carrier defence  |14 | manta, moray | chained waves, hull thresholds |
 * | 4 | Leviathan strike |14 | manta, moray, leviathan | capital target, objective-gated nav |
 */

// ---------------------------------------------------------------------------
// 1 — patrol
// ---------------------------------------------------------------------------

export const patrolVegaPerimeter = {
  id: 'm1-perimeter',
  title: 'Patrol — Vega Perimeter',
  type: 'patrol',
  act: 1,
  difficulty: 1,
  next: 'm2-amaranth',
  briefing: [
    'Routine perimeter sweep, three nav points, back in time for the mess.',
    'Sensor buoy 4 has been dropping packets for two days. Confirm it is a fault.',
    'Talon Control, out.',
  ],
  debrief: {
    success: ['Buoy 4 was not a fault. Debrief in twenty minutes.'],
    failure: ['We lost the patrol. Nobody is calling that a fault either.'],
  },

  world: {
    preset: 'nebula-teal',
    planets: [{ type: 'gas-giant', position: [-140000, -22000, -180000], radius: 42000, rings: true }],
    asteroids: { center: [4000, -800, -46000], radius: 5200, count: 420 },
  },

  player: { ship: 'confed_vampire', wing: 'Talon' },
  wingmen: ['ripcord'],
  base: [0, 0, 6000],

  navs: [
    { id: 'n1', name: 'NAV 1 · BUOY 4', position: [1200, 400, -21000], radius: 1400 },
    { id: 'n2', name: 'NAV 2 · ORE FIELD', position: [5600, -700, -47000], radius: 1600 },
    { id: 'n3', name: 'NAV 3 · RETURN VECTOR', position: [-9000, 1800, -68000], radius: 1600 },
  ],

  groups: {
    scouts: {
      ship: 'alien_manta', faction: 'nephilim', count: 2, tag: 'scouts',
      at: 'n2', offset: [900, 300, -1800], spread: 240, facing: 'player',
      skill: 'rookie', temperament: 'aggressive', squadron: 'Scout', formation: 'wedge',
      spawn: 'trigger',
    },
    derelict: {
      ship: 'civ_drayman', faction: 'civilian', count: 1, tag: 'derelict',
      at: 'n3', offset: [-1400, -200, -600], static: true, spawn: 'trigger',
    },
    ambush: {
      ship: 'alien_manta', faction: 'nephilim', count: 2, tag: 'ambush',
      at: 'n3', offset: [2400, 1200, -2400], spread: 300, facing: 'player',
      skill: 'veteran', temperament: 'aggressive', squadron: 'Ambush',
      spawn: 'trigger',
    },
  },

  objectives: [
    { id: 'sweep', kind: 'primary', label: 'Sweep all three nav points',
      auto: { allNavsVisited: true }, progress: { of: 'navs' } },
    { id: 'scouts', kind: 'primary', label: 'Destroy any hostile contacts',
      auto: { all: [{ groupDestroyed: 'scouts' }, { groupDestroyed: 'ambush' }] },
      progress: { of: 'groups', groups: ['scouts', 'ambush'] } },
    { id: 'derelict', kind: 'secondary', label: 'Identify the drifting hull at nav 3',
      state: 'pending',
      auto: { within: { of: 'player', to: 'derelict', range: 2500 } } },
  ],

  triggers: [
    { id: 'launch', on: { start: true }, do: [
      { comms: { from: 'Talon Control', text: 'Talon flight, you are clear to depart. Nav one is buoy four.', tone: 'calm' } },
    ] },

    { id: 'nav1', on: { nav: 'n1' }, do: [
      { comms: { from: 'Ripcord', text: 'Buoy is dark. No debris, no beacon. That is not a fault, Lead.', tone: 'grim' } },
    ] },

    { id: 'nav2', on: { nav: 'n2' }, do: [
      { spawn: 'scouts' },
      { comms: { from: 'Ripcord', text: 'Contacts! Two of them, coming out of the rocks!', tone: 'urgent', priority: 3 } },
    ] },

    { id: 'nav2clear', on: { groupDestroyed: 'scouts' }, after: 'nav2', do: [
      { comms: { from: 'Ripcord', text: 'Splash two. Those were not pirates, Lead. I have never seen that hull.', tone: 'grim' } },
      { objective: 'derelict', state: 'active' },
    ] },

    { id: 'nav3', on: { nav: 'n3' }, do: [
      { spawn: 'derelict' },
      { comms: { from: 'Talon Control', text: 'Talon lead, we read a cold hull on your nav. Get eyes on it.', tone: 'calm' } },
    ] },

    // The teeth of the mission: the thing that killed the freighter is still here.
    { id: 'ambush', after: 'nav3', delay: 14, on: { always: true }, do: [
      { spawn: 'ambush' },
      { comms: { from: 'Ripcord', text: 'Break! Break! They were sitting inside the wreck!', tone: 'panic', priority: 3 } },
    ] },

    { id: 'rtb', on: { all: [{ groupDestroyed: 'ambush' }, { navVisited: 'n3' }] }, do: [
      { comms: { from: 'Talon Control', text: 'Talon flight, RTB. And lead — do not talk about this on the open channel.', tone: 'grim' } },
    ] },
  ],
};

// ---------------------------------------------------------------------------
// 2 — escort
// ---------------------------------------------------------------------------

export const escortAmaranth = {
  id: 'm2-amaranth',
  title: 'Escort — Convoy Amaranth',
  type: 'escort',
  act: 1,
  difficulty: 2,
  next: 'm3-talon',
  briefing: [
    'Two ore haulers, Amaranth One and Two, out to the Sirius jump point.',
    'Whatever killed buoy four is still in this system and it likes soft targets.',
    'The freighters are the mission. Kills are not.',
  ],
  debrief: {
    success: ['Amaranth is through the jump point. That ore keeps the Talon flying.'],
    failure: ['We do not have the tonnage to lose freighters. Not one more.'],
  },

  world: {
    preset: 'nebula-magenta',
    planets: [{ type: 'rocky', position: [90000, -12000, -120000], radius: 26000 }],
    asteroids: { center: [-2500, 600, -58000], radius: 6000, count: 520 },
  },

  player: { ship: 'confed_vampire', wing: 'Talon' },
  wingmen: ['ripcord', 'gremlin'],
  base: [0, 0, 8000],

  navs: [
    { id: 'n1', name: 'NAV 1 · RENDEZVOUS', position: [-800, 200, -16000], radius: 1500 },
    { id: 'n2', name: 'NAV 2 · SIRIUS TRANSIT', position: [-6000, -1200, -44000], radius: 1800 },
    { id: 'n3', name: 'NAV 3 · JUMP POINT', position: [3000, 2200, -78000], radius: 2000, requires: ['deliver'] },
  ],

  groups: {
    convoy: {
      ship: 'civ_drayman', faction: 'civilian', count: 2, tag: 'amaranth',
      at: 'player', offset: [700, -120, -1400], spread: 900,
      escortRoute: true, protect: true, formation: 'trail',
      names: ['Amaranth One', 'Amaranth Two'],
    },
    wave1: {
      ship: 'alien_manta', faction: 'nephilim', count: 3, tag: 'wave1',
      at: 'n2', offset: [1800, 900, -2600], spread: 320, facing: 'player',
      skill: 'veteran', temperament: 'aggressive', squadron: 'Hunt', spawn: 'trigger',
    },
    wave2: {
      ship: 'alien_manta', faction: 'nephilim', count: 2, tag: 'wave2',
      at: 'amaranth', offset: [-2200, 800, 2600], spread: 300, facing: 'amaranth',
      skill: 'veteran', temperament: 'reckless', squadron: 'Hunt', spawn: 'trigger',
    },
    blocker: {
      ship: 'alien_moray', faction: 'nephilim', count: 1, tag: 'blocker',
      at: 'n3', offset: [0, 0, -3200], facing: 'player',
      skill: 'ace', temperament: 'disciplined', squadron: 'Gate', spawn: 'trigger',
    },
  },

  objectives: [
    { id: 'deliver', kind: 'primary', label: 'Escort Amaranth to the jump point',
      auto: { all: [{ navVisited: 'n3' }, { alive: 'amaranth' }, { groupDestroyed: 'blocker' }] },
      failIf: { destroyed: 'amaranth' } },
    { id: 'intact', kind: 'secondary', label: 'Do not lose a single freighter',
      auto: { objective: { id: 'deliver', state: 'complete' } },
      failIf: { groupAlive: { group: 'convoy', lte: 1 } },
      progress: { of: 'groups', groups: ['convoy'] } },
    { id: 'wing', kind: 'bonus', label: 'Bring your whole wing home',
      auto: { objective: { id: 'deliver', state: 'complete' } },
      failIf: { groupAlive: { group: 'wingmen', lte: 1 } } },
  ],

  triggers: [
    { id: 'launch', on: { start: true }, do: [
      { comms: { from: 'Amaranth One', text: 'Talon flight, Amaranth One. We are heavy and slow. Do not lose us.', tone: 'wry' } },
    ] },

    { id: 'nav2', on: { nav: 'n2' }, do: [
      { spawn: 'wave1' },
      { comms: { from: 'Gremlin', text: 'Three bogeys off the transit lane — they are going for the haulers!', tone: 'urgent', priority: 3 } },
    ] },

    // Conditional chain: the second wave is only called in if the first is still
    // alive to call it. Clear wave one fast and this never happens — which is the
    // whole reason `if` is evaluated when the delay expires, not when it starts.
    { id: 'nav2b', after: 'nav2', delay: 26, on: { always: true },
      if: { groupAlive: { group: 'wave1', gte: 1 } },
      do: [
        { spawn: 'wave2' },
        { comms: { from: 'Ripcord', text: 'They called friends. Two more on the convoy, high and behind.', tone: 'urgent', priority: 3 } },
      ] },

    { id: 'hauler-hit', on: { hullBelow: { ship: 'amaranth', frac: 0.65 } }, do: [
      { comms: { from: 'Amaranth One', text: 'We are holed! Somebody get them off us!', tone: 'panic', priority: 3 } },
    ] },

    { id: 'hauler-lost', on: { groupAlive: { group: 'convoy', lte: 1 } }, do: [
      { comms: { from: 'Talon Control', text: 'Talon lead, we just lost a hauler off the board. Protect the other one.', tone: 'grim', priority: 3 } },
      { flag: 'lost-hauler', value: true },
    ] },

    { id: 'nav3', on: { nav: 'n3' }, do: [
      { spawn: 'blocker' },
      { comms: { from: 'Ripcord', text: 'Something big is parked on the jump point. That is not a fighter.', tone: 'grim', priority: 3 } },
    ] },

    { id: 'jump', on: { objective: { id: 'deliver', state: 'complete' } }, do: [
      { comms: { from: 'Amaranth One', text: 'Jump drive is spinning. Thanks, Talon. Drinks are on the guild.', tone: 'calm' } },
    ] },
  ],

  failure: [{ destroyed: 'amaranth' }],
};

// ---------------------------------------------------------------------------
// 3 — defend
// ---------------------------------------------------------------------------

export const defendTalon = {
  id: 'm3-talon',
  title: 'Defend — TCS Talon',
  type: 'defend',
  act: 2,
  difficulty: 3,
  next: 'm4-leviathan',
  briefing: [
    'They followed the convoy home. Three waves inbound on the Talon, closing fast.',
    'The carrier cannot manoeuvre with a full deck. You are the only screen she has.',
    'Nothing gets through to the hull. Nothing.',
  ],
  debrief: {
    success: ['Deck is intact and we are still in this system. Rearm and stand by.'],
    failure: ['The Talon is burning. There is nowhere in Vega left to land.'],
  },

  world: {
    preset: 'nebula-deep-blue',
    planets: [{ type: 'ice', position: [-60000, 8000, -90000], radius: 18000 }],
  },

  player: { ship: 'confed_panther', position: [600, 0, -1800], wing: 'Talon' },
  wingmen: ['coldsnap', 'sundog'],
  base: [0, 0, 0],

  navs: [
    // The player launches inside nav 1 — the carrier *is* a nav point, which is
    // what lets the course express "get back to the Talon, now". Nav 3 is the
    // same place as nav 1: the third wave goes around you for the flight deck,
    // and the autopilot home aborts the moment they are inside knife range.
    { id: 'n1', name: 'NAV 1 · TCS TALON', position: [0, 0, 0], radius: 2400 },
    { id: 'n2', name: 'NAV 2 · CAP STATION', position: [2600, 600, -9000], radius: 1600, clear: false },
    { id: 'n3', name: 'NAV 3 · TALON — RETURN', position: [0, 0, 0], radius: 2400, clear: false },
  ],

  groups: {
    talon: {
      ship: 'confed_carrier', faction: 'confed', count: 1, tag: 'talon',
      at: [0, 0, 0], static: true, protect: true, names: ['TCS Talon'],
    },
    wave1: {
      ship: 'alien_manta', faction: 'nephilim', count: 4, tag: 'wave1',
      at: 'n1', offset: [1400, 900, -4200], spread: 380, facing: 'talon',
      skill: 'veteran', temperament: 'aggressive', squadron: 'Swarm', formation: 'wedge',
      spawn: 'trigger',
    },
    wave2: {
      ship: 'alien_manta', faction: 'nephilim', count: 3, tag: 'wave2',
      at: 'n2', offset: [-1600, -700, -2200], spread: 340, facing: 'player',
      skill: 'veteran', temperament: 'reckless', squadron: 'Swarm', spawn: 'trigger',
    },
    wave2h: {
      ship: 'alien_moray', faction: 'nephilim', count: 2, tag: 'wave2h',
      at: 'n2', offset: [-1200, -500, -3400], spread: 500, facing: 'player',
      skill: 'veteran', temperament: 'disciplined', squadron: 'Lance', spawn: 'trigger',
    },
    wave3: {
      ship: 'alien_manta', faction: 'nephilim', count: 4, tag: 'wave3',
      at: 'talon', offset: [-5200, 2400, 6400], spread: 420, facing: 'talon',
      skill: 'ace', temperament: 'aggressive', squadron: 'Chorus', spawn: 'trigger',
    },
    wave3h: {
      ship: 'alien_moray', faction: 'nephilim', count: 1, tag: 'wave3h',
      at: 'talon', offset: [-4600, 2000, 7600], facing: 'talon',
      skill: 'ace', temperament: 'disciplined', squadron: 'Chorus', spawn: 'trigger',
    },
  },

  objectives: [
    { id: 'repel', kind: 'primary', label: 'Destroy all three attack waves',
      auto: { all: [
        { groupDestroyed: 'wave1' }, { groupDestroyed: 'wave2' }, { groupDestroyed: 'wave2h' },
        { groupDestroyed: 'wave3' }, { groupDestroyed: 'wave3h' },
      ] },
      progress: { of: 'groups', groups: ['wave1', 'wave2', 'wave2h', 'wave3', 'wave3h'] } },
    { id: 'hull', kind: 'primary', label: 'TCS Talon must survive',
      auto: { objective: { id: 'repel', state: 'complete' } },
      failIf: { any: [{ destroyed: 'talon' }, { hullBelow: { ship: 'talon', frac: 0.35 } }] } },
    { id: 'noscratch', kind: 'secondary', label: 'Keep the Talon above 70% hull',
      auto: { objective: { id: 'repel', state: 'complete' } },
      failIf: { hullBelow: { ship: 'talon', frac: 0.7 } } },
    { id: 'wing', kind: 'bonus', label: 'No losses in Talon squadron',
      auto: { objective: { id: 'repel', state: 'complete' } },
      failIf: { groupAlive: { group: 'wingmen', lte: 1 } } },
  ],

  triggers: [
    { id: 'launch', on: { start: true }, do: [
      { spawn: 'wave1' },
      { comms: { from: 'Talon Control', text: 'Talon flight, launch launch launch. First wave is inside eight klicks.', tone: 'urgent', priority: 3 } },
    ] },

    // Wave two forms up at the CAP station: fly out and meet it, or wait and let
    // it come to you. Either way it arrives — a mission must never stall because
    // the player declined to press the button the designer had in mind.
    { id: 'wave2', on: { all: [
      { groupDestroyed: 'wave1' },
      { any: [{ nav: 'n2' }, { time: 110 }] },
    ] }, do: [
      { spawn: ['wave2', 'wave2h'] },
      { comms: { from: 'Talon Control', text: 'Second wave forming at the CAP station, and they brought something heavier.', tone: 'urgent', priority: 3 } },
    ] },

    // Wave three ignores you entirely and goes straight for the flight deck —
    // whichever nav point you are standing on, you now have to be at the other one.
    { id: 'wave3', after: 'wave2', on: { any: [
      { all: [{ groupDestroyed: 'wave2' }, { groupDestroyed: 'wave2h' }] },
      { time: 260 },
    ] }, do: [
      { spawn: ['wave3', 'wave3h'] },
      { comms: { from: 'Coldsnap', text: 'Third wave came around the bow. They are going for the flight deck.', tone: 'urgent', priority: 3 } },
    ] },

    { id: 'talon-hit', on: { hullBelow: { ship: 'talon', frac: 0.75 } }, do: [
      { comms: { from: 'Talon Control', text: 'We are taking hull hits up here! Get them off the spine!', tone: 'panic', priority: 3 } },
    ] },

    { id: 'talon-critical', on: { hullBelow: { ship: 'talon', frac: 0.45 } }, do: [
      { comms: { from: 'Talon Control', text: 'Hull is at forty percent. Talon flight, we cannot take another pass.', tone: 'panic', priority: 3 } },
      { flag: 'talon-critical', value: true },
      { order: 'breakAndAttack', to: 'all' },
    ] },

    { id: 'clear', on: { objective: { id: 'repel', state: 'complete' } }, do: [
      { comms: { from: 'Talon Control', text: 'Board is clear. Talon flight, you are cleared to trap. Good shooting.', tone: 'calm' } },
    ] },
  ],

  failure: [{ destroyed: 'talon' }],
};

// ---------------------------------------------------------------------------
// 4 — strike
// ---------------------------------------------------------------------------

export const strikeLeviathan = {
  id: 'm4-leviathan',
  title: 'Strike — The Leviathan',
  type: 'strike',
  act: 2,
  difficulty: 4,
  next: null,
  briefing: [
    'Recon found the mother. A Leviathan-class hull, holding station past the ore field.',
    'Bishop carries the torpedoes. You carry Bishop.',
    'Everything else in this flight plan is a detail.',
  ],
  debrief: {
    success: ['The Leviathan is a debris field. Vega is quiet for the first time in a month.'],
    failure: ['It is still out there, and it knows the way to the Talon.'],
  },

  world: {
    preset: 'nebula-ember',
    planets: [{ type: 'gas-giant', position: [110000, -18000, -150000], radius: 48000, rings: true }],
    asteroids: { center: [-3000, 0, -92000], radius: 7000, count: 560 },
  },

  player: { ship: 'confed_panther', wing: 'Talon' },
  wingmen: ['bishop', 'coldsnap'],
  base: [0, 0, 10000],

  navs: [
    { id: 'n1', name: 'NAV 1 · STAGING', position: [0, 0, -24000], radius: 1600 },
    { id: 'n2', name: 'NAV 2 · PICKET LINE', position: [-7000, 2000, -58000], radius: 1800 },
    { id: 'n3', name: 'NAV 3 · TARGET', position: [2000, -1500, -92000], radius: 2600 },
    { id: 'n4', name: 'NAV 4 · EGRESS', position: [-14000, 3000, -40000], radius: 2000, requires: ['kill'] },
  ],

  groups: {
    pickets: {
      ship: 'alien_manta', faction: 'nephilim', count: 4, tag: 'pickets',
      at: 'n2', offset: [1200, 600, -2800], spread: 420, facing: 'player',
      skill: 'veteran', temperament: 'disciplined', squadron: 'Picket', formation: 'lineAbreast',
      spawn: 'trigger',
    },
    leviathan: {
      ship: 'alien_leviathan', faction: 'nephilim', count: 1, tag: 'leviathan',
      at: 'n3', offset: [0, 0, -1200], facing: 'player',
      skill: 'veteran', squadron: 'Mother', spawn: 'trigger',
    },
    guards: {
      ship: 'alien_moray', faction: 'nephilim', count: 2, tag: 'guards',
      at: 'n3', offset: [1800, 400, -2600], spread: 700, facing: 'player',
      skill: 'ace', temperament: 'disciplined', squadron: 'Mother', spawn: 'trigger',
    },
    swarm: {
      ship: 'alien_manta', faction: 'nephilim', count: 4, tag: 'swarm',
      at: 'leviathan', offset: [-1600, 900, 2200], spread: 500, facing: 'player',
      skill: 'ace', temperament: 'reckless', squadron: 'Brood', spawn: 'trigger',
    },
    reserve: {
      ship: 'alien_manta', faction: 'nephilim', count: 3, tag: 'reserve',
      at: 'leviathan', offset: [2600, -1200, 1800], spread: 420, facing: 'player',
      skill: 'veteran', temperament: 'aggressive', squadron: 'Brood', spawn: 'trigger',
    },
  },

  objectives: [
    { id: 'kill', kind: 'primary', label: 'Destroy the Leviathan', auto: { destroyed: 'leviathan' } },
    { id: 'egress', kind: 'primary', label: 'Withdraw to the egress point',
      auto: { navVisited: 'n4' }, state: 'pending' },
    { id: 'bishop', kind: 'secondary', label: 'Bring Bishop home',
      auto: { objective: { id: 'kill', state: 'complete' } },
      failIf: { destroyed: 'bishop' } },
    { id: 'pickets', kind: 'bonus', label: 'Clear the picket line at nav 2',
      auto: { groupDestroyed: 'pickets' }, state: 'pending' },
  ],

  triggers: [
    { id: 'launch', on: { start: true }, do: [
      { comms: { from: 'Bishop', text: 'Torpedoes are hung and armed. I will need thirty seconds of quiet on the run.', tone: 'calm' } },
    ] },

    { id: 'nav2', on: { nav: 'n2' }, do: [
      { spawn: 'pickets' },
      { objective: 'pickets', state: 'active' },
      { comms: { from: 'Coldsnap', text: 'Picket line, four of them, line abreast. They know we are coming.', tone: 'calm', priority: 2 } },
    ] },

    { id: 'sighted', after: 'nav2', delay: 6, on: { always: true }, do: [
      { spawn: 'leviathan' },
      { comms: { from: 'Talon Control', text: 'Long range has your target at nav three. Mass reads six hundred metres.', tone: 'grim' } },
    ] },

    { id: 'nav3', on: { nav: 'n3' }, do: [
      { spawn: ['guards', 'swarm'] },
      { comms: { from: 'Bishop', text: 'Tally the mother. Starting my run — keep the escorts off my tail, Lead.', tone: 'calm', priority: 3 } },
    ] },

    // It notices when it is hurt, and it calls the brood in.
    { id: 'wounded', on: { hullBelow: { ship: 'leviathan', frac: 0.55 } }, do: [
      { spawn: 'reserve' },
      { comms: { from: 'Coldsnap', text: 'It is bleeding and it is screaming. More of them, out of the hull itself.', tone: 'urgent', priority: 3 } },
    ] },

    { id: 'bishop-down', on: { destroyed: 'bishop' }, do: [
      { comms: { from: 'Talon Control', text: 'Bishop is gone. Lead, you are the strike now. Use everything you have.', tone: 'grim', priority: 3 } },
      { flag: 'bishop-lost', value: true },
    ] },

    { id: 'kill', on: { destroyed: 'leviathan' }, do: [
      { objective: 'egress', state: 'active' },
      { comms: { from: 'Talon Control', text: 'Splash the Leviathan. Talon flight, get out of there — nav four, now.', tone: 'urgent', priority: 3 } },
      { setNav: 'n4' },
    ] },
  ],
};

// ---------------------------------------------------------------------------

/** The campaign, in flying order. */
export const CAMPAIGN = [
  patrolVegaPerimeter.id,
  escortAmaranth.id,
  defendTalon.id,
  strikeLeviathan.id,
];

export const MISSIONS = {
  [patrolVegaPerimeter.id]: patrolVegaPerimeter,
  [escortAmaranth.id]: escortAmaranth,
  [defendTalon.id]: defendTalon,
  [strikeLeviathan.id]: strikeLeviathan,
};

export const MISSION_IDS = Object.keys(MISSIONS);

/** Briefing-screen data for every mission, without instantiating anything. */
export function missionList() {
  return CAMPAIGN.map((id, i) => {
    const m = MISSIONS[id];
    return {
      id, index: i + 1, title: m.title, type: m.type, act: m.act,
      difficulty: m.difficulty, briefing: m.briefing.slice(),
      objectives: m.objectives.filter((o) => o.kind !== 'bonus').map((o) => o.label),
    };
  });
}

export default { MISSIONS, MISSION_IDS, CAMPAIGN, missionList };
