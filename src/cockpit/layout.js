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
 * ## The visibility band — why these numbers are what they are
 *
 * At the engine's 58° vertical FOV the glareshield's lower lip cuts the frame at
 * ~67 % of its height and the bottom of frame falls at panel y = −0.145. So the
 * *only* part of the instrument panel a pilot can actually see is
 *
 *     panel y ∈ [−0.145, +0.104]      (~25 cm of a 35 cm panel)
 *
 * Everything that must be read — both MFDs, the radar globe, the switch columns,
 * the corner rotaries — is placed inside that band, and everything above it is
 * deliberately decorative because the hood eats it. Move any of these and check
 * the band again, or you will spend a capture wondering where the MFDs went.
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
  size: 0.195,
  y: -0.020,
  leftX: -0.405,
  rightX: 0.405,
  bezel: 0.026,
  /** How far the bezel stands proud of the panel face. */
  relief: 0.014,
};

/** Central tactical radar globe, in panel space. */
export const RADAR = {
  x: 0,
  y: -0.015,
  r: 0.105,
  bezel: 0.020,
  relief: 0.012,
  /** Radius of the physical globe standing in the well, and its stand-off. */
  globe: 0.072,
  globeRelief: 0.030,
};

/** Centre stack that carries the radar and the annunciator lamps. */
export const STACK = { halfWidth: 0.175 };

/** Switch columns flanking the centre stack, panel space. */
export const SWITCHES = {
  colX: 0.228,
  topY: 0.095,
  pitch: 0.058,
  rows: 5,
};

/** Corner rotaries. */
export const KNOBS = { x: 0.564, ys: [0.040, -0.060], r: 0.0205 };

/** Glareshield / coaming hood over the panel. */
export const COAMING = {
  /** Near lip (closest to the pilot) at the centreline. */
  nearY: -0.035,
  nearZ: -0.560,
  /** Front edge, where it meets the panel top. */
  farY: -0.100,
  farZ: -0.820,
  halfWidth: 0.60,
  /** Extra height at the outboard corners, which frames the view. */
  cornerRise: 0.085,
  /** Corners also splay outboard toward the canopy sills. */
  cornerSplay: 0.055,
  thickness: 0.035,
  /** Drop of the forward lip. Larger eats into the top of the MFDs. */
  lipDrop: 0.055,
};

/**
 * Cockpit side wall: closes the lower corners of the frame and carries the eye
 * from the instrument panel up to the canopy sill.
 *
 * The main panel is 1.2 m across, so anything inboard of x = 0.6 would cut
 * straight over the MFDs. Each station is therefore outboard of the panel edge
 * and rakes outboard going aft, which puts it off-frame within half a metre —
 * exactly the behaviour of a real tub.
 */
export const SIDEWALL = {
  z: [-0.88, -0.62, -0.32, 0.05, 0.45],
  topX: [0.600, 0.660, 0.700, 0.712, 0.700],
  topY: [0.020, 0.010, 0.000, -0.010, -0.030],
  botX: [0.610, 0.700, 0.755, 0.775, 0.760],
  botY: [-0.460, -0.445, -0.430, -0.425, -0.425],
  /** Outward bulge of the mid station, metres. */
  bulge: 0.022,
};

/** Side consoles: left carries the throttle, right the side-stick. */
export const CONSOLE = {
  innerX: 0.615,
  outerX: 0.95,
  topY: -0.425,
  frontZ: -0.82,
  backZ: 0.10,
  drop: 0.24,
  /** Angle the deck slopes down outboard, radians. */
  cant: 0.26,
};

/**
 * Throttle quadrant, cockpit space. Placed so the grip just breaks the bottom
 * left of frame — a control the pilot can see moving is worth a lot of the
 * "this is a machine" read, and it costs one draw call.
 */
export const THROTTLE = {
  pivot: [-0.455, -0.335, -0.615],
  armLength: 0.19,
  /** Lever angle at idle and at full military power, radians about +X. */
  idle: 0.62,
  full: -0.30,
};

/** Right-hand side-stick, cockpit space. */
export const STICK = {
  pivot: [0.470, -0.445, -0.520],
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
export const HUD_FLOOR = 0.560;

/** HUD phosphor colour and over-range intensity (ARCHITECTURE §7). */
export const HUD_COLOR = '#7fe4ff';
export const HUD_INTENSITY = 1.62;

/**
 * Opacity of the dark backing laid under the symbology (`hud-backing` in
 * `CockpitSystem.js`).
 *
 * A combiner is additive, so against a sky already at 1.0 the HUD adds nothing
 * and disappears. Flying at the primary star through a nebula core, 18 % of the
 * upper frame measured fully clipped and the entire HUD was invisible. This is
 * the floor of contrast the symbology is guaranteed: high enough to survive a
 * blown sky, low enough that on a dark one it reads as a faint phosphor halo
 * rather than a black outline.
 */
export const HUD_BACKING = 0.88;

/**
 * Dilation radius of that backing, in framebuffer pixels at the *inner* ring;
 * the outer ring is twice this. Measured: at 1 px the bloom spilling off a
 * blown sky closed straight over the keyline and the symbology went with it.
 */
export const HUD_BACKING_PX = 1.6;
