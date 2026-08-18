/**
 * src/mission/campaign.js — persistent campaign state.
 *
 * What survives between flights: which missions are done, what the player killed,
 * who died flying his wing, and what rank that adds up to. One namespaced key,
 * one JSON blob, one version number so a future schema change can migrate rather
 * than corrupt.
 *
 * Storage is *optional*. The capture harness runs headless in a page where
 * `localStorage` may be missing, may throw on access (Chromium does exactly this
 * when storage is blocked), or may be full. Every path through this module
 * therefore degrades to an in-memory store and keeps playing — a campaign that
 * cannot be saved is a small disappointment; a mission system that throws on boot
 * because storage was blocked is a black screen.
 */

export const STORAGE_KEY = 'wc.campaign.v1';
export const SCHEMA_VERSION = 1;

/**
 * The promotion ladder. Thresholds are `{ missions, kills }` and both must be met
 * — a pilot who grinds kills in the skirmish generator does not out-rank one who
 * actually flew the campaign.
 */
export const RANKS = [
  { id: 'ens', name: '2nd Lieutenant', short: '2LT', missions: 0, kills: 0 },
  { id: 'lt', name: '1st Lieutenant', short: '1LT', missions: 1, kills: 6 },
  { id: 'capt', name: 'Captain', short: 'CAPT', missions: 2, kills: 16 },
  { id: 'maj', name: 'Major', short: 'MAJ', missions: 3, kills: 30 },
  { id: 'ltcol', name: 'Lieutenant Colonel', short: 'LTC', missions: 4, kills: 48 },
  { id: 'col', name: 'Colonel', short: 'COL', missions: 6, kills: 80 },
];

export const MEDALS = [
  { id: 'flightcross', name: 'Flight Cross', test: (s) => s.kills.total >= 25 },
  { id: 'goldensun', name: 'Golden Sun', test: (s) => Object.keys(s.completed).length >= 4 },
  { id: 'bloodstripe', name: 'Bronze Star', test: (s) => s.stats.perfectMissions >= 2 },
];

/** A storage object that always works, even when the real one does not. */
export function safeStorage(provided = null) {
  const probe = provided ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  try {
    if (probe) {
      const k = `${STORAGE_KEY}.probe`;
      probe.setItem(k, '1');
      probe.removeItem(k);
      return { get: (key) => probe.getItem(key), set: (key, v) => probe.setItem(key, v), remove: (key) => probe.removeItem(key), persistent: true };
    }
  } catch { /* blocked, quota-full, or a sandboxed frame — fall through */ }
  const mem = new Map();
  return {
    get: (key) => (mem.has(key) ? mem.get(key) : null),
    set: (key, v) => { mem.set(key, v); },
    remove: (key) => { mem.delete(key); },
    persistent: false,
  };
}

function blankState(seed = 0) {
  return {
    version: SCHEMA_VERSION,
    seed,
    createdAt: 0,
    /** missionId -> { attempts, completed, bestTime, bestKills, lastResult } */
    completed: {},
    attempts: {},
    kills: { total: 0, byClass: {}, byFaction: {} },
    losses: { wingmen: [], count: 0 },
    stats: { missionsFlown: 0, missionsWon: 0, missionsLost: 0, perfectMissions: 0, shotsFired: 0, timeFlown: 0 },
    rank: RANKS[0].id,
    medals: [],
    /** Cross-mission designer flags — "you let the transport die in act one". */
    flags: {},
    current: null,
  };
}

export function createCampaign({ seed = 0, storage = null, key = STORAGE_KEY } = {}) {
  const store = safeStorage(storage);
  let state = blankState(seed);

  function load() {
    try {
      const raw = store.get(key);
      if (!raw) return state;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return state;
      if (parsed.version !== SCHEMA_VERSION) {
        // A schema bump discards rather than guesses; the alternative is a save
        // file that half-loads and reports a rank the player never earned.
        console.warn(`[mission] campaign save is v${parsed.version}, expected v${SCHEMA_VERSION} — starting fresh`);
        return state;
      }
      state = { ...blankState(seed), ...parsed, kills: { ...blankState(seed).kills, ...(parsed.kills ?? {}) }, stats: { ...blankState(seed).stats, ...(parsed.stats ?? {}) } };
    } catch (err) {
      console.warn('[mission] campaign save unreadable —', err?.message ?? err);
    }
    return state;
  }

  function save() {
    try {
      store.set(key, JSON.stringify(state));
      return true;
    } catch (err) {
      // Quota or a private-mode window. Not worth interrupting a mission over.
      console.warn('[mission] campaign save failed —', err?.message ?? err);
      return false;
    }
  }

  function rankInfo() {
    const missions = Object.keys(state.completed).length;
    const kills = state.kills.total;
    let best = RANKS[0];
    for (const r of RANKS) if (missions >= r.missions && kills >= r.kills) best = r;
    return best;
  }

  /** Recompute rank + medals. Returns the promotion, if there was one. */
  function reassess() {
    const earned = rankInfo();
    let promotion = null;
    if (earned.id !== state.rank) {
      const from = RANKS.find((r) => r.id === state.rank) ?? RANKS[0];
      // Demotion is not a thing — a save edited by hand should not strip rank.
      if (RANKS.indexOf(earned) > RANKS.indexOf(from)) {
        promotion = { from: from.name, to: earned.name, rank: earned };
        state.rank = earned.id;
      }
    }
    for (const m of MEDALS) {
      try {
        if (!state.medals.includes(m.id) && m.test(state)) state.medals.push(m.id);
      } catch { /* a malformed save must not break the debrief */ }
    }
    return promotion;
  }

  /**
   * Fold one flown mission into the campaign.
   * @param {object} result { id, outcome:'complete'|'failed'|'aborted', elapsed,
   *                          kills, playerKills, losses:[callsign], objectives, perfect }
   * @returns {{promotion:object|null, rank:object, unlocked:string|null}}
   */
  function recordResult(result = {}) {
    const id = String(result.id ?? 'unknown');
    state.attempts[id] = (state.attempts[id] ?? 0) + 1;
    state.stats.missionsFlown++;
    state.stats.timeFlown += Math.max(0, result.elapsed ?? 0);
    state.kills.total += Math.max(0, result.playerKills ?? 0);
    for (const [cls, n] of Object.entries(result.killsByClass ?? {})) {
      state.kills.byClass[cls] = (state.kills.byClass[cls] ?? 0) + n;
    }
    for (const [f, n] of Object.entries(result.killsByFaction ?? {})) {
      state.kills.byFaction[f] = (state.kills.byFaction[f] ?? 0) + n;
    }
    for (const lost of result.losses ?? []) {
      state.losses.wingmen.push({ callsign: lost, mission: id });
      state.losses.count++;
    }
    if (result.outcome === 'complete') {
      state.stats.missionsWon++;
      const prev = state.completed[id];
      state.completed[id] = {
        attempts: state.attempts[id],
        completedAt: result.at ?? 0,
        bestTime: prev ? Math.min(prev.bestTime, result.elapsed ?? 0) : (result.elapsed ?? 0),
        bestKills: Math.max(prev?.bestKills ?? 0, result.playerKills ?? 0),
        perfect: !!(prev?.perfect || result.perfect),
      };
      if (result.perfect) state.stats.perfectMissions++;
      state.current = result.next ?? null;
    } else if (result.outcome === 'failed') {
      state.stats.missionsLost++;
    }
    for (const [k, v] of Object.entries(result.flags ?? {})) state.flags[k] = v;

    const promotion = reassess();
    save();
    return { promotion, rank: RANKS.find((r) => r.id === state.rank) ?? RANKS[0], unlocked: result.next ?? null };
  }

  function isComplete(id) { return !!state.completed[id]; }

  /** First mission in `order` the player has not finished. */
  function nextMission(order = []) {
    for (const id of order) if (!state.completed[id]) return id;
    return null;
  }

  function reset() {
    state = blankState(seed);
    save();
    return state;
  }

  load();

  return {
    get state() { return state; },
    get rank() { return RANKS.find((r) => r.id === state.rank) ?? RANKS[0]; },
    get persistent() { return store.persistent; },
    load, save, reset, recordResult, isComplete, nextMission, reassess,
    /** Read-only view for a UI pilot-record screen. */
    summary() {
      const rank = RANKS.find((r) => r.id === state.rank) ?? RANKS[0];
      return {
        rank: rank.name, rankShort: rank.short,
        kills: state.kills.total,
        missionsFlown: state.stats.missionsFlown,
        missionsWon: state.stats.missionsWon,
        completed: Object.keys(state.completed),
        medals: state.medals.map((id) => MEDALS.find((m) => m.id === id)?.name ?? id),
        losses: state.losses.wingmen.slice(),
        persistent: store.persistent,
      };
    },
  };
}

export default createCampaign;
