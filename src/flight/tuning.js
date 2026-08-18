/**
 * src/flight/tuning.js — THE FLIGHT MODEL'S NUMBERS. All of them. In one place.
 * ============================================================================
 *
 * Nothing in `src/flight/**` hard-codes a constant; every feel-affecting value
 * lives in one of the tables below so it can be tuned without reading a line of
 * integrator logic.
 *
 * UNITS (ARCHITECTURE §1.6 — 1 world unit = 1 metre)
 *   distance  metres            speed      m/s
 *   accel     m/s²              mass       kg
 *   angles    DEGREES in this file, converted to radians on resolve
 *   rates     degrees/second    time       seconds
 *
 * THE MODEL IN ONE PARAGRAPH
 *   Throttle is a *commanded speed*, not a thrust lever (this is the single
 *   thing that makes Wing Commander feel like Wing Commander). The velocity
 *   vector is split into a component along the nose and a lateral remainder.
 *   The nose component servos toward the commanded speed at `accel`. The
 *   lateral remainder — which is created for free every time you rotate, since
 *   the nose turns and the velocity does not — decays with time-constant
 *   `slipTau`. Small tau = the ship is on rails; large tau = Newtonian drift.
 *   Prophecy sits in between, and that lag is the "weight" players remember.
 *
 * SHIP STAT CONTRACT (ARCHITECTURE §5.4, `src/ships/stats.js`, agent-ships)
 *   stats = { mass, length, maxSpeed, accel, retroAccel,
 *             afterburnSpeed, afterburnAccel,
 *             pitchRate, yawRate, rollRate,   // RADIANS/second
 *             shields, armor, ... }
 *   Turn rates arrive in rad/s. A stat block may opt out with
 *   `stats.rateUnits = 'deg'`, and anything physically absurd (> 6.5 rad/s,
 *   i.e. more than a revolution a second) is auto-detected as degrees.
 *   Everything is then clamped into the per-class sanity ranges below, so a
 *   mis-unit'd stat degrades to "wrong but flyable", never "spins at 300 rev/s".
 *
 *   Optional stats are used when present and derived from the class row when
 *   not, so this module stays useful for ships nobody has authored yet.
 */

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const G_EARTH = 9.80665;

/**
 * Ship-local forward axis. Three.js convention: an Object3D looks down its own
 * -Z (`Object3D.lookAt` and PerspectiveCamera both assume it), so ship meshes
 * from `src/ships/` are expected to have their nose at -Z. If that ever
 * changes, this is the ONE line to flip.
 */
export const FORWARD_SIGN = -1; // forward = FORWARD_SIGN * localZ

// ---------------------------------------------------------------------------
// Integrator — semi-implicit Euler with adaptive substepping
// ---------------------------------------------------------------------------
export const INTEGRATOR = {
  /** Hard ceiling on substeps per frame (cost guard). */
  maxSubsteps: 24,
  /** A body never advances further than this in one substep, in metres. */
  maxTravelPerSubstep: 6.0,
  /**
   * ...and never further than this fraction of the *smallest* collidable radius
   * in the sim. At 1600 m/s an afterburning fighter covers 26.7 m per 1/60 s
   * frame; a 12 m-radius fighter would be tunnelled clean through without this.
   */
  travelSafetyFactor: 0.35,
  /** A body never rotates further than this in one substep, in radians. */
  maxTurnPerSubstep: 0.12,
  /** Frames longer than this are treated as this long (alt-tab guard). */
  maxDt: 0.1,
  /** Below this dt the frame is skipped entirely (paused). */
  minDt: 1e-6,
};

// ---------------------------------------------------------------------------
// Player input mapping (see ACTIONS in src/core/Input.js)
// ---------------------------------------------------------------------------
export const PLAYER = {
  /** How fast the -/= keys walk the commanded throttle across its full range. */
  throttleRate: 0.85, // 1/s
  /**
   * WC/joystick convention: pushing the stick forward (ArrowUp, +1 on the pitch
   * axis) drops the nose. Set false for "pull up = ArrowUp" instead.
   *
   * NOTE this only flips the *raw input axis*. `body.controls.pitch` is always
   * "+1 = nose up" so the AI system has an unambiguous contract to write to.
   */
  invertPitchAxis: true,
  /** Extra deadzone on top of the one Input already applies to gamepads. */
  stickDeadzone: 0.04,
  /** Autopilot / auto-slide are dropped if the pilot moves the stick this far. */
  manualOverrideThreshold: 0.25,
  /** Throttle presets are not bound in ACTIONS yet; kept for when they are. */
  throttlePresets: [0, 0.25, 0.5, 0.75, 1],
  /**
   * Optional actions this system will consume the moment `src/core/Input.js`
   * binds them. `input.held()` is a Set lookup, so unbound names are simply
   * false — no coupling, no crash.
   */
  optionalActions: {
    strafeLeft: 'strafeLeft',
    strafeRight: 'strafeRight',
    strafeUp: 'strafeUp',
    strafeDown: 'strafeDown',
    autoSlide: 'autoSlide',
    flightAssist: 'flightAssist',
  },
};

// ---------------------------------------------------------------------------
// Flight assist — the shaping layer between raw stick and commanded rate
// ---------------------------------------------------------------------------
export const ASSIST = {
  enabled: true,
  /** Blend of the |x|^power curve into the linear response, 0..1. */
  expo: 0.42,
  power: 2.1,
  /**
   * Slew limit on the shaped stick, in units/second. A keyboard tap therefore
   * ramps in over ~1/7 s instead of snapping — the difference between "weighty
   * fighter" and "mouse cursor".
   */
  slewRate: 7.0,
  /** Slew is faster when returning to centre so stopping a turn stays crisp. */
  slewReturnScale: 1.9,
  /** Optional auto-level: rolls wings-level toward world up when hands-off. */
  autoLevel: false,
  autoLevelGain: 0.9,
  autoLevelMaxInput: 0.55,
  /** Below this speed auto-level gives up (no airflow metaphor, just feel). */
  autoLevelMinSpeed: 15,
};

// ---------------------------------------------------------------------------
// Per-class handling. `resolveTuning()` picks a row, then merges the ship's own
// stats over the top and clamps everything into the row's sanity ranges.
// ---------------------------------------------------------------------------

/**
 * FIGHTER — Vampire/Panther-class. The reference feel.
 *   cruise 450 m/s · afterburner 1350 m/s · 78°/s pitch · 165°/s roll
 */
const FIGHTER = {
  className: 'fighter',

  // -- linear ---------------------------------------------------------------
  mass: 14_000,                 // kg, fallback when stats.mass is absent
  maxSpeed: 450,                // m/s commanded at throttle 1.0
  maxSpeedRange: [180, 620],    // sanity clamp on stats.maxSpeed
  accel: 125,                   // m/s² toward the commanded speed
  accelRange: [40, 420],
  accelFromSpeed: 3.6,          // if stats.accel is missing: maxSpeed / this
  decelScale: 1.35,             // fallback when stats.retroAccel is absent
  brakeScale: 1.55,             // × decel, [BRAKE] held
  fullStopScale: 1.35,          // × decel, [FULL STOP] — ~2.5 s from cruise to rest

  // -- afterburner ----------------------------------------------------------
  // Used only when the stat block has no afterburnSpeed/afterburnAccel.
  abSpeedMult: 3.00,            // 450 -> 1350 m/s (brief: 1200-1600)
  abAccelMult: 3.60,            // the kick in the back
  abDecelMult: 1.80,            // distinct falloff when released (~2.5 s to cruise)
  abSpoolUp: 0.45,              // s, thrust ramp in
  abSpoolDown: 0.28,            // s, thrust ramp out
  abFuelDrain: 0.105,           // fuel/s -> ~9.5 s of continuous burn
  abFuelRegen: 0.038,           // fuel/s -> ~26 s to refill from empty
  abBurnoutRecover: 0.30,       // after burnout, need this much fuel to relight
  abTurnPenalty: 0.62,          // control authority at full overspeed
  abGripBoost: 1.60,            // slip realigns this much faster on burners

  // -- angular --------------------------------------------------------------
  pitchRate: 78,                // °/s (brief: 60-110)
  yawRate: 70,
  rollRate: 165,                // °/s (brief: 120-200)
  pitchYawRange: [45, 120],     // sanity clamp
  rollRange: [90, 245],
  angTau: 0.26,                 // s to ~63% of commanded rate — the "weight"
  angStopTauScale: 0.70,        // stopping a turn is crisper than starting one
  angAccelBoost: 1.60,          // ceiling on angular accel = rate/tau * this
  /** Control authority at zero speed, ramping to 1.0 by `authorityFullFrac`. */
  lowSpeedAuthority: 0.45,
  authorityFullFrac: 0.30,      // of maxSpeed

  // -- lateral slip (THE nuance) -------------------------------------------
  /**
   * Time constant for the velocity vector to realign onto the nose. The steady
   * crab angle in a max-rate turn is ~atan(turnRate · slipTau); at the Vampire's
   * 77°/s that is 23° of visible skid, with the flight path lagging the nose by
   * about a third of a second every time you pull. Larger = driftier.
   * THIS IS THE SINGLE MOST FEEL-DEFINING NUMBER IN THE FILE.
   */
  slipTau: 0.32,
  slipTauSlide: 60,             // s — auto-slide/drift mode (~Newtonian)
  slipTauStop: 0.25,            // s — while braking to a full stop
  slipStrafeRelief: 2.60,       // grip loosens while the RCS is firing
  /**
   * THE HARD SPEED CAP. Total speed may not exceed the commanded speed by more
   * than this. Skidding through a corner is allowed to scrub a little extra
   * speed; it is not allowed to become a slingshot.
   */
  slipOverspeed: 1.20,
  slideOverspeed: 2.40,         // ...relaxed in auto-slide, where drift is the point

  // -- RCS / strafe ---------------------------------------------------------
  rcsAccel: 45,                 // m/s² of lateral/vertical translation
  rcsMaxSlide: 130,             // m/s cap on lateral velocity

  // -- idle trim ------------------------------------------------------------
  trimRate: 0.30,               // °/s of lazy wander when hands-off
  trimAccel: 0.045,             // m/s² of positional drift
  trimFreq: [0.37, 0.53, 0.29], // Hz-ish; three incommensurate rates = no loop
  trimSpeedFloor: 0.50,         // m/s of headroom the speed cap always leaves

  // -- feel / feedback ------------------------------------------------------
  inertialDamping: 14,          // divisor turning raw m/s² into "felt" G
  gLoadTau: 0.09,               // s smoothing on the published gLoad
  shakeDecay: 2.0,              // 1/s decay of collision shake

  // -- collision ------------------------------------------------------------
  radius: 12,                   // m, fallback if the mesh has no bounds
  restitution: 0.32,
  collisionDamageScale: 0.35,   // dmg = scale * relSpeed^1.7 * massRatio
  collisionDamageExp: 1.7,
  collisionSpinScale: 0.55,     // how much a hit tumbles you
  collisionSpinMax: 3.0,        // × max turn rate
  collisionCooldown: 0.20,      // s between events for the same pair

  // -- autopilot ------------------------------------------------------------
  apAbortRange: 3500,           // m — hostiles closer than this abort autopilot
  apArriveRadius: 150,          // m
  apArriveSpeed: 60,            // m/s at arrival
  apBurnerDistance: 6000,       // m — use afterburner beyond this
  apAlignGain: 2.6,             // rad -> stick
  apAlignForThrust: 0.965,      // cos of the cone we accelerate inside
  apDecelMargin: 1.25,          // stopping distance safety factor
  apLevelGain: 0.55,            // keeps the horizon steady during the cruise
};

/**
 * HEAVY — bombers, gunships, heavy fighters. Same model, more inertia.
 */
const HEAVY = {
  ...FIGHTER,
  className: 'heavy',
  mass: 42_000,
  maxSpeed: 300,
  maxSpeedRange: [110, 420],
  accel: 60,
  accelRange: [18, 220],
  accelFromSpeed: 5.5,
  decelScale: 1.25,
  brakeScale: 1.45,
  fullStopScale: 1.30,

  abSpeedMult: 2.40,
  abAccelMult: 3.00,
  abDecelMult: 2.10,
  abSpoolUp: 0.70,
  abSpoolDown: 0.40,
  abFuelDrain: 0.090,
  abFuelRegen: 0.030,

  pitchRate: 44,
  yawRate: 40,
  rollRate: 95,
  pitchYawRange: [18, 80],
  rollRange: [35, 150],
  angTau: 0.52,
  angAccelBoost: 1.40,
  lowSpeedAuthority: 0.40,

  slipTau: 0.48,
  slipTauSlide: 90,
  slipTauStop: 0.40,
  slipOverspeed: 1.18,
  slideOverspeed: 2.20,

  rcsAccel: 24,
  rcsMaxSlide: 90,

  trimRate: 0.18,
  trimAccel: 0.030,
  trimSpeedFloor: 0.35,
  inertialDamping: 18,

  radius: 22,
  restitution: 0.26,
  collisionDamageScale: 0.30,

  apArriveRadius: 220,
  apArriveSpeed: 45,
};

/**
 * CAPITAL — carriers, cruisers, transports. Cruise 40-80 m/s, 2-5°/s turns.
 * These slide enormously: a 900 m carrier changing heading keeps its old
 * velocity vector for the best part of ten seconds, which is exactly right.
 */
const CAPITAL = {
  ...FIGHTER,
  className: 'capital',
  mass: 2_600_000,
  maxSpeed: 62,
  maxSpeedRange: [22, 180],
  accel: 4.0,
  accelRange: [0.8, 22],
  accelFromSpeed: 16,
  decelScale: 1.15,
  brakeScale: 1.30,
  fullStopScale: 1.20,

  // "Flank speed" rather than a real afterburner.
  abSpeedMult: 1.25,
  abAccelMult: 1.60,
  abDecelMult: 1.30,
  abSpoolUp: 3.0,
  abSpoolDown: 2.0,
  abFuelDrain: 0.055,
  abFuelRegen: 0.020,
  abTurnPenalty: 0.85,
  abGripBoost: 1.10,

  pitchRate: 2.4,
  yawRate: 3.0,
  rollRate: 3.5,
  pitchYawRange: [0.6, 8],
  rollRange: [0.6, 12],
  angTau: 3.6,
  angStopTauScale: 0.85,
  angAccelBoost: 1.25,
  lowSpeedAuthority: 0.72,
  authorityFullFrac: 0.22,

  slipTau: 6.0,
  slipTauSlide: 240,
  slipTauStop: 2.0,
  slipStrafeRelief: 1.40,
  slipOverspeed: 1.12,
  slideOverspeed: 1.80,

  rcsAccel: 2.6,
  rcsMaxSlide: 26,

  trimRate: 0.05,
  trimAccel: 0.012,
  trimSpeedFloor: 0.15,
  inertialDamping: 45,

  radius: 300,
  restitution: 0.12,
  collisionDamageScale: 0.55,
  collisionSpinScale: 0.10,

  apAbortRange: 9000,
  apArriveRadius: 900,
  apArriveSpeed: 12,
  apBurnerDistance: 40_000,
  apAlignGain: 1.4,
};

export const CLASS_TUNING = { fighter: FIGHTER, heavy: HEAVY, capital: CAPITAL };

/** Used when `src/ships/Ships.js` has not filled in a stat block. */
export const DEFAULT_STATS = {
  mass: FIGHTER.mass,
  maxSpeed: FIGHTER.maxSpeed,
  accel: FIGHTER.accel,
  pitchRate: FIGHTER.pitchRate,
  yawRate: FIGHTER.yawRate,
  rollRate: FIGHTER.rollRate,
};

// ---------------------------------------------------------------------------
// Class inference
// ---------------------------------------------------------------------------
const CAPITAL_RE = /carrier|cruiser|destroy|dreadnought|battleship|frigate|corvette|capital|station|transport|freighter|tanker|hauler|liner|dread|cap_/i;
const HEAVY_RE = /bomber|heavy|gunship|assault|torpedo|shuttle|dropship|interdictor|hades|devastator/i;

/**
 * Decide which handling row a ship belongs to. Explicit wins, then the class id
 * string, then mass, then top speed. Ships may override with
 * `stats.flightClass = 'fighter' | 'heavy' | 'capital'`.
 */
export function inferClass(stats = {}, classId = '') {
  const explicit = stats.flightClass ?? stats.hullClass ?? stats.category ?? null;
  if (explicit && CLASS_TUNING[explicit]) return explicit;

  const id = String(classId ?? '');
  if (CAPITAL_RE.test(id)) return 'capital';
  if (HEAVY_RE.test(id)) return 'heavy';

  const mass = Number(stats.mass);
  if (Number.isFinite(mass) && mass > 0) {
    if (mass >= 150_000) return 'capital';
    if (mass >= 26_000) return 'heavy';
    return 'fighter';
  }

  const v = Number(stats.maxSpeed);
  if (Number.isFinite(v) && v > 0) {
    if (v <= 120) return 'capital';
    if (v <= 240) return 'heavy';
  }
  return 'fighter';
}

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const clampN = (v, [lo, hi]) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Merge a ship's stat block onto its class row and convert everything to SI.
 * The result is a flat, frozen-in-spirit record the FlightBody reads directly —
 * no lookups or unit maths inside the substep loop.
 */
/**
 * Turn rates arrive from `src/ships/stats.js` in rad/s. Anything above 6.5 rad/s
 * (a revolution a second) is physically absurd for a ship and is therefore a
 * degrees value that slipped through, so convert it. `stats.rateUnits` wins.
 */
function toDegPerSec(value, fallbackDeg, units) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return fallbackDeg;
  if (units === 'deg') return v;
  if (units === 'rad') return v * RAD;
  return v > 6.5 ? v : v * RAD;
}

export function resolveTuning(stats = {}, classId = '') {
  const className = inferClass(stats, classId);
  const T = CLASS_TUNING[className];
  const units = stats.rateUnits ?? null;

  const mass = Math.max(1, num(stats.mass, T.mass));
  const maxSpeed = clampN(num(stats.maxSpeed, T.maxSpeed), T.maxSpeedRange);
  const accel = clampN(num(stats.accel, maxSpeed / T.accelFromSpeed), T.accelRange);
  // Retro thrusters are their own stat and are usually weaker than the main drive.
  const decel = clampN(num(stats.retroAccel, accel * T.decelScale), [
    T.accelRange[0] * 0.4, T.accelRange[1] * 2,
  ]);

  const pitchDeg = clampN(toDegPerSec(stats.pitchRate, T.pitchRate, units), T.pitchYawRange);
  const yawDeg = clampN(toDegPerSec(stats.yawRate, T.yawRate, units), T.pitchYawRange);
  const rollDeg = clampN(toDegPerSec(stats.rollRate, T.rollRate, units), T.rollRange);

  // Authored afterburner numbers win over the class multipliers.
  const abSpeed = Math.max(maxSpeed, num(stats.afterburnSpeed, maxSpeed * T.abSpeedMult));
  const abAccel = Math.max(accel, num(stats.afterburnAccel, accel * T.abAccelMult));

  const pitchRate = pitchDeg * DEG;
  const yawRate = yawDeg * DEG;
  const rollRate = rollDeg * DEG;
  const angTau = num(stats.angTau, T.angTau);

  return {
    className,
    raw: T,

    // linear
    mass,
    invMass: 1 / mass,
    maxSpeed,
    accel,
    decel,
    brakeAccel: decel * T.brakeScale,
    fullStopAccel: decel * T.fullStopScale,

    // afterburner
    abSpeed,
    abAccel,
    abDecel: Math.max(decel, accel * T.abDecelMult),
    abSpoolUp: T.abSpoolUp,
    abSpoolDown: T.abSpoolDown,
    abFuelDrain: num(stats.abFuelDrain, T.abFuelDrain),
    abFuelRegen: num(stats.abFuelRegen, T.abFuelRegen),
    abBurnoutRecover: T.abBurnoutRecover,
    abTurnPenalty: T.abTurnPenalty,
    abGripBoost: T.abGripBoost,
    /** Absolute velocity ceiling — nothing, not even a collision, exceeds it. */
    hardSpeedCap: abSpeed * 1.08,

    // angular (rad/s, rad/s²)
    pitchRate,
    yawRate,
    rollRate,
    maxRate: Math.max(pitchRate, yawRate, rollRate),
    angTau,
    angStopTau: angTau * T.angStopTauScale,
    angAccelPitch: (pitchRate / angTau) * T.angAccelBoost,
    angAccelYaw: (yawRate / angTau) * T.angAccelBoost,
    angAccelRoll: (rollRate / angTau) * T.angAccelBoost,
    lowSpeedAuthority: T.lowSpeedAuthority,
    authorityFullSpeed: maxSpeed * T.authorityFullFrac,

    // slip
    slipTau: num(stats.slipTau, T.slipTau),
    slipTauSlide: T.slipTauSlide,
    slipTauStop: T.slipTauStop,
    slipStrafeRelief: T.slipStrafeRelief,
    slipOverspeed: T.slipOverspeed,
    slideOverspeed: T.slideOverspeed,

    // rcs
    rcsAccel: num(stats.rcsAccel, T.rcsAccel),
    rcsMaxSlide: T.rcsMaxSlide,

    // trim
    trimRate: T.trimRate * DEG,
    trimAccel: T.trimAccel,
    trimFreq: T.trimFreq,
    trimSpeedFloor: T.trimSpeedFloor,

    // feel
    inertialDamping: T.inertialDamping,
    gLoadTau: T.gLoadTau,
    shakeDecay: T.shakeDecay,

    // collision
    radius: Math.max(0.5, num(stats.radius, num(stats.length, T.radius * 2) * 0.5)),
    restitution: T.restitution,
    collisionDamageScale: T.collisionDamageScale,
    collisionDamageExp: T.collisionDamageExp,
    collisionSpinScale: T.collisionSpinScale,
    collisionSpinMax: T.collisionSpinMax * Math.max(pitchRate, yawRate, rollRate),
    collisionCooldown: T.collisionCooldown,

    // autopilot
    apAbortRange: T.apAbortRange,
    apArriveRadius: T.apArriveRadius,
    apArriveSpeed: T.apArriveSpeed,
    apBurnerDistance: T.apBurnerDistance,
    apAlignGain: T.apAlignGain,
    apAlignForThrust: T.apAlignForThrust,
    apDecelMargin: T.apDecelMargin,
    apLevelGain: T.apLevelGain,
  };
}
