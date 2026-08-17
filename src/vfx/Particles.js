/**
 * Pooled, instanced particle layers.
 *
 * One layer = one instanced quad draw call. Everything is preallocated: the CPU
 * state lives in parallel typed arrays, free slots come off a stack, and
 * `update()` performs no allocation whatsoever — the only objects it touches are
 * three module-scope scratch vectors.
 *
 * Layers differ only in configuration, and the configuration is what stops them
 * reading as the same effect three times:
 *
 *   fire    additive, unlit, high emissive, heavy curl advection, atlas erosion
 *           climbing with age so the puff dissolves instead of shrinking
 *   smoke   premultiplied alpha, LIT (key light + up to three fire lights), sorted
 *           back-to-front, low emissive tail so embers still glow inside it
 *   sparks  additive, velocity-stretched billboards
 *
 * ## Emission without garbage
 * `emit()` takes the shared `EMIT` descriptor rather than an object literal, so
 * staged emission from inside `update()` (an explosion feeding smoke in over a
 * second and a half) allocates nothing either. Callers fill EMIT, call emit(),
 * and the layer copies out of it immediately.
 */

import * as THREE from 'three';
import {
  GLSL_COMMON, GLSL_SOFT_DEPTH, GLSL_FIRE_LIGHTS, PARTICLE_VERT, PARTICLE_FRAG,
} from './glsl.js';
import { getPuffAtlas, getNoiseTexture, getBlackbodyRamp } from './Textures.js';
import { sampleCurl } from './curl.js';

/** Shared emission descriptor. Fill, then call `layer.emit(EMIT)`. */
export const EMIT = {
  px: 0, py: 0, pz: 0,
  vx: 0, vy: 0, vz: 0,
  life: 1, delay: 0,
  size0: 1, size1: 2,
  temp0: 1, tempPow: 1.6,
  alpha: 1, fadeIn: 0.08, fadeOut: 1.4,
  drag: 1.2,
  curlAmp: 0, curlScale: 0.05,
  rollSpeed: 0, roll0: 0,
  erode0: 0.05, erode1: 0.6,
  variant: 0, seed: 0,
  stretch: 0,
  tr: 1, tg: 1, tb: 1,
};

/** Reset EMIT to a neutral state so a caller only sets what it cares about. */
export function resetEmit() {
  const e = EMIT;
  e.px = e.py = e.pz = 0;
  e.vx = e.vy = e.vz = 0;
  e.life = 1; e.delay = 0;
  e.size0 = 1; e.size1 = 2;
  e.temp0 = 1; e.tempPow = 1.6;
  e.alpha = 1; e.fadeIn = 0.08; e.fadeOut = 1.4;
  e.drag = 1.2;
  e.curlAmp = 0; e.curlScale = 0.05;
  e.rollSpeed = 0; e.roll0 = 0;
  e.erode0 = 0.05; e.erode1 = 0.6;
  e.variant = 0; e.seed = 0;
  e.stretch = 0;
  e.tr = e.tg = e.tb = 1;
  return e;
}

const _cur = [0, 0, 0];
const _camPos = new THREE.Vector3();
const _camFwd = new THREE.Vector3();

/**
 * @param {object} engine
 * @param {object} opts
 * @returns particle layer
 */
export function createParticleLayer(engine, {
  name = 'vfx:particles',
  capacity = 512,
  mode = 'additive',        // 'additive' | 'premult'
  lit = false,
  sorted = false,
  stretch = false,
  emissive = 8,
  warp = 0.06,
  rim = 1.4,
  detail = 0.5,
  albedo = [0.09, 0.085, 0.082],
  ambient = [0.05, 0.06, 0.08],
  renderOrder = 10,
  softScale = 0.9,
  curlField = null,
} = {}) {
  const N = capacity;

  // ---- CPU state ----------------------------------------------------------
  const px = new Float32Array(N), py = new Float32Array(N), pz = new Float32Array(N);
  const vx = new Float32Array(N), vy = new Float32Array(N), vz = new Float32Array(N);
  const age = new Float32Array(N), life = new Float32Array(N);
  const s0 = new Float32Array(N), s1 = new Float32Array(N);
  const t0 = new Float32Array(N), tPow = new Float32Array(N);
  const al = new Float32Array(N), fIn = new Float32Array(N), fOut = new Float32Array(N);
  const drag = new Float32Array(N);
  const cAmp = new Float32Array(N), cScale = new Float32Array(N);
  const rollS = new Float32Array(N), roll = new Float32Array(N);
  const e0 = new Float32Array(N), e1 = new Float32Array(N);
  const variant = new Float32Array(N), seed = new Float32Array(N), stretchA = new Float32Array(N);
  const tintR = new Float32Array(N), tintG = new Float32Array(N), tintB = new Float32Array(N);

  const free = new Int32Array(N);
  for (let i = 0; i < N; i++) free[i] = N - 1 - i;
  let freeCount = N;
  const activeList = new Int32Array(N);
  const slotAt = new Int32Array(N).fill(-1);
  let count = 0;

  // Sort scratch (back-to-front for the alpha-blended layer).
  const key = sorted ? new Float32Array(N) : null;
  const order = sorted ? new Int32Array(N) : null;

  // ---- GPU buffers --------------------------------------------------------
  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setIndex(quad.index);
  geo.setAttribute('position', quad.attributes.position);
  geo.setAttribute('uv', quad.attributes.uv);
  geo.instanceCount = 0;

  const bPos = new Float32Array(N * 3);
  const bVel = new Float32Array(N * 3);
  const bA = new Float32Array(N * 4);
  const bB = new Float32Array(N * 4);
  const bT = new Float32Array(N * 3);
  const aPos = new THREE.InstancedBufferAttribute(bPos, 3).setUsage(THREE.DynamicDrawUsage);
  const aVel = new THREE.InstancedBufferAttribute(bVel, 3).setUsage(THREE.DynamicDrawUsage);
  const aA = new THREE.InstancedBufferAttribute(bA, 4).setUsage(THREE.DynamicDrawUsage);
  const aB = new THREE.InstancedBufferAttribute(bB, 4).setUsage(THREE.DynamicDrawUsage);
  const aT = new THREE.InstancedBufferAttribute(bT, 3).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iPos', aPos);
  geo.setAttribute('iVel', aVel);
  geo.setAttribute('iA', aA);
  geo.setAttribute('iB', aB);
  geo.setAttribute('iTint', aT);
  // The billboards expand in the vertex shader, so three's bounds are meaningless.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

  const defines = {};
  if (lit) defines.VFX_LIT = '';
  if (stretch) defines.VFX_STRETCH = '';
  if (mode === 'premult') defines.VFX_PREMULT = '';

  const uniforms = {
    uAtlas: { value: getPuffAtlas(engine) },
    uRamp: { value: getBlackbodyRamp(engine) },
    uNoise: { value: getNoiseTexture(engine) },
    uTime: { value: 0 },
    uEmissive: { value: emissive },
    uWarp: { value: warp },
    uRim: { value: rim },
    uDetail: { value: detail },
    uSoftScale: { value: softScale },
    uKeyDirView: { value: new THREE.Vector3(0, 0, 1) },
    uKeyColor: { value: new THREE.Color(0, 0, 0) },
    uAmbient: { value: new THREE.Color(...ambient) },
    uAlbedo: { value: new THREE.Color(...albedo) },
    // soft-particle depth
    tSceneDepth: { value: null },
    uInvRes: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    uCameraFar: { value: 8e6 },
    uCameraNear: { value: 1 },
    uHasDepth: { value: 0 },
    // fire lights
    uFireLightPos: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
    uFireLightCol: { value: [new THREE.Color(0, 0, 0), new THREE.Color(0, 0, 0), new THREE.Color(0, 0, 0)] },
  };

  const mat = new THREE.ShaderMaterial({
    defines,
    uniforms,
    vertexShader: GLSL_COMMON + PARTICLE_VERT,
    fragmentShader: GLSL_COMMON + GLSL_SOFT_DEPTH + (lit ? GLSL_FIRE_LIGHTS : '') + PARTICLE_FRAG,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  if (mode === 'additive') {
    mat.blending = THREE.AdditiveBlending;
  } else {
    // Premultiplied over: the fragment already multiplied colour by alpha.
    mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.OneFactor;
    mat.blendDst = THREE.OneMinusSrcAlphaFactor;
    mat.blendSrcAlpha = THREE.OneFactor;
    mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    mat.blendEquation = THREE.AddEquation;
  }

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  mesh.matrixAutoUpdate = false;
  // Excluded from the velocity G-buffer: the override material cannot reproduce
  // this vertex shader's billboard expansion, and we need the depth of the
  // *opaque* world behind the smoke anyway.
  mesh.userData.noVelocity = true;

  const stats = { live: 0, peak: 0, dropped: 0 };

  function emit(e) {
    if (freeCount === 0) { stats.dropped++; return -1; }
    const i = free[--freeCount];
    px[i] = e.px; py[i] = e.py; pz[i] = e.pz;
    vx[i] = e.vx; vy[i] = e.vy; vz[i] = e.vz;
    age[i] = -e.delay;
    life[i] = e.life;
    s0[i] = e.size0; s1[i] = e.size1;
    t0[i] = e.temp0; tPow[i] = e.tempPow;
    al[i] = e.alpha; fIn[i] = Math.max(1e-3, e.fadeIn); fOut[i] = e.fadeOut;
    drag[i] = e.drag;
    cAmp[i] = e.curlAmp; cScale[i] = e.curlScale;
    rollS[i] = e.rollSpeed; roll[i] = e.roll0;
    e0[i] = e.erode0; e1[i] = e.erode1;
    variant[i] = e.variant & 3; seed[i] = e.seed; stretchA[i] = e.stretch;
    tintR[i] = e.tr; tintG[i] = e.tg; tintB[i] = e.tb;
    slotAt[i] = count;
    activeList[count++] = i;
    if (count > stats.peak) stats.peak = count;
    return i;
  }

  function release(i) {
    const at = slotAt[i];
    if (at < 0) return;
    const last = activeList[--count];
    activeList[at] = last;
    slotAt[last] = at;
    slotAt[i] = -1;
    free[freeCount++] = i;
  }

  /**
   * Integrate, then write instance attributes.
   * @param {number} dt
   * @param {THREE.Camera} camera
   */
  function update(dt, camera) {
    if (dt > 0) {
      for (let k = count - 1; k >= 0; k--) {
        const i = activeList[k];
        const a = (age[i] += dt);
        if (a >= life[i]) { release(i); continue; }
        if (a <= 0) continue;

        // Curl advection. Sampling in world units scaled per-particle means a
        // capital-ship fireball rolls in bigger cells than a fighter's — the
        // same field, read at the length scale of the event.
        const ca = cAmp[i];
        if (ca > 0) {
          const cs = cScale[i];
          sampleCurl(curlField, px[i] * cs, py[i] * cs, pz[i] * cs, _cur);
          vx[i] += _cur[0] * ca * dt;
          vy[i] += _cur[1] * ca * dt;
          vz[i] += _cur[2] * ca * dt;
        }
        // Implicit drag — unconditionally stable at any dt.
        const kd = 1 / (1 + drag[i] * dt);
        vx[i] *= kd; vy[i] *= kd; vz[i] *= kd;
        px[i] += vx[i] * dt;
        py[i] += vy[i] * dt;
        pz[i] += vz[i] * dt;
        roll[i] += rollS[i] * dt;
      }
    }

    const n = count;
    stats.live = n;
    if (n === 0) { geo.instanceCount = 0; return; }

    let list = activeList;
    if (sorted) {
      camera.getWorldPosition(_camPos);
      camera.getWorldDirection(_camFwd);
      for (let k = 0; k < n; k++) {
        const i = activeList[k];
        key[k] = (px[i] - _camPos.x) * _camFwd.x + (py[i] - _camPos.y) * _camFwd.y + (pz[i] - _camPos.z) * _camFwd.z;
        order[k] = i;
      }
      // Insertion sort, descending: farthest drawn first. The list is nearly
      // sorted from the previous frame, so this is O(n) in practice.
      for (let k = 1; k < n; k++) {
        const kk = key[k], oi = order[k];
        let j = k - 1;
        while (j >= 0 && key[j] < kk) { key[j + 1] = key[j]; order[j + 1] = order[j]; j--; }
        key[j + 1] = kk; order[j + 1] = oi;
      }
      list = order;
    }

    let w = 0;
    for (let k = 0; k < n; k++) {
      const i = list[k];
      const a = age[i];
      if (a <= 0) continue;                 // still delayed
      const t = a / life[i];
      const inv = 1 - t;

      const alpha = al[i] * Math.min(1, t / fIn[i]) * Math.pow(inv, fOut[i]);
      if (alpha <= 0.002) continue;

      // Ease-out growth: a blast front decelerates, it does not expand linearly.
      const g = 1 - inv * inv;
      const d = s0[i] + (s1[i] - s0[i]) * g;

      const o3 = w * 3, o4 = w * 4;
      bPos[o3] = px[i]; bPos[o3 + 1] = py[i]; bPos[o3 + 2] = pz[i];
      bVel[o3] = vx[i]; bVel[o3 + 1] = vy[i]; bVel[o3 + 2] = vz[i];
      bA[o4] = d;
      bA[o4 + 1] = roll[i];
      bA[o4 + 2] = t0[i] * Math.pow(inv, tPow[i]);
      bA[o4 + 3] = alpha;
      bB[o4] = seed[i];
      bB[o4 + 1] = variant[i];
      bB[o4 + 2] = e0[i] + (e1[i] - e0[i]) * t;
      bB[o4 + 3] = stretchA[i];
      bT[o3] = tintR[i]; bT[o3 + 1] = tintG[i]; bT[o3 + 2] = tintB[i];
      w++;
    }

    geo.instanceCount = w;
    if (w > 0) {
      aPos.needsUpdate = true;
      aVel.needsUpdate = true;
      aA.needsUpdate = true;
      aB.needsUpdate = true;
      aT.needsUpdate = true;
    }
  }

  function clear() {
    for (let k = count - 1; k >= 0; k--) release(activeList[k]);
    geo.instanceCount = 0;
  }

  function dispose() {
    mesh.removeFromParent();
    geo.dispose();
    quad.dispose();
    mat.dispose();
  }

  return {
    name, mesh, uniforms, emit, update, clear, dispose, stats,
    get count() { return count; },
    get capacity() { return N; },
  };
}
