/**
 * Cockpit layout — the single source of truth for where everything sits.
 *
 * Both the texture atlas (which paints legends, wells and placards) and the
 * geometry builder (which extrudes the panel, bezels and screens) read these
 * numbers, so a label can never drift off the thing it labels.
 *
 * ## Frames of reference
 *
 * *Cockpit space*: metres, origin at the pilot's eye, **-Z forward**, +Y up,
 * +X starboard — the same convention every hull in `ships/` uses.
 *
 * *Panel space*: metres in the plane of the main instrument panel, origin at its
 * centre, +X starboard, +Y toward the top edge of the panel. `PANEL.position` and
 * `PANEL.tilt` map panel space into cockpit space.
 *
 * The numbers are chosen against a 58° vertical FOV — the engine default — so the
 * structure fills the lower ~40 % of frame at the centreline and rises to ~48 % at
 * the canopy sills, which is where ARCHITECTURE §7 wants it.
 */

/** Main instrument panel. */
export const PANEL = {
  w: 1.20,
  h: 0.35,
  thickness: 0.05,
  /** Centre of the panel face in cockpit space. */
  position: [0, -0.245, -0.74],
  /** Rotation about X. Negative tilts the top edge away from the pilot. */
  tilt: -0.42,
};

/** Multi-function displays, in panel space. Square so a 512² target maps 1:1. */
export const MFD = {
  size: 0.225,
  y: 0.002,
  leftX: -0.405,
  rightX: 0.405,
  bezel: 0.028,
  /** How far the bezel stands proud of the panel face. */
  relief: 0.014,
};

/** Central tactical radar globe, in panel space. */
export const RADAR = {
  x: 0,
  y: 0.012,
  r: 0.113,
  bezel: 0.022,
  relief: 0.012,
};

/** Centre stack that carries the radar and the annunciator lamps. */
export const STACK = { halfWidth: 0.175 };

/** Glareshield / coaming hood over the panel. */
export const COAMING = {
  /** Near lip (closest to the pilot) at the centreline. */
  nearY: -0.055,
  nearZ: -0.575,
  /** Front edge, where it meets the panel top. */
  farY: -0.108,
  farZ: -0.815,
  halfWidth: 0.60,
  /** Extra height at the outboard corners, which frames the view. */
  cornerRise: 0.085,
  /** Corners also splay outboard toward the canopy sills. */
  cornerSplay: 0.055,
  thickness: 0.035,
};

/** Side consoles: left carries the throttle, right the side-stick. */
export const CONSOLE = {
  innerX: 0.335,
  outerX: 0.66,
  topY: -0.245,
  frontZ: -0.80,
  backZ: -0.16,
  drop: 0.28,
  /** Angle the deck slopes down outboard, radians. */
  cant: 0.30,
};

/** Throttle quadrant, cockpit space. */
export const THROTTLE = {
  pivot: [-0.455, -0.315, -0.485],
  armLength: 0.20,
  /** Lever angle at idle and at full military power, radians about +X. */
  idle: 0.62,
  full: -0.30,
};

/** Right-hand side-stick, cockpit space. */
export const STICK = {
  pivot: [0.455, -0.44, -0.375],
  length: 0.22,
  /** Maximum visible deflection, radians. */
  travel: 0.13,
};

/** Canopy: the arch that frames the view and the transparency behind it. */
export const CANOPY = {
  /** Arch half-width and height above the sill reference, metres. */
  a: 0.615,
  b: 0.735,
  centreY: -0.165,
  /** Longitudinal position of the arch apex and its sills. */
  apexZ: -1.005,
  sillZ: -0.905,
  /** Angular sweep of the frame tube, radians either side of the apex. */
  sweep: 1.30,
  /** Where the sill rails run back to. */
  railBackZ: 0.62,
  tubeRadius: 0.033,
};

/** HUD combiner glass above the coaming. */
export const COMBINER = {
  halfWidth: 0.215,
  bottomY: -0.070,
  topY: 0.115,
  z: -0.585,
  tilt: 0.16,
};

/** Where the HUD symbology may draw, as a fraction of frame height from the top. */
export const HUD_FLOOR = 0.585;

/** HUD phosphor colour and over-range intensity (ARCHITECTURE §7). */
export const HUD_COLOR = '#7fe4ff';
export const HUD_INTENSITY = 1.62;
