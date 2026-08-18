/**
 * src/ai/personality.js — who is flying the thing.
 *
 * A pilot profile is a bag of *scalars that other modules actually read*. Nothing
 * in here is decoration: every field is consumed by behaviours.js, gunnery.js or
 * maneuvers.js, and the self-test asserts that a rookie and an ace produce
 * measurably different fights.
 *
 * Two independent axes:
 *   skill tier   — how well they fly and shoot (rookie → nemesis)
 *   temperament  — what they *choose* to do (aggressive / cautious / reckless /
 *                  disciplined). A reckless rookie and a reckless ace both press
 *                  a head-on merge; only one of them survives it.
 */
import { clamp01, lerp, hash01 } from './aimath.js';

/**
 * Skill tiers.
 *
 *  reaction     seconds between "I can see it" and "I am doing something"
 *  aimError     radians of slow aim wander at 1 km (scaled by range + target G)
 *  aimTau       correlation time of that wander — big = lazy drift, not jitter
 *  fireCone     half-angle within which they will pull the trigger (discipline:
 *               the better the pilot, the *tighter* this is — rookies spray)
 *  burst        [min,max] trigger-down seconds
 *  gap          [min,max] trigger-up seconds
 *  turnTau      steering law time constant — smaller = crisper, higher-G flying
 *  energy       0..1 energy management: throttle/afterburner discipline
 *  predict      0..1 how much they extrapolate a manoeuvring target
 *  repertoire   which manoeuvres they know at all
 *  missileSkill 0..1 launch discipline + evasion timing
 */
export const SKILL_TIERS = {
  rookie: {
    rank: 0,
    reaction: 0.62,
    aimError: 0.030,
    aimTau: 1.35,
    fireCone: 0.115,
    burst: [0.55, 1.6],
    gap: [0.35, 0.9],
    turnTau: 0.46,
    energy: 0.25,
    predict: 0.35,
    missileSkill: 0.3,
    evadeDelay: 0.85,
    repertoire: ['purePursuit', 'leadPursuit', 'breakTurn', 'jink', 'extend', 'missileBreak', 'headOnMerge'],
  },
  veteran: {
    rank: 1,
    reaction: 0.34,
    aimError: 0.0135,
    aimTau: 1.05,
    fireCone: 0.075,
    burst: [0.4, 1.05],
    gap: [0.28, 0.75],
    turnTau: 0.36,
    energy: 0.6,
    predict: 0.75,
    missileSkill: 0.6,
    evadeDelay: 0.45,
    repertoire: [
      'purePursuit', 'leadPursuit', 'lagPursuit', 'breakTurn', 'jink', 'extend',
      'missileBreak', 'headOnMerge', 'highYoyo', 'splitS', 'immelmann', 'flatScissors',
    ],
  },
  ace: {
    rank: 2,
    reaction: 0.2,
    aimError: 0.0062,
    aimTau: 0.85,
    fireCone: 0.052,
    burst: [0.3, 0.8],
    gap: [0.22, 0.6],
    turnTau: 0.29,
    energy: 0.85,
    predict: 0.95,
    missileSkill: 0.85,
    evadeDelay: 0.25,
    repertoire: [
      'purePursuit', 'leadPursuit', 'lagPursuit', 'breakTurn', 'jink', 'extend',
      'missileBreak', 'headOnMerge', 'highYoyo', 'lowYoyo', 'splitS', 'immelmann',
      'flatScissors', 'rollingScissors', 'barrelRoll',
    ],
  },
  nemesis: {
    rank: 3,
    reaction: 0.14,
    aimError: 0.0034,
    aimTau: 0.7,
    fireCone: 0.042,
    burst: [0.26, 0.7],
    gap: [0.18, 0.45],
    turnTau: 0.25,
    energy: 1.0,
    predict: 1.0,
    missileSkill: 1.0,
    evadeDelay: 0.16,
    repertoire: [
      'purePursuit', 'leadPursuit', 'lagPursuit', 'breakTurn', 'jink', 'extend',
      'missileBreak', 'headOnMerge', 'highYoyo', 'lowYoyo', 'splitS', 'immelmann',
      'flatScissors', 'rollingScissors', 'barrelRoll',
    ],
  },
};

/**
 * Temperaments. These shift *decisions*, not competence.
 *
 *  aggression  engage envelope, how long they hold a gun run, merge commitment
 *  nerve       hull fraction at which they think about leaving
 *  discipline  formation tightness, order compliance, trigger restraint,
 *              willingness to cover a wingman instead of chasing a kill
 *  flair       probability of choosing a fancy manoeuvre over the plain one
 *  patience    how long they will sit in lag pursuit rebuilding a solution
 *  chatter     how much they talk
 */
export const TEMPERAMENTS = {
  aggressive: { aggression: 0.9, nerve: 0.24, discipline: 0.5, flair: 0.55, patience: 0.35, chatter: 0.8 },
  cautious: { aggression: 0.42, nerve: 0.55, discipline: 0.75, flair: 0.3, patience: 0.85, chatter: 0.45 },
  reckless: { aggression: 1.0, nerve: 0.12, discipline: 0.2, flair: 0.85, patience: 0.15, chatter: 1.0 },
  disciplined: { aggression: 0.62, nerve: 0.35, discipline: 1.0, flair: 0.4, patience: 0.75, chatter: 0.55 },
};

export const TEMPERAMENT_IDS = Object.keys(TEMPERAMENTS);
export const SKILL_IDS = Object.keys(SKILL_TIERS);

// ------------------------------------------------------------------- naming

const CONFED_FIRST = [
  'Marcus', 'Elena', 'Dieter', 'Yuki', 'Rosa', 'Owen', 'Priya', 'Kestrel', 'Anton',
  'Mira', 'Cal', 'Ines', 'Ravi', 'Thea', 'Boyd', 'Nadia', 'Jonas', 'Lex',
];
const CONFED_LAST = [
  'Vance', 'Okonkwo', 'Brandt', 'Sasaki', 'Delgado', 'Reyes', 'Mahal', 'Kirov',
  'Ferrow', 'Lindqvist', 'Achebe', 'Marchetti', 'Stroud', 'Halloran', 'Ptak', 'Ives',
];
const CONFED_CALLSIGNS = [
  'Ripcord', 'Dagger', 'Tally', 'Switchblade', 'Gremlin', 'Nomad', 'Halftrack', 'Pyre',
  'Ratchet', 'Vector', 'Coldsnap', 'Bishop', 'Deadbolt', 'Lucky', 'Pike', 'Anvil',
  'Sundog', 'Wrecker', 'Cinder', 'Quill', 'Tinman', 'Bandsaw',
];
/** Hostile pilots get harsher, less pronounceable handles — they are the Other. */
const HOSTILE_CALLSIGNS = [
  'Kaskir', 'Vrenn', 'Thal-Ra', 'Skarn', 'Ozhek', 'Nrath', 'Sivek', 'Karrig',
  'Deshi', 'Zurath', 'Mekk', 'Ashaan', 'Torvek', 'Ghal', 'Rekhan', 'Yssin',
];
const HOSTILE_HOUSES = [
  'of the Broken Spire', 'Hive-Second', 'Blood Talon', 'of Nar Shivak',
  'Third Claw', 'Deep Chorus', 'Ash Brood', 'of the Long Silence',
];

/** Deterministic pick from a list. */
const pick = (list, seed, salt) => list[Math.floor(hash01(seed, salt) * list.length) % list.length];

/**
 * Build a pilot profile. Everything is derived from `seed`, so the same ship in
 * the same mission always draws the same person — which matters, because a
 * player who kills "Ripcord" twice in one campaign notices.
 */
export function makePilotProfile({
  seed = 1,
  skill = 'veteran',
  temperament = null,
  name = null,
  callsign = null,
  faction = 'confed',
  hostile = false,
} = {}) {
  const tierId = SKILL_TIERS[skill] ? skill : 'veteran';
  const tier = SKILL_TIERS[tierId];

  const tempId =
    temperament && TEMPERAMENTS[temperament]
      ? temperament
      : TEMPERAMENT_IDS[Math.floor(hash01(seed, 3301) * TEMPERAMENT_IDS.length) % TEMPERAMENT_IDS.length];
  const temp = TEMPERAMENTS[tempId];

  const alien = hostile || (faction !== 'confed' && faction !== 'militia' && faction !== 'civilian');

  const finalName =
    name ||
    (alien
      ? `${pick(HOSTILE_CALLSIGNS, seed, 11)} ${pick(HOSTILE_HOUSES, seed, 13)}`
      : `${pick(CONFED_FIRST, seed, 17)} ${pick(CONFED_LAST, seed, 19)}`);
  const finalCall =
    callsign || (alien ? pick(HOSTILE_CALLSIGNS, seed, 23) : pick(CONFED_CALLSIGNS, seed, 29));

  // Per-pilot variation so two aces of the same temperament are not clones.
  const jitter = (salt, amt) => (hash01(seed, salt) - 0.5) * 2 * amt;

  const profile = {
    seed,
    skill: tierId,
    rank: tier.rank,
    temperament: tempId,
    name: finalName,
    callsign: finalCall,
    faction,

    // competence
    reaction: Math.max(0.05, tier.reaction * (1 + jitter(41, 0.2))),
    aimError: Math.max(0.0008, tier.aimError * (1 + jitter(43, 0.3))),
    aimTau: tier.aimTau * (1 + jitter(47, 0.25)),
    fireCone: tier.fireCone * (1 + jitter(53, 0.15)),
    burst: tier.burst,
    gap: tier.gap,
    turnTau: tier.turnTau * (1 + jitter(59, 0.1)),
    energy: clamp01(tier.energy + jitter(61, 0.12)),
    predict: clamp01(tier.predict + jitter(67, 0.1)),
    missileSkill: clamp01(tier.missileSkill + jitter(71, 0.12)),
    evadeDelay: Math.max(0.06, tier.evadeDelay * (1 + jitter(73, 0.25))),
    repertoire: new Set(tier.repertoire),

    // disposition
    aggression: clamp01(temp.aggression + jitter(79, 0.12)),
    nerve: clamp01(temp.nerve + jitter(83, 0.1)),
    discipline: clamp01(temp.discipline + jitter(89, 0.12)),
    flair: clamp01(temp.flair + jitter(97, 0.15)),
    patience: clamp01(temp.patience + jitter(101, 0.15)),
    chatter: clamp01(temp.chatter + jitter(103, 0.15)),

    // which way this pilot instinctively breaks when the geometry is symmetric.
    // Small thing; it is why two bandits do not mirror each other perfectly.
    breakBias: hash01(seed, 107) < 0.5 ? -1 : 1,
    planeHint: (hash01(seed, 109) - 0.5) * 0.9,
  };

  // Derived envelopes the behaviour layer reads directly.
  profile.engageRange = lerp(3200, 6000, profile.aggression);
  profile.gunRangeMin = lerp(190, 110, profile.aggression); // reckless pilots press closer
  profile.breakOffRange = lerp(320, 150, profile.aggression);
  profile.fleeHull = clamp01(profile.nerve * 0.55); // hull fraction that triggers running
  profile.mergeCommit = lerp(520, 170, profile.aggression); // metres held in a head-on
  profile.abBudget = lerp(0.45, 1, profile.energy); // fraction of time willing to burn AB
  return profile;
}

/** Human-readable one-liner, used by debug.js and the self-test report. */
export function describePilot(p) {
  return `${p.callsign} (${p.name}) — ${p.skill}/${p.temperament} agg ${p.aggression.toFixed(2)} nerve ${p.nerve.toFixed(2)}`;
}
