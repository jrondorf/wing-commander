import * as THREE from 'three';
import { makeRng, hashSeed } from '../core/Rand.js';
import {
  G_EARTH, FORWARD_SIGN, ASSIST, resolveTuning, DEFAULT_STATS,
} from './tuning.js';
import {
  clamp, clamp01, clamp11, lerp, smoothRange,
  tauDecay, moveToward, shapeAxis, deadzone,
} from './util.js';

/**
 * FlightBody — every scrap of a ship's motion state, plus the integrator that
 * advances it. One per ship; created by `FlightSystem.attach(ship)`.
 *
 * THE MODEL
 * ---------
 * 1. Throttle is a commanded *speed* (0..1 of maxSpeed), not a thrust input.
 *    The nose-aligned component of the velocity servos toward it at `accel`.
 * 2. The remaining (lateral) component of the velocity is the slip. Rotating
 *    creates it for free — the nose moves, momentum does not — and it decays
 *    with time constant `slipTau`. This lag is the Wing Commander feel.
 * 3. Rotation is a rate servo with real angular acceleration and damping, not
 *    an instant rate change. Heavier hulls get a longer time constant.
 * 4. Orientation is a quaternion, integrated exactly (axis-angle) each substep.
 *    No Euler angles anywhere, so no gimbal lock at the poles.
 *
 * FRAME PROTOCOL (driven by FlightSystem)
 *    syncExternal()  adopt any transform another system wrote onto ship.group
 *    beginFrame(dt)  resolve controls -> commanded speed / rates / fuel  (1x)
 *    substep(h)      integrate rotation then translation                 (Nx)
 *    endFrame(dt)    derive published values, write back to ship.group    (1x)
 *
 * PUBLISHED (read by camera rig, cockpit HUD, AI, combat lead computation)
 *    forward, right, up      unit basis vectors, world space
 *    velocity, speed         m/s
 *    forwardSpeed            velocity along the nose (negative = flying backwards)
 *    slipAngle               radians between nose and velocity — the drift readout
 *    gLoad                   felt G after inertial dampers (camera shake / HUD)
 *    gLoadRaw                honest |a| / 9.80665
 *    acceleration            world m/s², this frame
 *    shake                   0..1.5 impact shake, decays
 *    fuel, afterburner, burnout, autoSlide, autopilotActive
 */

// -- scratch: the substep loop must not allocate --------------------------
const _q = new THREE.Quaternion();
const _lat = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

export class FlightBody {
  /**
   * @param {object} ship the game-side ship record (see Game.spawnShip)
   * @param {object} [opts] { seed }
   */
  constructor(ship, opts = {}) {
    this.ship = ship ?? null;
    this.group = ship?.group ?? null;

    /** Ship stat block (ARCHITECTURE §5.4). Missing fields fall back to defaults. */
    this.stats = {
      ...DEFAULT_STATS,
      ...(ship?.stats ?? ship?.group?.userData?.stats ?? ship?.userData?.stats ?? {}),
    };
    /** Resolved, unit-converted handling numbers. See src/flight/tuning.js. */
    this.tuning = resolveTuning(this.stats, ship?.classId ?? '');

    // ---- primary state ---------------------------------------------------
    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.velocity = new THREE.Vector3();
    /**
     * Body-local rotation vector, rad/s. x = pitch (+ nose up), y = yaw
     * (+ nose LEFT, right-hand rule about local +Y), z = roll (+ counter-
     * clockwise about local +Z). Control inputs are mapped onto it in
     * `_resolveAngular`; other systems should prefer `controls`.
     */
    this.angularVelocity = new THREE.Vector3();

    // ---- control inputs (written by the player mapper or the AI system) ---
    this.controls = {
      pitch: 0,        // -1..1, +1 = nose UP
      yaw: 0,          // -1..1, +1 = nose RIGHT
      roll: 0,         // -1..1, +1 = roll RIGHT
      throttle: 0,     // 0..1 commanded speed as a fraction of maxSpeed
      afterburner: false,
      strafeX: 0,      // -1..1, +1 = translate RIGHT
      strafeY: 0,      // -1..1, +1 = translate UP
      brake: 0,        // 0..1
    };

    // ---- modes -----------------------------------------------------------
    /** Prophecy-style auto-slide: decouple velocity from facing. */
    this.autoSlide = false;
    /** Inertia-damped stop, see `requestFullStop()`. */
    this.fullStopActive = false;
    /** Pinned in place (hero/beauty shots). Still trims, never translates. */
    this.static = false;
    /** Participates in collision resolution. */
    this.collides = true;
    /** Per-body flight-assist overrides; falls back to the ASSIST table. */
    this.assist = {
      enabled: ASSIST.enabled,
      autoLevel: ASSIST.autoLevel,
      expo: ASSIST.expo,
      power: ASSIST.power,
      slewRate: ASSIST.slewRate,
    };

    // ---- afterburner -----------------------------------------------------
    this.fuel = 1;              // 0..1
    this.abThrottle = 0;        // 0..1 spool state of the burner
    this.afterburner = false;   // burner actually lit this frame
    this.burnout = false;       // ran the tank dry; needs abBurnoutRecover to relight

    // ---- published derived values ----------------------------------------
    this.forward = new THREE.Vector3(0, 0, FORWARD_SIGN);
    this.right = new THREE.Vector3(1, 0, 0);
    this.up = new THREE.Vector3(0, 1, 0);
    this.speed = 0;
    this.forwardSpeed = 0;
    this.commandedSpeed = 0;
    this.throttleActual = 0;    // speed / maxSpeed — HUD speed bar
    /**
     * Engine output for vfx/audio: 0..1 on the main drive, up to 3 on burners.
     * Driven by the *commanded* throttle, not by speed, so a ship holding
     * station at 35 % throttle still reads as hot at the nozzles.
     */
    this.enginePower = 0;
    this.slipAngle = 0;         // radians
    this.acceleration = new THREE.Vector3();
    this.gLoad = 0;
    this.gLoadRaw = 0;
    this.shake = 0;
    this.autopilot = null;      // { target, phase, elapsed } while engaged
    this.autopilotActive = false;

    // ---- collision bounds (filled by FlightSystem.attach) ----------------
    this.halfExtents = new THREE.Vector3(this.tuning.radius * 0.45, this.tuning.radius * 0.35, this.tuning.radius);
    this.boundsCenter = new THREE.Vector3();
    this.boundsRadius = this.tuning.radius;   // tight sphere about boundsCenter
    this.radius = this.tuning.radius;         // conservative sphere about the origin

    // ---- internals -------------------------------------------------------
    this.time = 0;
    this._seed = hashSeed(`flight:${ship?.classId ?? 'unknown'}:${ship?.id ?? 0}:${opts.seed ?? 0}`);
    const rng = makeRng(this._seed);
    // Three incommensurate phases so the idle wander never visibly repeats.
    this._trimPhase = [rng.range(0, 6.283), rng.range(0, 6.283), rng.range(0, 6.283)];
    this._trimPhase2 = [rng.range(0, 6.283), rng.range(0, 6.283), rng.range(0, 6.283)];

    this._shapedIn = { pitch: 0, yaw: 0, roll: 0 };
    this._cmdOmega = new THREE.Vector3();
    this._trimOmega = new THREE.Vector3();
    this._trimLin = new THREE.Vector3();
    this._anchor = new THREE.Vector3();

    this._cmdSpeed = 0;
    this._accelFwd = this.tuning.accel;
    this._accelBack = this.tuning.decel;
    this._slipTau = this.tuning.slipTau;
    this._angTau = this.tuning.angTau;
    this._authority = 1;
    this._overspeed = this.tuning.slipOverspeed;
    /**
     * The hard speed cap, as a state rather than a constant: it chases the
     * commanded speed at the same rates as the main servo, so a ship that is
     * *decelerating* from afterburner is never snapped down to its cruise cap.
     */
    this._ceiling = 0;
    this._ceilTarget = 0;

    /**
     * Thrust axis while auto-sliding: the velocity vector is locked to the
     * heading held when the pilot engaged drift mode, and the throttle drives
     * speed along *that* rather than along the nose. This is what lets a
     * Prophecy pilot keep guns on a target while flying sideways.
     */
    this._slideAxis = new THREE.Vector3(0, 0, FORWARD_SIGN);
    this._slideActive = false;

    this._v0 = new THREE.Vector3();
    this._writtenPos = new THREE.Vector3(NaN, NaN, NaN);
    this._writtenQuat = new THREE.Quaternion(0, 0, 0, NaN);
    this._hitCooldown = new Map(); // otherShipId -> seconds remaining

    if (this.group) {
      this.position.copy(this.group.position);
      this.quaternion.copy(this.group.quaternion);
      this._writtenPos.copy(this.position);
      this._writtenQuat.copy(this.quaternion);
    }
    this._anchor.copy(this.position);
    this._updateBasis();
  }

  // =======================================================================
  // public helpers
  // =======================================================================

  /** Commanded speed in m/s (throttle × maxSpeed), ignoring the burner. */
  get cruiseSpeed() { return clamp01(this.controls.throttle) * this.tuning.maxSpeed; }

  /** Set the throttle so the ship settles at `mps`. Used by match-speed / AI. */
  setThrottleForSpeed(mps) {
    this.controls.throttle = clamp01(mps / Math.max(1e-3, this.tuning.maxSpeed));
    return this.controls.throttle;
  }

  /** Toggle Prophecy-style drift mode. */
  setAutoSlide(on) {
    this.autoSlide = !!on;
    return this.autoSlide;
  }

  toggleAutoSlide() { return this.setAutoSlide(!this.autoSlide); }

  /**
   * Kill all motion with a believable deceleration profile — hard braking while
   * fast, easing off as the ship settles rather than snapping to zero.
   */
  requestFullStop(on = true) {
    this.fullStopActive = !!on;
    if (this.fullStopActive) this.autopilotDisengage('full-stop');
    return this.fullStopActive;
  }

  /** Pin/unpin the body in place (beauty shots, docked ships, debris props). */
  setStatic(on = true) {
    this.static = !!on;
    if (this.static) {
      this._anchor.copy(this.position);
      this.velocity.set(0, 0, 0);
    }
    return this.static;
  }

  /** World-space impulse in kg·m/s. Used by collisions and by weapon knockback. */
  applyImpulse(impulse) {
    this.velocity.addScaledVector(impulse, this.tuning.invMass);
    this._clampSpeed();
  }

  /** Angular impulse about a world axis, rad/s applied straight to the body. */
  applyAngularKick(worldOmega) {
    _tmp.copy(worldOmega).applyQuaternion(_q.copy(this.quaternion).invert());
    this.angularVelocity.add(_tmp);
    const cap = this.tuning.collisionSpinMax;
    if (this.angularVelocity.lengthSq() > cap * cap) this.angularVelocity.setLength(cap);
  }

  addShake(amount) {
    this.shake = Math.min(1.5, this.shake + amount);
  }

  autopilotDisengage(reason = 'manual') {
    if (!this.autopilot) return null;
    const ap = this.autopilot;
    this.autopilot = null;
    this.autopilotActive = false;
    return { ...ap, reason };
  }

  /** Refresh forward/right/up from the current quaternion. */
  _updateBasis() {
    this.forward.copy(AXIS_Z).applyQuaternion(this.quaternion).multiplyScalar(FORWARD_SIGN);
    this.right.copy(AXIS_X).applyQuaternion(this.quaternion);
    this.up.copy(AXIS_Y).applyQuaternion(this.quaternion);
  }

  // =======================================================================
  // frame protocol
  // =======================================================================

  /**
   * Another system (a shot scene, a mission script, a docking sequence) may write
   * straight onto `ship.group`. If the transform differs from what we last wrote,
   * that write wins and the body adopts it.
   */
  syncExternal() {
    const g = this.group;
    if (!g) return;
    if (!g.position.equals(this._writtenPos)) {
      this.position.copy(g.position);
      this._anchor.copy(g.position);
    }
    if (!g.quaternion.equals(this._writtenQuat)) {
      this.quaternion.copy(g.quaternion);
      this._updateBasis();
    }
  }

  /** Resolve one frame of control input into servo targets. Called once per frame. */
  beginFrame(dt) {
    this.time += dt;
    this._v0.copy(this.velocity);
    // Refresh from the live vector rather than last frame's cache: another
    // system may have written `body.velocity` directly (spawn, knockback, a
    // scripted launch), and the servos must see that immediately.
    this.speed = this.velocity.length();
    this.forwardSpeed = this.velocity.dot(this.forward);

    const dead = !!(this.ship && this.ship.alive === false);

    // -- afterburner state machine ---------------------------------------
    this._updateAfterburner(dt, dead);

    // -- flight assist: shape + slew the stick ----------------------------
    this._shapeInputs(dt, dead);

    // -- idle trim: nothing in this game is ever perfectly still -----------
    this._updateTrim(dt);

    // -- angular targets ---------------------------------------------------
    this._resolveAngular(dead);

    // -- linear targets ----------------------------------------------------
    this._resolveLinear(dt, dead);
  }

  _updateAfterburner(dt, dead) {
    const T = this.tuning;
    const want = !dead && !!this.controls.afterburner && !this.static;

    if (this.burnout && this.fuel >= T.abBurnoutRecover) this.burnout = false;

    const lit = want && this.fuel > 0 && !this.burnout;
    this.afterburner = lit;

    if (lit) {
      this.fuel = Math.max(0, this.fuel - T.abFuelDrain * dt);
      if (this.fuel <= 0) {
        this.burnout = true;
        this.afterburner = false;
      }
    } else {
      this.fuel = Math.min(1, this.fuel + T.abFuelRegen * dt);
    }

    // Thrust spools in and out on its own curve, which is what gives the burner
    // its distinct "shove, then a long coast back down" character.
    const tau = this.afterburner ? T.abSpoolUp : T.abSpoolDown;
    const target = this.afterburner ? 1 : 0;
    this.abThrottle = target + (this.abThrottle - target) * tauDecay(tau, dt);
    if (Math.abs(this.abThrottle - target) < 1e-4) this.abThrottle = target;
  }

  _shapeInputs(dt, dead) {
    const a = this.assist;
    const c = this.controls;
    const s = this._shapedIn;
    const dz = 0; // Input already deadzones the gamepad; extra dz is in the mapper

    const raw = {
      pitch: dead ? 0 : clamp11(c.pitch),
      yaw: dead ? 0 : clamp11(c.yaw),
      roll: dead ? 0 : clamp11(c.roll),
    };

    if (!a.enabled) {
      s.pitch = raw.pitch; s.yaw = raw.yaw; s.roll = raw.roll;
      return;
    }

    for (const k of ['pitch', 'yaw', 'roll']) {
      const target = shapeAxis(deadzone(raw[k], dz), a.expo, a.power);
      // Returning to centre is allowed to be quicker than deflecting — a turn
      // starts with weight but stops cleanly.
      const returning = Math.abs(target) < Math.abs(s[k]);
      const rate = a.slewRate * (returning ? ASSIST.slewReturnScale : 1);
      s[k] = moveToward(s[k], target, rate * dt);
    }
  }

  _updateTrim(dt) {
    const T = this.tuning;
    const t = this.time;
    const f = T.trimFreq;
    const p = this._trimPhase;
    const p2 = this._trimPhase2;

    // Two detuned sines per axis: no visible period, no accumulating drift.
    const w = (i) => (
      Math.sin(t * f[i] + p[i]) * 0.7 +
      Math.sin(t * f[i] * 1.618 + p2[i]) * 0.3
    );

    // Trim fades out as soon as the pilot asks for something.
    const inputMag = Math.min(1,
      Math.abs(this._shapedIn.pitch) + Math.abs(this._shapedIn.yaw) + Math.abs(this._shapedIn.roll));
    const k = 1 - inputMag;

    this._trimOmega.set(w(0), w(1), w(2)).multiplyScalar(T.trimRate * k);
    this._trimLin.set(w(1) * 0.6, w(2) * 0.8, w(0) * 0.6)
      .multiplyScalar(T.trimAccel * k);
  }

  _resolveAngular(dead) {
    const T = this.tuning;
    const s = this._shapedIn;

    // Control authority: thin at a standstill (no relative motion for the
    // control surfaces/vectoring to bite on) and pinched at overspeed.
    const speedAuth = lerp(
      T.lowSpeedAuthority, 1,
      smoothRange(this.speed, 0, T.authorityFullSpeed),
    );
    // Overspeed is measured on the *thrust* axis, not on total speed: a hard
    // turn skids and so raises |v| above cruise, and that must not be mistaken
    // for afterburner overspeed and quietly rob the ship of its turn rate.
    const overspeed = clamp01(
      (Math.abs(this.forwardSpeed) - T.maxSpeed) / Math.max(1e-3, T.abSpeed - T.maxSpeed),
    );
    const abAuth = lerp(1, T.abTurnPenalty, overspeed);
    this._authority = dead ? 0 : speedAuth * abAuth;

    let rollIn = s.roll;
    // Optional auto-level: roll wings-level toward world up when hands-off.
    if (this.assist.enabled && this.assist.autoLevel && !dead &&
        Math.abs(s.roll) < ASSIST.autoLevelMaxInput && this.speed > ASSIST.autoLevelMinSpeed) {
      const err = this._rollErrorToWorldUp();
      rollIn = clamp11(rollIn - err * ASSIST.autoLevelGain);
    }

    // controls -> body-local rotation vector.
    //   pitch up   = +X rotation
    //   yaw right  = -Y rotation
    //   roll right = -Z rotation
    this._cmdOmega.set(
      s.pitch * T.pitchRate * this._authority,
      -s.yaw * T.yawRate * this._authority,
      -rollIn * T.rollRate * this._authority,
    );
    this._cmdOmega.add(this._trimOmega);

    // A turn that is being *stopped* uses a shorter time constant than one being
    // started: the strong angular damping that stops WC fighters dead.
    const cmdMag = Math.abs(s.pitch) + Math.abs(s.yaw) + Math.abs(rollIn);
    this._angTau = cmdMag < 0.02 ? T.angStopTau : T.angTau;
  }

  /** Signed roll angle away from wings-level w.r.t. world up, radians. */
  _rollErrorToWorldUp() {
    // Remove the component of world up along the nose, then measure where it
    // sits in the ship's right/up plane.
    _tmp.copy(_up).addScaledVector(this.forward, -_up.dot(this.forward));
    if (_tmp.lengthSq() < 1e-6) return 0;
    _tmp.normalize();
    return -Math.atan2(this.right.dot(_tmp), this.up.dot(_tmp));
  }

  _resolveLinear(dt, dead) {
    const T = this.tuning;
    const c = this.controls;

    if (dead) {
      // Destroyed hulls coast: no thrust, no grip, pure ballistic drift.
      this._cmdSpeed = this.forwardSpeed;
      this._accelFwd = 0;
      this._accelBack = 0;
      this._slipTau = 1e9;
      this._overspeed = 1e9;   // ballistic: only the absolute cap applies
      this._ceilTarget = this.speed;
      this._ceiling = Math.max(this._ceiling, this.speed);
      return;
    }

    // Commanded speed: throttle, overridden by the burner, then by the brakes.
    const cruise = clamp01(c.throttle) * T.maxSpeed;
    let cmd = lerp(cruise, T.abSpeed, this.abThrottle);
    let accelUp = lerp(T.accel, T.abAccel, this.abThrottle);
    // Falling back from overspeed has its own (firmer) deceleration.
    let accelDown = this.speed > T.maxSpeed ? T.abDecel : T.decel;

    const brake = clamp01(c.brake);
    if (brake > 0) {
      cmd = lerp(cmd, 0, brake);
      accelDown = lerp(accelDown, T.brakeAccel, brake);
    }

    // Auto-slide: lock the thrust axis to the heading we were flying, so the
    // hull can rotate freely without the engines dragging the velocity vector
    // round with the nose.
    if (this.autoSlide) {
      if (!this._slideActive || this.speed < 5) {
        this._slideActive = true;
        if (this.speed > 1e-3) this._slideAxis.copy(this.velocity).multiplyScalar(1 / this.speed);
        else this._slideAxis.copy(this.forward);
      }
    } else {
      this._slideActive = false;
    }

    let slipTau = this.autoSlide ? T.slipTauSlide : T.slipTau;
    if (!this.autoSlide) {
      // Burners bite: the velocity vector snaps back onto the nose faster.
      slipTau /= 1 + this.abThrottle * (T.abGripBoost - 1);
      // ...and the RCS loosens the grip so a commanded slide can actually build.
      const strafeMag = Math.min(1, Math.abs(c.strafeX) + Math.abs(c.strafeY));
      slipTau *= 1 + strafeMag * (T.slipStrafeRelief - 1);
    }

    if (this.fullStopActive) {
      cmd = 0;
      // Deceleration profile: full authority while fast, easing as it settles,
      // so the ship sinks to rest instead of stopping like a hit wall.
      const f = smoothRange(this.speed, 0, T.maxSpeed * 0.18);
      accelDown = T.fullStopAccel * lerp(0.22, 1, f);
      slipTau = T.slipTauStop;
      if (this.speed < 0.75) {
        this.velocity.set(0, 0, 0);
        this.fullStopActive = false;
        c.throttle = 0;
        c.brake = 0;
      }
    }

    this._cmdSpeed = cmd;
    this._accelFwd = accelUp;
    this._accelBack = accelDown;
    this._slipTau = slipTau;
    this._overspeed = this.autoSlide ? T.slideOverspeed : T.slipOverspeed;
    this.commandedSpeed = cmd;

    // Hard speed cap. The RCS gets its own allowance so a ship at zero throttle
    // can still translate on thrusters.
    const strafeMag = Math.min(1, Math.abs(c.strafeX) + Math.abs(c.strafeY));
    // The floor leaves just enough headroom for the idle trim drift, so a ship
    // at a dead stop still breathes instead of being clamped to absolute zero.
    this._ceilTarget = Math.max(cmd, strafeMag * T.rcsMaxSlide, T.trimSpeedFloor);
    // Never clamp below what the ship is already doing — combat knockback and
    // scripted velocities are legitimate, they just have to bleed off normally.
    if (this._ceiling < this.speed) this._ceiling = this.speed;
  }

  /**
   * One integration substep. Semi-implicit Euler: rotate, then accelerate, then
   * translate with the *new* velocity — stable and, at a fixed dt, exactly
   * reproducible.
   */
  substep(h) {
    this._integrateAngular(h);
    this._integrateLinear(h);
  }

  _integrateAngular(h) {
    const T = this.tuning;
    const w = this.angularVelocity;
    const target = this._cmdOmega;
    const tau = this._angTau;
    const accelMax = [T.angAccelPitch, T.angAccelYaw, T.angAccelRoll];
    const comp = ['x', 'y', 'z'];

    for (let i = 0; i < 3; i++) {
      const k = comp[i];
      const diff = target[k] - w[k];
      if (diff === 0) continue;
      let a = diff / tau;                       // exponential approach...
      const cap = accelMax[i];
      if (a > cap) a = cap; else if (a < -cap) a = -cap;   // ...torque-limited
      const next = w[k] + a * h;
      // Never overshoot the commanded rate within a substep.
      w[k] = (target[k] - next) * diff < 0 ? target[k] : next;
    }

    // Exact axis-angle quaternion integration in the body frame. No small-angle
    // approximation, no Euler angles, no gimbal lock.
    const len = Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z);
    if (len > 1e-12) {
      const half = len * h * 0.5;
      const s = Math.sin(half) / len;
      _q.set(w.x * s, w.y * s, w.z * s, Math.cos(half));
      this.quaternion.multiply(_q).normalize();
    }
    this._updateBasis();
  }

  _integrateLinear(h) {
    const T = this.tuning;
    const c = this.controls;

    if (this.static) {
      // Pinned: no translation, but a few centimetres of life so the frame is
      // never dead (ARCHITECTURE §7 "Motion — nothing is static").
      this.velocity.set(0, 0, 0);
      this.position.copy(this._anchor).addScaledVector(this._trimLin, 6);
      return;
    }

    const v = this.velocity;
    // Normally the engines push along the nose. In auto-slide they push along
    // the locked drift heading instead.
    const f = this.autoSlide ? this._slideAxis : this.forward;

    // --- split velocity into thrust-aligned and lateral -------------------
    const vf = v.dot(f);
    _lat.copy(v).addScaledVector(f, -vf);

    // --- nose axis: servo toward the commanded speed ---------------------
    const err = this._cmdSpeed - vf;
    const a = err >= 0 ? this._accelFwd : this._accelBack;
    const step = a * h;
    const nvf = vf + (err > step ? step : err < -step ? -step : err);

    // --- lateral axis: the slip decays back onto the nose ----------------
    _lat.multiplyScalar(tauDecay(this._slipTau, h));

    // --- RCS translation --------------------------------------------------
    // The thruster cap bounds what the RCS may *add*; it must never clamp the
    // slip a hard turn generated, or the ship silently loses its drift.
    if (c.strafeX !== 0 || c.strafeY !== 0) {
      const latBefore = _lat.length();
      if (c.strafeX !== 0) _lat.addScaledVector(this.right, clamp11(c.strafeX) * T.rcsAccel * h);
      if (c.strafeY !== 0) _lat.addScaledVector(this.up, clamp11(c.strafeY) * T.rcsAccel * h);
      const cap = Math.max(latBefore, T.rcsMaxSlide);
      const latSq = _lat.lengthSq();
      if (latSq > cap * cap) _lat.multiplyScalar(cap / Math.sqrt(latSq));
    }

    v.copy(_lat).addScaledVector(f, nvf);

    // --- idle drift -------------------------------------------------------
    v.addScaledVector(this._trimLin, h);

    // --- the hard speed cap ----------------------------------------------
    // The ceiling walks toward the commanded speed at the servo's own rates,
    // so it never snaps a decelerating ship down and never lets a skid turn
    // into free energy. This is the WC "your speed never exceeds your throttle"
    // rule, expressed so that afterburner falloff and knockback still work.
    this._ceiling = moveToward(
      this._ceiling, this._ceilTarget,
      (this._ceiling < this._ceilTarget ? this._accelFwd : this._accelBack) * h,
    );
    const cap = this._ceiling * this._overspeed;
    const spSq = v.lengthSq();
    if (spSq > cap * cap && spSq > 1e-9) v.multiplyScalar(cap / Math.sqrt(spSq));

    this._clampSpeed();
    this.position.addScaledVector(v, h);
  }

  /** Hard velocity ceiling — the WC speed cap, and a guard against blow-ups. */
  _clampSpeed() {
    const cap = this.tuning.hardSpeedCap;
    const sq = this.velocity.lengthSq();
    if (sq > cap * cap) this.velocity.multiplyScalar(cap / Math.sqrt(sq));
  }

  /** Derive published values and push the transform onto the render group. */
  endFrame(dt) {
    const T = this.tuning;

    this.speed = this.velocity.length();
    this.forwardSpeed = this.velocity.dot(this.forward);
    this.throttleActual = this.speed / T.maxSpeed;
    this.enginePower = clamp01(this.controls.throttle) + 2 * this.abThrottle;

    // Slip angle: how far the velocity vector lags the nose. 0 on rails,
    // ~30-50° mid hard-turn in a fighter, 90°+ in auto-slide.
    if (this.speed > 0.5) {
      const d = clamp(this.forwardSpeed / this.speed, -1, 1);
      this.slipAngle = Math.acos(d);
    } else {
      this.slipAngle = 0;
    }

    // G-load. `gLoadRaw` is honest; `gLoad` is what the pilot feels after the
    // inertial dampers, which is the number the HUD prints and the camera rig
    // shakes with.
    _tmp.copy(this.velocity).sub(this._v0).multiplyScalar(1 / dt);
    this.acceleration.copy(_tmp);
    const rawG = _tmp.length() / G_EARTH;
    this.gLoadRaw = rawG;
    const feltTarget = rawG / T.inertialDamping;
    this.gLoad = feltTarget + (this.gLoad - feltTarget) * tauDecay(T.gLoadTau, dt);

    this.shake *= tauDecay(1 / T.shakeDecay, dt);
    if (this.shake < 1e-4) this.shake = 0;

    for (const [k, t] of this._hitCooldown) {
      const n = t - dt;
      if (n <= 0) this._hitCooldown.delete(k); else this._hitCooldown.set(k, n);
    }

    this.autopilotActive = this.autopilot != null;

    const g = this.group;
    if (g) {
      g.position.copy(this.position);
      g.quaternion.copy(this.quaternion);
      this._writtenPos.copy(this.position);
      this._writtenQuat.copy(this.quaternion);
      g.updateMatrix();
    }
  }

  /** Debug/telemetry snapshot; also what the self-test hashes. */
  snapshot() {
    return [
      this.position.x, this.position.y, this.position.z,
      this.quaternion.x, this.quaternion.y, this.quaternion.z, this.quaternion.w,
      this.velocity.x, this.velocity.y, this.velocity.z,
      this.angularVelocity.x, this.angularVelocity.y, this.angularVelocity.z,
      this.fuel, this.abThrottle,
    ];
  }
}
