/**
 * Curl-noise advection field.
 *
 * `procgen/noise.js` already has a correct `curl3`, but it costs six `fbm3`
 * evaluations per sample — roughly 150 hashed gradients. A thousand live fire
 * particles advected every frame would spend the whole budget there, so instead
 * we bake the field **once** into a small periodic 3D grid and trilinearly
 * sample it. Two grid taps at different scales cost ~60 flops and give the same
 * rolling, folding motion.
 *
 * Why the field is built here rather than by calling `curl3`:
 *   - it must **tile**. `perlin3` takes no period, so a wrapped lookup into a
 *     `curl3` bake shows a shear seam wherever the field discontinuously jumps,
 *     and a shear seam in a velocity field is visible as a straight edge cutting
 *     through the fireball. A potential built from integer-frequency sinusoids
 *     is periodic by construction.
 *   - the curl of that potential is taken by central differences *on the grid*,
 *     so the sampled field is discretely divergence-free: particles swirl and
 *     fold, they never pile up in sinks or blow apart from sources. That is the
 *     entire difference between "rolling fireball" and "expanding puff of dots".
 */

import { makeRng } from '../core/Rand.js';

/**
 * @param {object} engine
 * @param {{size?:number, waves?:number, seed?:number}} opts
 * @returns {{n:number, data:Float32Array}} `data` is n³ × 3, cell-major.
 */
export function getCurlField(engine, { size = 20, waves = 13, seed = 20789 } = {}) {
  const key = `vfx/curlField/${size}/${waves}/${seed}`;
  const build = () => buildCurlField(size, waves, seed);
  return engine?.registry ? engine.registry.get(key, build) : build();
}

function buildCurlField(n, waveCount, seed) {
  const rng = makeRng(seed);
  const cells = n * n * n;
  // Vector potential A. curl(A) is divergence-free for any A.
  const A = new Float32Array(cells * 3);

  const TAU = Math.PI * 2;
  for (let c = 0; c < 3; c++) {
    for (let w = 0; w < waveCount; w++) {
      // Integer wave vectors keep the potential exactly periodic over the grid.
      const kx = rng.int(-3, 3);
      const ky = rng.int(-3, 3);
      const kz = rng.int(-3, 3);
      if (kx === 0 && ky === 0 && kz === 0) continue;
      const mag = Math.sqrt(kx * kx + ky * ky + kz * kz);
      // 1/k falloff: low frequencies carry the large rolling cells, high ones
      // the fine shear that tears the fireball's edge.
      const amp = 1 / (mag * mag);
      const ph = rng() * TAU;
      const fx = (TAU * kx) / n;
      const fy = (TAU * ky) / n;
      const fz = (TAU * kz) / n;
      for (let z = 0, i = c; z < n; z++) {
        const pz = fz * z;
        for (let y = 0; y < n; y++) {
          const py = fy * y + pz + ph;
          for (let x = 0; x < n; x++, i += 3) {
            A[i] += amp * Math.sin(fx * x + py);
          }
        }
      }
    }
  }

  // curl(A) by central differences with wrapped indices.
  const F = new Float32Array(cells * 3);
  const idx = (x, y, z) => (((z + n) % n) * n * n + ((y + n) % n) * n + ((x + n) % n)) * 3;
  let maxLen = 1e-6;
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const o = (z * n * n + y * n + x) * 3;
        const dAz_dy = (A[idx(x, y + 1, z) + 2] - A[idx(x, y - 1, z) + 2]) * 0.5;
        const dAy_dz = (A[idx(x, y, z + 1) + 1] - A[idx(x, y, z - 1) + 1]) * 0.5;
        const dAx_dz = (A[idx(x, y, z + 1) + 0] - A[idx(x, y, z - 1) + 0]) * 0.5;
        const dAz_dx = (A[idx(x + 1, y, z) + 2] - A[idx(x - 1, y, z) + 2]) * 0.5;
        const dAy_dx = (A[idx(x + 1, y, z) + 1] - A[idx(x - 1, y, z) + 1]) * 0.5;
        const dAx_dy = (A[idx(x, y + 1, z) + 0] - A[idx(x, y - 1, z) + 0]) * 0.5;
        const vx = dAz_dy - dAy_dz;
        const vy = dAx_dz - dAz_dx;
        const vz = dAy_dx - dAx_dy;
        F[o] = vx; F[o + 1] = vy; F[o + 2] = vz;
        const l = vx * vx + vy * vy + vz * vz;
        if (l > maxLen) maxLen = l;
      }
    }
  }
  // Normalise to unit peak so callers set amplitude in m/s directly.
  const inv = 1 / Math.sqrt(maxLen);
  for (let i = 0; i < F.length; i++) F[i] *= inv;

  return { n, data: F };
}

/**
 * Trilinear, wrapped sample. Writes into `out` (three-element array-like) —
 * never allocates, because this runs a few thousand times a frame.
 */
export function sampleCurl(field, x, y, z, out) {
  const n = field.n;
  const d = field.data;
  const fx = x - Math.floor(x / n) * n;
  const fy = y - Math.floor(y / n) * n;
  const fz = z - Math.floor(z / n) * n;
  const x0 = fx | 0, y0 = fy | 0, z0 = fz | 0;
  const tx = fx - x0, ty = fy - y0, tz = fz - z0;
  const x1 = x0 + 1 === n ? 0 : x0 + 1;
  const y1 = y0 + 1 === n ? 0 : y0 + 1;
  const z1 = z0 + 1 === n ? 0 : z0 + 1;
  const nn = n * n;
  const r0 = z0 * nn, r1 = z1 * nn;
  const c00 = (r0 + y0 * n + x0) * 3, c10 = (r0 + y0 * n + x1) * 3;
  const c01 = (r0 + y1 * n + x0) * 3, c11 = (r0 + y1 * n + x1) * 3;
  const d00 = (r1 + y0 * n + x0) * 3, d10 = (r1 + y0 * n + x1) * 3;
  const d01 = (r1 + y1 * n + x0) * 3, d11 = (r1 + y1 * n + x1) * 3;
  const ix = 1 - tx, iy = 1 - ty, iz = 1 - tz;
  const w000 = ix * iy * iz, w100 = tx * iy * iz, w010 = ix * ty * iz, w110 = tx * ty * iz;
  const w001 = ix * iy * tz, w101 = tx * iy * tz, w011 = ix * ty * tz, w111 = tx * ty * tz;
  for (let k = 0; k < 3; k++) {
    out[k] =
      d[c00 + k] * w000 + d[c10 + k] * w100 + d[c01 + k] * w010 + d[c11 + k] * w110 +
      d[d00 + k] * w001 + d[d10 + k] * w101 + d[d01 + k] * w011 + d[d11 + k] * w111;
  }
  return out;
}
