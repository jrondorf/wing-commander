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
 * On the four lighting numbers, because they are easy to get wrong:
 *
 *   `star.dir`        **the single biggest lever on whether a hull reads as solid.**
 *                     Not a decoration — it decides which N·L band the *visible*
 *                     surfaces occupy, and a fighter is not a sphere: it is a slab
 *                     with a broad top deck and a near-vertical flank, and those two
 *                     families are what the eye reads a terminator between. So the
 *                     number that matters is the key's **elevation**, not its azimuth
 *                     offset from the camera. Measured against the capture harness,
 *                     the old set had every star sitting 10–24° above the horizontal:
 *                     hero-fighter's top deck reached only N·L 0.40 while its flank
 *                     held 0.13, a 3:1 irradiance spread that the ACES shoulder
 *                     squeezed to 149-vs-87 on screen — mid grey against mid grey,
 *                     i.e. flat. (Swinging the azimuth *toward* the camera is worse,
 *                     not better: it lights top and flank equally and the terminator
 *                     leaves the visible form entirely.) Each `dir` below now sits
 *                     44–52° up, with 70–80° of azimuth between it and its primary
 *                     scenario's camera, which puts the top deck near N·L 0.75, the
 *                     flank near 0.15, and the terminator right along the shoulder
 *                     where the fuselage rolls over — the most legible place on the
 *                     model for it to be.
 *   `star.intensity`  three.js divides Lambert diffuse by pi, so a hull reflects
 *                     `albedo * intensity / pi` at full N·L. With hull albedo now
 *                     correctly authored at 0.20–0.45 linear (see MaterialLibrary's
 *                     `adaptPalette`) and the post stack exposing at 3.2, intensity 5.6
 *                     drove the lit side to ~0.5 linear — past the ACES shoulder,
 *                     where a 2:1 irradiance ratio compresses to 1.2:1 on screen and
 *                     the terminator dissolves. ~4.2 lands the lit side around 0.28
 *                     linear: mid-curve, with shoulder left over for speculars.
 *   `envIntensity`    the *only* fill in the game — there is no hemisphere light by
 *                     design. Multiplied by each material's own `envMapIntensity`
 *                     (hulls: 2.1), so the numbers below are half of the real figure.
 *                     They are **not** free-hand: each was solved so that the PMREM's
 *                     measured irradiance lands at 12 % of that preset's key radiance,
 *                     which is where the shadow side reads as coloured nebula light
 *                     instead of crushing to black. The nebulae are not equally bright
 *                     — at a flat 2.0 across the board, deep-blue delivered 8.6 % (the
 *                     carrier's ventral hull went to rgb 9,11,40) while vista delivered
 *                     14.5 % — so a shared constant is exactly the wrong shape for this
 *                     number. Measured PMREM irradiance per unit of the product, from
 *                     an albedo-1 lambert probe averaged over six axis normals:
 *                       teal 0.0192  magenta 0.0192  ember 0.0224
 *                       deep-blue 0.0159  vista 0.0231
 *                     Re-solve against those if a `sky` block is ever retuned.
 *   `star.rim`        scaled by PrimaryStar to ~13 % of key *radiance* (bible §7).
 *                     The triples below are near-unit so that ratio actually lands; a
 *                     rim colour of 0.2 silently makes it 3 %.
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
      // hero-fighter frames from azimuth 0.85 / elevation 0.24. High upper-left, 50°
      // up and 78° round: top deck N·L 0.77, flank 0.13. The nose points frame-right
      // and falls into shadow, which is where the rim then does its work.
      dir: v(-0.315, 0.766, 0.561),
      temperature: 7400,
      color: [0.72, 0.83, 1.0],
      intensity: 4.2,
      rim: [0.36, 0.80, 0.94],
      angular: 0.0105,
    },
    envIntensity: 2.50,   // -> 12.0 % fill:key
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
      // Magenta is a cockpit palette (cockpit-idle, missile-lock) and the view axis is
      // the ship's nose, so "elevation" here means height above the flight path: 44°
      // up and off to port. Traffic ahead-to-starboard shows the camera a lit port
      // flank (0.60) and dorsal (0.69) with its aft in shadow (-0.40) — a terminator
      // on a moving subject — and the cockpit coaming is raked from the left.
      dir: v(-0.599, 0.694, -0.399),
      temperature: 9200,
      color: [0.78, 0.85, 1.0],
      intensity: 4.3,
      rim: [0.86, 0.34, 0.78],
      angular: 0.0090,
    },
    envIntensity: 2.70,   // -> 12.0 % fill:key
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
      // cockpit-combat is the money frame. 46° up and to port: crossing targets get
      // dorsal 0.72 / port flank 0.46 / aft -0.52, so a Nephilim fighter turning
      // through the frame rolls its own terminator across itself. The red giant's
      // disc lands outside a 55° fov — a star this high cannot also be on screen in
      // a level cockpit view, and shape on the targets is worth more than the disc.
      dir: v(-0.460, 0.720, -0.520),
      temperature: 3900,
      color: [1.0, 0.60, 0.38],
      intensity: 4.0,
      rim: [0.94, 0.44, 0.22],
      angular: 0.0180,
    },
    envIntensity: 2.20,   // -> 11.9 % fill:key
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
      // capital-ship frames from azimuth 1.15 / elevation 0.18. The old direction sat
      // 26° off that — near-frontal, which flattens a 400 m hull into a lit billboard
      // and kills every greeble's shadow. 46° up and 76° round: top decks at 0.72,
      // flank at 0.17, so the terminator runs the length of the hull and the greebling
      // finally casts something.
      dir: v(-0.122, 0.719, 0.684),
      temperature: 11000,
      color: [0.80, 0.87, 1.0],
      intensity: 4.4,
      rim: [0.30, 0.52, 0.98],
      angular: 0.0085,
    },
    envIntensity: 3.20,   // -> 12.0 % fill:key
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
      // The vista shot exists to show the star, so this is the one preset deliberately
      // kept near the view axis (26°, up and right of centre): on screen for god rays,
      // off centre enough that the shafts rake diagonally, and oblique enough to throw
      // a crescent terminator across the planet.
      dir: v(0.121, 0.278, -0.953),
      temperature: 5100,
      color: [1.0, 0.80, 0.60],
      intensity: 4.1,
      rim: [0.74, 0.46, 0.80],
      angular: 0.0140,
    },
    envIntensity: 2.05,   // -> 11.9 % fill:key
  },
};

export const PRESET_IDS = Object.keys(PRESETS);
export const DEFAULT_PRESET = 'nebula-teal';

export function getPreset(name) {
  return PRESETS[name] ?? PRESETS[DEFAULT_PRESET];
}
