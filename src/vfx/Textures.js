/**
 * Procedural texture synthesis for VFX.
 *
 * Everything here is generated from noise at runtime (ARCHITECTURE §1.1) and cached
 * in `engine.registry` (§1.4) — a puff atlas costs ~200 ms to synthesise and must be
 * built exactly once per session.
 *
 * Colour discipline (§1.7): every texture on this page is *data*, not albedo. The
 * puff atlas packs density/detail/thickness, the ramp stores already-linearised
 * blackbody chroma. All of them are `NoColorSpace` so three does no sRGB decode.
 */

import * as THREE from 'three';
import { fbm2, billow2, worley2, valueNoise2, perlin2, clamp, smoothstep } from '../procgen/noise.js';

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

function dataTex(data, w, h, { filter = THREE.LinearFilter, wrap = THREE.ClampToEdgeWrapping, mips = false } = {}) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.NoColorSpace;
  t.magFilter = filter;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : filter;
  t.wrapS = wrap;
  t.wrapT = wrap;
  t.generateMipmaps = mips;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------
// Puff atlas — the shape library every smoke/fireball sprite draws from.
//
// 2x2 tiles of 256², four genuinely different billowing masses. A single blob
// texture is the fastest way to get the "obvious camera-facing disc" failure of
// §7; four eroded, cauliflower-lobed masses rotated and warped per particle are
// what break the repeat.
//
//   .r  density   — the alpha mask, eroded by a worley ridge so the silhouette
//                   has real lobes rather than a gaussian falloff
//   .g  detail    — high-frequency grain, used to dissolve the puff as it cools
//   .b  thickness — a smooth height field; its gradient drives the fake normal
//                   that makes each sprite shade like a lit volume
//   .a  = .r
// ---------------------------------------------------------------------------
export function getPuffAtlas(engine, { size = 512, seed = 4711 } = {}) {
  const key = `vfx/puffAtlas/${size}/${seed}`;
  return engine.registry.get(key, () => {
    const tile = size >> 1;
    const data = new Uint8Array(size * size * 4);
    const inv = 1 / tile;

    for (let ti = 0; ti < 4; ti++) {
      const ox = (ti & 1) * tile;
      const oy = (ti >> 1) * tile;
      const s = seed + ti * 977;
      // Each tile gets its own scale/erosion character so the four masses do not
      // read as one shape at four rotations.
      const freq = 3.4 + ti * 0.85;
      const warpAmt = 0.55 + ti * 0.16;
      const erode = 0.13 + ti * 0.05;

      for (let y = 0; y < tile; y++) {
        for (let x = 0; x < tile; x++) {
          const u = (x + 0.5) * inv;
          const v = (y + 0.5) * inv;
          const cx = u * 2 - 1;
          const cy = v * 2 - 1;
          const d = Math.sqrt(cx * cx + cy * cy);

          // Domain warp first — this is what turns concentric noise into
          // convecting, folded gas.
          const wx = fbm2(u * 2.6, v * 2.6, { seed: s, octaves: 3 });
          const wy = fbm2(u * 2.6 + 5.3, v * 2.6 - 2.1, { seed: s + 7, octaves: 3 });
          const fx = u * freq + wx * warpAmt;
          const fy = v * freq + wy * warpAmt;

          const bill = billow2(fx, fy, { seed: s + 31, octaves: 4 });
          const w = worley2(fx * 1.55, fy * 1.55, { seed: s + 53, jitter: 0.92 });
          // f2-f1 is ~0 on a cell boundary: subtracting it carves the creases
          // between lobes, which is what makes a fireball look like cauliflower.
          const crease = clamp(1 - (w.f2 - w.f1) * 2.4);

          const base = smoothstep(1.02, 0.1, d);
          let dens = base * (0.3 + 1.15 * bill) - crease * erode * base;
          dens = clamp(dens * 1.3);
          // Guarantee a clean transparent border so mip chains never bleed
          // between atlas tiles.
          dens *= smoothstep(1.0, 0.86, d);

          const thick = clamp(base * (0.5 + 0.65 * bill));
          const detail = clamp(fbm2(fx * 3.3, fy * 3.3, { seed: s + 91, octaves: 3 }) * 0.5 + 0.5);

          const i = ((oy + y) * size + (ox + x)) * 4;
          data[i] = dens * 255;
          data[i + 1] = detail * 255;
          data[i + 2] = thick * 255;
          data[i + 3] = dens * 255;
        }
      }
    }
    return dataTex(data, size, size, { mips: true });
  });
}

// ---------------------------------------------------------------------------
// Tiling noise — per-particle UV warping, heat shimmer, beam scroll.
// Four independent octaves in four channels so a shader can build a cheap
// multi-scale field from one fetch.
// ---------------------------------------------------------------------------
export function getNoiseTexture(engine, { size = 128, seed = 9001 } = {}) {
  const key = `vfx/noise/${size}/${seed}`;
  return engine.registry.get(key, () => {
    const data = new Uint8Array(size * size * 4);
    const inv = 1 / size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = (x + 0.5) * inv;
        const v = (y + 0.5) * inv;
        const i = (y * size + x) * 4;
        data[i] = valueNoise2(u * 4, v * 4, seed, 4) * 255;
        data[i + 1] = valueNoise2(u * 9, v * 9, seed + 17, 9) * 255;
        data[i + 2] = (perlin2(u * 6, v * 6, seed + 43, 6) * 0.5 + 0.5) * 255;
        data[i + 3] = valueNoise2(u * 17, v * 17, seed + 71, 17) * 255;
      }
    }
    return dataTex(data, size, size, { wrap: THREE.RepeatWrapping, mips: true });
  });
}

// ---------------------------------------------------------------------------
// Blackbody ramp.
//
// Temperature 0..1 maps to 800 K .. 8000 K through a Planck approximation, so the
// cooling ramp is white → yellow → orange → deep red → black by physics rather
// than by an artist's guess. Stored *linear* (§1.7) and normalised to unit peak;
// the shader supplies the HDR magnitude, which is what blooms.
// ---------------------------------------------------------------------------
function blackbodyRGB(kelvin) {
  const t = kelvin / 100;
  let r, g, b;
  if (t <= 66) r = 255;
  else r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
  if (t <= 66) g = 99.4708025861 * Math.log(t) - 161.1195681661;
  else g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [clamp(r / 255), clamp(g / 255), clamp(b / 255)];
}

export function getBlackbodyRamp(engine, { size = 256 } = {}) {
  return engine.registry.get(`vfx/ramp/blackbody/${size}`, () => {
    const data = new Uint8Array(size * 4);
    for (let i = 0; i < size; i++) {
      const u = i / (size - 1);
      const k = 800 + Math.pow(u, 1.3) * 7200;
      const srgb = blackbodyRGB(k);
      let lin = srgb.map(srgbToLinear);
      const peak = Math.max(lin[0], lin[1], lin[2], 1e-4);
      lin = lin.map((c) => c / peak);
      // Below ~0.12 the gas is no longer radiating usefully; slide the chroma
      // toward cold soot so the tail of the ramp is smoke, not dark orange.
      const soot = smoothstep(0.16, 0.02, u);
      const o = i * 4;
      data[o] = clamp(lin[0] * (1 - soot) + 0.34 * soot) * 255;
      data[o + 1] = clamp(lin[1] * (1 - soot) + 0.31 * soot) * 255;
      data[o + 2] = clamp(lin[2] * (1 - soot) + 0.3 * soot) * 255;
      data[o + 3] = 255;
    }
    return dataTex(data, size, 1);
  });
}

// ---------------------------------------------------------------------------
// Beam energy — scrolls along a beam weapon's length. v tiles, u is across the
// beam so the core stays hot and the flanks break into travelling filaments.
// ---------------------------------------------------------------------------
export function getBeamTexture(engine, { w = 64, h = 256, seed = 3313 } = {}) {
  return engine.registry.get(`vfx/beam/${w}x${h}/${seed}`, () => {
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = (x + 0.5) / w;
        const v = (y + 0.5) / h;
        const c = Math.abs(u * 2 - 1);
        // Longitudinal filaments: stretched fbm, tiled in v.
        const f1 = fbm2(u * 3, v * 11, { seed, octaves: 3, period: 0 });
        const fil = clamp(0.5 + f1 * 0.9);
        const band = clamp(valueNoise2(u * 2, v * 23, seed + 5, 23) * 1.4 - 0.2);
        const core = Math.exp(-c * c * 26);
        const halo = Math.exp(-c * c * 4.5);
        const i = (y * w + x) * 4;
        data[i] = clamp(core + halo * 0.25 * fil) * 255;
        data[i + 1] = clamp(halo * (0.35 + 0.65 * fil)) * 255;
        data[i + 2] = clamp(band * halo) * 255;
        data[i + 3] = clamp(core * 0.6 + halo * 0.9 * (0.4 + 0.6 * fil)) * 255;
      }
    }
    const t = dataTex(data, w, h, { mips: true });
    t.wrapT = THREE.RepeatWrapping;
    t.wrapS = THREE.ClampToEdgeWrapping;
    return t;
  });
}

// ---------------------------------------------------------------------------
// Debris hull skin. Debris chunks are real geometry lit by the scene, so this is
// a genuine albedo/roughness pair — scorched plating with torn, brighter metal
// where the hull sheared.
// ---------------------------------------------------------------------------
export function getDebrisMaterialMaps(engine, { size = 256, seed = 6151 } = {}) {
  return engine.registry.get(`vfx/debris/maps/${size}/${seed}`, () => {
    const alb = new Uint8Array(size * size * 4);
    const rgh = new Uint8Array(size * size * 4);
    const inv = 1 / size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = (x + 0.5) * inv;
        const v = (y + 0.5) * inv;
        const plate = worley2(u * 7, v * 7, { seed, period: 7, jitter: 0.85 });
        const line = smoothstep(0.0, 0.055, plate.f2 - plate.f1);
        const grime = fbm2(u * 9, v * 9, { seed: seed + 13, octaves: 5, period: 9 }) * 0.5 + 0.5;
        const scorch = clamp(Math.pow(fbm2(u * 3.5, v * 3.5, { seed: seed + 29, octaves: 4, period: 3.5 }) * 0.5 + 0.5, 2.2) * 1.6);
        const scratch = valueNoise2(u * 60, v * 6, seed + 41, 60);

        const base = 0.2 + grime * 0.16 + scratch * 0.05;
        const tint = 1 - scorch * 0.75;
        const i = (y * size + x) * 4;
        alb[i] = clamp(base * tint * (0.92 + line * 0.18)) * 255;
        alb[i + 1] = clamp(base * tint * 0.99) * 255;
        alb[i + 2] = clamp(base * tint * 1.08) * 255;
        alb[i + 3] = 255;

        const r = clamp(0.42 + grime * 0.3 + scorch * 0.25 - line * 0.12);
        rgh[i] = 255;
        rgh[i + 1] = r * 255;       // roughness in G (three's glTF-style packing)
        rgh[i + 2] = clamp(0.85 - scorch * 0.45) * 255; // metalness in B
        rgh[i + 3] = 255;
      }
    }
    const map = dataTex(alb, size, size, { wrap: THREE.RepeatWrapping, mips: true });
    map.colorSpace = THREE.SRGBColorSpace;
    const orm = dataTex(rgh, size, size, { wrap: THREE.RepeatWrapping, mips: true });
    return { map, orm };
  });
}
