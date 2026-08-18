/**
 * src/mission/wingmen.js — the squadron roster.
 *
 * `ai/personality.js` can invent a pilot from a seed, and for the twelve bandits
 * at nav three that is exactly right. It is wrong for the two people on your wing:
 * a wingman the player flies with across four missions has to be the *same* person
 * every time, with the same voice, the same flying, and a name the player will
 * still recognise when it appears in a casualty line.
 *
 * So the roster is hand-written, and each entry maps straight onto the two axes
 * `ai/personality.js` exposes (`skill` × `temperament`). Nothing here duplicates
 * the AI's model — it selects from it.
 *
 * A mission references wingmen by key:  `wingmen: ['ripcord', 'gremlin']`
 */

export const WINGMEN = {
  ripcord: {
    key: 'ripcord', callsign: 'Ripcord', name: 'Elena Vance',
    skill: 'veteran', temperament: 'disciplined', ship: 'confed_vampire',
    bio: 'Second element lead. Flies like a manual and gets everybody home.',
  },
  gremlin: {
    key: 'gremlin', callsign: 'Gremlin', name: 'Cal Ptak',
    skill: 'rookie', temperament: 'reckless', ship: 'confed_vampire',
    bio: 'Eleven weeks out of the academy and convinced he is already an ace.',
  },
  anvil: {
    key: 'anvil', callsign: 'Anvil', name: 'Dieter Brandt',
    skill: 'veteran', temperament: 'cautious', ship: 'confed_panther',
    bio: 'Flew freighters before the war. Still flies like the cargo is his.',
  },
  coldsnap: {
    key: 'coldsnap', callsign: 'Coldsnap', name: 'Yuki Sasaki',
    skill: 'ace', temperament: 'disciplined', ship: 'confed_panther',
    bio: 'Nineteen confirmed. Has never once been heard to raise her voice.',
  },
  sundog: {
    key: 'sundog', callsign: 'Sundog', name: 'Rosa Delgado',
    skill: 'veteran', temperament: 'aggressive', ship: 'confed_vampire',
    bio: 'Will chase a damaged bandit into a minefield. Has done, twice.',
  },
  bishop: {
    key: 'bishop', callsign: 'Bishop', name: 'Owen Halloran',
    skill: 'ace', temperament: 'cautious', ship: 'confed_devastator',
    bio: 'Torpedo lead. Talks the run down like a man reading a shopping list.',
  },
  quill: {
    key: 'quill', callsign: 'Quill', name: 'Priya Mahal',
    skill: 'rookie', temperament: 'cautious', ship: 'confed_vampire',
    bio: 'Best shot in her class, and terrified of every minute of this.',
  },
  wrecker: {
    key: 'wrecker', callsign: 'Wrecker', name: 'Boyd Stroud',
    skill: 'veteran', temperament: 'reckless', ship: 'confed_panther',
    bio: 'Three reprimands, two commendations, one very tired flight surgeon.',
  },
};

export const WINGMAN_KEYS = Object.keys(WINGMEN);

/** Resolve a roster key (or an inline literal) into a wingman record. */
export function resolveWingman(ref) {
  if (!ref) return null;
  if (typeof ref === 'string') {
    const k = ref.toLowerCase();
    return WINGMEN[k] ? { ...WINGMEN[k] } : { key: k, callsign: ref, name: ref, skill: 'veteran', temperament: 'disciplined', ship: 'confed_vampire', bio: '' };
  }
  const base = ref.key && WINGMEN[ref.key] ? WINGMEN[ref.key] : {};
  return { ship: 'confed_vampire', skill: 'veteran', temperament: 'disciplined', ...base, ...ref };
}

/**
 * Build the config object `AISystem.attach(ship, cfg)` documents, for a wingman
 * flying slot `index` of the player's flight.
 */
export function wingmanAIConfig(w, index, { wing = 'Talon', formation = 'fingerFour', spacing = 95 } = {}) {
  return {
    name: w.name,
    callsign: w.callsign,
    skill: w.skill,
    temperament: w.temperament,
    squadron: wing,
    formation,
    spacing,
    role: 'wingman',
    slot: index + 1,
    freeEngage: true,
    state: 'formUp',
  };
}

export default { WINGMEN, WINGMAN_KEYS, resolveWingman, wingmanAIConfig };
