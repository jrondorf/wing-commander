/**
 * Screen-warping layers: shockwave rings and heat haze.
 *
 * Two instanced draws share the DISTORT shader pair through a `VFX_ORIENTED` /
 * `VFX_RING` define switch:
 *
 *   ring   an **annulus in a real world plane**, not a billboard. A blast front
 *          is a physical surface; billboarding it makes it a decal that always
 *          faces you, which is the single fastest way to make an explosion look
 *          like a sprite sheet. Seen edge-on it correctly thins to a line.
 *   haze   camera-facing discs of hot gas around the fireball, refracting only.
 *
 * Both refract the nebula cubemap and add nothing where the sky is flat, so a
 * haze disc over empty space is invisible rather than a grey smudge.
 */

import * as THREE from 'three';
import { GLSL_COMMON, GLSL_SOFT_DEPTH, DISTORT_VERT, DISTORT_FRAG } from './glsl.js';
import { getNoiseTexture, getBlackbodyRamp } from './Textures.js';

/** Annulus with uv.x running across the ring's thickness, uv.y around it. */
function ringGeometry(segments = 96, cross = 5, inner = 0.55) {
  const pos = [];
  const uv = [];
  const idx = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    for (let j = 0; j <= cross; j++) {
      const f = j / cross;
      const r = inner + (1 - inner) * f;
      pos.push(ca * r, sa * r, 0);
      uv.push(f, i / segments);
    }
  }
  const row = cross + 1;
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < cross; j++) {
      const a = i * row + j;
      const b = (i + 1) * row + j;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

export function createDistortLayer(engine, {
  name = 'vfx:distort',
  capacity = 24,
  kind = 'ring',           // 'ring' | 'haze'
  renderOrder = 14,
  softScale = 1.2,
  refract = 0.55,
  rimColor = [1.0, 0.72, 0.42],
  rimIntensity = 12,
} = {}) {
  const N = capacity;
  const isRing = kind === 'ring';

  const base = isRing ? ringGeometry(96, 5, 0.5) : new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setIndex(base.index);
  geo.setAttribute('position', base.attributes.position);
  geo.setAttribute('uv', base.attributes.uv);
  geo.instanceCount = 0;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

  const bPos = new Float32Array(N * 3);
  const bQuat = new Float32Array(N * 4);
  const bA = new Float32Array(N * 4);
  const bB = new Float32Array(N * 4);
  const aPos = new THREE.InstancedBufferAttribute(bPos, 3).setUsage(THREE.DynamicDrawUsage);
  const aQuat = new THREE.InstancedBufferAttribute(bQuat, 4).setUsage(THREE.DynamicDrawUsage);
  const aA = new THREE.InstancedBufferAttribute(bA, 4).setUsage(THREE.DynamicDrawUsage);
  const aB = new THREE.InstancedBufferAttribute(bB, 4).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iPos', aPos);
  geo.setAttribute('iQuat', aQuat);
  geo.setAttribute('iA', aA);
  geo.setAttribute('iB', aB);

  const defines = {};
  if (isRing) { defines.VFX_ORIENTED = ''; defines.VFX_RING = ''; }

  const uniforms = {
    uSky: { value: null },
    uHasSky: { value: 0 },
    uSkyFlip: { value: 1 },
    uRefract: { value: refract },
    uNoise: { value: getNoiseTexture(engine) },
    uRamp: { value: getBlackbodyRamp(engine) },
    uTime: { value: 0 },
    uRimColor: { value: new THREE.Color(...rimColor) },
    uRimIntensity: { value: rimIntensity },
    uSoftScale: { value: softScale },
    uCamRight: { value: new THREE.Vector3(1, 0, 0) },
    uCamUp: { value: new THREE.Vector3(0, 1, 0) },
    uCamZ: { value: new THREE.Vector3(0, 0, 1) },
    tSceneDepth: { value: null },
    uInvRes: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    uCameraFar: { value: 8e6 },
    uCameraNear: { value: 1 },
    uHasDepth: { value: 0 },
  };

  const mat = new THREE.ShaderMaterial({
    defines,
    uniforms,
    vertexShader: GLSL_COMMON + DISTORT_VERT,
    fragmentShader: GLSL_COMMON + GLSL_SOFT_DEPTH + DISTORT_FRAG,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendEquation: THREE.AddEquation,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  mesh.matrixAutoUpdate = false;
  mesh.userData.noVelocity = true;

  // ---- CPU state ----------------------------------------------------------
  const px = new Float32Array(N), py = new Float32Array(N), pz = new Float32Array(N);
  const qx = new Float32Array(N), qy = new Float32Array(N), qz = new Float32Array(N), qw = new Float32Array(N);
  const age = new Float32Array(N), life = new Float32Array(N);
  const r0 = new Float32Array(N), r1 = new Float32Array(N);
  const str0 = new Float32Array(N), str1 = new Float32Array(N);
  const alpha0 = new Float32Array(N), fadeP = new Float32Array(N);
  const seedA = new Float32Array(N), innerF = new Float32Array(N), rimP = new Float32Array(N);
  const scrollS = new Float32Array(N);
  const grow = new Float32Array(N);

  const free = new Int32Array(N);
  for (let i = 0; i < N; i++) free[i] = N - 1 - i;
  let freeCount = N;
  const activeList = new Int32Array(N);
  const slotAt = new Int32Array(N).fill(-1);
  let count = 0;

  /**
   * @param {{position, quaternion?, life, r0, r1, strength0, strength1,
   *          alpha?, fade?, seed?, inner?, rimPow?, scroll?, growExp?}} o
   */
  function spawn(o) {
    if (freeCount === 0) return -1;
    const i = free[--freeCount];
    px[i] = o.position.x; py[i] = o.position.y; pz[i] = o.position.z;
    const q = o.quaternion;
    qx[i] = q ? q.x : 0; qy[i] = q ? q.y : 0; qz[i] = q ? q.z : 0; qw[i] = q ? q.w : 1;
    age[i] = 0; life[i] = o.life;
    r0[i] = o.r0; r1[i] = o.r1;
    str0[i] = o.strength0; str1[i] = o.strength1 ?? 0;
    alpha0[i] = o.alpha ?? 1; fadeP[i] = o.fade ?? 1.2;
    seedA[i] = o.seed ?? 0;
    innerF[i] = o.inner ?? 0.35;
    rimP[i] = o.rimPow ?? 2.2;
    scrollS[i] = o.scroll ?? 0.6;
    grow[i] = o.growExp ?? 0.45;
    slotAt[i] = count;
    activeList[count++] = i;
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

  function update(dt) {
    if (dt > 0) {
      for (let k = count - 1; k >= 0; k--) {
        const i = activeList[k];
        age[i] += dt;
        if (age[i] >= life[i]) release(i);
      }
    }
    const n = count;
    let w = 0;
    for (let k = 0; k < n; k++) {
      const i = activeList[k];
      const t = age[i] / life[i];
      // A shock front's radius goes as t^0.4 (Sedov-Taylor is t^0.4 in 3D) —
      // very fast at first, then visibly decelerating. Linear growth reads as an
      // animation; this reads as a detonation.
      const g = Math.pow(t, grow[i]);
      const radius = r0[i] + (r1[i] - r0[i]) * g;
      const a = alpha0[i] * Math.pow(1 - t, fadeP[i]);
      if (a <= 0.003) continue;
      const o3 = w * 3, o4 = w * 4;
      bPos[o3] = px[i]; bPos[o3 + 1] = py[i]; bPos[o3 + 2] = pz[i];
      bQuat[o4] = qx[i]; bQuat[o4 + 1] = qy[i]; bQuat[o4 + 2] = qz[i]; bQuat[o4 + 3] = qw[i];
      bA[o4] = radius;
      bA[o4 + 1] = str0[i] + (str1[i] - str0[i]) * t;
      bA[o4 + 2] = a;
      bA[o4 + 3] = seedA[i];
      bB[o4] = innerF[i];
      bB[o4 + 1] = rimP[i];
      bB[o4 + 2] = 0;
      bB[o4 + 3] = age[i] * scrollS[i];
      w++;
    }
    geo.instanceCount = w;
    if (w > 0) {
      aPos.needsUpdate = true; aQuat.needsUpdate = true;
      aA.needsUpdate = true; aB.needsUpdate = true;
    }
  }

  function clear() {
    for (let k = count - 1; k >= 0; k--) release(activeList[k]);
    geo.instanceCount = 0;
  }

  function dispose() {
    mesh.removeFromParent();
    geo.dispose();
    base.dispose();
    mat.dispose();
  }

  return {
    name, mesh, uniforms, spawn, update, clear, dispose,
    get count() { return count; },
  };
}
