/**
 * Tracer bolts.
 *
 * Each bolt is a **cylindrical billboard**: the quad rotates about the bolt's
 * own travel axis to face the camera, so a tracer crossing the frame is a
 * streak, one coming at you is a dot, and neither is ever seen as an edge-on
 * card. Inside, two nested gaussians — a needle-thin near-white core and a wide
 * coloured halo — because a single falloff is the flat-capsule look the art
 * bible calls out.
 *
 * `combat/projectiles.js` draws its own bolts when the combat system owns them.
 * This layer only fires when nothing else is drawing the shot, so the two never
 * double up (see `enabled` below, set by VFXSystem).
 */

import * as THREE from 'three';
import { GLSL_COMMON, GLSL_SOFT_DEPTH, BOLT_VERT, BOLT_FRAG } from './glsl.js';

export function createBoltLayer(engine, {
  name = 'vfx:tracers',
  capacity = 320,
  renderOrder = 6,
  coreBoost = 5.0,
} = {}) {
  const N = capacity;
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setIndex(base.index);
  geo.setAttribute('position', base.attributes.position);
  geo.setAttribute('uv', base.attributes.uv);
  geo.instanceCount = 0;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

  const bPos = new Float32Array(N * 3);
  const bDir = new Float32Array(N * 3);
  const bA = new Float32Array(N * 4);
  const bCol = new Float32Array(N * 3);
  const attrs = {
    iPos: new THREE.InstancedBufferAttribute(bPos, 3).setUsage(THREE.DynamicDrawUsage),
    iDir: new THREE.InstancedBufferAttribute(bDir, 3).setUsage(THREE.DynamicDrawUsage),
    iA: new THREE.InstancedBufferAttribute(bA, 4).setUsage(THREE.DynamicDrawUsage),
    iCol: new THREE.InstancedBufferAttribute(bCol, 3).setUsage(THREE.DynamicDrawUsage),
  };
  for (const k in attrs) geo.setAttribute(k, attrs[k]);

  const uniforms = {
    uCoreBoost: { value: coreBoost },
    tSceneDepth: { value: null },
    uInvRes: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    uCameraFar: { value: 8e6 },
    uCameraNear: { value: 1 },
    uHasDepth: { value: 0 },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: GLSL_COMMON + BOLT_VERT,
    fragmentShader: GLSL_COMMON + GLSL_SOFT_DEPTH + BOLT_FRAG,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    blending: THREE.AdditiveBlending,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  mesh.matrixAutoUpdate = false;
  mesh.userData.noVelocity = true;

  const px = new Float32Array(N), py = new Float32Array(N), pz = new Float32Array(N);
  const dx = new Float32Array(N), dy = new Float32Array(N), dz = new Float32Array(N);
  const speed = new Float32Array(N);
  const len = new Float32Array(N), rad = new Float32Array(N), inten = new Float32Array(N);
  const age = new Float32Array(N), life = new Float32Array(N);
  const cr = new Float32Array(N), cg = new Float32Array(N), cb = new Float32Array(N);

  const free = new Int32Array(N);
  for (let i = 0; i < N; i++) free[i] = N - 1 - i;
  let freeCount = N;
  const activeList = new Int32Array(N);
  const slotAt = new Int32Array(N).fill(-1);
  let count = 0;

  function spawn(o) {
    if (freeCount === 0) return -1;
    const i = free[--freeCount];
    px[i] = o.position.x; py[i] = o.position.y; pz[i] = o.position.z;
    dx[i] = o.direction.x; dy[i] = o.direction.y; dz[i] = o.direction.z;
    speed[i] = o.speed;
    len[i] = o.length; rad[i] = o.radius; inten[i] = o.intensity;
    age[i] = 0; life[i] = o.life;
    cr[i] = o.color[0]; cg[i] = o.color[1]; cb[i] = o.color[2];
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
        if (age[i] >= life[i]) { release(i); continue; }
        const s = speed[i] * dt;
        px[i] += dx[i] * s; py[i] += dy[i] * s; pz[i] += dz[i] * s;
      }
    }
    const n = count;
    for (let k = 0; k < n; k++) {
      const i = activeList[k];
      const t = age[i] / life[i];
      const o3 = k * 3, o4 = k * 4;
      bPos[o3] = px[i]; bPos[o3 + 1] = py[i]; bPos[o3 + 2] = pz[i];
      bDir[o3] = dx[i]; bDir[o3 + 1] = dy[i]; bDir[o3 + 2] = dz[i];
      bA[o4] = len[i];
      bA[o4 + 1] = rad[i];
      bA[o4 + 2] = inten[i];
      // Bolts dim only right at the end of their run — energy weapons do not
      // visibly fade over their flight, they just stop.
      bA[o4 + 3] = Math.min(1, (1 - t) * 5);
      bCol[o3] = cr[i]; bCol[o3 + 1] = cg[i]; bCol[o3 + 2] = cb[i];
    }
    geo.instanceCount = n;
    if (n > 0) for (const k in attrs) attrs[k].needsUpdate = true;
  }

  return {
    name, mesh, uniforms, spawn, update,
    get count() { return count; },
    clear() { for (let k = count - 1; k >= 0; k--) release(activeList[k]); geo.instanceCount = 0; },
    dispose() {
      mesh.removeFromParent();
      geo.dispose();
      base.dispose();
      mat.dispose();
    },
  };
}
