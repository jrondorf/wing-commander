/**
 * Shared noise kernels.
 *
 * Owned by the lead because every art module depends on it — hull textures, nebulae,
 * asteroid displacement, explosion turbulence and shader chunks all pull from here so
 * detail across the game shares a visual family.
 *
 * Everything is seeded and deterministic. All 2D functions are tileable when a
 * `period` is supplied, which matters because hull textures wrap around geometry.
 */

// ---------------------------------------------------------------- hash helpers

function hash2(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 1274126177) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function hash3(x, y, z, seed) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 1274126177) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;
const wrap = (v, period) => (period ? ((v % period) + period) % period : v);

// --------------------------------------------------------------- value noise

/** Value noise in [0,1]. Cheap; good base for wear masks and grunge. */
export function valueNoise2(x, y, seed = 0, period = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = fade(xf), v = fade(yf);
  const x0 = wrap(xi, period), x1 = wrap(xi + 1, period);
  const y0 = wrap(yi, period), y1 = wrap(yi + 1, period);
  return lerp(
    lerp(hash2(x0, y0, seed), hash2(x1, y0, seed), u),
    lerp(hash2(x0, y1, seed), hash2(x1, y1, seed), u),
    v,
  );
}

// -------------------------------------------------------------- perlin noise

function grad2(hx, hy, seed, dx, dy) {
  const a = hash2(hx, hy, seed) * Math.PI * 2;
  return Math.cos(a) * dx + Math.sin(a) * dy;
}

/** Perlin gradient noise in [-1,1]. The workhorse for panel warping and clouds. */
export function perlin2(x, y, seed = 0, period = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = fade(xf), v = fade(yf);
  const x0 = wrap(xi, period), x1 = wrap(xi + 1, period);
  const y0 = wrap(yi, period), y1 = wrap(yi + 1, period);
  return lerp(
    lerp(grad2(x0, y0, seed, xf, yf), grad2(x1, y0, seed, xf - 1, yf), u),
    lerp(grad2(x0, y1, seed, xf, yf - 1), grad2(x1, y1, seed, xf - 1, yf - 1), u),
    v,
  );
}

function grad3(hx, hy, hz, seed, dx, dy, dz) {
  const h = hash3(hx, hy, hz, seed);
  const theta = h * Math.PI * 2;
  const z = hash3(hx, hy, hz, seed ^ 0x9e37) * 2 - 1;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return Math.cos(theta) * r * dx + Math.sin(theta) * r * dy + z * dz;
}

/** 3D Perlin — used for volumetric nebulae and solid asteroid displacement. */
export function perlin3(x, y, z, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = fade(xf), v = fade(yf), w = fade(zf);
  const c = (i, j, k) => grad3(xi + i, yi + j, zi + k, seed, xf - i, yf - j, zf - k);
  return lerp(
    lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), v),
    lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}

// ------------------------------------------------------------------- fractals

/**
 * Fractional Brownian motion. `octaves` layers of noise at doubling frequency.
 * Returns roughly [-1,1] for perlin basis, [0,1] for value basis.
 */
export function fbm2(x, y, {
  octaves = 5, frequency = 1, lacunarity = 2, gain = 0.5, seed = 0, period = 0, basis = perlin2,
} = {}) {
  let sum = 0, amp = 1, norm = 0, f = frequency, p = period;
  for (let i = 0; i < octaves; i++) {
    sum += amp * basis(x * f, y * f, seed + i * 1013, p ? p * f : 0);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

export function fbm3(x, y, z, { octaves = 5, frequency = 1, lacunarity = 2, gain = 0.5, seed = 0 } = {}) {
  let sum = 0, amp = 1, norm = 0, f = frequency;
  for (let i = 0; i < octaves; i++) {
    sum += amp * perlin3(x * f, y * f, z * f, seed + i * 1013);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

/**
 * Ridged multifractal — sharp creases. This is what makes asteroid silhouettes and
 * nebula filaments read as eroded rather than lumpy.
 */
export function ridged2(x, y, { octaves = 5, frequency = 1, lacunarity = 2.1, gain = 0.5, seed = 0, period = 0, sharpness = 1 } = {}) {
  let sum = 0, amp = 1, norm = 0, f = frequency;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(perlin2(x * f, y * f, seed + i * 1013, period ? period * f : 0));
    n = Math.pow(n, 1 + sharpness);
    sum += amp * n;
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

export function ridged3(x, y, z, { octaves = 5, frequency = 1, lacunarity = 2.1, gain = 0.5, seed = 0, sharpness = 1 } = {}) {
  let sum = 0, amp = 1, norm = 0, f = frequency;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(perlin3(x * f, y * f, z * f, seed + i * 1013));
    n = Math.pow(n, 1 + sharpness);
    sum += amp * n;
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

/**
 * Billow — the inverse crease of ridged, giving puffy cumulus forms. Used for the
 * rolling interior of explosion fireballs and dense nebula cores.
 */
export function billow2(x, y, opts = {}) {
  const { octaves = 5, frequency = 1, lacunarity = 2, gain = 0.5, seed = 0, period = 0 } = opts;
  let sum = 0, amp = 1, norm = 0, f = frequency;
  for (let i = 0; i < octaves; i++) {
    sum += amp * Math.abs(perlin2(x * f, y * f, seed + i * 1013, period ? period * f : 0));
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

// -------------------------------------------------------------------- worley

/**
 * Worley / cellular noise.
 * @returns {{f1:number, f2:number, id:number, cx:number, cy:number}}
 *   f1/f2 are distances to the nearest and second-nearest feature point (in cell
 *   units), `id` identifies the owning cell — use it to give each cell its own
 *   random value, which is how hull plating gets per-panel tone variation.
 */
export function worley2(x, y, { seed = 0, period = 0, jitter = 1 } = {}) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = Infinity, f2 = Infinity, id = 0, cx = 0, cy = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const gx = xi + ox, gy = yi + oy;
      const wx = wrap(gx, period), wy = wrap(gy, period);
      const px = gx + (0.5 + (hash2(wx, wy, seed) - 0.5) * jitter);
      const py = gy + (0.5 + (hash2(wx, wy, seed ^ 0x5bf03) - 0.5) * jitter);
      const dx = px - x, dy = py - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < f1) {
        f2 = f1; f1 = d;
        id = (wx * 73856093) ^ (wy * 19349663);
        cx = px; cy = py;
      } else if (d < f2) f2 = d;
    }
  }
  return { f1, f2, id: (id >>> 0), cx, cy };
}

/** Deterministic [0,1) value for a worley cell id — per-panel albedo jitter. */
export function cellValue(id, salt = 0) {
  let h = (id ^ Math.imul(salt + 1, 2654435761)) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 2246822519);
  h ^= h >>> 13; h = Math.imul(h, 3266489917);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------- curl

/**
 * Divergence-free curl noise field. Particles advected through this swirl instead
 * of drifting apart, which is what separates a real explosion from a puff of dots.
 */
export function curl2(x, y, { seed = 0, epsilon = 0.001, frequency = 1, octaves = 3 } = {}) {
  const p = (px, py) => fbm2(px, py, { seed, frequency, octaves });
  const dx = (p(x, y + epsilon) - p(x, y - epsilon)) / (2 * epsilon);
  const dy = (p(x + epsilon, y) - p(x - epsilon, y)) / (2 * epsilon);
  return { x: dx, y: -dy };
}

export function curl3(x, y, z, { seed = 0, epsilon = 0.01, frequency = 1, octaves = 3 } = {}) {
  const o = { seed, frequency, octaves };
  const oy = { seed: seed + 9871, frequency, octaves };
  const oz = { seed: seed + 4231, frequency, octaves };
  const p1 = (a, b, c) => fbm3(a, b, c, o);
  const p2 = (a, b, c) => fbm3(a, b, c, oy);
  const p3 = (a, b, c) => fbm3(a, b, c, oz);
  const e = epsilon;
  const x1 = (p3(x, y + e, z) - p3(x, y - e, z)) / (2 * e) - (p2(x, y, z + e) - p2(x, y, z - e)) / (2 * e);
  const y1 = (p1(x, y, z + e) - p1(x, y, z - e)) / (2 * e) - (p3(x + e, y, z) - p3(x - e, y, z)) / (2 * e);
  const z1 = (p2(x + e, y, z) - p2(x - e, y, z)) / (2 * e) - (p1(x, y + e, z) - p1(x, y - e, z)) / (2 * e);
  return { x: x1, y: y1, z: z1 };
}

// ------------------------------------------------------------------ utilities

export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const smoothstep = (a, b, t) => { const x = clamp((t - a) / (b - a)); return x * x * (3 - 2 * x); };
export const remap = (v, a, b, c, d) => c + ((v - a) / (b - a)) * (d - c);
export const mix = lerp;

/**
 * Height field → tangent-space normal map (RGB, Uint8). Sobel filtered and
 * wrap-sampled so it tiles.
 * @param {Float32Array} height size*size, values in [0,1]
 */
export function heightToNormal(height, size, strength = 2.0, out = null) {
  const rgb = out ?? new Uint8Array(size * size * 4);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv; ny *= inv; nz *= inv;
      const i = (y * size + x) * 4;
      rgb[i] = (nx * 0.5 + 0.5) * 255;
      rgb[i + 1] = (ny * 0.5 + 0.5) * 255;
      rgb[i + 2] = (nz * 0.5 + 0.5) * 255;
      rgb[i + 3] = 255;
    }
  }
  return rgb;
}

/**
 * Ambient-occlusion approximation from a height field: compare each texel against
 * the local neighbourhood average at several radii. Cavities darken, which is what
 * makes panel lines and rivet recesses read as geometry rather than a decal.
 */
export function heightToAO(height, size, { radius = 6, strength = 1 } = {}) {
  const ao = new Float32Array(size * size);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  const taps = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    taps.push([Math.cos(a), Math.sin(a)]);
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const h = at(x, y);
      let occ = 0, n = 0;
      for (let r = 2; r <= radius; r += 2) {
        for (const [ux, uy] of taps) {
          const s = at(Math.round(x + ux * r), Math.round(y + uy * r));
          // Higher neighbours occlude; weight falls off with distance.
          occ += Math.max(0, s - h) / r;
          n++;
        }
      }
      ao[y * size + x] = clamp(1 - (occ / n) * 24 * strength);
    }
  }
  return ao;
}

/** Separable box blur over a Float32 field; two passes approximate a gaussian. */
export function blurField(field, size, radius = 2, passes = 2) {
  let src = field, dst = new Float32Array(size * size);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let s = 0;
        for (let k = -radius; k <= radius; k++) s += src[y * size + ((x + k + size) % size)];
        dst[y * size + x] = s / (radius * 2 + 1);
      }
    }
    [src, dst] = [dst, src];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let s = 0;
        for (let k = -radius; k <= radius; k++) s += src[((y + k + size) % size) * size + x];
        dst[y * size + x] = s / (radius * 2 + 1);
      }
    }
    [src, dst] = [dst, src];
  }
  return src;
}
