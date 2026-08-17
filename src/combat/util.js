/**
 * src/combat/util.js — the small shared vocabulary of the combat module.
 *
 * Scalar helpers, faction relations, ship-state readers that tolerate a missing
 * flight body, and the two pieces of geometry every other file in here leans on:
 *
 *   readHull(ship, out)   — a ship's world-space OBB, however it is expressed
 *   segmentVsOBB(...)     — swept-sphere / segment against that OBB
 *
 * The swept test is the whole reason projectiles work at all. At 2000 m/s and
 * 60 fps a bolt covers 33 m per frame; a 28 m fighter is *smaller than one
 * frame of travel*, so a point-in-box test misses more often than it hits. Every
 * hit in this game is resolved as a capsule sweep, never a point sample.
 */
import * as THREE from 'three';

export const DEG = Math.PI / 180;

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
export function clamp11(v) { return v < -1 ? -1 : v > 1 ? 1 : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }

/** 0 below `lo`, 1 above `hi`, smoothstep between. */
export function smoothRange(v, lo, hi) {
  if (hi <= lo) return v >= hi ? 1 : 0;
  const t = clamp01((v - lo) / (hi - lo));
  return t * t * (3 - 2 * t);
}

export function num(v, fallback = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// ---------------------------------------------------------------------------
// factions
// ---------------------------------------------------------------------------

/**
 * Who shoots at whom. Deliberately duplicated from `ai/threat.js` rather than
 * imported: combat must keep resolving hits in a build where `ai/` is absent,
 * and a static import would take the whole module down with it.
 * TODO(contract): promote this table to `src/core/` and have both read it.
 */
const ALLIES = {
  confed: new Set(['confed', 'militia', 'civilian', 'terran']),
  militia: new Set(['confed', 'militia', 'civilian', 'terran']),
  civilian: new Set(['confed', 'militia', 'civilian', 'terran']),
  terran: new Set(['confed', 'militia', 'civilian', 'terran']),
  nephilim: new Set(['nephilim', 'alien', 'bug']),
  alien: new Set(['nephilim', 'alien', 'bug']),
  kilrathi: new Set(['kilrathi']),
  pirate: new Set(['pirate']),
  neutral: new Set(),
};

export function isHostile(a, b) {
  if (!a || !b || a === b) return false;
  const fa = a.faction ?? 'confed';
  const fb = b.faction ?? 'confed';
  if (fa === 'neutral' || fb === 'neutral') return false;
  const set = ALLIES[fa];
  return set ? !set.has(fb) : fa !== fb;
}

export function isFriendly(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return !isHostile(a, b);
}

const CAPITAL_RE = /carrier|cruiser|destroyer|corvette|frigate|dreadnought|station|transport|capital|leviathan|drayman|cap_/i;

/** Capital ships are attacked, not dogfought — and only torpedoes lock them. */
export function isCapitalShip(ship) {
  if (!ship) return false;
  if (typeof ship.isCapital === 'boolean') return ship.isCapital;
  const s = ship.stats;
  if (s) {
    if (typeof s.isCapital === 'boolean') return s.isCapital;
    if (num(s.mass, 0) > 200_000) return true;
    if (num(s.length, 0) > 120) return true;
  }
  if ((ship.hardpoints?.turrets?.length ?? 0) >= 4) return true;
  return CAPITAL_RE.test(ship.classId ?? '');
}

export function isAlive(ship) {
  return !!ship && ship.alive !== false;
}

// ---------------------------------------------------------------------------
// ship state readers  (tolerate a ship with no flight body)
// ---------------------------------------------------------------------------

const _zero = new THREE.Vector3();

export function shipPosition(ship, out) {
  const p = ship?.body?.position ?? ship?.group?.position ?? null;
  return p ? out.copy(p) : out.set(0, 0, 0);
}

export function shipVelocity(ship, out) {
  const v = ship?.body?.velocity ?? null;
  return v ? out.copy(v) : out.set(0, 0, 0);
}

export function shipQuaternion(ship, out) {
  const q = ship?.body?.quaternion ?? ship?.group?.quaternion ?? null;
  return q ? out.copy(q) : out.identity();
}

/** Nose direction, world space. Ships/ guarantees -Z is forward. */
export function shipForward(ship, out) {
  const f = ship?.body?.forward;
  if (f) return out.copy(f);
  const q = ship?.body?.quaternion ?? ship?.group?.quaternion;
  out.set(0, 0, -1);
  return q ? out.applyQuaternion(q) : out;
}

/** Rough hull radius, for reticles, blast falloff and broadphase padding. */
export function shipRadius(ship) {
  return num(ship?.body?.boundsRadius,
    num(ship?.group?.userData?.radius,
      Math.max(6, num(ship?.stats?.length, 20) * 0.5)));
}

/**
 * A reusable world-space oriented bounding box for a ship.
 *
 * `out` is mutated and returned so the per-frame hull table never allocates.
 * Prefers the flight body's measured bounds; falls back to the mesh bounds that
 * `ships/` publishes, and finally to a box derived from the class length.
 */
export function readHull(ship, out) {
  out.ship = ship;
  out.ok = false;
  if (!ship) return out;

  const body = ship.body ?? null;
  const group = ship.group ?? null;

  const pos = body?.position ?? group?.position;
  const quat = body?.quaternion ?? group?.quaternion;
  if (!pos || !quat) return out;

  out.position.copy(pos);
  out.quat.copy(quat);
  if (body?.velocity) out.velocity.copy(body.velocity); else out.velocity.copy(_zero);

  if (body?.halfExtents) {
    out.half.copy(body.halfExtents);
    out.localCenter.copy(body.boundsCenter);
    out.radius = num(body.boundsRadius, out.half.length());
  } else {
    const bounds = group?.userData?.bounds;
    if (bounds?.isBox3 && !bounds.isEmpty()) {
      bounds.getCenter(out.localCenter);
      bounds.getSize(out.half).multiplyScalar(0.5);
    } else {
      const L = Math.max(4, num(ship.stats?.length, 20));
      out.localCenter.set(0, 0, 0);
      out.half.set(L * 0.42, L * 0.22, L * 0.5);
    }
    out.radius = out.half.length();
  }

  // Guard degenerate axes — a flat plate must still be hittable.
  const eps = Math.max(0.25, out.radius * 0.02);
  out.half.x = Math.max(out.half.x, eps);
  out.half.y = Math.max(out.half.y, eps);
  out.half.z = Math.max(out.half.z, eps);

  out.center.copy(out.localCenter).applyQuaternion(out.quat).add(out.position);
  out.ok = true;
  return out;
}

/** Allocate a hull record for `readHull` to fill. */
export function makeHullRef() {
  return {
    ship: null,
    ok: false,
    position: new THREE.Vector3(),
    center: new THREE.Vector3(),
    localCenter: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    half: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    radius: 1,
  };
}

// ---------------------------------------------------------------------------
// swept collision
// ---------------------------------------------------------------------------

const _iq = new THREE.Quaternion();
const _l0 = new THREE.Vector3();
const _l1 = new THREE.Vector3();
const _ld = new THREE.Vector3();
const _lp = new THREE.Vector3();
const _ln = new THREE.Vector3();

/**
 * Segment (p0 -> p1) swept with radius `radius` against an oriented box.
 *
 * The box is inflated by `radius` and the segment tested against the inflated
 * slabs. That is the Minkowski sum of the box with a sphere, minus the rounded
 * corners — a hair generous at the eight corners and exact everywhere else,
 * which is the right way to be wrong for a weapon hit test.
 *
 * @returns {boolean} true on contact, with `out.t` (0..1 along the segment),
 *          `out.point` and `out.normal` (world space, pointing out of the box).
 */
export function segmentVsOBB(p0, p1, boxCenter, boxQuat, half, radius, out) {
  _iq.copy(boxQuat).invert();
  _l0.copy(p0).sub(boxCenter).applyQuaternion(_iq);
  _l1.copy(p1).sub(boxCenter).applyQuaternion(_iq);
  _ld.copy(_l1).sub(_l0);

  const hx = half.x + radius;
  const hy = half.y + radius;
  const hz = half.z + radius;

  let tmin = 0;
  let tmax = 1;
  let axis = -1;
  let sign = 1;

  const h = [hx, hy, hz];
  const o = [_l0.x, _l0.y, _l0.z];
  const d = [_ld.x, _ld.y, _ld.z];

  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      // Parallel to this slab: either always inside it, or never.
      if (o[i] < -h[i] || o[i] > h[i]) return false;
      continue;
    }
    const inv = 1 / d[i];
    let t1 = (-h[i] - o[i]) * inv;
    let t2 = (h[i] - o[i]) * inv;
    let s = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = i; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }

  if (tmax < 0 || tmin > 1) return false;

  const t = tmin > 0 ? tmin : 0;
  _lp.copy(_l0).addScaledVector(_ld, t);

  if (axis < 0 || tmin <= 0) {
    // Started already overlapping — push out through the nearest face so the
    // normal is still meaningful for a shield ripple.
    const ex = hx - Math.abs(_lp.x);
    const ey = hy - Math.abs(_lp.y);
    const ez = hz - Math.abs(_lp.z);
    if (ex <= ey && ex <= ez) _ln.set(Math.sign(_lp.x) || 1, 0, 0);
    else if (ey <= ez) _ln.set(0, Math.sign(_lp.y) || 1, 0);
    else _ln.set(0, 0, Math.sign(_lp.z) || 1);
  } else {
    _ln.set(0, 0, 0);
    _ln.setComponent(axis, sign);
  }

  // Clamp the contact point onto the *real* hull surface, not the inflated one,
  // so shield ripples and sparks sit on the skin.
  out.localPoint.set(
    clamp(_lp.x, -half.x, half.x),
    clamp(_lp.y, -half.y, half.y),
    clamp(_lp.z, -half.z, half.z),
  );
  out.point.copy(out.localPoint).applyQuaternion(boxQuat).add(boxCenter);
  out.normal.copy(_ln).applyQuaternion(boxQuat).normalize();
  out.t = t;
  return true;
}

export function makeHitRef() {
  return {
    t: 0,
    point: new THREE.Vector3(),
    localPoint: new THREE.Vector3(),
    normal: new THREE.Vector3(),
  };
}

/**
 * Parametric position (0..1) of the point on segment p0->p1 closest to `c`.
 * Used to order a point-defence hit on a missile against hits on hulls.
 */
export function segmentClosestT(p0, p1, c) {
  const bx = p1.x - p0.x, by = p1.y - p0.y, bz = p1.z - p0.z;
  const bb = bx * bx + by * by + bz * bz;
  if (bb < 1e-12) return 0;
  const t = ((c.x - p0.x) * bx + (c.y - p0.y) * by + (c.z - p0.z) * bz) / bb;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Cheap reject: does the segment come within `r` of a sphere? */
export function segmentNearSphere(p0, p1, center, r) {
  const ax = p0.x, ay = p0.y, az = p0.z;
  const bx = p1.x - ax, by = p1.y - ay, bz = p1.z - az;
  const cx = center.x - ax, cy = center.y - ay, cz = center.z - az;
  const bb = bx * bx + by * by + bz * bz;
  let t = bb > 1e-12 ? (cx * bx + cy * by + cz * bz) / bb : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = cx - bx * t, dy = cy - by * t, dz = cz - bz * t;
  return dx * dx + dy * dy + dz * dz <= r * r;
}

// ---------------------------------------------------------------------------
// damage facing
// ---------------------------------------------------------------------------

export const FACINGS = ['fore', 'aft', 'left', 'right'];

/**
 * Which shield quadrant eats this hit.
 *
 * Compared in *shape-normalised* space: a 900 m carrier hit amidships on the
 * flank must read as a flank hit, not as a bow hit just because |z| is large.
 * Dorsal/ventral hits fold onto the nearest of the four quadrants, exactly as
 * Wing Commander's four-bank model does.
 */
export function facingFromLocalPoint(local, half) {
  const nx = local.x / Math.max(1e-3, half.x);
  const nz = local.z / Math.max(1e-3, half.z);
  if (Math.abs(nz) >= Math.abs(nx)) return nz < 0 ? 'fore' : 'aft';
  return nx > 0 ? 'right' : 'left';
}
