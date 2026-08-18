/**
 * src/ui/missiondata.js — the adaptor between whatever `src/mission/` hands us
 * and what the briefing/debrief screens need.
 *
 * `src/mission/` is being written in parallel with this module, so nothing here
 * may assume a field name. Every read goes through an alias list and every
 * screen renders from the normalised shape below. When the mission system is
 * absent entirely the UI still has a complete, deterministic placeholder to
 * draw — which is the difference between "the briefing screen is not finished"
 * and "the briefing screen is finished and the mission is not".
 *
 * TODO(contract): once `src/mission/MissionSystem.js` lands, whichever alias it
 * actually uses is the one to keep; the rest can go.
 *
 * ## Normalised mission
 * ```
 * { id, number, title, codename, sector, system, carrier, stardate,
 *   summary,                                     // typed into the briefing
 *   threat: { level, rating, text, contacts:[{ label, count }] },
 *   objectives: [{ id, text, type, status }],    // type primary|secondary|bonus
 *   wingmen:  [{ callsign, name, ship, faction, slot }],
 *   navPoints:[{ id, name, kind, hostile, note, x, y }],  // x,y already 2D
 *   legs:     [{ from, to }],
 *   palette }                                    // backdrop mood
 * ```
 */
import { makeRng, hashSeed } from '../core/Rand.js';

/**
 * `src/mission/wingmen.js` owns the squadron roster and resolves a key like
 * `'ripcord'` into a callsign, a name and a one-line bio. Importing it
 * statically would make this whole subsystem fail to load if that file ever
 * moves, so `UISystem` hands the resolver in at boot behind a guarded dynamic
 * import instead.
 */
let resolveWingmanRef = null;
export function attachWingmanRoster(fn) {
  if (typeof fn === 'function') resolveWingmanRef = fn;
}

/** Factions the Confederation shoots at. Mirrors mission/MissionSystem's table. */
const HOSTILE_FACTIONS = new Set(['nephilim', 'alien', 'bug', 'kilrathi', 'pirate']);

/** `briefing` arrives from `mission/format.js` as an array of paragraphs. */
const paragraphs = (v) => (Array.isArray(v) ? v.filter(Boolean).join('\n\n') : v);

const first = (obj, keys, dflt = undefined) => {
  if (!obj) return dflt;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return dflt;
};

const THREAT_LEVELS = ['low', 'moderate', 'high', 'extreme'];

/** Placeholder used when no mission module is loaded, or it hands us nothing. */
export function placeholderMission(seed = 1337) {
  return {
    id: 'shakedown',
    number: 1,
    title: 'Shakedown',
    codename: 'BRIGHT LANCE',
    sector: 'Hellespont Quadrant',
    system: 'Ceres Drift',
    carrier: 'TCS MIDWAY',
    stardate: '2681.114',
    summary:
      'Long-range sensors have picked up unidentified drive signatures inside the Ceres Drift, '
      + 'twelve hours after we lost contact with the survey tender [[Kellogg]].\n\n'
      + 'You will fly the standard three-point patrol out to the drift and back. Sweep each nav '
      + 'point, identify anything you find, and destroy anything that shoots first.\n\n'
      + 'If you make contact with [[hostile capital elements]], do not engage. Mark the position '
      + 'and get your flight home. We need the intelligence more than we need the kill.',
    threat: { level: 'moderate', rating: 0.45, text: 'Light fighter opposition expected. Capital contact unconfirmed.', contacts: [] },
    objectives: [
      { id: 'nav', text: 'Patrol all three nav points', type: 'primary', status: 'active' },
      { id: 'ident', text: 'Identify the unknown contact', type: 'primary', status: 'pending' },
      { id: 'rtb', text: 'Return to TCS Midway', type: 'primary', status: 'pending' },
      { id: 'wing', text: 'Bring your wingman home', type: 'secondary', status: 'pending' },
    ],
    wingmen: [
      { callsign: 'Maestro', name: 'Lt. R. Sandoval', ship: 'Panther', faction: 'confed', slot: 'Wing 2' },
    ],
    navPoints: null,
    legs: null,
    palette: 'teal',
    _seed: seed,
  };
}

function normThreat(src, rng) {
  if (typeof src === 'string') {
    const lvl = THREAT_LEVELS.includes(src.toLowerCase()) ? src.toLowerCase() : 'moderate';
    return { level: lvl, rating: (THREAT_LEVELS.indexOf(lvl) + 1) / 4, text: '', contacts: [] };
  }
  const t = src ?? {};
  let level = String(first(t, ['level', 'rating', 'severity'], '') || '').toLowerCase();
  let rating = Number(first(t, ['value', 'score', 'ratingValue'], NaN));
  if (!THREAT_LEVELS.includes(level)) {
    if (Number.isFinite(rating)) level = THREAT_LEVELS[Math.min(3, Math.max(0, Math.round(rating * 4) - 1))];
    else level = 'moderate';
  }
  if (!Number.isFinite(rating)) rating = (THREAT_LEVELS.indexOf(level) + 1) / 4;
  const rawContacts = first(t, ['contacts', 'enemies', 'opfor', 'forces'], []) ?? [];
  const contacts = (Array.isArray(rawContacts) ? rawContacts : []).map((c) => (
    typeof c === 'string'
      ? { label: c, count: 0 }
      : { label: String(first(c, ['label', 'name', 'class', 'classId', 'type'], 'Unknown')), count: Number(first(c, ['count', 'n', 'qty'], 0)) || 0 }
  ));
  return {
    level,
    rating: Math.max(0, Math.min(1, rating)),
    text: String(first(t, ['text', 'note', 'summary', 'assessment'], '') ?? ''),
    contacts,
    _rng: rng,
  };
}

/** `confed_vampire` -> `Vampire`; ship ids are not briefing copy. */
function shipLabel(id) {
  if (!id) return '';
  const tail = String(id).split(/[_\-\s]+/).slice(-1)[0] ?? id;
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}

function normObjectives(src) {
  const list = Array.isArray(src) ? src : [];
  return list.map((o, i) => normObjective(o, i)).filter(Boolean);
}

/** Also used by the live tracker, which receives one objective at a time. */
export function normObjective(o, i = 0) {
  if (o == null) return null;
  if (typeof o === 'string') return { id: `obj${i}`, text: o, type: 'primary', status: 'active' };
  const text = String(first(o, ['text', 'label', 'name', 'description', 'title'], '') ?? '');
  if (!text) return null;
  let status = String(first(o, ['status', 'state'], '') || '').toLowerCase();
  if (o.complete === true || o.completed === true || o.done === true) status = 'complete';
  if (o.failed === true) status = 'failed';
  if (!['pending', 'active', 'complete', 'failed'].includes(status)) status = 'active';
  let type = String(first(o, ['type', 'kind', 'priority', 'category'], 'primary') || 'primary').toLowerCase();
  if (o.optional === true || o.secondary === true) type = 'secondary';
  if (!['primary', 'secondary', 'bonus'].includes(type)) type = 'primary';
  const pr = o.progress;
  return {
    id: String(first(o, ['id', 'key', 'name'], `obj${i}`)),
    text, type, status,
    detail: String(first(o, ['detail'], '') ?? ''),
    /** `{ current, total }` from mission/objectives.js, or null. */
    progress: pr && typeof pr === 'object' && Number.isFinite(pr.total) && pr.total > 1
      ? { current: Number(pr.current) || 0, total: Number(pr.total) }
      : null,
  };
}

function normWingmen(src) {
  const list = Array.isArray(src) ? src : [];
  return list.map((raw, i) => {
    // A mission references its wing by roster key (`wingmen: ['ripcord']`).
    // Resolving it gives the briefing a real name and the pilot's one-liner.
    let w = raw;
    if (resolveWingmanRef) {
      try { w = resolveWingmanRef(raw) ?? raw; } catch { w = raw; }
    }
    if (typeof w === 'string') return { callsign: w, name: '', ship: '', bio: '', faction: 'confed', slot: `Wing ${i + 2}` };
    return {
      bio: String(first(w, ['bio', 'note', 'blurb'], '') ?? ''),
      callsign: String(first(w, ['callsign', 'name', 'pilot', 'id'], `Wing ${i + 2}`)),
      name: String(first(w, ['pilotName', 'fullName', 'realName', 'name'], '') ?? ''),
      ship: shipLabel(String(first(w, ['ship', 'shipClass', 'classId', 'craft'], '') ?? '')),
      faction: String(first(w, ['faction', 'side'], 'confed')),
      slot: String(first(w, ['slot', 'position'], `Wing ${i + 2}`)),
    };
  });
}

/**
 * Nav points come in as 3D world positions (metres) or as pre-flattened 2D.
 * The map is top-down, so world XZ becomes map XY — Y (altitude) is dropped
 * rather than projected, because a patrol route drawn in perspective is
 * unreadable at briefing size and WC's own maps were plan-view.
 */
function normNav(src, rng, objectiveCount, mission = null) {
  const list = Array.isArray(src) ? src : [];
  // A nav point is a threat if the mission parks a hostile group on it. The
  // designer never says "this one is dangerous" — they just put four Mantas
  // there, and the plot should show that.
  const hotNavs = new Set();
  for (const g of Object.values(mission?.groups ?? {})) {
    if (!HOSTILE_FACTIONS.has(String(g?.faction ?? '').toLowerCase())) continue;
    for (const k of [g.at, g.atNav]) if (typeof k === 'string') hotNavs.add(k);
  }
  const out = list.map((n, i) => {
    const p = n?.position ?? n?.pos ?? n?.location ?? n;
    let x = 0; let y = 0;
    if (Array.isArray(p)) { x = Number(p[0]) || 0; y = Number(p[2] ?? p[1]) || 0; }
    else if (p && typeof p === 'object') {
      x = Number(p.x ?? 0) || 0;
      y = Number(p.z ?? p.y ?? 0) || 0;
    }
    const kindRaw = String(first(n, ['kind', 'type'], '') || '').toLowerCase();
    const hostile = n?.hostile === true || n?.enemy === true
      || hotNavs.has(String(n?.id ?? ''))
      || /combat|hostile|ambush|strike|intercept/.test(kindRaw);
    let kind = 'nav';
    if (/jump/.test(kindRaw)) kind = 'jump';
    else if (/base|carrier|home|dock|station/.test(kindRaw)) kind = 'base';
    else if (hostile) kind = 'combat';
    return {
      id: String(first(n, ['id', 'key'], `nav${i + 1}`)),
      name: String(first(n, ['name', 'label', 'title'], `Nav ${i + 1}`)),
      note: String(first(n, ['note', 'desc', 'description', 'text'], '') ?? ''),
      kind, hostile, x, y,
    };
  });

  // Prepend the carrier so the plot shows where the flight leaves from and the
  // first leg has a real length. `base` is where ai/wingmen.js sends "RTB".
  const home = mission?.base ?? mission?.player?.position ?? null;
  if (out.length && home && typeof home === 'object') {
    const hx = Number(home.x ?? home[0] ?? 0) || 0;
    const hy = Number(home.z ?? home[2] ?? home.y ?? 0) || 0;
    const far = Math.hypot(out[0].x - hx, out[0].y - hy);
    if (far > 500) {
      out.unshift({ id: '__base', name: mission?.carrier ?? 'TCS Midway', note: 'Departure and recovery.', kind: 'base', hostile: false, x: hx, y: hy });
    }
  }
  if (out.length >= 2) return out;

  // No route supplied: synthesise a plausible one, seeded, so a briefing screen
  // never renders an empty map while the mission module is still landing.
  const n = Math.max(3, Math.min(6, objectiveCount + 1));
  const gen = [];
  let ang = rng.range(-0.6, 0.6);
  let x = 0; let y = 0;
  for (let i = 0; i < n; i++) {
    const hostile = i > 0 && i < n - 1 && rng.bool(0.45);
    gen.push({
      id: `nav${i + 1}`,
      name: i === 0 ? 'TCS Midway' : i === n - 1 ? 'TCS Midway' : `Nav ${i}`,
      note: '',
      kind: i === 0 || i === n - 1 ? 'base' : hostile ? 'combat' : 'nav',
      hostile,
      x, y,
    });
    ang += rng.range(0.7, 1.9);
    const step = rng.range(24000, 62000);
    x += Math.cos(ang) * step;
    y += Math.sin(ang) * step;
  }
  // Close the loop back onto the carrier.
  gen[n - 1].x = gen[0].x + rng.range(-6000, 6000);
  gen[n - 1].y = gen[0].y + rng.range(-6000, 6000);
  return gen;
}

function normLegs(src, navCount) {
  const list = Array.isArray(src) ? src : [];
  const out = [];
  for (const l of list) {
    if (Array.isArray(l) && l.length >= 2) out.push({ from: l[0] | 0, to: l[1] | 0 });
    else if (l && typeof l === 'object') {
      const f = Number(first(l, ['from', 'a', 'start'], NaN));
      const t = Number(first(l, ['to', 'b', 'end'], NaN));
      if (Number.isFinite(f) && Number.isFinite(t)) out.push({ from: f | 0, to: t | 0 });
    }
  }
  if (out.length) return out;
  const seq = [];
  for (let i = 0; i + 1 < navCount; i++) seq.push({ from: i, to: i + 1 });
  return seq;
}

/**
 * Missions in `mission/missions.js` are titled `'Patrol — Vega Perimeter'`: a
 * type on the left of the dash and a place on the right. Splitting it gives the
 * briefing header a *name* and the meta strip a *type* and a *sector*, instead
 * of one string repeated three times.
 */
function splitTitle(raw) {
  const m = /^\s*([^\u2014\u2013|-]{2,20}?)\s*[\u2014\u2013|-]\s*(.+)$/.exec(String(raw ?? ''));
  if (!m) return { name: String(raw ?? ''), type: '', place: '' };
  return { name: m[2].trim(), type: m[1].trim(), place: m[2].trim() };
}

/** `nebula-teal` / `crimson-drift` -> a backdrop palette family. */
function paletteFor(world) {
  const key = String(world?.preset ?? world?.palette ?? world ?? '').toLowerCase();
  if (/amber|gold|ochre|sol|k-class/.test(key)) return 'amber';
  if (/crimson|red|ember|blood|giant/.test(key)) return 'crimson';
  return 'teal';
}

/** Build a threat call from the mission's own spawn groups. */
function threatFromGroups(groups, difficulty) {
  const contacts = [];
  let hostiles = 0;
  for (const g of Object.values(groups ?? {})) {
    if (!HOSTILE_FACTIONS.has(String(g?.faction ?? '').toLowerCase())) continue;
    const count = Math.max(1, Number(g.count) || 1);
    hostiles += count;
    const label = shipLabel(g.ship);
    const existing = contacts.find((c) => c.label === label);
    if (existing) existing.count += count;
    else contacts.push({ label, count });
  }
  if (!contacts.length && !Number.isFinite(difficulty)) return null;
  // Difficulty 1..4 from the campaign, nudged by how many hulls are waiting.
  const d = Number.isFinite(difficulty) ? difficulty : 1;
  const rating = Math.max(0.15, Math.min(1, d / 4.5 + Math.min(0.35, hostiles / 40)));
  const level = rating < 0.3 ? 'low' : rating < 0.55 ? 'moderate' : rating < 0.8 ? 'high' : 'extreme';
  return {
    level,
    rating,
    text: hostiles
      ? `${hostiles} hostile contacts projected across the course.`
      : 'No hostile contacts projected. Assume the projection is wrong.',
    contacts: contacts.sort((a, b) => b.count - a.count),
  };
}

export function normalizeMission(mission, { seed = 1337 } = {}) {
  const src = mission && typeof mission === 'object' ? mission : null;
  // `base` is always the placeholder: it is the *default* value for every field
  // a real mission does not carry (a mission definition has no stardate and no
  // carrier name). Aliasing `base` to `src` — which an earlier version did —
  // silently turned every missing field into `undefined` on screen.
  const base = placeholderMission(seed);
  const m = src ?? base;

  const rawTitle = String(first(m, ['title', 'name', 'missionName'], base.title));
  const parts = splitTitle(rawTitle);
  const title = parts.name || rawTitle;
  const rng = makeRng(hashSeed(`mission:${title}:${seed}`));
  const objectives = normObjectives(first(m, ['objectives', 'goals', 'tasks'], base.objectives));
  const derivedThreat = src ? threatFromGroups(m.groups, Number(m.difficulty)) : null;
  const navPoints = normNav(first(m, ['navs', 'navPoints', 'navpoints', 'nav', 'waypoints', 'route'], base.navPoints),
    rng, objectives.length, src);

  return {
    id: String(first(m, ['id', 'key'], base.id)),
    number: Number(first(m, ['number', 'index', 'missionNumber', 'act'], base.number)) || 1,
    title,
    type: String(first(m, ['type'], parts.type || 'patrol')),
    // Only the placeholder invents an operation name; a real mission that does
    // not declare one gets none, rather than borrowing the placeholder's.
    codename: String(first(m, ['codename', 'operation', 'opName'], src ? '' : (base.codename ?? '')) ?? ''),
    sector: String(first(m, ['sector', 'region', 'quadrant'], parts.place || base.sector)),
    system: String(first(m, ['system', 'starSystem', 'locale'], src ? '' : (base.system ?? '')) ?? ''),
    act: Number(first(m, ['act'], 1)) || 1,
    carrier: String(first(m, ['carrier', 'homeBase', 'carrierName'], base.carrier)),
    stardate: String(first(m, ['stardate', 'date', 'time'], base.stardate)),
    summary: String(paragraphs(first(m, ['summary', 'brief', 'briefing', 'description', 'text', 'body'], base.summary))),
    threat: normThreat(first(m, ['threat', 'threatAssessment', 'opposition'], derivedThreat ?? base.threat), rng),
    objectives: objectives.length ? objectives : normObjectives(base.objectives),
    wingmen: normWingmen(first(m, ['wingmen', 'wing', 'flight', 'escorts'], base.wingmen)),
    navPoints,
    legs: normLegs(first(m, ['legs', 'route', 'course'], base.legs), navPoints.length),
    palette: src ? paletteFor(m.world) : String(base.palette ?? 'teal'),
    playerShip: shipLabel(String(first(m, ['playerShip', 'craft', 'fighter'], m?.player?.ship ?? 'Panther') ?? 'Panther')),
    wing: String(m?.player?.wing ?? 'Talon'),
    /** Kept so a screen can reach anything the adaptor did not know about. */
    raw: src,
  };
}

/**
 * Debrief result. Anything the mission system omits is filled from the UI's own
 * running tally (see UISystem's `tally`) so a debrief always has real numbers.
 */
export function normalizeResult(result, tally = null, mission = null) {
  const r = result && typeof result === 'object' ? result : {};
  const t = tally ?? {};
  const num = (keys, fallback) => {
    const v = Number(first(r, keys, NaN));
    return Number.isFinite(v) ? v : fallback;
  };
  const shots = num(['shotsFired', 'shots', 'fired'], t.shotsFired ?? 0);
  const hits = num(['shotsHit', 'hits'], t.shotsHit ?? 0);
  let acc = Number(first(r, ['accuracy'], NaN));
  if (!Number.isFinite(acc)) acc = shots > 0 ? hits / shots : 0;
  if (acc > 1.0001) acc /= 100;

  let outcome = String(first(r, ['outcome', 'result', 'status'], '') || '').toLowerCase();
  if (r.success === true || r.won === true) outcome = 'success';
  if (r.success === false || r.failed === true) outcome = 'failure';
  const objectives = normObjectives(first(r, ['objectives', 'goals'], mission?.objectives ?? []));
  if (!['success', 'failure'].includes(outcome)) {
    const prim = objectives.filter((o) => o.type === 'primary');
    outcome = prim.length && prim.every((o) => o.status === 'complete') ? 'success'
      : prim.some((o) => o.status === 'failed') ? 'failure'
        : prim.length ? 'failure' : 'success';
  }

  return {
    outcome,
    kills: num(['kills', 'killCount', 'destroyed'], t.kills ?? 0),
    killList: first(r, ['killList', 'killsByClass'], t.killList ?? []) ?? [],
    shotsFired: shots,
    shotsHit: hits,
    accuracy: Math.max(0, Math.min(1, acc)),
    missiles: num(['missilesFired', 'missiles'], t.missiles ?? 0),
    missileHits: num(['missileHits'], t.missileHits ?? 0),
    hullTaken: num(['damageTaken', 'hullTaken'], t.hullTaken ?? 0),
    wingmenLost: num(['wingmenLost', 'losses'], t.wingmenLost ?? 0),
    time: num(['time', 'elapsed', 'duration'], t.time ?? 0),
    score: num(['score', 'points'], NaN),
    objectives,
    rank: String(first(r, ['rank'], '') ?? ''),
    promotion: String(first(r, ['promotion', 'promotedTo'], '') ?? ''),
    medal: String(first(r, ['medal', 'award', 'decoration'], '') ?? ''),
    remark: String(first(r, ['remark', 'note', 'comment', 'debrief'], '') ?? ''),
  };
}
