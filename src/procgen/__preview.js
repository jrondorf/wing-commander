/**
 * Standalone visual harness for the procgen texture stack.
 *
 * Not part of the game build — it exists so this agent can screenshot its own
 * output and judge it, which is the only way to tell "layered PBR hull" from
 * "noise slapped on grey".
 *
 *   /src/procgen/__preview.html?style=confed&size=2048&seed=7&wear=0.6&shape=panel
 */

import * as THREE from 'three';
import { Registry } from '../core/Registry.js';
import { generateHullMaterialSet, HULL_STYLE_IDS } from './textures.js';
import { createHullMaterial, createChitinMaterial, createGlassMaterial } from '../render/MaterialLibrary.js';
import { generateGreebleSet } from './greebles.js';

const qs = new URLSearchParams(location.search);
const STYLE = qs.get('style') ?? 'confed';
const SIZE = Number(qs.get('size') ?? 2048);
const SEED = Number(qs.get('seed') ?? 7);
const WEAR = Number(qs.get('wear') ?? 0.55);
const PSCALE = Number(qs.get('panelScale') ?? 1);
const SHAPE = qs.get('shape') ?? 'panel';
const ZOOM = Number(qs.get('zoom') ?? 1);

const view = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(view.clientWidth, view.clientHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping; // preview only — the game tone maps in post
renderer.toneMappingExposure = 1.0;
view.appendChild(renderer.domElement);

// A minimal stand-in for the engine object the generators expect.
const engine = {
  registry: new Registry(),
  maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
  renderer,
};

// ---------------------------------------------------------------- environment
// A coloured nebula gradient so PBR has something to reflect. world/ will supply
// the real one; this only needs to be plausible.
function makeEnv() {
  const W = 256, H = 128;
  const data = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const v = y / (H - 1);
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1);
      const up = 1 - v;
      // Deep indigo above, warm dust below, a bright band near the star azimuth.
      let r = 0.045 + 0.10 * up + 0.28 * Math.pow(Math.max(0, Math.cos((u - 0.28) * Math.PI * 2)), 8);
      let g = 0.055 + 0.075 * up + 0.20 * Math.pow(Math.max(0, Math.cos((u - 0.28) * Math.PI * 2)), 8);
      let b = 0.11 + 0.16 * up + 0.16 * Math.pow(Math.max(0, Math.cos((u - 0.28) * Math.PI * 2)), 8);
      const warm = Math.pow(v, 2.2) * 0.14;
      r += warm * 1.4; g += warm * 0.8; b += warm * 0.4;
      const i = (y * W + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 1;
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromEquirectangular(tex);
  pmrem.dispose();
  tex.dispose();
  return rt.texture;
}

const scene = new THREE.Scene();
scene.environment = makeEnv();
scene.background = new THREE.Color(0x070a0e);

const camera = new THREE.PerspectiveCamera(35, view.clientWidth / view.clientHeight, 0.05, 200);

// One hard key light, as the art bible demands, plus a dim rim for silhouette.
const key = new THREE.DirectionalLight(0xcfe0ff, 4.2);
key.position.set(-2.2, 2.6, 2.0);
scene.add(key);
const rim = new THREE.DirectionalLight(0x6fa8d8, 0.55);
rim.position.set(2.4, -0.6, -2.2);
scene.add(rim);

// ------------------------------------------------------------------ generation
const t0 = performance.now();
const set = generateHullMaterialSet(engine, {
  size: SIZE, seed: SEED, style: STYLE, wear: WEAR, panelScale: PSCALE, keepFields: true,
});
const genMs = performance.now() - t0;

const t1 = performance.now();
const material = STYLE === 'alien'
  ? createChitinMaterial(engine, { size: SIZE, seed: SEED, style: STYLE, wear: WEAR, panelScale: PSCALE })
  : createHullMaterial(engine, { size: SIZE, seed: SEED, style: STYLE, wear: WEAR, panelScale: PSCALE });
const matMs = performance.now() - t1;

// ----------------------------------------------------------------- test bodies
let mesh;
if (SHAPE === 'sphere') {
  mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 96), material);
} else if (SHAPE === 'box') {
  mesh = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.0, 1.6, 8, 8, 8), material);
} else {
  // A gently curved panel: flat enough to read the texture, curved enough that
  // the specular sweeps across it and exposes any flatness in the roughness map.
  const g = new THREE.PlaneGeometry(2.4, 2.4, 160, 160);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i);
    p.setZ(i, -0.16 * (x * x * 0.6 + y * y * 0.25));
  }
  g.computeVertexNormals();
  g.computeTangents?.();
  mesh = new THREE.Mesh(g, material);
}
mesh.geometry.setAttribute('uv1', mesh.geometry.attributes.uv);
scene.add(mesh);

// A sphere alongside gives an unambiguous read on roughness structure.
const ball = new THREE.Mesh(new THREE.SphereGeometry(0.42, 96, 64), material);
ball.position.set(1.55, -0.85, 0.55);
ball.geometry.setAttribute('uv1', ball.geometry.attributes.uv);
scene.add(ball);

// Canopy sample, to check the glass material compiles and reads.
const canopy = new THREE.Mesh(
  new THREE.SphereGeometry(0.3, 48, 32, 0, Math.PI * 2, 0, Math.PI * 0.55),
  createGlassMaterial(engine, {}),
);
canopy.position.set(-1.5, -0.9, 0.6);
canopy.rotation.x = -0.4;
scene.add(canopy);

// Greebles, instanced onto a bar so their silhouettes are visible.
let greebleInfo = 'greebles: —';
try {
  const gs = generateGreebleSet(SEED);
  const names = Object.keys(gs);
  let gx = -1.15;
  for (const n of names) {
    const gm = new THREE.Mesh(gs[n], material);
    gm.scale.setScalar(2.2);
    gm.position.set(gx, 1.45, 0.3);
    scene.add(gm);
    gx += 0.3;
  }
  greebleInfo = `greebles: ${names.length} — ${names.join(' ')}`;
} catch (e) {
  greebleInfo = `greebles: FAILED ${e.message}`;
  console.error(e);
}

camera.position.set(0, 0.1, 3.05 / ZOOM);
camera.lookAt(0, 0, 0);

// --------------------------------------------------------------- map thumbnails
const dbg = set.debug;
function thumb(parent, label, w, h, painter) {
  const wrapEl = document.createElement('div');
  wrapEl.className = 'm';
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  painter(img.data, w, h);
  ctx.putImageData(img, 0, 0);
  const s = document.createElement('span');
  s.textContent = label;
  wrapEl.appendChild(c);
  wrapEl.appendChild(s);
  parent.appendChild(wrapEl);
}

const T = 112;
function resampler(src, srcSize, stride, pick) {
  return (out, w, h) => {
    for (let y = 0; y < h; y++) {
      const sy = Math.floor(y * srcSize / h);
      for (let x = 0; x < w; x++) {
        const sx = Math.floor(x * srcSize / w);
        pick(out, (y * w + x) * 4, src, (sy * srcSize + sx) * stride);
      }
    }
  };
}
const mapsEl = document.getElementById('maps');
thumb(mapsEl, 'ALBEDO', T, T, resampler(dbg.albedo, SIZE, 4, (o, oi, s, si) => {
  o[oi] = s[si]; o[oi + 1] = s[si + 1]; o[oi + 2] = s[si + 2]; o[oi + 3] = 255;
}));
thumb(mapsEl, 'NORMAL', T, T, resampler(dbg.normal, SIZE, 4, (o, oi, s, si) => {
  o[oi] = s[si]; o[oi + 1] = s[si + 1]; o[oi + 2] = s[si + 2]; o[oi + 3] = 255;
}));
thumb(mapsEl, 'ROUGH (G)', T, T, resampler(dbg.orm, SIZE, 4, (o, oi, s, si) => {
  o[oi] = o[oi + 1] = o[oi + 2] = s[si + 1]; o[oi + 3] = 255;
}));
thumb(mapsEl, 'METAL (B)', T, T, resampler(dbg.orm, SIZE, 4, (o, oi, s, si) => {
  o[oi] = o[oi + 1] = o[oi + 2] = s[si + 2]; o[oi + 3] = 255;
}));
thumb(mapsEl, 'AO (R)', T, T, resampler(dbg.orm, SIZE, 4, (o, oi, s, si) => {
  o[oi] = o[oi + 1] = o[oi + 2] = s[si]; o[oi + 3] = 255;
}));
thumb(mapsEl, 'HEIGHT', T, T, resampler(dbg.heightBytes, dbg.hSize, 1, (o, oi, s, si) => {
  o[oi] = o[oi + 1] = o[oi + 2] = s[si]; o[oi + 3] = 255;
}));
thumb(mapsEl, 'EMISSIVE', T, T, resampler(dbg.emissive, dbg.eSize, 4, (o, oi, s, si) => {
  o[oi] = s[si]; o[oi + 1] = s[si + 1]; o[oi + 2] = s[si + 2]; o[oi + 3] = 255;
}));
thumb(mapsEl, 'GRIME/STRK/SOOT', T, T, (out, w, h) => {
  const L = dbg.low, N = dbg.LOW;
  for (let y = 0; y < h; y++) {
    const sy = Math.floor(y * N / h);
    for (let x = 0; x < w; x++) {
      const sx = Math.floor(x * N / w);
      const i = (sy * N + sx) * 6;
      const o = (y * w + x) * 4;
      out[o] = L[i] * 255; out[o + 1] = L[i + 3] * 255; out[o + 2] = L[i + 4] * 255; out[o + 3] = 255;
    }
  }
});
thumb(mapsEl, 'SEAM/RIVET', T, T, (out, w, h) => {
  const L = dbg.layout;
  for (let y = 0; y < h; y++) {
    const sy = Math.floor(y * SIZE / h);
    for (let x = 0; x < w; x++) {
      const sx = Math.floor(x * SIZE / w);
      const i = sy * SIZE + sx;
      const o = (y * w + x) * 4;
      out[o] = L.seam[i] * 255;
      out[o + 1] = L.rivet[i] * 255;
      out[o + 2] = L.edgePx[i];
      out[o + 3] = 255;
    }
  }
});

// 1:1 crops — the only honest way to judge micro-detail.
const cropsEl = document.getElementById('crops');
const CW = 224;
function crop(label, src, srcSize, stride, pick, ox = 0.32, oy = 0.28) {
  thumb(cropsEl, label, CW, CW, (out, w, h) => {
    const bx = Math.floor(ox * srcSize), by = Math.floor(oy * srcSize);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const si = (((by + y) % srcSize) * srcSize + ((bx + x) % srcSize)) * stride;
        pick(out, (y * w + x) * 4, src, si);
      }
    }
  });
}
crop('ALBEDO 1:1', dbg.albedo, SIZE, 4, (o, oi, s, si) => {
  o[oi] = s[si]; o[oi + 1] = s[si + 1]; o[oi + 2] = s[si + 2]; o[oi + 3] = 255;
});
crop('ROUGH 1:1', dbg.orm, SIZE, 4, (o, oi, s, si) => {
  o[oi] = o[oi + 1] = o[oi + 2] = s[si + 1]; o[oi + 3] = 255;
});
crop('NORMAL 1:1', dbg.normal, SIZE, 4, (o, oi, s, si) => {
  o[oi] = s[si]; o[oi + 1] = s[si + 1]; o[oi + 2] = s[si + 2]; o[oi + 3] = 255;
});
crop('METAL 1:1', dbg.orm, SIZE, 4, (o, oi, s, si) => {
  o[oi] = o[oi + 1] = o[oi + 2] = s[si + 2]; o[oi + 3] = 255;
});

// ------------------------------------------------------------------- statistics
function stats(arr, stride, off, scale = 1 / 255) {
  let mn = 1e9, mx = -1e9, sum = 0, sum2 = 0, n = 0;
  for (let i = off; i < arr.length; i += stride * 7) {
    const v = arr[i] * scale;
    if (v < mn) mn = v; if (v > mx) mx = v;
    sum += v; sum2 += v * v; n++;
  }
  const mean = sum / n;
  return { min: mn, max: mx, mean, sd: Math.sqrt(Math.max(0, sum2 / n - mean * mean)) };
}
const rS = stats(dbg.orm, 4, 1);
const mS = stats(dbg.orm, 4, 2);
const aS = stats(dbg.orm, 4, 0);
const lS = stats(dbg.albedo, 4, 0);

const fmt = (s) => `min ${s.min.toFixed(3)} max ${s.max.toFixed(3)} mean ${s.mean.toFixed(3)} sd ${s.sd.toFixed(4)}`;
const lines = [
  `style      ${STYLE}   size ${SIZE}   seed ${SEED}   wear ${WEAR}`,
  `generate   ${genMs.toFixed(0)} ms   material ${matMs.toFixed(0)} ms`,
  ...Object.entries(set.timings).map(([k, v]) => `  ${k.padEnd(9)}${v.toFixed(0)} ms`),
  '',
  `roughness  ${fmt(rS)}`,
  `metalness  ${fmt(mS)}`,
  `ao         ${fmt(aS)}`,
  `albedo.r   ${fmt(lS)}`,
  '',
  `features   hatch ${dbg.features.hatches.length} vent ${dbg.features.vents.length} noz ${dbg.features.nozzles.length} rib ${dbg.features.ribs.length} light ${dbg.features.lights.length}`,
  greebleInfo,
  `styles     ${HULL_STYLE_IDS.join(' ')}`,
];
document.getElementById('stats').textContent = lines.join('\n');
document.getElementById('hud').textContent = `${STYLE.toUpperCase()} · ${SIZE}² · ${genMs.toFixed(0)}ms`;

window.__PREVIEW_STATS__ = {
  style: STYLE, size: SIZE, genMs, matMs, timings: set.timings,
  roughness: rS, metalness: mS, ao: aS,
};

// ------------------------------------------------------------------- render
let frames = 0;
function tick() {
  const t = performance.now() * 0.0002;
  mesh.rotation.y = Math.sin(t) * 0.25;
  mesh.rotation.x = -0.12;
  renderer.render(scene, camera);
  frames++;
  if (frames === 4) window.__READY__ = true;
  requestAnimationFrame(tick);
}
window.addEventListener('error', (e) => { window.__FATAL__ = String(e.message); });
tick();
