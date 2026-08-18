import * as THREE from 'three';
import { clamp } from './util.js';

/**
 * src/flight/Collision.js — sphere/OBB collision for ships and asteroids.
 *
 * Broadphase is a sphere-sphere reject against a conservative radius taken from
 * the ship's own mesh bounds. Narrowphase treats the *smaller* body as a sphere
 * and the larger as an oriented box, which is the right trade for this game: a
 * fighter clipping a carrier's flight deck should feel the deck's actual shape,
 * and two fighters brushing at 400 m/s do not need mesh-accurate contact.
 *
 * Tunnelling is prevented upstream, by FlightSystem's substepping — no body
 * advances more than a fraction of the smallest collidable radius per substep.
 *
 * Emits (ARCHITECTURE §5.6):
 *   collision      { a, b, kind, point, normal, impulse, relativeSpeed, damageA, damageB }
 *   shield:impact  { ship, position, normal, strength, source:'collision' }
 */

const _l = new THREE.Vector3();
const _iq = new THREE.Quaternion();
const _rA = new THREE.Vector3();
const _rB = new THREE.Vector3();
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _imp = new THREE.Vector3();
const _cross = new THREE.Vector3();
const _wA = new THREE.Vector3();
const _wB = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _zero = new THREE.Vector3();
const _rockC = new THREE.Vector3();
const _sphereC = new THREE.Vector3();
const _obbC = new THREE.Vector3();
const _box = new THREE.Box3();
const _querySphere = new THREE.Sphere();

/** Solid-of-revolution inertia coefficient — I = COEF * m * r². */
const INERTIA_COEF = 0.4;

/** Reusable contact record so narrowphase never allocates. */
const _hit = {
  normal: new THREE.Vector3(),
  point: new THREE.Vector3(),
  depth: 0,
};

// ---------------------------------------------------------------------------
// bounds
// ---------------------------------------------------------------------------

/**
 * Measure a ship group's bounds in its own local space, once, at attach time.
 *
 * The group's transform is temporarily neutralised so `Box3.setFromObject` gives
 * local-space extents rather than wherever the ship happens to be sitting. Falls
 * back to the class radius when the mesh has not been built (or has no geometry
 * yet, which happens while agent-ships is still landing).
 */
export function computeLocalBounds(group, fallbackRadius) {
  const out = {
    center: new THREE.Vector3(),
    half: new THREE.Vector3(fallbackRadius * 0.45, fallbackRadius * 0.35, fallbackRadius),
    sphereRadius: fallbackRadius,
    radius: fallbackRadius,
    measured: false,
  };
  if (!group) return finishBounds(out);

  // Fast path: agent-ships publishes local-space bounds on the group
  // (`userData.bounds` is a THREE.Box3 in hull space). Prefer it — it is
  // authoritative, and it avoids unioning every LOD level of the mesh.
  const ud = group.userData;
  if (ud?.bounds?.isBox3 && !ud.bounds.isEmpty()) {
    ud.bounds.getCenter(out.center);
    ud.bounds.getSize(out.half).multiplyScalar(0.5);
    const eps = Math.max(0.05, fallbackRadius * 0.02);
    out.half.x = Math.max(out.half.x, eps);
    out.half.y = Math.max(out.half.y, eps);
    out.half.z = Math.max(out.half.z, eps);
    out.measured = true;
    return finishBounds(out);
  }

  let px = null, qx = null;
  try {
    px = group.position.clone();
    qx = group.quaternion.clone();
    group.position.set(0, 0, 0);
    group.quaternion.identity();
    group.updateMatrix();

    _box.makeEmpty();
    _box.setFromObject(group);

    if (!_box.isEmpty() &&
        Number.isFinite(_box.min.x) && Number.isFinite(_box.max.x) &&
        Number.isFinite(_box.min.y) && Number.isFinite(_box.max.y) &&
        Number.isFinite(_box.min.z) && Number.isFinite(_box.max.z)) {
      _box.getCenter(out.center);
      _box.getSize(out.half).multiplyScalar(0.5);
      // Guard against a degenerate axis (flat plates, single quads).
      const eps = Math.max(0.05, fallbackRadius * 0.02);
      out.half.x = Math.max(out.half.x, eps);
      out.half.y = Math.max(out.half.y, eps);
      out.half.z = Math.max(out.half.z, eps);
      out.measured = true;
    }
  } catch {
    /* mesh not ready — keep the class fallback */
  } finally {
    if (px && qx) {
      group.position.copy(px);
      group.quaternion.copy(qx);
      group.updateMatrix();
    }
  }
  return finishBounds(out);
}

function finishBounds(out) {
  out.sphereRadius = out.half.length();
  out.radius = out.center.length() + out.sphereRadius;
  return out;
}

/** World-space centre of a body's tight bounding sphere. */
export function boundsCenterWorld(body, target) {
  return target.copy(body.boundsCenter).applyQuaternion(body.quaternion).add(body.position);
}

// ---------------------------------------------------------------------------
// narrowphase
// ---------------------------------------------------------------------------

/**
 * Sphere vs oriented box. `out.normal` points from the box toward the sphere.
 * @returns {boolean} true on contact, with `out` filled in.
 */
export function sphereVsOBB(sphereCenter, sphereRadius, obbCenter, obbQuat, half, out) {
  _iq.copy(obbQuat).invert();
  _l.copy(sphereCenter).sub(obbCenter).applyQuaternion(_iq);

  const cx = clamp(_l.x, -half.x, half.x);
  const cy = clamp(_l.y, -half.y, half.y);
  const cz = clamp(_l.z, -half.z, half.z);
  const dx = _l.x - cx, dy = _l.y - cy, dz = _l.z - cz;
  const d2 = dx * dx + dy * dy + dz * dz;

  if (d2 > sphereRadius * sphereRadius) return false;

  if (d2 > 1e-10) {
    const d = Math.sqrt(d2);
    out.normal.set(dx / d, dy / d, dz / d).applyQuaternion(obbQuat);
    out.depth = sphereRadius - d;
    out.point.set(cx, cy, cz).applyQuaternion(obbQuat).add(obbCenter);
  } else {
    // Centre is inside the box — escape through the nearest face.
    const ex = half.x - Math.abs(_l.x);
    const ey = half.y - Math.abs(_l.y);
    const ez = half.z - Math.abs(_l.z);
    if (ex <= ey && ex <= ez) {
      const s = _l.x >= 0 ? 1 : -1;
      out.normal.set(s, 0, 0).applyQuaternion(obbQuat);
      out.depth = sphereRadius + ex;
      out.point.set(s * half.x, _l.y, _l.z).applyQuaternion(obbQuat).add(obbCenter);
    } else if (ey <= ez) {
      const s = _l.y >= 0 ? 1 : -1;
      out.normal.set(0, s, 0).applyQuaternion(obbQuat);
      out.depth = sphereRadius + ey;
      out.point.set(_l.x, s * half.y, _l.z).applyQuaternion(obbQuat).add(obbCenter);
    } else {
      const s = _l.z >= 0 ? 1 : -1;
      out.normal.set(0, 0, s).applyQuaternion(obbQuat);
      out.depth = sphereRadius + ez;
      out.point.set(_l.x, _l.y, s * half.z).applyQuaternion(obbQuat).add(obbCenter);
    }
  }
  return true;
}

/**
 * Ship vs ship. The smaller hull is the sphere, the bigger one the box, so a
 * fighter is tested against a carrier's actual silhouette rather than a
 * 600 m ball.
 */
function shipVsShip(a, b, out) {
  const ca = boundsCenterWorld(a, _sphereC);
  const cb = boundsCenterWorld(b, _obbC);

  // Broadphase.
  const rsum = a.boundsRadius + b.boundsRadius;
  if (ca.distanceToSquared(cb) > rsum * rsum) return 0;

  if (a.boundsRadius <= b.boundsRadius) {
    // a is the sphere; normal points from b toward a.
    if (!sphereVsOBB(ca, a.boundsRadius, cb, b.quaternion, b.halfExtents, out)) return 0;
    return 1;
  }
  // b is the sphere; flip the normal so it still points from b toward a.
  if (!sphereVsOBB(cb, b.boundsRadius, ca, a.quaternion, a.halfExtents, out)) return 0;
  out.normal.negate();
  return 1;
}

// ---------------------------------------------------------------------------
// response
// ---------------------------------------------------------------------------

function worldOmega(body, target) {
  return target.copy(body.angularVelocity).applyQuaternion(body.quaternion);
}

function addWorldOmega(body, deltaWorld, scale) {
  if (!(scale > 0)) return;
  _tmp.copy(deltaWorld).multiplyScalar(scale).applyQuaternion(_iq.copy(body.quaternion).invert());
  body.angularVelocity.add(_tmp);
  const cap = body.tuning.collisionSpinMax;
  if (body.angularVelocity.lengthSq() > cap * cap) body.angularVelocity.setLength(cap);
}

/**
 * Impulse response for one contact. `b` may be null, meaning "immovable world
 * geometry" (an asteroid), in which case only `a` is pushed.
 *
 * @returns {number} the closing speed along the normal (>= 0), or 0 if the pair
 *                   was already separating.
 */
export function resolveContact(a, b, normal, depth, point, opts = {}) {
  // A pinned body is immovable: infinite mass, infinite inertia.
  const invMa = a.static ? 0 : a.tuning.invMass;
  const invMb = b && !b.static ? b.tuning.invMass : 0;
  const restitution = opts.restitution ??
    Math.max(a.tuning.restitution, b ? b.tuning.restitution : a.tuning.restitution);

  _rA.copy(point).sub(a.position);
  worldOmega(a, _wA);
  _vA.copy(a.velocity).add(_cross.copy(_wA).cross(_rA));

  if (b) {
    _rB.copy(point).sub(b.position);
    worldOmega(b, _wB);
    _vB.copy(b.velocity).add(_cross.copy(_wB).cross(_rB));
  } else {
    _rB.set(0, 0, 0);
    _vB.copy(opts.otherVelocity ?? _zero.set(0, 0, 0));
  }

  _rel.copy(_vA).sub(_vB);
  const vn = _rel.dot(normal);
  if (vn > 0) return 0; // already separating

  const ra = Math.max(1e-3, a.boundsRadius);
  const invIa = invMa > 0 ? 1 / (INERTIA_COEF * (1 / invMa) * ra * ra) : 0;
  const rb = b ? Math.max(1e-3, b.boundsRadius) : 1;
  const invIb = b && invMb > 0 ? 1 / (INERTIA_COEF * (1 / invMb) * rb * rb) : 0;

  // Effective mass along the normal, including the rotational terms.
  let denom = invMa + invMb;
  _cross.copy(_rA).cross(normal);
  denom += invIa * _cross.lengthSq();
  if (b) {
    _cross.copy(_rB).cross(normal);
    denom += invIb * _cross.lengthSq();
  }
  if (denom <= 1e-12) return 0;

  const j = (-(1 + restitution) * vn) / denom;
  _imp.copy(normal).multiplyScalar(j);

  a.velocity.addScaledVector(_imp, invMa);
  _cross.copy(_rA).cross(_imp).multiplyScalar(invIa);
  addWorldOmega(a, _cross, a.tuning.collisionSpinScale);
  a._clampSpeed();

  if (b) {
    b.velocity.addScaledVector(_imp, -invMb);
    _cross.copy(_rB).cross(_imp).multiplyScalar(-invIb);
    addWorldOmega(b, _cross, b.tuning.collisionSpinScale);
    b._clampSpeed();
  }

  // Positional correction: push the hulls apart so they do not sink and stick.
  const totalInv = invMa + invMb;
  if (depth > 0.02 && totalInv > 0) {
    const corr = Math.min(depth - 0.01, 4) * 0.65;
    if (corr > 0) {
      a.position.addScaledVector(normal, corr * (invMa / totalInv));
      if (b) b.position.addScaledVector(normal, -corr * (invMb / totalInv));
    }
  }

  return -vn;
}

/** dmg = scale · closing^exp · (how much heavier the other guy is, capped at 1). */
function collisionDamage(self, otherMass, closing) {
  const T = self.tuning;
  const ratio = Math.min(1, otherMass / T.mass);
  return T.collisionDamageScale * Math.pow(closing, T.collisionDamageExp) * ratio;
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------

/** True if this pair already fired an event recently (event spam guard). */
function onCooldown(a, b) {
  const ka = b.ship?.id ?? -1;
  return a._hitCooldown.has(ka);
}

function markCooldown(a, b) {
  const t = Math.max(a.tuning.collisionCooldown, b.tuning.collisionCooldown);
  const ka = b.ship?.id ?? -1;
  const kb = a.ship?.id ?? -1;
  a._hitCooldown.set(ka, t);
  b._hitCooldown.set(kb, t);
}

/**
 * Test and resolve every ship pair. O(n²) with a squared-distance broadphase —
 * with the dozens of ships a WC mission carries this is a rounding error next to
 * one draw call, and it keeps the ordering perfectly deterministic.
 */
export function resolveShipCollisions(bodies, engine) {
  const n = bodies.length;
  for (let i = 0; i < n; i++) {
    const a = bodies[i];
    if (!a.collides) continue;
    for (let j = i + 1; j < n; j++) {
      const b = bodies[j];
      if (!b.collides) continue;
      if (a.static && b.static) continue; // two immovables can never resolve

      if (!shipVsShip(a, b, _hit)) continue;

      const closing = resolveContact(a, b, _hit.normal, _hit.depth, _hit.point);
      if (closing <= 0) continue;

      const shakeA = Math.min(1.2, closing / 90);
      a.addShake(shakeA);
      b.addShake(shakeA);

      if (onCooldown(a, b)) continue;
      markCooldown(a, b);

      const damageA = collisionDamage(a, b.tuning.mass, closing);
      const damageB = collisionDamage(b, a.tuning.mass, closing);

      emitCollision(engine, {
        a: a.ship, b: b.ship, kind: 'ship',
        bodyA: a, bodyB: b,
        point: _hit.point.clone(),
        normal: _hit.normal.clone(),
        relativeSpeed: closing,
        impulse: closing / Math.max(1e-9, a.tuning.invMass + b.tuning.invMass),
        damageA, damageB,
      });
    }
  }
}

/**
 * Ships vs the asteroid field. `world.queryAsteroids(sphere)` is optional — the
 * world module may not have landed, or a scene may have no field — so every step
 * of this is guarded and the shapes it returns are read defensively.
 */
export function resolveAsteroidCollisions(bodies, engine) {
  const world = engine?.game?.world;
  const query = world?.queryAsteroids;
  if (typeof query !== 'function') return;

  for (const body of bodies) {
    if (!body.collides || body.static) continue;

    boundsCenterWorld(body, _sphereC);
    _querySphere.center.copy(_sphereC);
    _querySphere.radius = body.boundsRadius + Math.max(8, body.speed * 0.02);

    let list = null;
    try {
      list = query.call(world, _querySphere);
    } catch {
      return; // a broken world query must never take flight down
    }
    if (!list || typeof list.length !== 'number' || list.length === 0) continue;

    for (let i = 0; i < list.length; i++) {
      const rock = readAsteroid(list[i]);
      if (!rock) continue;

      // Asteroid is the sphere, ship is the box; normal points from ship to rock.
      if (!sphereVsOBB(rock.center, rock.radius, _sphereC, body.quaternion, body.halfExtents, _hit)) continue;
      _hit.normal.negate(); // ...flip so it points from the rock toward the ship

      const closing = resolveContact(body, null, _hit.normal, _hit.depth, _hit.point, {
        otherVelocity: rock.velocity,
        restitution: body.tuning.restitution,
      });
      if (closing <= 0) continue;

      body.addShake(Math.min(1.4, closing / 70));

      if (body._hitCooldown.has(-2)) continue;
      body._hitCooldown.set(-2, body.tuning.collisionCooldown);

      emitCollision(engine, {
        a: body.ship, b: list[i], kind: 'asteroid',
        bodyA: body, bodyB: null,
        point: _hit.point.clone(),
        normal: _hit.normal.clone(),
        relativeSpeed: closing,
        impulse: closing / Math.max(1e-9, body.tuning.invMass),
        damageA: collisionDamage(body, Number.POSITIVE_INFINITY, closing),
        damageB: 0,
      });
    }
  }
}

/** Read whatever shape the world module hands back, defensively. */
function readAsteroid(item) {
  if (!item) return null;
  const c = item.position ?? item.center ??
    (typeof item.x === 'number' ? item : null);
  if (!c || typeof c.x !== 'number') return null;
  let r = item.radius ?? item.boundingRadius ?? item.size ?? null;
  if (typeof r !== 'number') r = typeof item.scale === 'number' ? item.scale : null;
  if (typeof r !== 'number' || !(r > 0)) r = 20;
  const v = item.velocity && typeof item.velocity.x === 'number' ? item.velocity : null;
  _rockC.set(c.x, c.y, c.z);
  return { center: _rockC, radius: r, velocity: v };
}

function emitCollision(engine, payload) {
  const events = engine?.events;
  if (!events?.emit) return;
  events.emit('collision', payload);
  // A hull strike is a shield strike; vfx/audio already listen for this one.
  if (payload.a) {
    events.emit('shield:impact', {
      ship: payload.a, position: payload.point, normal: payload.normal,
      strength: Math.min(1, payload.relativeSpeed / 120), source: 'collision',
    });
  }
  if (payload.b && payload.kind === 'ship') {
    events.emit('shield:impact', {
      ship: payload.b, position: payload.point, normal: payload.normal.clone().negate(),
      strength: Math.min(1, payload.relativeSpeed / 120), source: 'collision',
    });
  }
}
