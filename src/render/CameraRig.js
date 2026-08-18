/**
 * Camera rig — system `camera`, priority 700.
 *
 * Runs after flight/AI/VFX have moved everything and before the cockpit projects
 * its HUD, so the HUD is always drawn against the camera transform it will
 * actually be composited with.
 *
 * Modes
 * ─────
 *   cockpit    pilot's eye, inside the ship, with inertia lag and G-force sway
 *   chase      spring-damped follow with velocity-aware lag and lead
 *   orbit      slow inspection orbit, used by briefing/debrief and hangar views
 *   cinematic  deterministic shot director — recomposes every few seconds
 *   free       detached fly-cam driven by the input axes
 *   padlock    Wing Commander's view lock: eye stays in the cockpit, head turns
 *              to keep the current target framed
 *
 * Two cameras, one transform. `engine.camera` (near 1, far 8e6) draws the world;
 * `engine.cockpitCamera` (near 0.01, far 50) draws the dashboard. They share a
 * world matrix and an FOV exactly so a 2 m canopy strut and a 40 km carrier line
 * up perfectly while neither z-fights the other.
 *
 * Nothing here is ever mechanically still: even a locked-off shot carries a
 * handheld drift of a few millimetres and a fraction of a degree. That is the
 * difference between a render and a photograph.
 *
 * `rig.enabled = false` releases the camera completely — Engine skips disabled
 * systems, and this file touches nothing outside `update()`. The capture harness
 * relies on that to frame shots by hand.
 */

import * as THREE from 'three';
import { makeRng } from '../core/Rand.js';

export const CAMERA_MODES = ['cockpit', 'chase', 'orbit', 'cinematic', 'free', 'padlock'];

// --------------------------------------------------------------------- noise
// A tiny 1D value noise with cubic interpolation. Two octaves is enough for both
// the handheld drift and the shake; Perlin-grade gradient noise would be
// indistinguishable at these amplitudes and costs three times as much.
function hash1(n) {
  let h = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}
function noise1(t, seed = 0) {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  const a = hash1((i + seed * 7919) | 0);
  const b = hash1((i + 1 + seed * 7919) | 0);
  return (a + (b - a) * u) * 2 - 1;
}
function fbm1(t, seed = 0) {
  return noise1(t, seed) * 0.65 + noise1(t * 2.17 + 13.7, seed + 91) * 0.35;
}

/** Frame-rate independent exponential approach. `rate` is in units of 1/second. */
const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * @param {import('../core/Engine.js').Engine} engine
 * @param {object} [opts]
 */
export function createCameraRig(engine, opts = {}) {
  const settings = {
    /** Base vertical FOV in degrees; ARCHITECTURE's default is 58. */
    fov: 58,
    /** Afterburner FOV target. The kick is most of the sensation of speed. */
    fovAfterburner: 72,
    /** Extra FOV proportional to speed fraction, on top of the base. */
    fovSpeedGain: 4,
    fovEase: 4.5,

    cockpit: {
      /** Orientation lag — the pilot's head does not snap with the airframe. */
      inertia: 9,
      /** How far the head sways under lateral/vertical G, in metres. */
      gSway: 0.055,
      gSwayEase: 6,
      /** Look-around offset applied by padlock/look-back, radians. */
      maxLook: Math.PI,
    },

    chase: {
      /** Multiples of the subject's bounding radius. */
      distance: 3.1,
      height: 0.75,
      /** Spring rate (rad/s) and damping ratio for the follow. */
      stiffness: 6.5,
      damping: 1.05,
      /** Camera falls further back the faster the ship goes. */
      speedLag: 0.0075,
      maxSpeedLag: 26,
      /** Look-ahead along the velocity vector, in seconds of travel. */
      lead: 0.16,
      maxLead: 90,
      /** 0 = camera stays world-up, 1 = camera rolls with the ship. */
      rollFollow: 0.55,
      aimEase: 7,
    },

    orbit: { distance: 3.4, height: 0.32, speed: 0.16, tilt: 0.14 },

    cinematic: {
      shotDuration: 5.5,
      distanceMin: 2.2,
      distanceMax: 7.5,
      dolly: 0.22,
      fovMin: 34,
      fovMax: 62,
      seed: 90210,
    },

    free: { speed: 220, boost: 6, turnRate: 1.6, damping: 4 },

    shake: {
      /** Trauma decays linearly; shake amplitude is trauma², so it falls off fast. */
      decay: 1.35,
      frequency: 22,
      pitch: 0.055,
      yaw: 0.055,
      roll: 0.05,
      translate: 0.55,
      /** Continuous low-level rumble while the afterburner is lit. */
      afterburnerRumble: 0.3,
      /** World range over which an explosion still shakes the camera. */
      impactRange: 900,
      max: 1,
    },

    handheld: {
      enabled: true,
      /** Metres of positional drift. */
      position: 0.05,
      /** Radians of rotational drift. */
      rotation: 0.0022,
      frequency: 0.21,
    },

    /** Blend time when switching modes, in seconds. 0 = cut. */
    transition: 0.45,
  };

  Object.assign(settings, opts.settings ?? {});

  const cam = engine.camera;
  const cpt = engine.cockpitCamera;

  const rig = {
    name: 'camera',
    priority: 700,
    enabled: true,
    settings,
    mode: engine.game?.viewMode ?? 'cockpit',
    /** Explicit subject override; otherwise the player ship is used. */
    subject: null,
    /** Explicit padlock target override. */
    lockTarget: null,
    trauma: 0,
    rumble: 0,
    update,
    resize,
    dispose,
    setMode,
    addTrauma,
    addRumble,
    snap,
    getSubject,
  };

  // ------------------------------------------------------------------- state
  const st = {
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    aim: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    up: new THREE.Vector3(0, 1, 0),
    fov: settings.fov,
    lastFov: -1,
    gSway: new THREE.Vector3(),
    prevSubjectVel: new THREE.Vector3(),
    orbitAngle: 0,
    freeQuat: new THREE.Quaternion(),
    freeVel: new THREE.Vector3(),
    shotIndex: -1,
    shotTime: 0,
    shot: null,
    /** Mode-change cross-fade: 0 at the cut, 1 once the new rig owns the frame. */
    blend: 1,
    fromPos: new THREE.Vector3(),
    fromQuat: new THREE.Quaternion(),
    needsSnap: true,
    time: 0,
  };

  const rng = makeRng(settings.cinematic.seed);

  // Scratch — allocating a Vector3 per frame in a 60 Hz rig is how you get GC
  // hitches in a dogfight.
  const _a = new THREE.Vector3();
  const _b = new THREE.Vector3();
  const _c = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  /** Camera velocity relative to the subject, for the chase spring's feed-forward. */
  const _rel = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _q2 = new THREE.Quaternion();
  const _m = new THREE.Matrix4();
  const _e = new THREE.Euler();
  const _box = new THREE.Box3();

  // -------------------------------------------------------------- event wiring
  const offs = [];
  const ev = engine.events;
  if (ev) {
    const impact = (amount) => (p) => addTrauma(amount, p?.position ?? p?.point ?? null);
    offs.push(ev.on('weapon:hit', impact(0.22)));
    offs.push(ev.on('shield:impact', impact(0.16)));
    offs.push(ev.on('explosion', (p) => addTrauma(0.85 * (p?.scale ?? 1), p?.position ?? null)));
    offs.push(ev.on('ship:destroyed', (p) => addTrauma(0.9 * (p?.scale ?? 1), p?.position ?? null)));
    offs.push(ev.on('missile:launched', (p) => addTrauma(0.1, p?.position ?? null)));
    offs.push(ev.on('weapon:fired', (p) => {
      // Only the player's own guns kick the camera — a wingman firing 400 m away
      // must not rattle the frame.
      if (p?.ship && p.ship === (engine.player ?? engine.game?.player)) addTrauma(0.035, null);
    }));
  }

  // ------------------------------------------------------------------ helpers
  function getSubject() {
    if (rig.subject) return rig.subject;
    const p = engine.player ?? engine.game?.player ?? null;
    if (p?.group) return p;
    const ships = engine.game?.ships;
    if (ships?.length) return ships.find((s) => s?.group) ?? null;
    return null;
  }

  /** Bounding radius of a ship, computed once and cached on the group. */
  function subjectRadius(ship) {
    const g = ship.group;
    let r = g.userData.__wcRadius;
    if (r === undefined) {
      _box.setFromObject(g, true);
      r = _box.isEmpty() ? 12 : _box.getSize(_a).length() * 0.5;
      if (!Number.isFinite(r) || r <= 0.01) r = 12;
      g.userData.__wcRadius = r;
    }
    return r;
  }

  /**
   * Pilot's eye position in ship-local space.
   *
   * TODO(contract): ships/ should publish `group.userData.hardpoints.cockpit`
   * as `{ pos: Vector3 }` (or `userData.cockpitEye`). Until it does, this derives
   * a plausible eye point from the bounding box — forward of centre and up near
   * the canopy — which is right to within a few centimetres for a fighter.
   */
  function cockpitEye(ship, out) {
    const g = ship.group;
    let e = g.userData.__wcCockpitEye;
    if (!e) {
      const hp = ship.hardpoints ?? g.userData.hardpoints;
      const explicit = hp?.cockpit?.pos ?? hp?.cockpit ?? g.userData.cockpitEye;
      if (explicit?.isVector3) {
        e = explicit.clone();
      } else {
        _box.setFromObject(g, true);
        if (_box.isEmpty()) {
          e = new THREE.Vector3(0, 0.8, -1.5);
        } else {
          const c = _box.getCenter(_a);
          const s = _box.getSize(_b);
          // Ships face -Z; sit the eye 18% forward of centre and just under the
          // canopy line so the dashboard fills the lower third of frame.
          e = new THREE.Vector3(0, c.y + s.y * 0.14, c.z - s.z * 0.18);
        }
      }
      g.userData.__wcCockpitEye = e;
    }
    return out.copy(e);
  }

  function subjectVelocity(ship, out) {
    const v = ship.body?.velocity ?? ship.velocity;
    if (v?.isVector3) return out.copy(v);
    return out.set(0, 0, 0);
  }

  function afterburnerOn(ship) {
    const c = ship?.body?.controls;
    if (c && (c.afterburner === true || c.afterburner > 0.5)) return true;
    if (ship?.isPlayer && engine.input?.held?.('afterburner')) return true;
    return false;
  }

  function speedFraction(ship, speed) {
    const max = ship?.stats?.maxSpeed ?? ship?.body?.stats?.maxSpeed ?? 500;
    return clamp(speed / Math.max(1, max), 0, 2);
  }

  function padlockTarget() {
    if (rig.lockTarget?.isObject3D) return rig.lockTarget;
    if (rig.lockTarget?.group) return rig.lockTarget.group;
    const s = getSubject();
    const t = s?.target ?? engine.game?.player?.target ?? null;
    if (t?.group) return t.group;
    if (t?.isObject3D) return t;
    return null;
  }

  // ------------------------------------------------------------------- public
  function setMode(mode, { instant = false } = {}) {
    if (!CAMERA_MODES.includes(mode)) return false;
    const changed = rig.mode !== mode;
    rig.mode = mode;
    if (engine.game) engine.game.viewMode = mode;
    // External views must not draw the dashboard over the frame. The cockpit
    // system may also manage this; setting it here keeps a mode switch coherent
    // even before that system exists.
    if (engine.cockpitScene) engine.cockpitScene.visible = mode === 'cockpit' || mode === 'padlock';

    // Solve the new mode from scratch, then cross-fade the *result* in from where
    // the camera actually is — springing across a cut produces a swoop through
    // the middle of the ship.
    st.needsSnap = true;
    st.shotIndex = -1;
    st.shot = null;
    if (instant || settings.transition <= 0 || !changed) {
      st.blend = 1;
    } else {
      st.blend = 0;
      st.fromPos.copy(cam.position);
      st.fromQuat.copy(cam.quaternion);
    }
    return true;
  }

  /**
   * Add camera trauma. Shake amplitude is trauma², so 0.2 is a gunshot tremor and
   * 1.0 is a capship going up next to you.
   * @param {number} amount
   * @param {THREE.Vector3|null} [position] world position; falls off with distance
   */
  function addTrauma(amount, position = null) {
    let a = amount;
    if (position?.isVector3) {
      const d = position.distanceTo(cam.position);
      const f = clamp(1 - d / settings.shake.impactRange, 0, 1);
      a *= f * f;
    }
    if (a <= 0) return;
    rig.trauma = clamp(rig.trauma + a, 0, settings.shake.max);
  }

  /** Sustained vibration (afterburner, atmospheric entry, tractor beam). */
  function addRumble(amount) {
    rig.rumble = clamp(Math.max(rig.rumble, amount), 0, 1);
  }

  /** Force the next frame to place the camera exactly, with no spring lag. */
  function snap() { st.needsSnap = true; }

  function resize() { /* Engine owns aspect; nothing rig-specific to do. */ }

  function dispose() {
    for (const off of offs) off?.();
    offs.length = 0;
  }

  // -------------------------------------------------------------------- modes
  function updateCockpit(ship, dt) {
    const g = ship.group;
    cockpitEye(ship, _a);
    g.localToWorld(_a);

    // Head sway: the pilot's mass lags the airframe under lateral G. Derive the
    // acceleration from the velocity delta rather than trusting a stats field.
    subjectVelocity(ship, _b);
    _c.copy(_b).sub(st.prevSubjectVel).divideScalar(Math.max(dt, 1e-4));
    st.prevSubjectVel.copy(_b);
    // Express acceleration in ship-local axes so sway is left/right, not world X.
    _q.copy(g.quaternion).invert();
    _c.applyQuaternion(_q);
    const sway = settings.cockpit.gSway;
    _c.multiplyScalar(-sway / 100);
    _c.clampLength(0, sway * 6);
    st.gSway.lerp(_c, 1 - Math.exp(-settings.cockpit.gSwayEase * dt));

    _b.copy(st.gSway).applyQuaternion(g.quaternion);
    _a.add(_b);

    // Rigidly attached to the airframe — the G-sway above *is* the give.
    st.pos.copy(_a);

    // Orientation lags the hull slightly, which reads as the pilot's head
    // resisting the turn. Zero lag looks like the canopy is welded to the camera.
    _q.copy(g.quaternion);
    if (rig.mode === 'padlock') {
      const t = padlockTarget();
      if (t) {
        t.getWorldPosition(_b);
        _up.set(0, 1, 0).applyQuaternion(g.quaternion);
        _m.lookAt(_a, _b, _up);
        _q.setFromRotationMatrix(_m);
      }
    }

    if (st.needsSnap) st.quat.copy(_q);
    else st.quat.slerp(_q, 1 - Math.exp(-settings.cockpit.inertia * dt));
  }

  function updateChase(ship, dt) {
    const g = ship.group;
    const c = settings.chase;
    const r = subjectRadius(ship);

    subjectVelocity(ship, _b);
    const speed = _b.length();

    // Desired eye: behind and above in ship-local space, pushed further back the
    // faster we are going so an afterburner run opens the frame up.
    const lag = Math.min(speed * c.speedLag * r, c.maxSpeedLag);
    _a.set(0, r * c.height, r * c.distance + lag);
    _a.applyQuaternion(g.quaternion).add(g.position);

    if (st.needsSnap) {
      st.pos.copy(_a);
      st.vel.set(0, 0, 0);
    } else {
      // Critically-damped-ish spring, substepped so a 100 ms hitch cannot make it
      // explode.
      const steps = Math.max(1, Math.ceil(dt / (1 / 45)));
      const h = dt / steps;
      const w = c.stiffness;
      const z = c.damping;
      // Damp against velocity *relative to the subject*, not absolute velocity.
      //
      // Damping absolute velocity makes this a spring chasing a moving target,
      // which settles at a steady-state error of 2*zeta*V/w — at 500 m/s and
      // w=6.5 that is 161 m of unwanted trail, and the ship shrinks to a speck at
      // full throttle. Subtracting the subject's velocity turns it into a spring
      // in the subject's frame, so the error goes to zero at constant speed while
      // the deliberate speedLag term stays in charge of how far back the camera
      // sits. Measured before this change: 218 m against a 69 m target.
      for (let i = 0; i < steps; i++) {
        _rel.copy(st.vel).sub(_b);
        _c.copy(_a).sub(st.pos).multiplyScalar(w * w);
        _c.addScaledVector(_rel, -2 * z * w);
        st.vel.addScaledVector(_c, h);
        st.pos.addScaledVector(st.vel, h);
      }
    }

    // Aim ahead of the ship along its velocity — the camera anticipates rather
    // than chases, which is what makes a turning fight readable.
    const lead = Math.min(speed * c.lead, c.maxLead);
    _c.copy(g.position);
    if (speed > 1) _c.addScaledVector(_b, lead / speed);
    else _c.addScaledVector(_fwd.set(0, 0, -1).applyQuaternion(g.quaternion), lead);

    if (st.needsSnap) st.aim.copy(_c);
    else st.aim.lerp(_c, 1 - Math.exp(-c.aimEase * dt));

    // Roll partially follows the ship: full follow is disorienting, none makes a
    // barrel roll invisible.
    _up.set(0, 1, 0).applyQuaternion(g.quaternion);
    _up.lerp(_b.set(0, 1, 0), 1 - c.rollFollow).normalize();
    if (_up.lengthSq() < 1e-6) _up.set(0, 1, 0);

    _m.lookAt(st.pos, st.aim, _up);
    _q.setFromRotationMatrix(_m);
    if (st.needsSnap) st.quat.copy(_q);
    else st.quat.slerp(_q, 1 - Math.exp(-c.aimEase * 1.4 * dt));
  }

  function updateOrbit(ship, dt) {
    const g = ship.group;
    const o = settings.orbit;
    const r = subjectRadius(ship);
    st.orbitAngle += o.speed * dt;

    _a.set(Math.sin(st.orbitAngle) * r * o.distance, r * o.height, Math.cos(st.orbitAngle) * r * o.distance);
    _a.add(g.position);
    st.pos.copy(_a);
    st.aim.copy(g.position);

    _up.set(Math.sin(st.orbitAngle * 0.37) * o.tilt, 1, 0).normalize();
    _m.lookAt(st.pos, st.aim, _up);
    st.quat.setFromRotationMatrix(_m);
  }

  /**
   * Deterministic shot director. Picks a framing, holds it for `shotDuration`
   * while slowly dollying, then cuts to a new one. Seeded, so a replay or a
   * capture reproduces the same edit every time.
   */
  function updateCinematic(ship, dt) {
    const cn = settings.cinematic;
    const g = ship.group;
    const r = subjectRadius(ship);

    st.shotTime += dt;
    if (!st.shot || st.shotTime >= cn.shotDuration) {
      st.shotTime = 0;
      st.shotIndex++;
      st.shot = {
        azimuth: rng() * Math.PI * 2,
        elevation: rng.range(-0.42, 0.55),
        distance: rng.range(cn.distanceMin, cn.distanceMax),
        dolly: rng.range(-cn.dolly, cn.dolly),
        orbit: rng.range(-0.12, 0.12),
        fov: rng.range(cn.fovMin, cn.fovMax),
        roll: rng.range(-0.09, 0.09),
        offset: new THREE.Vector3(rng.range(-0.3, 0.3), rng.range(-0.2, 0.35), 0).multiplyScalar(r),
      };
      st.needsSnap = true;
    }

    const s = st.shot;
    const t = st.shotTime;
    const az = s.azimuth + s.orbit * t;
    const dist = r * s.distance * (1 + s.dolly * t * 0.1);

    _a.set(
      Math.sin(az) * Math.cos(s.elevation) * dist,
      Math.sin(s.elevation) * dist,
      Math.cos(az) * Math.cos(s.elevation) * dist,
    );
    _a.applyQuaternion(g.quaternion).add(g.position);

    st.pos.copy(_a);
    _c.copy(s.offset).applyQuaternion(g.quaternion).add(g.position);
    if (st.needsSnap) st.aim.copy(_c);
    else st.aim.lerp(_c, 1 - Math.exp(-3.5 * dt));

    _up.set(Math.sin(s.roll), Math.cos(s.roll), 0).applyQuaternion(g.quaternion);
    _m.lookAt(st.pos, st.aim, _up);
    _q.setFromRotationMatrix(_m);
    if (st.needsSnap) st.quat.copy(_q);
    else st.quat.slerp(_q, 1 - Math.exp(-4.5 * dt));

    st.fov = damp(st.fov, s.fov, 1.2, dt);
  }

  function updateFree(dt) {
    const f = settings.free;
    const input = engine.input;
    const ax = input?.axes ?? { pitch: 0, yaw: 0, roll: 0, throttle: 0 };

    _e.set(-ax.pitch * f.turnRate * dt, -ax.yaw * f.turnRate * dt, -ax.roll * f.turnRate * dt, 'XYZ');
    _q2.setFromEuler(_e);
    st.freeQuat.multiply(_q2).normalize();

    const boost = input?.held?.('afterburner') ? f.boost : 1;
    _fwd.set(0, 0, -1).applyQuaternion(st.freeQuat);
    const throttle = clamp(ax.throttle, -1, 1);
    _a.copy(_fwd).multiplyScalar(f.speed * boost * (throttle !== 0 ? throttle : 1));
    st.freeVel.lerp(_a, 1 - Math.exp(-f.damping * dt));
    st.pos.addScaledVector(st.freeVel, dt);
    st.quat.copy(st.freeQuat);
  }

  // ---------------------------------------------------------------- the frame
  function update(dt, eng) {
    if (dt <= 0) dt = 1e-4;
    st.time += dt;

    const ship = getSubject();

    if (rig.mode === 'free') {
      if (st.needsSnap) {
        st.pos.copy(cam.position);
        st.freeQuat.copy(cam.quaternion);
        st.quat.copy(cam.quaternion);
      }
      updateFree(dt);
    } else if (!ship?.group) {
      // Nothing to look at — leave whatever framing was set by hand. This is the
      // path a scripted capture takes before ships/ has landed.
      return;
    } else {
      switch (rig.mode) {
        case 'chase': updateChase(ship, dt); break;
        case 'orbit': updateOrbit(ship, dt); break;
        case 'cinematic': updateCinematic(ship, dt); break;
        case 'padlock':
        case 'cockpit':
        default: updateCockpit(ship, dt); break;
      }
    }

    // ---- FOV: base + speed + afterburner kick --------------------------------
    if (rig.mode !== 'cinematic') {
      let targetFov = settings.fov;
      if (ship) {
        subjectVelocity(ship, _b);
        const frac = speedFraction(ship, _b.length());
        targetFov += settings.fovSpeedGain * frac;
        if (afterburnerOn(ship)) {
          targetFov = Math.max(targetFov, settings.fovAfterburner);
          addRumble(settings.shake.afterburnerRumble);
        }
      }
      st.fov = st.needsSnap ? targetFov : damp(st.fov, targetFov, settings.fovEase, dt);
    }

    // ---- trauma / rumble -----------------------------------------------------
    rig.trauma = Math.max(0, rig.trauma - settings.shake.decay * dt);
    rig.rumble = Math.max(0, rig.rumble - 2.5 * dt);

    const sh = settings.shake;
    const shakeAmp = rig.trauma * rig.trauma + rig.rumble * rig.rumble * 0.22;

    // ---- handheld drift ------------------------------------------------------
    // Always on. A perfectly locked camera is the single clearest signal that a
    // frame came out of a renderer rather than off a set.
    const hh = settings.handheld;
    let driftX = 0;
    let driftY = 0;
    let driftZ = 0;
    let driftRx = 0;
    let driftRy = 0;
    let driftRz = 0;
    if (hh.enabled) {
      const t = st.time * hh.frequency;
      driftX = fbm1(t, 3) * hh.position;
      driftY = fbm1(t + 5.1, 5) * hh.position;
      driftZ = fbm1(t + 9.3, 7) * hh.position * 0.4;
      driftRx = fbm1(t * 1.31 + 2.4, 11) * hh.rotation;
      driftRy = fbm1(t * 1.17 + 6.8, 13) * hh.rotation;
      driftRz = fbm1(t * 0.83 + 1.9, 17) * hh.rotation * 0.6;
    }

    if (shakeAmp > 1e-5) {
      const t = st.time * sh.frequency;
      driftRx += fbm1(t, 23) * sh.pitch * shakeAmp;
      driftRy += fbm1(t + 3.7, 29) * sh.yaw * shakeAmp;
      driftRz += fbm1(t + 8.1, 31) * sh.roll * shakeAmp;
      driftX += fbm1(t * 0.81 + 4.4, 37) * sh.translate * shakeAmp;
      driftY += fbm1(t * 0.79 + 7.2, 41) * sh.translate * shakeAmp;
      driftZ += fbm1(t * 0.87 + 2.2, 43) * sh.translate * shakeAmp * 0.5;
    }

    // ---- mode cross-fade -----------------------------------------------------
    _c.copy(st.pos);
    _q2.copy(st.quat);
    if (st.blend < 1) {
      const e = st.blend * st.blend * (3 - 2 * st.blend); // smoothstep
      _c.copy(st.fromPos).lerp(st.pos, e);
      _q2.copy(st.fromQuat).slerp(st.quat, e);
    }

    _e.set(driftRx, driftRy, driftRz, 'XYZ');
    _q.setFromEuler(_e);
    _q.premultiply(_q2);

    _a.set(driftX, driftY, driftZ).applyQuaternion(_q);
    _b.copy(_c).add(_a);

    // ---- commit to both cameras ---------------------------------------------
    cam.position.copy(_b);
    cam.quaternion.copy(_q);
    cam.updateMatrixWorld(true);

    cpt.position.copy(_b);
    cpt.quaternion.copy(_q);
    cpt.updateMatrixWorld(true);

    const fov = clamp(st.fov, 20, 120);
    if (Math.abs(fov - st.lastFov) > 1e-3) {
      st.lastFov = fov;
      cam.fov = fov;
      cpt.fov = fov;
      cam.updateProjectionMatrix();
      cpt.updateProjectionMatrix();
    }

    st.needsSnap = false;
    st.blend = Math.min(1, st.blend + dt / Math.max(1e-3, settings.transition));
  }

  return rig;
}
