/**
 * src/ai/kinematicFallback.js — a stand-in flight body, used ONLY when
 * `src/flight/` has not produced a `ship.body` for a ship the AI is flying.
 *
 * Why this exists: many agents build this game in parallel. Without it, an AI
 * pilot attached to a ship that has no flight body would sit motionless at its
 * spawn point, and every capture of a "dogfight" would be a row of parked
 * fighters. With it, the AI can be developed, captured and self-tested before
 * flight lands.
 *
 * It self-disables the instant `ship.body` appears — `AISystem.bodyOf()` prefers
 * the real body always, and the shadow is dropped. It deliberately implements
 * only the documented contract surface (ARCHITECTURE §5.5) and nothing more, so
 * it cannot silently become a second flight model:
 *
 *   { position, quaternion, velocity, angularVelocity, forward, speed, controls, stats }
 *
 * The integration is intentionally simple — rate-limited body-axis rotation plus
 * a first-order velocity lag that produces visible drift through turns.
 */
import * as THREE from 'three';
import { clamp, clamp01, clamp11, num } from './aimath.js';

const _e = new THREE.Euler();
const _dq = new THREE.Quaternion();
const _want = new THREE.Vector3();
const _side = new THREE.Vector3();

export function makeControls() {
  return { pitch: 0, yaw: 0, roll: 0, throttle: 0, afterburner: 0, strafeX: 0, strafeY: 0, brake: 0 };
}

/** Create a shadow body seeded from the ship's current transform. */
export function createShadowBody(ship) {
  const g = ship?.group;
  const body = {
    __shadow: true,
    position: g ? g.position.clone() : new THREE.Vector3(),
    quaternion: g ? g.quaternion.clone() : new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    angularVelocity: new THREE.Vector3(),
    forward: new THREE.Vector3(0, 0, -1),
    speed: 0,
    controls: makeControls(),
    stats: ship?.stats ?? null,
  };
  body.forward.applyQuaternion(body.quaternion);
  const cruise = (ship?.stats?.maxSpeed ?? 420) * 0.55;
  body.velocity.copy(body.forward).multiplyScalar(cruise);
  body.speed = cruise;
  return body;
}

/**
 * Advance a shadow body one step and mirror it onto the ship's Object3D.
 * `driven` is false for ships we merely observe (the player before flight lands),
 * in which case we read their transform instead of writing it.
 */
export function integrateShadow(body, ship, dt, driven = true) {
  if (!body || dt <= 0) return;
  const g = ship?.group;

  if (!driven) {
    // Observation mode: track the transform somebody else owns and difference it
    // for a velocity estimate, so threat maths still works.
    if (g) {
      _want.copy(g.position).sub(body.position).multiplyScalar(1 / dt);
      body.velocity.lerp(_want, 0.35);
      body.position.copy(g.position);
      body.quaternion.copy(g.quaternion);
    }
    body.forward.set(0, 0, -1).applyQuaternion(body.quaternion);
    body.speed = body.velocity.length();
    return;
  }

  const c = body.controls ?? (body.controls = makeControls());
  const st = ship?.stats ?? {};
  const pitchRate = num(st.pitchRate, 1.35);
  const yawRate = num(st.yawRate, 1.05);
  const rollRate = num(st.rollRate, 2.6);
  const maxSpeed = num(st.maxSpeed, 430);
  const abSpeed = num(st.afterburnerSpeed, maxSpeed * 3.1);
  const accel = num(st.accel, 130);

  // Body-axis rotation. Sign convention documented in aimath.js:
  //   +pitch = nose up  → +X   |  +yaw = nose right → −Y  |  +roll = right → −Z
  const rx = clamp11(num(c.pitch)) * pitchRate * dt;
  const ry = -clamp11(num(c.yaw)) * yawRate * dt;
  const rz = -clamp11(num(c.roll)) * rollRate * dt;
  _e.set(rx, ry, rz, 'XYZ');
  _dq.setFromEuler(_e);
  body.quaternion.multiply(_dq).normalize();
  body.angularVelocity.set(rx / dt, ry / dt, rz / dt);

  body.forward.set(0, 0, -1).applyQuaternion(body.quaternion);

  const ab = clamp01(num(c.afterburner));
  const throttle = clamp01(num(c.throttle));
  const brake = clamp01(num(c.brake));
  let want = maxSpeed * throttle + (abSpeed - maxSpeed) * ab;
  if (brake > 0) want *= 1 - brake * 0.75;

  const a = accel * (1 + ab * 2.2) * dt;
  const cur = body.speed;
  body.speed = cur + clamp(want - cur, -a * 2.2, a);

  // Velocity lags the nose: this is what makes a hard turn read as a *turn*
  // rather than a cursor moving. tau shortens with speed, as it would with more
  // control authority.
  _want.copy(body.forward).multiplyScalar(body.speed);
  if (c.strafeX || c.strafeY) {
    _side.set(clamp11(num(c.strafeX)), clamp11(num(c.strafeY)), 0).applyQuaternion(body.quaternion);
    _want.addScaledVector(_side, maxSpeed * 0.18);
  }
  const tau = 0.55;
  const k = 1 - Math.exp(-dt / tau);
  body.velocity.lerp(_want, k);

  body.position.addScaledVector(body.velocity, dt);

  if (g) {
    g.position.copy(body.position);
    g.quaternion.copy(body.quaternion);
  }
}
