import * as THREE from 'three';

/**
 * Environment presets — the colour identity of a mission.
 *
 * Prophecy framed almost every dogfight against a coloured nebula wall, and the
 * palette of that wall is what makes one system read differently from another.
 * Each preset drives three things that must agree with each other:
 *
 *   1. the nebula's three emission bands + its dust colour,
 *   2. the primary star's colour temperature and key-light intensity,
 *   3. the PMREM fill that lands on every hull in the scene.
 *
 * All colours are **linear** HDR triples, not sRGB hex. The world renders with no
 * tone mapping (ARCHITECTURE §1.7) so cores above 1.0 are deliberate — that is
 * what feeds bloom and god rays downstream.
 *
 * On the three lighting numbers, because they are easy to under-set:
 *
 *   `star.intensity`  three.js divides Lambert diffuse by pi, so a hull reflects
 *                     `albedo * intensity / pi` at full N·L. At the bible's floor of
 *                     3 even a 0.25-albedo hull only reaches 0.24 linear; these sit
 *                     in the upper half of the 3–6 band so the lit side lands near
 *                     0.4–0.5 after ACES.
 *   `envIntensity`    the *only* fill in the game — there is no hemisphere light by
 *                     design — and a nebula PMREM is a very dark source, so this
 *                     runs near 2 to keep the shadow side coloured rather than
 *                     crushed. It also drives every metal reflection in the scene.
 *   `star.rim`        scaled by PrimaryStar to ~15 % of key (bible §7). The triples
 *                     below are near-unit so that ratio actually lands; a rim colour
 *                     of 0.2 silently makes it 3 %.
 */

const v = (x, y, z) => new THREE.Vector3(x, y, z).normalize();

/**
 * @typedef {object} Preset
 * @property {string} id
 * @property {object} sky   nebula generation parameters
 * @property {object} star  primary star + key light
 */

export const PRESETS = {
  // ------------------------------------------------------- teal / oxygen-rich
  'nebula-teal': {
    id: 'nebula-teal',
    sky: {
      seed: 11.37,
      scale: 2.15,
      warp: 2.9,
      coverage: 0.30,
      dust: 1.05,
      absorb: 3.9,
      exposure: 1.0,
      wall: v(-0.35, 0.18, 0.92),
      wallSoft: 0.95,
      galNormal: v(0.28, 0.93, -0.24),
      gasHot: [0.62, 1.35, 1.30],
      gasMid: [0.07, 0.52, 0.62],
      gasCool: [0.020, 0.105, 0.175],
      dustCol: [0.045, 0.055, 0.080],
      deep: [0.0075, 0.0130, 0.0230],
      band: [0.085, 0.115, 0.165],
    },
    star: {
      dir: v(-0.58, 0.40, 0.71),
      temperature: 7400,
      color: [0.72, 0.83, 1.0],
      intensity: 5.6,
      rim: [0.36, 0.80, 0.94],
      angular: 0.0105,
    },
    envIntensity: 1.95,
  },

  // ------------------------------------------------- magenta / hydrogen-alpha
  'nebula-magenta': {
    id: 'nebula-magenta',
    sky: {
      seed: 73.19,
      scale: 2.35,
      warp: 3.1,
      coverage: 0.28,
      dust: 1.15,
      absorb: 4.2,
      exposure: 1.0,
      wall: v(0.30, 0.14, -0.94),
      wallSoft: 1.0,
      galNormal: v(-0.18, 0.90, 0.40),
      gasHot: [1.45, 0.42, 0.86],
      gasMid: [0.56, 0.10, 0.44],
      gasCool: [0.115, 0.030, 0.205],
      dustCol: [0.062, 0.032, 0.058],
      deep: [0.0165, 0.0080, 0.0250],
      band: [0.130, 0.100, 0.170],
    },
    star: {
      dir: v(0.34, 0.24, -0.91),
      temperature: 9200,
      color: [0.78, 0.85, 1.0],
      intensity: 5.8,
      rim: [0.86, 0.34, 0.78],
      angular: 0.0090,
    },
    envIntensity: 1.85,
  },

  // ---------------------------------------------------- ember / red-giant sky
  'nebula-ember': {
    id: 'nebula-ember',
    sky: {
      seed: 148.6,
      scale: 2.05,
      warp: 2.7,
      coverage: 0.31,
      dust: 1.30,
      absorb: 4.6,
      exposure: 1.0,
      wall: v(-0.42, 0.10, -0.90),
      wallSoft: 0.9,
      galNormal: v(0.36, 0.88, 0.31),
      gasHot: [1.55, 0.66, 0.22],
      gasMid: [0.66, 0.205, 0.075],
      gasCool: [0.170, 0.055, 0.048],
      dustCol: [0.058, 0.030, 0.022],
      deep: [0.0215, 0.0115, 0.0105],
      band: [0.150, 0.115, 0.090],
    },
    star: {
      dir: v(-0.44, 0.31, -0.84),
      temperature: 3900,
      color: [1.0, 0.60, 0.38],
      intensity: 5.2,
      rim: [0.94, 0.44, 0.22],
      angular: 0.0180,
    },
    envIntensity: 2.05,
  },

  // ------------------------------------------------------- cold deep-blue rift
  'nebula-deep-blue': {
    id: 'nebula-deep-blue',
    sky: {
      seed: 205.4,
      scale: 2.25,
      warp: 3.0,
      coverage: 0.33,
      dust: 1.0,
      absorb: 3.7,
      exposure: 1.0,
      wall: v(0.22, -0.10, -0.97),
      wallSoft: 1.05,
      galNormal: v(-0.32, 0.86, -0.40),
      gasHot: [0.52, 0.78, 1.50],
      gasMid: [0.10, 0.24, 0.62],
      gasCool: [0.024, 0.055, 0.170],
      dustCol: [0.030, 0.040, 0.068],
      deep: [0.0065, 0.0105, 0.0245],
      band: [0.090, 0.120, 0.180],
    },
    star: {
      dir: v(0.62, 0.40, 0.67),
      temperature: 11000,
      color: [0.80, 0.87, 1.0],
      intensity: 6.0,
      rim: [0.30, 0.52, 0.98],
      angular: 0.0085,
    },
    envIntensity: 1.75,
  },

  // ------------------------------------ the showcase: magenta core, teal rims
  'nebula-vista': {
    id: 'nebula-vista',
    sky: {
      seed: 317.8,
      scale: 2.30,
      warp: 3.25,
      coverage: 0.26,
      dust: 1.25,
      absorb: 4.4,
      exposure: 1.05,
      wall: v(-0.22, -0.10, -0.97),
      wallSoft: 1.25,
      galNormal: v(0.42, 0.84, -0.34),
      gasHot: [1.50, 0.46, 0.78],
      gasMid: [0.13, 0.62, 0.72],
      gasCool: [0.045, 0.095, 0.245],
      dustCol: [0.052, 0.036, 0.050],
      deep: [0.0125, 0.0160, 0.0300],
      band: [0.120, 0.140, 0.190],
    },
    star: {
      dir: v(-0.52, 0.30, -0.80),
      temperature: 5100,
      color: [1.0, 0.80, 0.60],
      intensity: 5.5,
      rim: [0.74, 0.46, 0.80],
      angular: 0.0140,
    },
    envIntensity: 2.0,
  },
};

export const PRESET_IDS = Object.keys(PRESETS);
export const DEFAULT_PRESET = 'nebula-teal';

export function getPreset(name) {
  return PRESETS[name] ?? PRESETS[DEFAULT_PRESET];
}
