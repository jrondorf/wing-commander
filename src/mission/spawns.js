/**
 * src/mission/spawns.js — turning a spawn group into positions and orientations.
 *
 * Deliberately free of three.js. `game.spawnShip()` takes anything with `x,y,z`
 * (it calls `Vector3.copy`) and anything with `x,y,z,w` for the quaternion, so the
 * whole placement layer is plain arithmetic — which means `__selftest.mjs` can
 * assert that a wave really does spawn 2.6 km off the nav point, headless, with no
 * renderer and no WebGL context anywhere in sight.
 *
 * Placement rules:
 *   - the *anchor* is a nav point, the player, another tagged ship, or a literal
 *     world position;
 *   - `offset` is applied in world axes (the nav course runs roughly along −Z, so
 *     a designer writing `[0, 400, -2600]` gets "high and in front" every time,
 *     which is not true if the offset rotates with the anchor's heading);
 *   - ships in a group fan out on a deterministic lattice scaled by `spread`, with
 *     a little seeded jitter so a four-ship wave is not a picket fence.
 */

const V = (x = 0, y = 0, z = 0) => ({ x, y, z });

export const add = (a, b) => V(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a, b) => V(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a, s) => V(a.x * s, a.y * s, a.z * s);
export const len = (a) => Math.hypot(a.x, a.y, a.z);

export function normalize(a, fallback = V(0, 0, -1)) {
  const l = len(a);
  if (!(l > 1e-6)) return { ...fallback };
  return V(a.x / l, a.y / l, a.z / l);
}

export const cross = (a, b) => V(
  a.y * b.z - a.z * b.y,
  a.z * b.x - a.x * b.z,
  a.x * b.y - a.y * b.x,
);

/**
 * Quaternion that points a three.js object's local −Z along `dir`.
 *
 * Ships are authored nose-down −Z (ARCHITECTURE §5.4 and every class in ships/),
 * so the object's +Z basis vector is the *backwards* direction. Getting this sign
 * wrong spawns an entire alien wave flying politely away from the player, which
 * reads as a broken AI rather than as a broken spawn.
 */
export function quatLookAt(dir, upHint = V(0, 1, 0)) {
  const z = normalize(scale(normalize(dir), -1));       // object +Z = backwards
  let up = upHint;
  if (Math.abs(z.x * up.x + z.y * up.y + z.z * up.z) > 0.999) up = V(1, 0, 0);
  const x = normalize(cross(up, z), V(1, 0, 0));
  const y = cross(z, x);

  // Matrix → quaternion (Shepperd's method, branch on the largest diagonal).
  const m00 = x.x, m01 = y.x, m02 = z.x;
  const m10 = x.y, m11 = y.y, m12 = z.y;
  const m20 = x.z, m21 = y.z, m22 = z.z;
  const trace = m00 + m11 + m22;
  let qx, qy, qz, qw;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    qw = 0.25 / s; qx = (m21 - m12) * s; qy = (m02 - m20) * s; qz = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    qw = (m21 - m12) / s; qx = 0.25 * s; qy = (m01 + m10) / s; qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    qw = (m02 - m20) / s; qx = (m01 + m10) / s; qy = 0.25 * s; qz = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    qw = (m10 - m01) / s; qx = (m02 + m20) / s; qy = (m12 + m21) / s; qz = 0.25 * s;
  }
  return { x: qx, y: qy, z: qz, w: qw };
}

/**
 * Lattice offsets for `n` ships around a group centre.
 * Deterministic in `rng`, so the same mission + seed always spawns the same
 * geometry — the capture harness compares screenshots between runs.
 */
export function formationOffsets(n, spread, rng, formation = 'wedge') {
  const out = [];
  const s = Math.max(20, spread);
  for (let i = 0; i < n; i++) {
    const rank = Math.ceil(i / 2);
    const side = i === 0 ? 0 : (i % 2 === 1 ? 1 : -1);
    let x, y, z;
    switch (formation) {
      case 'lineAbreast':
        x = (i - (n - 1) / 2) * s; y = 0; z = 0;
        break;
      case 'trail':
        x = 0; y = 0; z = i * s * 1.4;
        break;
      case 'echelonRight':
        x = i * s * 0.8; y = 0; z = i * s * 0.8;
        break;
      case 'column':
        x = 0; y = i * s * 0.5; z = i * s * 1.2;
        break;
      case 'fingerFour':
        x = side * rank * s; y = side * rank * s * 0.18; z = rank * s * 0.7;
        break;
      case 'wedge':
      default:
        x = side * rank * s; y = 0; z = rank * s * 0.85;
        break;
    }
    // Seeded jitter: ±12 % of spacing, and a little vertical stagger. Without it
    // a wave reads as a wallpaper pattern the moment the player sees it side-on.
    const j = s * 0.12;
    out.push(V(
      x + (rng ? rng.gauss(0, j) : 0),
      y + (rng ? rng.gauss(0, j * 0.8) : 0),
      z + (rng ? rng.gauss(0, j) : 0),
    ));
  }
  return out;
}

/**
 * Resolve a spawn group into concrete placements.
 *
 * @param {object} group   normalized group definition
 * @param {object} anchor  world position the offset is measured from
 * @param {object|null} facePos world position to point at, or null to keep the
 *                              group's travel direction
 * @param {Function} rng   makeRng instance
 * @param {number} count   how many to place (may be trimmed by the ship budget)
 * @returns {Array<{position:{x,y,z}, quaternion:{x,y,z,w}}>}
 */
export function placeGroup(group, anchor, facePos, rng, count = group.count) {
  const centre = add(anchor, group.offset);
  const offsets = formationOffsets(count, group.spread, rng, group.formation);
  const out = [];
  for (let i = 0; i < count; i++) {
    const position = add(centre, offsets[i]);
    const dir = facePos ? sub(facePos, position) : sub(centre, anchor);
    out.push({ position, quaternion: quatLookAt(len(dir) > 1 ? dir : V(0, 0, -1)) });
  }
  return out;
}

export default { placeGroup, formationOffsets, quatLookAt, add, sub, scale, normalize, len };
