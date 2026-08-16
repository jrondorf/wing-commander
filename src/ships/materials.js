/**
 * Ship material resolution.
 *
 * The real hull materials come from `src/render/MaterialLibrary.js` (agent-render)
 * on top of `src/procgen/textures.js` (agent-procgen). This module is the adapter:
 * it asks the library for what it needs and, if the library has not landed yet,
 * falls back to a deliberately small local stand-in so ships still read as painted
 * metal instead of untextured plastic.
 *
 * The fallback is NOT a texture-synthesis pipeline and must not grow into one —
 * it is a single fbm roughness/normal pair plus a tiny PMREM environment so PBR
 * has something to reflect. When MaterialLibrary is present, none of it is used.
 */
import * as THREE from 'three';
import { fbm2, worley2, cellValue, heightToNormal, clamp } from '../procgen/noise.js';
import { makeRng } from '../core/Rand.js';

// Optional dependencies — absent during parallel build-out, present later.
let ML = null;
try { ML = await import('../render/MaterialLibrary.js'); } catch { /* not landed yet */ }
let PROCGEN_GREEBLES = null;
try { PROCGEN_GREEBLES = await import('../procgen/greebles.js'); } catch { /* not landed yet */ }

export const hasMaterialLibrary = () => !!ML?.createHullMaterial;
export const greebleModule = () => PROCGEN_GREEBLES;

// ------------------------------------------------------------------ palettes

/**
 * Faction palettes. Confederation is gunmetal slate-blue with off-white panels
 * and safety-orange accents; Nephilim is oxidised bronze and swamp green with a
 * sickly green-yellow glow; civilian hulls are worn ochre. Straight out of §7.
 */
export const PALETTES = {
  confed: {
    base: '#4a5560', panel: '#c8cdd2', dark: '#242a31', accent: '#e07a2a',
    metal: '#7c848c', glow: '#5ec8ff', glowIntensity: 16, style: 'confed',
  },
  confed_capital: {
    base: '#3f4a55', panel: '#a8b0b8', dark: '#1c2127', accent: '#e07a2a',
    metal: '#6f777f', glow: '#5ec8ff', glowIntensity: 12, style: 'capital',
  },
  nephilim: {
    base: '#7a6540', panel: '#3d4a3a', dark: '#1d1a14', accent: '#b8ff4a',
    metal: '#5d5138', glow: '#b8ff4a', glowIntensity: 9, style: 'alien',
  },
  civilian: {
    base: '#6b6257', panel: '#9c9484', dark: '#26221c', accent: '#b8862a',
    metal: '#6e6a63', glow: '#ffb44a', glowIntensity: 8, style: 'civilian',
  },
};

export function paletteFor(faction, variant = 'default') {
  if (faction === 'nephilim' || faction === 'alien' || faction === 'kilrathi') return PALETTES.nephilim;
  if (faction === 'civilian' || faction === 'merchant' || faction === 'pirate') return PALETTES.civilian;
  if (variant === 'capital') return PALETTES.confed_capital;
  return PALETTES.confed;
}

// ------------------------------------------------- fallback texture stand-ins

/**
 * FALLBACK ONLY. One 512² height field driving a roughness map and a normal map:
 * worley plating for per-panel tone, fbm grunge for wear, a rivet lattice for
 * micro-detail. Deleted from the render path the moment MaterialLibrary exists.
 */
function fallbackHullMaps(engine, style, seed) {
  return engine.registry.get(`ships/fallbackmaps/${style}/${seed}`, () => {
    const S = 512;
    const height = new Float32Array(S * S);
    const rough = new Uint8Array(S * S * 4);
    const panelScale = style === 'alien' ? 5 : 9;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        const w = worley2(u * panelScale, v * panelScale, { seed, period: panelScale, jitter: 0.9 });
        const seam = clamp(1 - Math.min(1, (w.f2 - w.f1) * 9));         // panel gaps
        const tone = cellValue(w.id, seed);                              // per-plate tone
        const grunge = fbm2(u * 18, v * 18, { seed: seed + 31, octaves: 5, period: 18 }) * 0.5 + 0.5;
        const micro = fbm2(u * 90, v * 90, { seed: seed + 77, octaves: 3, period: 90 }) * 0.5 + 0.5;
        // Rivet lattice: a soft dot grid along the plate seams.
        const rv = Math.max(0, 1 - 26 * Math.hypot(
          (u * panelScale * 3) % 1 - 0.5, (v * panelScale * 3) % 1 - 0.5)) * (style === 'alien' ? 0 : 1);
        const h = clamp(0.5 - seam * 0.42 + (tone - 0.5) * 0.1 + rv * 0.16 + (micro - 0.5) * 0.06);
        height[y * S + x] = h;
        const i = (y * S + x) * 4;
        // Roughness varies with plate identity, wear and seam cavity — a constant
        // roughness value is the single biggest tell of cheap CG.
        const r = clamp(0.34 + tone * 0.26 + grunge * 0.2 + seam * 0.18 + micro * 0.08);
        rough[i] = 255;                                  // (unused) AO in R for aoMap reuse
        rough[i + 1] = r * 255;                          // roughness -> G
        rough[i + 2] = clamp(0.08 + (1 - grunge) * 0.35 + seam * 0.25) * 255; // metalness -> B
        rough[i + 3] = 255;
      }
    }
    const normalData = heightToNormal(height, S, style === 'alien' ? 1.4 : 2.6);

    const mk = (data, srgb) => {
      const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = engine.maxAnisotropy ?? 4;
      t.needsUpdate = true;
      return t;
    };
    return { ormMap: mk(rough, false), normalMap: mk(normalData, false) };
  });
}

/**
 * FALLBACK ONLY. A 3-stop equirect environment (nebula floor, cool sky, hot key
 * blob) pushed through PMREM. Without *some* environment, metalness renders black
 * and every hull looks like painted cardboard. world/ replaces this at runtime.
 */
function fallbackEnvironment(engine) {
  if (engine.scene?.environment) return engine.scene.environment;
  return engine.registry.get('ships/fallbackenv', () => {
    const W = 128, H = 64;
    const data = new Float32Array(W * H * 4);
    const key = new THREE.Vector3(1, 0.55, 0.7).normalize();
    for (let y = 0; y < H; y++) {
      const phi = (y / (H - 1)) * Math.PI;       // 0 at -Y ... pi at +Y
      const cy = -Math.cos(phi);
      for (let x = 0; x < W; x++) {
        const theta = (x / W) * Math.PI * 2;
        const dir = new THREE.Vector3(Math.sin(phi) * Math.cos(theta), cy, Math.sin(phi) * Math.sin(theta));
        const up = clamp(cy * 0.5 + 0.5);
        // Deep magenta-brown floor into a cold teal sky — reads as a nebula shell.
        let r = 0.06 + up * 0.05, g = 0.035 + up * 0.11, b = 0.07 + up * 0.20;
        const d = Math.max(0, dir.dot(key));
        const hot = Math.pow(d, 42) * 26 + Math.pow(d, 5) * 0.55;
        r += hot * 0.86; g += hot * 0.93; b += hot * 1.0;
        const i = (y * W + x) * 4;
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 1;
      }
    }
    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.needsUpdate = true;
    const autoClear = engine.renderer.autoClear;
    engine.renderer.autoClear = true;
    const pmrem = new THREE.PMREMGenerator(engine.renderer);
    const rt = pmrem.fromEquirectangular(tex);
    pmrem.dispose();
    tex.dispose();
    engine.renderer.autoClear = autoClear;
    return rt.texture;
  });
}

// ------------------------------------------------------------------ resolution

function fallbackHull(engine, { style, seed, palette, kind }) {
  const { ormMap, normalMap } = fallbackHullMaps(engine, style, seed);
  const env = fallbackEnvironment(engine);
  const isAlien = style === 'alien';
  const colorHex = kind === 'panel' ? palette.panel : kind === 'metal' ? palette.metal : palette.base;
  const m = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(colorHex),
    roughness: 1.0,
    metalness: 1.0,
    roughnessMap: ormMap,       // reads .g
    metalnessMap: ormMap,       // reads .b
    normalMap,
    normalScale: new THREE.Vector2(isAlien ? 0.7 : 1.15, isAlien ? 0.7 : 1.15),
    clearcoat: isAlien ? 0.55 : 0.22,
    clearcoatRoughness: isAlien ? 0.35 : 0.45,
    sheen: isAlien ? 0.5 : 0,
    sheenColor: new THREE.Color(isAlien ? '#6f8a3a' : '#000000'),
    envMap: env,
    envMapIntensity: isAlien ? 1.15 : 1.0,
    vertexColors: true,
  });
  m.name = `fallback-hull-${style}-${kind}`;
  return m;
}

function adopt(mat) {
  // Whatever MaterialLibrary hands back, our per-part tone jitter lives in vertex
  // colours, so it has to be switched on. Clone first — never mutate a cached
  // material another module also handed out.
  const m = mat.clone();
  m.vertexColors = true;
  return m;
}

/**
 * Everything a ship builder needs, resolved once per (style, palette, seed) and
 * cached in the engine registry.
 */
export function resolveMaterials(engine, { style, seed, palette, faction }) {
  const key = `ships/mats/${style}/${faction}/${seed}`;
  return engine.registry.get(key, () => {
    const mk = (kind) => {
      if (ML?.createHullMaterial) {
        try {
          return adopt(ML.createHullMaterial(engine, {
            style, seed: seed + kind.length, palette, kind,
            color: kind === 'panel' ? palette.panel : kind === 'metal' ? palette.metal : palette.base,
          }));
        } catch (err) {
          console.warn('[ships] createHullMaterial failed, using fallback —', err?.message ?? err);
        }
      }
      return fallbackHull(engine, { style, seed, palette, kind });
    };

    const hull = mk('hull');
    const panel = mk('panel');
    const metal = mk('metal');

    // Unlit interior: duct throats, hangar recesses, gear bays. Rough, dark, and
    // it is what sells "there is depth in there" next to a lit hull.
    const dark = new THREE.MeshStandardMaterial({
      color: new THREE.Color(palette.dark), roughness: 0.95, metalness: 0.15,
      vertexColors: true, side: THREE.DoubleSide,
    });

    let glass;
    if (ML?.createGlassMaterial) {
      try { glass = ML.createGlassMaterial(engine, { tint: palette.glow }); } catch { /* fall through */ }
    }
    if (!glass) {
      glass = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color('#0d1a24'), roughness: 0.06, metalness: 0.0,
        transparent: true, opacity: 0.38, clearcoat: 1.0, clearcoatRoughness: 0.03,
        envMap: fallbackEnvironment(engine), envMapIntensity: 2.2,
        side: THREE.DoubleSide, depthWrite: false,
      });
    }

    let chitin = null;
    if (style === 'alien') {
      if (ML?.createChitinMaterial) {
        try { chitin = adopt(ML.createChitinMaterial(engine, { seed, palette })); } catch { /* fall through */ }
      }
      chitin = chitin ?? hull;
    }

    // Nav lights: one unlit material for the whole ship, colours in vertex data,
    // values allowed well above 1 so the bloom pass has something to find.
    const lights = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: false });

    const emissiveCache = new Map();
    const emissive = (color, intensity) => {
      const k = `${color}|${intensity}`;
      let m = emissiveCache.get(k);
      if (m) return m;
      if (ML?.createEmissiveMaterial) {
        try { m = ML.createEmissiveMaterial(engine, { color, intensity }); } catch { /* fall through */ }
      }
      if (!m) {
        m = new THREE.MeshBasicMaterial({
          color: new THREE.Color(color).multiplyScalar(intensity),
          toneMapped: false, fog: false,
        });
      }
      m.name = `emissive-${k}`;
      emissiveCache.set(k, m);
      return m;
    };

    return { hull, panel, metal, dark, glass, chitin: chitin ?? hull, lights, emissive, palette, style };
  });
}

/** Greeble shapes: procgen's set if it exists, otherwise the local kit's. */
export function resolveGreebles(engine, seed, fallbackFactory) {
  return engine.registry.get(`ships/greebles/${seed}`, () => {
    if (PROCGEN_GREEBLES?.generateGreebleSet) {
      try {
        const set = PROCGEN_GREEBLES.generateGreebleSet(seed);
        if (Array.isArray(set) && set.length) return set;
      } catch (err) {
        console.warn('[ships] generateGreebleSet failed, using local kit —', err?.message ?? err);
      }
    }
    return fallbackFactory(makeRng(seed ^ 0x9e3779b9));
  });
}
