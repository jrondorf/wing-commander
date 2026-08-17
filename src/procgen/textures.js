/**
 * Procedural PBR hull texture synthesis.
 *
 * There are no image assets in this project and there never will be, so every
 * texel of every ship is computed here. The goal is not "a noise pattern on grey"
 * — it is the full stack a texture artist would build in Substance:
 *
 *   layout      irregular structural sections, each running its own plating at its
 *               own angle and gauge, plates recursively subdivided (panels.js)
 *   height      bevelled seams, proud/recessed plates, rivet rows following seams,
 *               weld beads, stiffener ribs, access hatches, louvred vents, nozzles
 *   wear        derived from the *cavity/convexity of that height field*, so paint
 *               thins exactly where a real airframe rubs — plate shoulders, rivet
 *               crowns, hatch rims — never scattered at random
 *   grime       broad dirt clouds plus directional streaking that flows down-axis
 *               and pools below vents and behind thruster ports
 *   scorch      soot cones around nozzles and gun muzzles
 *   markings    squadron insignia, hull numbers, stencilled warning blocks and
 *               livery stripes, composited *under* the wear so they fade with it
 *   micro       anisotropic scratches and texel-scale roughness breakup
 *
 * Constant roughness is the number-one tell of cheap CG, so the roughness output
 * is assembled from seven independent bands of structure — per-plate, macro
 * mottle, seam dirt, grime, streaks, wear, micro.
 *
 * Channel packing: AO/roughness/metalness share one RGB texture in the glTF ORM
 * convention (three.js reads aoMap.r, roughnessMap.g, metalnessMap.b), which cuts
 * a full set from ~150 MB of VRAM to ~66 MB.
 */

import * as THREE from 'three';
import { makeRng, hashSeed } from '../core/Rand.js';
import {
  fbm2, valueNoise2, ridged2, cellValue, clamp, smoothstep,
  heightToNormal, heightToAO,
} from './noise.js';
import { paintMarkingLayer } from './decals.js';
import { canvasRGBA, hexToRgb } from './canvasKit.js';
import { buildPanelField } from './panels.js';

// ============================================================ style definitions

/**
 * Palettes follow the art-direction bible: Confederation gunmetal/slate with
 * off-white panels and safety-orange accents; Kilrathi desaturated ochre and
 * oxidised bronze; nothing anywhere near a saturated primary.
 */
export const HULL_STYLES = {
  confed: {
    base: '#4a5560', baseAlt: '#434e59', panel: '#8b959e', panelAlt: '#c8cdd2',
    primer: '#525a51', metal: '#8d949c', metalBright: '#c6ccd2',
    accent: '#c96f2c', grime: '#23282d', soot: '#101113', streak: '#33383c',
    markLight: '#d8dde2', markDark: '#171b21', emissive: '#5ec8ff',
    roughBase: 0.40, roughSpread: 1, clearcoat: 0.24,
    panelScale: 1, macroCells: 4, seamDepth: 1, weld: 0.35, ribs: 0,
    barePlate: 0.045, primerPlate: 0.03, lightPlate: 0.10,
    oxidise: 0.25, organic: 0,
  },
  kilrathi: {
    base: '#7a6540', baseAlt: '#6a5636', panel: '#8a7548', panelAlt: '#4a5340',
    primer: '#5a3a24', metal: '#907f5e', metalBright: '#c0ad84',
    accent: '#b08c33', grime: '#2a2418', soot: '#131009', streak: '#3a3324',
    markLight: '#d9cba4', markDark: '#1d1810', emissive: '#b8ff4a',
    roughBase: 0.52, roughSpread: 1.15, clearcoat: 0.14,
    panelScale: 1.15, macroCells: 4, seamDepth: 1.3, weld: 0.7, ribs: 0.35,
    barePlate: 0.09, primerPlate: 0.06, lightPlate: 0.12,
    oxidise: 0.6, organic: 0.15,
  },
  alien: {
    base: '#2f3a33', baseAlt: '#26302b', panel: '#46503f', panelAlt: '#1d2621',
    primer: '#3a4436', metal: '#6d7a63', metalBright: '#a8b49a',
    accent: '#8ea54a', grime: '#161c18', soot: '#0b0d0b', streak: '#232b24',
    markLight: '#9fb27a', markDark: '#12170f', emissive: '#b8ff4a',
    roughBase: 0.34, roughSpread: 1.3, clearcoat: 0.55,
    panelScale: 1.4, macroCells: 6, seamDepth: 0.7, weld: 0, ribs: 0.8,
    barePlate: 0.05, primerPlate: 0.0, lightPlate: 0.28,
    oxidise: 0.35, organic: 1,
  },
  capital: {
    base: '#545b63', baseAlt: '#4c535b', panel: '#828a92', panelAlt: '#aab2b9',
    primer: '#4e564b', metal: '#868d95', metalBright: '#bcc2c8',
    accent: '#d1742c', grime: '#1f2327', soot: '#0e0f10', streak: '#2e3236',
    markLight: '#ccd2d8', markDark: '#14181d', emissive: '#ffcf9a',
    roughBase: 0.5, roughSpread: 1.1, clearcoat: 0.12,
    panelScale: 2.6, macroCells: 3, seamDepth: 1.6, weld: 1, ribs: 1,
    barePlate: 0.07, primerPlate: 0.08, lightPlate: 0.14,
    oxidise: 0.45, organic: 0,
  },
  civilian: {
    base: '#9aa0a2', baseAlt: '#8b9193', panel: '#b8b3a4', panelAlt: '#cfc7b4',
    primer: '#7a4a34', metal: '#9aa1a6', metalBright: '#cfd4d8',
    accent: '#c94f2c', grime: '#2c2b27', soot: '#15130f', streak: '#3d3b35',
    markLight: '#e6e2d8', markDark: '#22201c', emissive: '#ffd9a0',
    roughBase: 0.48, roughSpread: 0.95, clearcoat: 0.3,
    panelScale: 1.5, macroCells: 4, seamDepth: 0.95, weld: 0.25, ribs: 0.15,
    barePlate: 0.05, primerPlate: 0.1, lightPlate: 0.2,
    oxidise: 0.8, organic: 0,
  },
};

export const HULL_STYLE_IDS = Object.keys(HULL_STYLES);

// =============================================================== small helpers

const LOW = 384;   // low-frequency field resolution, spans the whole texture
const HI = 512;    // high-frequency tile, repeated with per-tile offset + mirror

const fade5 = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Deterministic lattice value from noise.js's cell hash. */
function lattice(xi, yi, seed) {
  return cellValue((((xi * 73856093) ^ (yi * 19349663)) >>> 0), seed);
}

/**
 * Value noise with independent X/Y periods. noise.js only tiles on a single
 * period, and anisotropic detail (scratches, brushed metal, rain streaks) needs
 * to wrap at different rates on each axis or the tile shows.
 */
function anisoValue(x, y, px, py, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const u = fade5(x - xi), v = fade5(y - yi);
  const x0 = ((xi % px) + px) % px, x1 = (x0 + 1) % px;
  const y0 = ((yi % py) + py) % py, y1 = (y0 + 1) % py;
  const a = lattice(x0, y0, seed), b = lattice(x1, y0, seed);
  const c = lattice(x0, y1, seed), d = lattice(x1, y1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function anisoFbm(x, y, px, py, seed, octaves = 4, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * anisoValue(x * f, y * f, px * f, py * f, seed + i * 1013);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

/**
 * Bilinear wrapped fetch from the interleaved low-frequency pack.
 *
 * Hand-unrolled for six channels: this runs twice per texel — 8.4 M times for a
 * 2048² set — and a dynamic-length inner loop costs more than the fetch itself.
 */
function lowFetch(field, u, v, out, o = 0) {
  const fx = u * LOW - 0.5, fy = v * LOW - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const xa = ((x0 % LOW) + LOW) % LOW, xb = xa + 1 === LOW ? 0 : xa + 1;
  const ya = ((y0 % LOW) + LOW) % LOW, yb = ya + 1 === LOW ? 0 : ya + 1;
  const ia = (ya * LOW + xa) * 6, ib = (ya * LOW + xb) * 6;
  const ic = (yb * LOW + xa) * 6, id = (yb * LOW + xb) * 6;
  const w0 = (1 - tx) * (1 - ty), w1 = tx * (1 - ty), w2 = (1 - tx) * ty, w3 = tx * ty;
  out[o] = field[ia] * w0 + field[ib] * w1 + field[ic] * w2 + field[id] * w3;
  out[o + 1] = field[ia + 1] * w0 + field[ib + 1] * w1 + field[ic + 1] * w2 + field[id + 1] * w3;
  out[o + 2] = field[ia + 2] * w0 + field[ib + 2] * w1 + field[ic + 2] * w2 + field[id + 2] * w3;
  out[o + 3] = field[ia + 3] * w0 + field[ib + 3] * w1 + field[ic + 3] * w2 + field[id + 3] * w3;
  out[o + 4] = field[ia + 4] * w0 + field[ib + 4] * w1 + field[ic + 4] * w2 + field[id + 4] * w3;
  out[o + 5] = field[ia + 5] * w0 + field[ib + 5] * w1 + field[ic + 5] * w2 + field[id + 5] * w3;
  return out;
}

/**
 * The low-frequency pack is 384² spanning the whole texture, so at 2048² five
 * output texels share one source texel. Sampling it every fourth texel and
 * lerping across costs a quarter as much and is visually identical.
 */
function fillLowRow(field, v, out, size) {
  const n = (size >> 2) + 2;
  for (let k = 0; k < n; k++) lowFetch(field, (k * 4 + 0.5) / size, v, out, k * 6);
}

function downsample2(src, size) {
  const h = size >> 1;
  const out = new Float32Array(h * h);
  for (let y = 0; y < h; y++) {
    const r0 = (y * 2) * size, r1 = (y * 2 + 1) * size;
    for (let x = 0; x < h; x++) {
      const c = x * 2;
      out[y * h + x] = (src[r0 + c] + src[r0 + c + 1] + src[r1 + c] + src[r1 + c + 1]) * 0.25;
    }
  }
  return out;
}

/**
 * Convexity field: texel height minus the mean of eight neighbours at `radius`.
 * Positive = a proud edge that paint rubs off; negative = a cavity that collects
 * dirt. This is the whole basis of the differential-wear pass.
 */
function computeCavity(h, size, radius) {
  const out = new Float32Array(size * size);
  const r = radius | 0;
  const d = Math.max(1, Math.round(radius * 0.7071));
  const m = size - 1;
  for (let y = 0; y < size; y++) {
    const rowN = ((y - r) & m) * size, rowS = ((y + r) & m) * size;
    const rowNd = ((y - d) & m) * size, rowSd = ((y + d) & m) * size;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const xw = (x - r) & m, xe = (x + r) & m;
      const xwd = (x - d) & m, xed = (x + d) & m;
      const s = h[row + xw] + h[row + xe] + h[rowN + x] + h[rowS + x]
        + h[rowNd + xwd] + h[rowNd + xed] + h[rowSd + xwd] + h[rowSd + xed];
      out[row + x] = h[row + x] - s * 0.125;
    }
  }
  return out;
}

// ============================================================== field builders

/**
 * Low-frequency fields, six channels interleaved so the composite loop pays for
 * one set of bilinear weights instead of six:
 *   0 grime · 1 oxide · 2 mottle · 3 streak · 4 soot · 5 warp
 */
function buildLowFields(seed, style) {
  const n = LOW * LOW;
  const f = new Float32Array(n * 6);
  const inv = 1 / LOW;
  for (let y = 0; y < LOW; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < LOW; x++) {
      const u = (x + 0.5) * inv;
      const i = (y * LOW + x) * 6;
      // Broad dirt clouds: heavy-tailed so most of the hull is clean and a few
      // regions are filthy, rather than a uniform grey haze.
      const g = fbm2(u * 3, v * 3, { octaves: 5, period: 3, seed, basis: valueNoise2 });
      f[i] = clamp(g * 1.35 - 0.18);
      // Oxidation / sun-faded paint: larger, softer, decorrelated from grime.
      f[i + 1] = clamp(fbm2(u * 5, v * 5, { octaves: 4, period: 5, seed: seed + 3121, basis: valueNoise2 }) * 1.5 - 0.25);
      // Paint batch variation — this is what stops big plates reading as one flat fill.
      f[i + 2] = fbm2(u * 8, v * 8, { octaves: 4, period: 8, seed: seed + 6421, basis: valueNoise2 });
      f[i + 3] = 0; // streaks, accumulated below
      f[i + 4] = 0; // soot, stamped from features
      f[i + 5] = fbm2(u * 2, v * 2, { octaves: 3, period: 2, seed: seed + 991, basis: valueNoise2 });
      if (style.organic > 0) {
        // Chitin gets a ridged vein network in the mottle channel.
        const rr = ridged2(u * 6, v * 6, { octaves: 4, period: 6, seed: seed + 77, sharpness: 1.6 });
        f[i + 2] = f[i + 2] * (1 - style.organic) + rr * style.organic;
      }
    }
  }
  return f;
}

/**
 * High-frequency tile, four channels:
 *   0 micro (texel-scale) · 1 fine mottle · 2 anisotropic scratches · 3 speckle
 * Repeated across the texture with a per-tile offset and mirror so the 512² tile
 * never reads as a grid.
 */
function buildHiFields(seed, scratchAngle) {
  const n = HI * HI;
  const f = new Float32Array(n * 4);
  const inv = 1 / HI;
  const ca = Math.cos(scratchAngle), sa = Math.sin(scratchAngle);
  for (let y = 0; y < HI; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < HI; x++) {
      const u = (x + 0.5) * inv;
      const i = (y * HI + x) * 4;
      // Texel-scale breakup. Two octaves only — this must survive mip filtering
      // as *structure*, not average away to a constant like white noise does.
      f[i] = anisoFbm(u * 192, v * 192, 192, 192, seed + 11, 2, 0.55);
      f[i + 1] = anisoFbm(u * 40, v * 40, 40, 40, seed + 29, 4, 0.5);
      // Scratches: noise stretched 40:1 along one axis, ridged into thin lines.
      const rx = (u * ca - v * sa), ry = (u * sa + v * ca);
      const st = anisoFbm(rx * 320, ry * 8, 320, 8, seed + 53, 3, 0.55);
      // Soft-edged so a scratch is a hairline, not a stair-stepped run of texels.
      const line = 1 - smoothstep(0.010, 0.030, Math.abs(st - 0.5));
      f[i + 2] = clamp(line * (0.15 + anisoValue(u * 24, v * 24, 24, 24, seed + 71) * 1.1));
      f[i + 3] = anisoValue(u * 256, v * 256, 256, 256, seed + 97);
    }
  }
  return f;
}

/**
 * Directional streaking by downward accumulation: dirt released at a source runs
 * along +V, spreading and fading. A vertical gradient of noise cannot do this —
 * the give-away of a real streak is that it *starts* somewhere and tapers.
 */
function accumulateStreaks(low, seed, sources, gravity) {
  const rng = makeRng((seed ^ 0x5f3d) >>> 0);
  const seedField = new Float32Array(LOW * LOW);
  // Sparse leak points. Too many and every column streaks, which averages back
  // out to a flat wash — the whole point of a streak is the clean skin beside it.
  for (let i = 0; i < 78; i++) {
    const x = (rng() * LOW) | 0, y = (rng() * LOW) | 0;
    const v = 0.35 + rng() * 0.65;
    // A leak is a short horizontal lip, not a point.
    const w = 1 + ((rng() * 4) | 0);
    for (let k = 0; k < w; k++) {
      const xi = (x + k) % LOW;
      if (v > seedField[y * LOW + xi]) seedField[y * LOW + xi] = v;
    }
  }
  // Feature sources (vents, nozzles, hatch lips) leak much harder.
  for (const s of sources) {
    const cx = (s.u * LOW) | 0, cy = (s.v * LOW) | 0;
    const r = Math.max(1, (s.r * LOW) | 0);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d = Math.hypot(dx, dy) / r;
        if (d > 1) continue;
        const x = ((cx + dx) % LOW + LOW) % LOW, y = ((cy + dy) % LOW + LOW) % LOW;
        const val = s.strength * (1 - d);
        if (val > seedField[y * LOW + x]) seedField[y * LOW + x] = val;
      }
    }
  }

  // Two passes so a streak that runs off the bottom re-enters at the top.
  const acc = new Float32Array(LOW * LOW);
  // Half-life of ~46 rows: a streak runs about an eighth of the hull before it
  // fades out, which is what they do on a real airframe.
  const decay = 0.974 - gravity * 0.003;
  for (let pass = 0; pass < 2; pass++) {
    for (let x = 0; x < LOW; x++) {
      let a = acc[((LOW - 1) * LOW) + x];
      for (let y = 0; y < LOW; y++) {
        const i = y * LOW + x;
        const s = seedField[i];
        a = a * decay;
        if (s > a) a = s;
        if (a > acc[i]) acc[i] = a;
      }
    }
  }
  // Lateral bleed — streaks widen as they run.
  const tmp = new Float32Array(LOW * LOW);
  for (let y = 0; y < LOW; y++) {
    for (let x = 0; x < LOW; x++) {
      const l = acc[y * LOW + ((x - 1 + LOW) % LOW)];
      const r = acc[y * LOW + ((x + 1) % LOW)];
      tmp[y * LOW + x] = acc[y * LOW + x] * 0.6 + (l + r) * 0.2;
    }
  }
  for (let i = 0; i < LOW * LOW; i++) low[i * 6 + 3] = tmp[i];
}

/** Soft radial soot blotches stamped into the low-frequency soot channel. */
function stampSoot(low, blots) {
  for (const b of blots) {
    const cx = b.u * LOW, cy = b.v * LOW;
    const r = Math.max(2, b.r * LOW);
    const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r);
    const y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
    for (let y = y0; y <= y1; y++) {
      const wy = ((y % LOW) + LOW) % LOW;
      for (let x = x0; x <= x1; x++) {
        const wx = ((x % LOW) + LOW) % LOW;
        const dx = (x - cx) / r;
        // Soot plumes trail: squash across the flow axis, stretch along it.
        const dy = (y - cy) / (r * (b.stretch ?? 1));
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > 1) continue;
        const v = b.strength * Math.pow(1 - d, 1.9);
        const i = (wy * LOW + wx) * 6 + 4;
        if (v > low[i]) low[i] = v;
      }
    }
  }
}

// ================================================================ hull features

const SPECIAL_NONE = 0, SPECIAL_HATCH = 1, SPECIAL_VENT = 2,
  SPECIAL_NOZZLE = 3, SPECIAL_RIB = 4, SPECIAL_LIGHT = 5, SPECIAL_GRILLE = 6;

/**
 * Plan the hard-surface features. Positions are normalised UV so a ship builder
 * can later hand us real hardpoint UVs via `opts.ports`; until then they are
 * seeded deterministically.
 */
function planFeatures(rng, style, size, ports) {
  const F = { hatches: [], vents: [], nozzles: [], muzzles: [], ribs: [], lights: [] };
  const S = size / 2048;

  const hatchClusters = style.organic > 0.5 ? 2 : 5;
  for (let c = 0; c < hatchClusters; c++) {
    const cu = rng(), cv = rng();
    const count = rng.int(2, 5);
    for (let i = 0; i < count; i++) {
      const w = (0.030 + rng() * 0.055) * size;
      const h = w * (0.55 + rng() * 0.85);
      F.hatches.push({
        x: (cu + rng.gauss(0, 0.055)) * size,
        y: (cv + rng.gauss(0, 0.055)) * size,
        w, h,
        r: Math.min(w, h) * (rng() < 0.4 ? 0.42 : 0.1),
        bolts: rng() < 0.7,
        recess: (0.6 + rng() * 0.8),
      });
    }
  }

  const ventCount = style.organic > 0.5 ? 2 : 4 + rng.int(0, 2);
  for (let i = 0; i < ventCount; i++) {
    const w = (0.028 + rng() * 0.04) * size;
    const h = (0.016 + rng() * 0.022) * size;
    F.vents.push({
      x: rng() * size, y: rng() * size, w, h,
      slats: rng.int(4, 9),
      vertical: rng() < 0.3,
    });
  }

  const nozzleSpec = ports?.thrusters ?? null;
  const nozzleCount = nozzleSpec ? nozzleSpec.length : (style.panelScale > 2 ? 5 : 3);
  for (let i = 0; i < nozzleCount; i++) {
    const p = nozzleSpec?.[i];
    const r = (p?.r ?? (0.035 + rng() * 0.03)) * size;
    F.nozzles.push({
      x: (p?.u ?? rng()) * size,
      y: (p?.v ?? (0.06 + rng() * 0.25)) * size,
      r, rings: rng.int(2, 4),
    });
  }

  const muzzleSpec = ports?.muzzles ?? null;
  const muzzleCount = muzzleSpec ? muzzleSpec.length : 4;
  for (let i = 0; i < muzzleCount; i++) {
    const p = muzzleSpec?.[i];
    F.muzzles.push({
      x: (p?.u ?? rng()) * size,
      y: (p?.v ?? rng()) * size,
      r: (p?.r ?? (0.008 + rng() * 0.008)) * size,
    });
  }

  if (style.ribs > 0) {
    const ribCount = Math.round(style.ribs * (4 + rng.int(0, 4)));
    for (let i = 0; i < ribCount; i++) {
      const vertical = rng() < 0.5;
      F.ribs.push({
        x: rng() * size, y: rng() * size,
        len: (0.25 + rng() * 0.55) * size,
        w: (2.5 + rng() * 4) * S * (style.panelScale > 2 ? 2.4 : 1),
        vertical,
        bolts: rng() < 0.8,
      });
    }
  }

  const lightCount = style.panelScale > 2 ? 70 : 14;
  for (let i = 0; i < lightCount; i++) {
    F.lights.push({
      x: rng() * size, y: rng() * size,
      r: (style.panelScale > 2 ? 2.5 + rng() * 3 : 2 + rng() * 2.5) * S,
      w: style.panelScale > 2 ? (5 + rng() * 14) * S : 0,
      strength: 0.4 + rng() * 0.6,
    });
  }
  return F;
}

/** Stamp features into the additive height field and the material-id mask. */
function stampFeatures(F, size, hAdd, special, style) {
  const S = size / 2048;
  const m = size - 1;
  const put = (x, y, v, id) => {
    const i = ((y & m) * size) + (x & m);
    hAdd[i] += v;
    if (id !== undefined) special[i] = id;
  };

  // ---- access hatches ------------------------------------------------------
  for (const h of F.hatches) {
    const x0 = Math.floor(h.x - h.w / 2) - 4, x1 = Math.ceil(h.x + h.w / 2) + 4;
    const y0 = Math.floor(h.y - h.h / 2) - 4, y1 = Math.ceil(h.y + h.h / 2) + 4;
    const hw = h.w / 2, hh = h.h / 2;
    const depth = 0.016 * h.recess;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        // Signed distance to a rounded rect: negative inside.
        const dx = Math.abs(x - h.x) - (hw - h.r);
        const dy = Math.abs(y - h.y) - (hh - h.r);
        const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
        const sd = outside + Math.min(Math.max(dx, dy), 0) - h.r;
        if (sd > 3 * S) continue;
        const inside = 1 - smoothstep(-1.6 * S, 0.6 * S, sd);
        const rim = (1 - smoothstep(0, 2.2 * S, Math.abs(sd + 1.2 * S)));
        put(x, y, -depth * inside + 0.006 * rim, inside > 0.5 ? SPECIAL_HATCH : undefined);
      }
    }
    if (h.bolts) {
      const per = Math.max(2, Math.round(h.w / (13 * S)));
      const perV = Math.max(2, Math.round(h.h / (13 * S)));
      const stampBolt = (bx, by) => {
        const r = 2.0 * S;
        for (let y = Math.floor(by - r); y <= by + r; y++) {
          for (let x = Math.floor(bx - r); x <= bx + r; x++) {
            const d = Math.hypot(x - bx, y - by) / r;
            if (d < 1) put(x, y, Math.sqrt(1 - d) * 0.009);
          }
        }
      };
      for (let i = 0; i <= per; i++) {
        const bx = h.x - hw + 3.5 * S + (h.w - 7 * S) * (i / per);
        stampBolt(bx, h.y - hh + 3.5 * S);
        stampBolt(bx, h.y + hh - 3.5 * S);
      }
      for (let i = 1; i < perV; i++) {
        const by = h.y - hh + 3.5 * S + (h.h - 7 * S) * (i / perV);
        stampBolt(h.x - hw + 3.5 * S, by);
        stampBolt(h.x + hw - 3.5 * S, by);
      }
    }
  }

  // ---- louvred vents -------------------------------------------------------
  // A vent is a raised machined housing with a recessed louvre core. Without the
  // housing it reads as a black rectangle stuck on the paint.
  for (const v of F.vents) {
    const hw = v.w / 2, hh = v.h / 2;
    const bez = 4.5 * S;
    const pitch = (v.vertical ? v.w : v.h) / v.slats;
    for (let y = Math.floor(v.y - hh - bez) - 2; y <= v.y + hh + bez + 2; y++) {
      for (let x = Math.floor(v.x - hw - bez) - 2; x <= v.x + hw + bez + 2; x++) {
        const sdOut = Math.max(Math.abs(x - v.x) - (hw + bez), Math.abs(y - v.y) - (hh + bez));
        if (sdOut > 2 * S) continue;
        const sdIn = Math.max(Math.abs(x - v.x) - hw, Math.abs(y - v.y) - hh);
        const inHousing = 1 - smoothstep(-1.2 * S, 0.8 * S, sdOut);
        const inCore = 1 - smoothstep(-1.2 * S, 0.8 * S, sdIn);
        if (inHousing <= 0.02) continue;
        if (inCore > 0.02) {
          const t = (v.vertical ? (x - v.x + hw) : (y - v.y + hh)) / pitch;
          const ft = t - Math.floor(t);
          // Angled slat: deep at the leading edge, rising to the trailing lip.
          const slat = -0.026 + 0.030 * ft * ft;
          put(x, y, (slat - 0.006) * inCore + 0.008 * inHousing,
            inCore > 0.5 ? SPECIAL_GRILLE : undefined);
        } else {
          put(x, y, 0.009 * inHousing);
        }
      }
    }
  }

  // ---- thruster nozzles ----------------------------------------------------
  for (const nz of F.nozzles) {
    const R = nz.r;
    for (let y = Math.floor(nz.y - R) - 2; y <= nz.y + R + 2; y++) {
      for (let x = Math.floor(nz.x - R) - 2; x <= nz.x + R + 2; x++) {
        const d = Math.hypot(x - nz.x, y - nz.y) / R;
        if (d > 1.06) continue;
        // Concentric machined rings falling into a deep throat.
        const rings = Math.cos(d * nz.rings * Math.PI * 2) * 0.004;
        const bowl = -0.05 * Math.pow(clamp(1 - d * 1.15), 1.6);
        const lip = (1 - smoothstep(0, 0.09, Math.abs(d - 0.96))) * 0.012;
        put(x, y, bowl + rings * (d < 0.95 ? 1 : 0) + lip, d < 1.02 ? SPECIAL_NOZZLE : undefined);
      }
    }
  }

  // ---- gun muzzles ---------------------------------------------------------
  for (const mz of F.muzzles) {
    const R = mz.r;
    for (let y = Math.floor(mz.y - R * 2) - 2; y <= mz.y + R * 2 + 2; y++) {
      for (let x = Math.floor(mz.x - R * 2) - 2; x <= mz.x + R * 2 + 2; x++) {
        const d = Math.hypot(x - mz.x, y - mz.y) / R;
        if (d > 2) continue;
        const bore = -0.045 * clamp(1 - d);
        const collar = (1 - smoothstep(0, 0.5, Math.abs(d - 1.45))) * 0.010;
        put(x, y, bore + collar, d < 1.7 ? SPECIAL_NOZZLE : undefined);
      }
    }
  }

  // ---- stiffener ribs ------------------------------------------------------
  for (const rb of F.ribs) {
    const hw = rb.w / 2;
    const nx = rb.vertical ? 0 : 1, ny = rb.vertical ? 1 : 0;
    const steps = Math.ceil(rb.len);
    for (let s = 0; s < steps; s++) {
      const cx = rb.x + nx * s, cy = rb.y + ny * s;
      for (let k = -Math.ceil(hw) - 2; k <= hw + 2; k++) {
        const x = Math.round(cx + ny * k), y = Math.round(cy + nx * k);
        const t = Math.abs(k) / hw;
        if (t > 1.35) continue;
        // Rounded-top extrusion with a shadow gap either side.
        const prof = t <= 1 ? 0.020 * Math.sqrt(1 - t * t) : -0.008 * (1 - smoothstep(1, 1.35, t));
        put(x, y, prof, t < 1 ? SPECIAL_RIB : undefined);
      }
      if (rb.bolts && s % Math.round(22 * S) === 0) {
        const r = 2.0 * S;
        for (let y = Math.floor(cy - r); y <= cy + r; y++) {
          for (let x = Math.floor(cx - r); x <= cx + r; x++) {
            const d = Math.hypot(x - cx, y - cy) / r;
            if (d < 1) put(x, y, Math.sqrt(1 - d) * 0.008);
          }
        }
      }
    }
  }

  // ---- running lights / lit ports ------------------------------------------
  for (const lt of F.lights) {
    const R = Math.max(lt.r, 1);
    const W = lt.w;
    for (let y = Math.floor(lt.y - R) - 2; y <= lt.y + R + 2; y++) {
      for (let x = Math.floor(lt.x - R - W) - 2; x <= lt.x + R + W + 2; x++) {
        const dx = Math.max(0, Math.abs(x - lt.x) - W / 2);
        const d = Math.hypot(dx, y - lt.y) / R;
        if (d > 1.5) continue;
        const rim = (1 - smoothstep(0.85, 1.35, d)) * 0.006;
        put(x, y, -0.004 * clamp(1 - d) + rim, d < 1 ? SPECIAL_LIGHT : undefined);
      }
    }
  }
}

// ================================================================= main builder

function styleOf(style) {
  return HULL_STYLES[style] ?? HULL_STYLES.confed;
}

function resolvePalette(styleDef, palette) {
  if (!palette) return styleDef;
  return { ...styleDef, ...palette };
}

function paletteKey(p) {
  if (!p) return 'def';
  return Object.keys(p).sort().map((k) => `${k}:${p[k]}`).join(',');
}

function insigniaKey(i) {
  if (!i) return 'none';
  if (typeof i === 'string') return i;
  return Object.keys(i).sort().map((k) => `${k}=${i[k]}`).join('|');
}

/**
 * Build the complete PBR set for one hull.
 *
 * @param {object} engine  needs `.registry` and `.maxAnisotropy`
 * @param {object} opts
 * @param {number} [opts.size=2048]
 * @param {number} [opts.seed]
 * @param {'confed'|'kilrathi'|'alien'|'capital'|'civilian'} [opts.style='confed']
 * @param {object} [opts.palette] partial override of the style palette
 * @param {number} [opts.wear=0.5] 0 = factory fresh, 1 = twenty years in a war
 * @param {number} [opts.panelScale=1] >1 = larger plates
 * @param {object|string} [opts.insignia] squadron marking spec
 * @param {object} [opts.ports] optional real hardpoint UVs from the ship builder:
 *        `{ thrusters:[{u,v,r}], muzzles:[{u,v,r}], vents:[{u,v,r}] }`
 * @returns {{map, normalMap, roughnessMap, metalnessMap, aoMap, emissiveMap, heightMap, timings}}
 */
export function generateHullMaterialSet(engine, opts = {}) {
  const {
    size = 2048, seed = 1, style = 'confed', palette = null,
    wear = 0.5, panelScale = 1, insignia = null, ports = null, keepFields = false,
  } = opts;
  const key = `hull/${style}/${size}/s${seed >>> 0}/w${wear.toFixed(3)}/p${panelScale.toFixed(3)}`
    + `/i${insigniaKey(insignia)}/c${paletteKey(palette)}/o${ports ? hashSeed(JSON.stringify(ports)) : 0}`
    + (keepFields ? '/fields' : '');
  const build = () => buildHullSet(engine, { size, seed, style, palette, wear, panelScale, insignia, ports, keepFields });
  return engine?.registry ? engine.registry.get(key, build) : build();
}

function buildHullSet(engine, {
  size, seed, style, palette, wear, panelScale, insignia, ports, keepFields = false,
}) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const mark = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const timings = {};
  const sd = resolvePalette(styleOf(style), palette);
  const iseed = (hashSeed(`hull:${style}:${seed}`) >>> 0) || 1;
  const rng = makeRng(iseed);
  const S = size / 2048;
  const n = size * size;
  const m = size - 1;

  // ---------------------------------------------------------------- layout ---
  let t = mark();
  const layout = buildPanelFieldCached(size, {
    seed: iseed,
    panelScale: panelScale * sd.panelScale,
    macroCells: sd.macroCells,
    treeOpts: {
      maxDepth: 6,
      minEdge: sd.organic > 0.5 ? 0.13 : 0.105,
      rakeChance: sd.organic > 0.5 ? 0.35 : 0.08,
      stopChance: 0.2,
      seamWide: 0.0042 * (sd.panelScale > 2 ? 1.6 : 1),
      seamFine: 0.0018,
    },
  });
  timings.layout = mark() - t;

  // ------------------------------------------------------------- noise fields -
  t = mark();
  const scratchAngle = rng() * Math.PI;
  const low = buildLowFields(iseed, sd);
  const hi = buildHiFields(iseed + 4093, scratchAngle);
  timings.noise = mark() - t;

  // ----------------------------------------------------------------- features -
  t = mark();
  const F = planFeatures(rng, sd, size, ports);
  const hAdd = new Float32Array(n);
  const special = new Uint8Array(n);
  stampFeatures(F, size, hAdd, special, sd);

  // Vents and nozzles leak; that is where every streak on a real hull starts.
  const streakSrc = [];
  for (const v of F.vents) streakSrc.push({ u: v.x / size, v: (v.y + v.h * 0.6) / size, r: v.w / size * 0.7, strength: 0.85 });
  for (const nz of F.nozzles) streakSrc.push({ u: nz.x / size, v: (nz.y + nz.r * 1.1) / size, r: nz.r / size * 0.9, strength: 1 });
  for (const h of F.hatches) if (rng() < 0.4) streakSrc.push({ u: h.x / size, v: (h.y + h.h * 0.6) / size, r: h.w / size * 0.35, strength: 0.5 });
  accumulateStreaks(low, iseed, streakSrc, 1);

  const blots = [];
  for (const nz of F.nozzles) blots.push({ u: nz.x / size, v: (nz.y + nz.r * 0.35) / size, r: nz.r / size * 2.0, strength: 1, stretch: 1.8 });
  for (const mz of F.muzzles) blots.push({ u: mz.x / size, v: mz.y / size, r: mz.r / size * 5, strength: 0.9, stretch: 1.5 });
  stampSoot(low, blots);
  timings.features = mark() - t;

  // ------------------------------------------------------------------ height -
  t = mark();
  const height = new Float32Array(n);
  const { panel, macro, seam, seamAmp, rivet, edgePx, along } = layout;
  const rivetH = 0.020 * (layout.rivetHeightScale ?? 1);

  // Per-plate attributes. One table lookup beats a hash per texel.
  const PC = 65536;
  const pTone = new Float32Array(PC);
  const pRough = new Float32Array(PC);
  const pKind = new Uint8Array(PC);
  const pStep = new Float32Array(PC);
  const pRand = new Float32Array(PC);
  for (let i = 0; i < PC; i++) {
    pTone[i] = (cellValue(i, iseed + 17) - 0.5) * 2;
    pRough[i] = (cellValue(i, iseed + 41) - 0.5) * 2;
    pRand[i] = cellValue(i, iseed + 89);
    // Plates sit at slightly different heights — shimming and manufacturing
    // tolerance. A perfectly flush hull is a rendering, not a machine.
    pStep[i] = (cellValue(i, iseed + 137) - 0.42) * 0.011;
    pKind[i] = cellValue(i, iseed + 5) < 0.5 ? 0 : 5;
  }
  // Second pass: classify with the owning section's bias folded in. `panel`
  // encodes `section * maxLeaves + leaf + tile * nCells * maxLeaves`, so the
  // section index falls straight out of the index.
  const maxLeaves = layout.maxLeaves;
  const nSections = layout.macroCount;
  const bare = sd.barePlate, prim = sd.primerPlate, lite = sd.lightPlate;

  const mTone = new Float32Array(256);
  const mStep = new Float32Array(256);
  // Some structural sections are predominantly light — a white nose cone, a
  // pale control surface. Scattering light plates uniformly instead produces a
  // quilt, which is the fastest way to make a hull look procedurally generated.
  // Must be built before the classification pass below, which biases by section.
  const mLight = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    mTone[i] = (cellValue(i, iseed + 271) - 0.5) * 2;
    mStep[i] = (cellValue(i, iseed + 311) - 0.5) * 0.010;
    const q = cellValue(i, iseed + 353);
    mLight[i] = q > 0.78 ? 0.45 : q > 0.6 ? 0.12 : -0.1;
  }

  for (let i = 0; i < PC; i++) {
    const sec = ((i / maxLeaves) | 0) % nSections;
    const c = pRand[i] - mLight[sec] * 0.55;
    if (c < bare) pKind[i] = 3;
    else if (c < bare + prim) pKind[i] = 2;
    else if (c < bare + prim + lite * (1 + mLight[sec] * 2.6)) pKind[i] = 1;
    else if (c > 0.955 - mLight[sec] * 0.35) pKind[i] = 4;
  }

  const hiTiles = Math.max(1, size / HI) | 0;
  const hiShift = Math.log2(HI) | 0;
  const hiMask = HI - 1;
  const tileCount = Math.max(1, hiTiles * hiTiles);
  const hoffX = new Int32Array(tileCount), hoffY = new Int32Array(tileCount), hflip = new Uint8Array(tileCount);
  for (let i = 0; i < tileCount; i++) {
    hoffX[i] = (cellValue(i, iseed + 601) * HI) | 0;
    hoffY[i] = (cellValue(i, iseed + 631) * HI) | 0;
    hflip[i] = (cellValue(i, iseed + 661) * 4) | 0;
  }
  const tileMask = hiTiles - 1;
  const hiAt = (x, y) => {
    const ti = ((y >> hiShift) & tileMask) * hiTiles + ((x >> hiShift) & tileMask);
    let xm = (x + hoffX[ti]) & hiMask;
    let ym = (y + hoffY[ti]) & hiMask;
    if (hflip[ti] & 1) xm = hiMask - xm;
    if (hflip[ti] & 2) ym = hiMask - ym;
    return (ym * HI + xm) * 4;
  };

  const lowBuf = new Float32Array(6);
  const lowRow = new Float32Array(((size >> 2) + 2) * 6);
  const seamDepth = 0.030 * sd.seamDepth;
  const invSize = 1 / size;
  const weldAmt = sd.weld;

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) * invSize;
    fillLowRow(low, v, lowRow, size);
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const b0 = (x >> 2) * 6, fr = (x & 3) * 0.25;
      const lWarp = lowRow[b0 + 5] + (lowRow[b0 + 11] - lowRow[b0 + 5]) * fr;
      const lMot = lowRow[b0 + 2] + (lowRow[b0 + 8] - lowRow[b0 + 2]) * fr;
      const hoff = hiAt(x, y);

      const amp = seamAmp[i] / 255;
      const sm = seam[i];
      const p = panel[i];

      let h = 0.5;
      h += mStep[macro[i]];
      // Plate step fades out into the seam so the edge reads as a chamfered lip.
      h += pStep[p] * smoothstep(0.0, 6 * S, edgePx[i]);
      h -= sm * seamDepth * (0.35 + 0.65 * amp);
      h += rivet[i] * rivetH;

      // Weld bead: a raised, rippled bead sitting in the structural seams. Only
      // on hulls that are welded rather than fastened.
      if (weldAmt > 0 && amp > 0.93 && sm > 0.25) {
        const ripple = 0.5 + 0.5 * Math.sin(along[i] * (0.9 / S));
        h += weldAmt * sm * (0.012 + 0.008 * ripple);
      }

      h += hAdd[i];
      // Skin between the frames is never dead flat.
      h += (lWarp - 0.5) * 0.014 + (lMot - 0.5) * 0.006;
      // Orange peel and oil-canning. Without this the skin between panel lines
      // is a mathematically flat plane and reads as plastic.
      h += (hi[hoff + 1] - 0.5) * 0.0042;
      h += (hi[hoff] - 0.5) * 0.0011;
      h -= hi[hoff + 2] * 0.0016;
      height[i] = h;
    }
  }
  timings.height = mark() - t;

  // ----------------------------------------------------------- derived fields -
  t = mark();
  const cavity = computeCavity(height, size, Math.max(2, Math.round(3 * S)));
  // Normalise convexity against its own RMS so wear thresholds hold regardless of
  // how much height amplitude a given style ends up with.
  let acc = 0, cnt = 0;
  for (let i = 0; i < n; i += 37) { acc += cavity[i] * cavity[i]; cnt++; }
  const cavScale = 1 / Math.max(1e-5, Math.sqrt(acc / cnt) * 2.6);

  // AO at quarter resolution — it is a low-frequency term, and the crisp contact
  // darkening in seams is added analytically at full res below.
  let aoSrc = height;
  let aoSize = size;
  while (aoSize > 512) { aoSrc = downsample2(aoSrc, aoSize); aoSize >>= 1; }
  const aoLow = heightToAO(aoSrc, aoSize, { radius: 6, strength: 1.15 });
  timings.derived = mark() - t;

  // -------------------------------------------------------------- markings ----
  t = mark();
  const markCanvas = paintMarkingLayer(size, {
    seed: iseed, style, palette: sd, insignia, wear,
  });
  const mark4 = canvasRGBA(markCanvas);
  timings.markings = mark() - t;

  // ------------------------------------------------------------- composition --
  t = mark();
  const albedo = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);

  const cBase = hexToRgb(sd.base), cBaseAlt = hexToRgb(sd.baseAlt);
  const cPanel = hexToRgb(sd.panel), cPanelAlt = hexToRgb(sd.panelAlt);
  const cPrimer = hexToRgb(sd.primer);
  const cMetal = hexToRgb(sd.metal), cMetalBright = hexToRgb(sd.metalBright);
  const cGrime = hexToRgb(sd.grime), cSoot = hexToRgb(sd.soot), cStreak = hexToRgb(sd.streak);
  const cAccent = hexToRgb(sd.accent);

  const roughBase = sd.roughBase;
  const rs = sd.roughSpread;
  const wearK = wear;
  const aoInv = 1 / aoSize;

  composePass({
    size, S, low, hi, hiTiles, hiShift, hiMask, tileMask, hoffX, hoffY, hflip,
    panel, macro, seam, seamAmp, rivet, edgePx, special, hAdd, cavity, cavScale,
    mark4, aoLow, aoSize, pKind, pTone, pRough, mTone, albedo, orm,
    cBase, cBaseAlt, cPanel, cPanelAlt, cPrimer, cMetal, cMetalBright,
    cGrime, cSoot, cStreak, cAccent,
    roughBase, rs, wearK, oxidise: sd.oxidise,
  });
  timings.compose = mark() - t;

  // ---------------------------------------------------------------- normals ---
  t = mark();
  const normal = heightToNormal(height, size, 4.6 * Math.max(0.3, S));
  timings.normal = mark() - t;

  // --------------------------------------------------------------- emissive ---
  t = mark();
  const eSize = Math.max(128, size >> 2);
  const emissive = new Uint8Array(eSize * eSize * 4);
  const eScale = eSize / size;
  const cEm = hexToRgb(sd.emissive);
  for (const lt of F.lights) {
    const ex = lt.x * eScale, ey = lt.y * eScale;
    const er = Math.max(1.2, lt.r * eScale * 1.5);
    const ew = lt.w * eScale;
    const bright = lt.strength;
    for (let y = Math.floor(ey - er * 2.5); y <= ey + er * 2.5; y++) {
      for (let x = Math.floor(ex - ew / 2 - er * 2.5); x <= ex + ew / 2 + er * 2.5; x++) {
        const dx = Math.max(0, Math.abs(x - ex) - ew / 2);
        const d = Math.hypot(dx, y - ey) / er;
        if (d > 2.5) continue;
        const core = clamp(1 - d) ** 1.5;
        const halo = Math.exp(-d * d * 0.9) * 0.35;
        const val = (core + halo) * bright;
        const idx = ((((y % eSize) + eSize) % eSize) * eSize + (((x % eSize) + eSize) % eSize)) * 4;
        const add = (c, o) => { const nv = emissive[idx + o] + c * val; emissive[idx + o] = nv > 255 ? 255 : nv; };
        add(cEm[0], 0); add(cEm[1], 1); add(cEm[2], 2);
        emissive[idx + 3] = 255;
      }
    }
  }
  for (let i = 3; i < emissive.length; i += 4) emissive[i] = 255;
  timings.emissive = mark() - t;

  // ----------------------------------------------------------------- height ---
  const hSize = Math.max(256, size >> 1);
  let hs = height, hsSize = size;
  while (hsSize > hSize) { hs = downsample2(hs, hsSize); hsSize >>= 1; }
  const heightBytes = new Uint8Array(hsSize * hsSize);
  for (let i = 0; i < heightBytes.length; i++) {
    const v = (hs[i] - 0.5) * 3 + 0.5;
    heightBytes[i] = v < 0 ? 0 : v > 1 ? 255 : v * 255;
  }

  // ---------------------------------------------------------------- textures --
  const aniso = engine?.maxAnisotropy ?? 8;
  const mapTex = makeTexture(albedo, size, THREE.RGBAFormat, THREE.SRGBColorSpace, aniso);
  const normalTex = makeTexture(normal, size, THREE.RGBAFormat, THREE.NoColorSpace, aniso);
  const ormTex = makeTexture(orm, size, THREE.RGBAFormat, THREE.NoColorSpace, aniso);
  const emissiveTex = makeTexture(emissive, eSize, THREE.RGBAFormat, THREE.SRGBColorSpace, aniso);
  const heightTex = makeTexture(heightBytes, hsSize, THREE.RedFormat, THREE.NoColorSpace, 1);

  timings.total = mark() - t0;

  const set = {
    map: mapTex,
    normalMap: normalTex,
    roughnessMap: ormTex,
    metalnessMap: ormTex,
    aoMap: ormTex,
    emissiveMap: emissiveTex,
    heightMap: heightTex,
    ormMap: ormTex,
    style: sd,
    timings,
    /**
     * Raw fields, for the preview harness. Off by default — three 16 MB typed
     * arrays retained in the registry for every hull is not a debug convenience,
     * it is a leak.
     */
    debug: keepFields
      ? { size, features: F, albedo, normal, orm, height, heightBytes, emissive, hSize: hsSize, eSize, layout, cavity, low, hi, LOW, HI }
      : { size, features: F },
    /** Registry.dispose() finds this and frees all five GPU allocations. */
    dispose() {
      mapTex.dispose(); normalTex.dispose(); ormTex.dispose();
      emissiveTex.dispose(); heightTex.dispose();
    },
  };
  return set;
}


/**
 * The composite pass — albedo and packed ORM, one texel at a time.
 *
 * Lifted out of `buildHullSet` on purpose. Inlined there it made that function
 * large enough that V8 gave up optimising it and the pass ran 2–3× slower; as a
 * standalone function with a single monomorphic argument shape it stays hot.
 */
function composePass(P) {
  const {
    size, S, low, hi, hiTiles, hiShift, hiMask, tileMask, hoffX, hoffY, hflip,
    panel, macro, seam, seamAmp, rivet, edgePx, special, hAdd, cavity, cavScale,
    mark4, aoLow, aoSize, pKind, pTone, pRough, mTone, albedo, orm,
    cBase, cBaseAlt, cPanel, cPanelAlt, cPrimer, cMetal, cMetalBright,
    cGrime, cSoot, cStreak, cAccent, roughBase, rs, wearK, oxidise,
  } = P;
  const invSize = 1 / size;
  const m = size - 1;
  const lowRow = new Float32Array(((size >> 2) + 2) * 6);
  const hiAt = (x, y) => {
    const ti = ((y >> hiShift) & tileMask) * hiTiles + ((x >> hiShift) & tileMask);
    let xm = (x + hoffX[ti]) & hiMask;
    let ym = (y + hoffY[ti]) & hiMask;
    if (hflip[ti] & 1) xm = hiMask - xm;
    if (hflip[ti] & 2) ym = hiMask - ym;
    return (ym * HI + xm) * 4;
  };

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) * invSize;
    fillLowRow(low, v, lowRow, size);
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = (x + 0.5) * invSize;
      const b0 = (x >> 2) * 6, fr = (x & 3) * 0.25;
      const grime0 = lowRow[b0] + (lowRow[b0 + 6] - lowRow[b0]) * fr;
      const oxide = lowRow[b0 + 1] + (lowRow[b0 + 7] - lowRow[b0 + 1]) * fr;
      const mottle = lowRow[b0 + 2] + (lowRow[b0 + 8] - lowRow[b0 + 2]) * fr;
      const streak = lowRow[b0 + 3] + (lowRow[b0 + 9] - lowRow[b0 + 3]) * fr;
      const soot = lowRow[b0 + 4] + (lowRow[b0 + 10] - lowRow[b0 + 4]) * fr;
      const hoff = hiAt(x, y);
      const micro = hi[hoff], fine = hi[hoff + 1], scratch = hi[hoff + 2], speck = hi[hoff + 3];

      const p = panel[i];
      const kind = pKind[p];
      const tone = pTone[p];
      const sm = seam[i];
      const eP = edgePx[i];
      const sp = special[i];
      const riv = rivet[i];

      // ---- base paint -----------------------------------------------------
      let r, g, b;
      if (kind === 1) { r = cPanel[0]; g = cPanel[1]; b = cPanel[2]; }
      else if (kind === 4) { r = cPanelAlt[0]; g = cPanelAlt[1]; b = cPanelAlt[2]; }
      else if (kind === 2) { r = cPrimer[0]; g = cPrimer[1]; b = cPrimer[2]; }
      else if (kind === 3) { r = cMetal[0]; g = cMetal[1]; b = cMetal[2]; }
      else if (kind === 5) { r = cBaseAlt[0]; g = cBaseAlt[1]; b = cBaseAlt[2]; }
      else { r = cBase[0]; g = cBase[1]; b = cBase[2]; }

      // Per-plate paint batch, macro section tint, and broad mottling.
      const toneK = 1 + tone * 0.055 + mTone[macro[i]] * 0.022
        + (mottle - 0.5) * 0.13 + (fine - 0.5) * 0.06;
      r *= toneK; g *= toneK; b *= toneK;

      // ---- hard-surface substrate ------------------------------------------
      // Applied before weathering so soot and grime land *on* the nozzles and
      // grilles rather than being painted over by them.
      if (sp !== SPECIAL_NONE) {
        if (sp === SPECIAL_NOZZLE) {
          const k = 0.8;
          r += (cMetal[0] * 0.78 - r) * k; g += (cMetal[1] * 0.78 - g) * k; b += (cMetal[2] * 0.84 - b) * k;
        } else if (sp === SPECIAL_GRILLE) {
          // Slat crowns catch light; the gaps between them go black.
          const lit = clamp((hAdd[i] + 0.024) * 42);
          const k = 0.30 + 0.62 * lit;
          r = r * k + cMetal[0] * 0.12 * lit;
          g = g * k + cMetal[1] * 0.12 * lit;
          b = b * k + cMetal[2] * 0.13 * lit;
        } else if (sp === SPECIAL_RIB) {
          r *= 1.04; g *= 1.04; b *= 1.05;
        }
      }

      // ---- markings, painted on before anything weathers them --------------
      // Canvas rows run top-down, DataTexture V runs bottom-up.
      const mo = ((m - y) * size + x) * 4;
      const ma = sp === SPECIAL_NONE || sp === SPECIAL_HATCH ? mark4[mo + 3] / 255 : 0;
      if (ma > 0.004) {
        const k = ma * 0.78;
        r += (mark4[mo] - r) * k;
        g += (mark4[mo + 1] - g) * k;
        b += (mark4[mo + 2] - b) * k;
      }

      // ---- differential wear, derived from the height field ----------------
      // Convex geometry loses paint: plate shoulders, rivet crowns, hatch rims.
      const conv = cavity[i] * cavScale;
      const edgeProx = 1 - smoothstep(1.0 * S, 9 * S, eP);
      // Patchy, but averaging ~1 — wear that is uniformly scaled down just reads
      // as a slightly different shade of paint.
      // High-contrast patchiness: continuous edge wear reads as a cartoon
      // outline, patchy edge wear reads as an airframe.
      const patch = 0.12 + 2.0 * clamp(oxide * 0.9 + grime0 * 0.5 + (fine - 0.5) * 1.1 - 0.05);
      let wearM = smoothstep(0.24, 1.05, conv) * (0.3 + 1.3 * edgeProx);
      wearM += riv * 0.8 * (0.4 + 0.6 * edgeProx);
      wearM = clamp(wearM * wearK * 1.55 * patch);
      // Scratches cut straight through to metal.
      const scr = scratch * clamp(0.3 + wearK * 1.35) * (0.5 + 0.5 * edgeProx);

      // Stage one: the paint does not vanish, it thins — the pigment lifts and
      // goes chalky well before any substrate shows.
      const chalk = clamp(wearM * 1.7);
      r = r * (1 + 0.09 * chalk) + 9 * chalk;
      g = g * (1 + 0.09 * chalk) + 9 * chalk;
      b = b * (1 + 0.08 * chalk) + 8 * chalk;
      // Stage two: only where it is truly rubbed through does alloy appear.
      const wr = clamp((wearM - 0.3) * 1.9 + scr * 0.7);
      r += (cMetal[0] - r) * wr;
      g += (cMetal[1] - g) * wr;
      b += (cMetal[2] - b) * wr;
      if (scr > 0.02) {
        const sk = scr * 0.5;
        r += (cMetalBright[0] - r) * sk;
        g += (cMetalBright[1] - g) * sk;
        b += (cMetalBright[2] - b) * sk;
      }

      // ---- oxidation on exposed metal --------------------------------------
      if (oxidise > 0) {
        const ox = clamp(oxide * 1.3 - 0.25) * oxidise * (0.25 + 0.75 * wr);
        r += (cGrime[0] * 1.9 - r) * ox * 0.5;
        g += (cGrime[1] * 1.5 - g) * ox * 0.5;
        b += (cGrime[2] * 1.1 - b) * ox * 0.5;
      }

      // ---- seams, grime, streaks ------------------------------------------
      const seamDirt = sm * (0.55 + 0.45 * grime0);
      const grimeAmt = clamp(grime0 * 0.95 + seamDirt * 0.5 + speck * 0.06)
        * (0.25 + 0.85 * wearK);
      const gk = grimeAmt * 0.62;
      r += (cGrime[0] - r) * gk;
      g += (cGrime[1] - g) * gk;
      b += (cGrime[2] - b) * gk;

      const streakAmt = clamp(streak * (0.65 + 0.85 * fine) - 0.04) * (0.35 + 0.85 * wearK);
      const sk2 = streakAmt * 0.62;
      r += (cStreak[0] - r) * sk2;
      g += (cStreak[1] - g) * sk2;
      b += (cStreak[2] - b) * sk2;

      // ---- scorching -------------------------------------------------------
      // Break the radial falloff with fine noise — a scorch mark has grain, an
      // airbrushed gradient does not.
      const sootAmt = clamp(soot * (0.45 + 0.75 * fine + 0.35 * speck) * (0.7 + 0.5 * grime0));
      if (sootAmt > 0.002) {
        const k = sootAmt * 0.92;
        r += (cSoot[0] - r) * k;
        g += (cSoot[1] - g) * k;
        b += (cSoot[2] - b) * k;
      }

      // Lens housings stay clean — they get wiped between sorties.
      if (sp === SPECIAL_LIGHT) {
        r += (cAccent[0] - r) * 0.45; g += (cAccent[1] - g) * 0.45; b += (cAccent[2] - b) * 0.45;
      }

      // Rivet crowns catch light, their recesses hold dirt.
      const rk = riv * 0.10;
      r *= 1 + rk; g *= 1 + rk; b *= 1 + rk;
      // Seam line itself is a dark scribe.
      const sdark = 1 - sm * 0.26 * (0.55 + 0.45 * (seamAmp[i] / 255));
      r *= sdark; g *= sdark; b *= sdark;

      const ao4 = i * 4;
      albedo[ao4] = r < 0 ? 0 : r > 255 ? 255 : r;
      albedo[ao4 + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      albedo[ao4 + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      albedo[ao4 + 3] = 255;

      // ---- roughness: structure at every scale ------------------------------
      let rough = roughBase;
      rough += pRough[p] * 0.055 * rs;              // per-plate paint batch
      rough += (mottle - 0.5) * 0.10 * rs;          // broad sheen variation
      rough += (fine - 0.5) * 0.085 * rs;           // orange peel
      rough += (micro - 0.5) * 0.055 * rs;          // texel-scale breakup
      rough += (speck - 0.5) * 0.03;
      rough += seamDirt * 0.14;                     // dirt packed into seams
      rough += grimeAmt * 0.20;
      rough += streakAmt * 0.16;
      rough += sootAmt * 0.42;
      rough -= wearM * 0.16;                        // rubbed-bare metal is smoother
      rough -= scr * 0.30;                          // a fresh scratch is bright
      rough += clamp(oxide * 1.2 - 0.3) * oxidise * 0.18;
      if (kind === 3) rough -= 0.09;
      if (kind === 2) rough += 0.16;                // primer is dead matte
      if (sp === SPECIAL_NOZZLE) rough += 0.18;
      if (sp === SPECIAL_GRILLE) rough += 0.22;
      if (sp === SPECIAL_LIGHT) rough -= 0.28;
      rough = rough < 0.05 ? 0.05 : rough > 0.99 ? 0.99 : rough;

      // ---- metalness --------------------------------------------------------
      let met = kind === 3 ? 0.92 : 0.04;
      const wm = wearM * 0.85 + scr * 0.8;
      if (wm > met) met = wm > 0.95 ? 0.95 : wm;
      if (sp === SPECIAL_NOZZLE) met = 0.95;
      if (sp === SPECIAL_GRILLE) met = 0.8;
      met *= 1 - sootAmt * 0.75;
      met *= 1 - grimeAmt * 0.35;

      // ---- ambient occlusion ------------------------------------------------
      const ax = u * aoSize - 0.5, ay = v * aoSize - 0.5;
      const ax0 = Math.floor(ax), ay0 = Math.floor(ay);
      const atx = ax - ax0, aty = ay - ay0;
      const axa = ((ax0 % aoSize) + aoSize) % aoSize, axb = (axa + 1) % aoSize;
      const aya = ((ay0 % aoSize) + aoSize) % aoSize, ayb = (aya + 1) % aoSize;
      const a00 = aoLow[aya * aoSize + axa], a10 = aoLow[aya * aoSize + axb];
      const a01 = aoLow[ayb * aoSize + axa], a11 = aoLow[ayb * aoSize + axb];
      let ao = a00 + (a10 - a00) * atx + (a01 - a00) * aty + (a00 - a10 - a01 + a11) * atx * aty;
      // Crisp contact darkening that a quarter-res AO pass cannot resolve.
      ao *= 1 - sm * 0.5 * (0.4 + 0.6 * (seamAmp[i] / 255));
      ao *= 1 - clamp(-conv * 0.45);
      if (sp === SPECIAL_GRILLE) ao *= 0.55;
      if (sp === SPECIAL_NOZZLE) ao *= 0.7;
      ao = ao < 0 ? 0 : ao > 1 ? 1 : ao;

      orm[ao4] = ao * 255;
      orm[ao4 + 1] = rough * 255;
      orm[ao4 + 2] = met * 255;
      orm[ao4 + 3] = 255;
    }
  }
}

function makeTexture(data, size, format, colorSpace, aniso) {
  const tex = new THREE.DataTexture(data, size, size, format, THREE.UnsignedByteType);
  tex.colorSpace = colorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = aniso;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.channel = 0;
  tex.needsUpdate = true;
  return tex;
}

// The layout pass is by far the most expensive stage and is identical for any two
// hulls that share seed/scale/style, so it gets its own module-level memo. Keeps
// a squadron of eight fighters from paying for it eight times even when their
// palettes differ.
const _layoutCache = new Map();
function buildPanelFieldCached(size, opts) {
  const k = `${size}/${opts.seed}/${opts.panelScale}/${opts.macroCells}/${JSON.stringify(opts.treeOpts)}`;
  let hit = _layoutCache.get(k);
  if (!hit) {
    hit = buildPanelField(size, opts);
    if (_layoutCache.size > 6) _layoutCache.delete(_layoutCache.keys().next().value);
    _layoutCache.set(k, hit);
  }
  return hit;
}

export { buildPanelField };
