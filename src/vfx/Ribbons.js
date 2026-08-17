/**
 * Ribbon trails — one draw call for the whole pool.
 *
 * A trail is a ring buffer of world-space points. Each point becomes two
 * vertices offset along the screen-space perpendicular of the local tangent, so
 * the strip always presents its face to the camera without ever being a
 * billboard: it follows the path the emitter actually flew, which is why a
 * missile trail curves and a spinning debris chunk corkscrews.
 *
 * The index buffer is static and covers every slot in the pool. Unused segments
 * are collapsed to a single point, so they rasterise as zero-area triangles and
 * cost nothing but the vertex transform. That keeps the whole system allocation
 * free and at exactly one draw call regardless of how many trails are live.
 */

import * as THREE from 'three';
import { GLSL_COMMON, GLSL_SOFT_DEPTH, RIBBON_VERT, RIBBON_FRAG } from './glsl.js';
import { getNoiseTexture, getBlackbodyRamp } from './Textures.js';

const _t = new THREE.Vector3();

export function createRibbonLayer(engine, {
  name = 'vfx:ribbons',
  trails = 28,
  points = 22,
  renderOrder = 11,
  emissive = 9,
  softScale = 2.5,
} = {}) {
  const T = trails, P = points;
  const V = T * P * 2;

  const pos = new Float32Array(V * 3);
  const tan = new Float32Array(V * 3);
  const par = new Float32Array(V * 4);
  const col = new Float32Array(V * 3);
  const tmp = new Float32Array(V);

  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aTan = new THREE.BufferAttribute(tan, 3).setUsage(THREE.DynamicDrawUsage);
  const aPar = new THREE.BufferAttribute(par, 4).setUsage(THREE.DynamicDrawUsage);
  const aCol = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
  const aTmp = new THREE.BufferAttribute(tmp, 1).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos);
  geo.setAttribute('aTangent', aTan);
  geo.setAttribute('aParam', aPar);
  geo.setAttribute('aColor', aCol);
  geo.setAttribute('aTemp', aTmp);

  const idx = new Uint32Array(T * (P - 1) * 6);
  for (let t = 0, o = 0; t < T; t++) {
    const b = t * P * 2;
    for (let p = 0; p < P - 1; p++) {
      const a0 = b + p * 2, a1 = a0 + 1, a2 = a0 + 2, a3 = a0 + 3;
      idx[o++] = a0; idx[o++] = a2; idx[o++] = a1;
      idx[o++] = a1; idx[o++] = a2; idx[o++] = a3;
    }
  }
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

  const uniforms = {
    uNoise: { value: getNoiseTexture(engine) },
    uRamp: { value: getBlackbodyRamp(engine) },
    uTime: { value: 0 },
    uEmissive: { value: emissive },
    uAmbient: { value: new THREE.Color(0.05, 0.06, 0.08) },
    uKeyColor: { value: new THREE.Color(0, 0, 0) },
    uSoftScale: { value: softScale },
    tSceneDepth: { value: null },
    uInvRes: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    uCameraFar: { value: 8e6 },
    uCameraNear: { value: 1 },
    uHasDepth: { value: 0 },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: GLSL_COMMON + RIBBON_VERT,
    fragmentShader: GLSL_COMMON + GLSL_SOFT_DEPTH + RIBBON_FRAG,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    // Premultiplied over — smoke must be able to darken the sky behind it.
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    blendEquation: THREE.AddEquation,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  mesh.matrixAutoUpdate = false;
  mesh.userData.noVelocity = true;

  // ---- trail state --------------------------------------------------------
  const tp = new Float32Array(T * P * 3);   // point positions
  const ta = new Float32Array(T * P);       // point age
  const used = new Uint8Array(T);
  const head = new Int32Array(T);           // index of newest point
  const num = new Int32Array(T);
  const feeding = new Uint8Array(T);
  const width0 = new Float32Array(T), width1 = new Float32Array(T);
  const fade = new Float32Array(T);         // seconds a point survives
  const temp0 = new Float32Array(T), tempPow = new Float32Array(T);
  const cr = new Float32Array(T), cg = new Float32Array(T), cb = new Float32Array(T);
  const minStep = new Float32Array(T);
  const alphaMul = new Float32Array(T);
  const gen = new Int32Array(T);            // bumped on release: stale handles die

  /**
   * @param {{width0:number,width1:number,fade:number,temp:number,tempPow?:number,
   *          color:[number,number,number], minStep?:number, alpha?:number}} o
   * @returns {number} handle, or -1 when the pool is full
   */
  function acquire(o) {
    for (let t = 0; t < T; t++) {
      if (used[t]) continue;
      used[t] = 1; feeding[t] = 1;
      head[t] = 0; num[t] = 0;
      width0[t] = o.width0; width1[t] = o.width1;
      fade[t] = o.fade; temp0[t] = o.temp ?? 0; tempPow[t] = o.tempPow ?? 2;
      cr[t] = o.color[0]; cg[t] = o.color[1]; cb[t] = o.color[2];
      minStep[t] = o.minStep ?? 1.5;
      alphaMul[t] = o.alpha ?? 1;
      return t | (gen[t] << 8);
    }
    return -1;
  }

  const slotOf = (h) => (h < 0 ? -1 : (h & 0xff));
  const valid = (h) => {
    const s = slotOf(h);
    return s >= 0 && s < T && used[s] && gen[s] === (h >> 8);
  };

  /** Feed the head of a trail. Adds a new point only once the emitter has moved. */
  function push(h, x, y, z) {
    if (!valid(h)) return;
    const t = slotOf(h);
    const b = t * P;
    if (num[t] === 0) {
      head[t] = 0; num[t] = 1;
      tp[b * 3] = x; tp[b * 3 + 1] = y; tp[b * 3 + 2] = z;
      ta[b] = 0;
      return;
    }
    const hi = b + head[t];
    const dx = x - tp[hi * 3], dy = y - tp[hi * 3 + 1], dz = z - tp[hi * 3 + 2];
    if (dx * dx + dy * dy + dz * dz < minStep[t] * minStep[t]) {
      // Not far enough for a new knot — slide the existing head so the ribbon
      // stays attached to the emitter instead of visibly lagging behind it.
      tp[hi * 3] = x; tp[hi * 3 + 1] = y; tp[hi * 3 + 2] = z;
      ta[hi] = 0;
      return;
    }
    head[t] = (head[t] + 1) % P;
    if (num[t] < P) num[t]++;
    const ni = b + head[t];
    tp[ni * 3] = x; tp[ni * 3 + 1] = y; tp[ni * 3 + 2] = z;
    ta[ni] = 0;
  }

  /** Stop feeding. The trail persists until its last point has aged out. */
  function release(h) {
    if (!valid(h)) return;
    feeding[slotOf(h)] = 0;
  }

  function freeSlot(t) {
    used[t] = 0; feeding[t] = 0; num[t] = 0;
    gen[t] = (gen[t] + 1) & 0xffffff;
  }

  function update(dt, camera) {
    let w = 0;
    for (let t = 0; t < T; t++) {
      const b = t * P;
      if (used[t]) {
        let alive = 0;
        for (let p = 0; p < num[t]; p++) {
          const i = b + p;
          ta[i] += dt;
          if (ta[i] < fade[t]) alive++;
        }
        if (!feeding[t] && alive === 0) freeSlot(t);
      }

      const vb = t * P * 2;
      if (!used[t] || num[t] < 2) {
        // Collapse to a degenerate strip: zero area, no fragments.
        for (let p = 0; p < P; p++) {
          const v0 = (vb + p * 2) * 3;
          pos[v0] = 0; pos[v0 + 1] = -1e7; pos[v0 + 2] = 0;
          pos[v0 + 3] = 0; pos[v0 + 4] = -1e7; pos[v0 + 5] = 0;
          par[(vb + p * 2) * 4 + 2] = 0;
          par[(vb + p * 2 + 1) * 4 + 2] = 0;
        }
        continue;
      }

      const n = num[t];
      for (let p = 0; p < P; p++) {
        const src = p < n ? (head[t] - p + P * 2) % P : (head[t] - (n - 1) + P * 2) % P;
        const si = b + src;
        const x = tp[si * 3], y = tp[si * 3 + 1], z = tp[si * 3 + 2];

        // Tangent from the neighbouring knots.
        const pPrev = Math.max(0, p - 1);
        const pNext = Math.min(n - 1, p + 1);
        const iPrev = b + ((head[t] - pPrev + P * 2) % P);
        const iNext = b + ((head[t] - pNext + P * 2) % P);
        _t.set(
          tp[iPrev * 3] - tp[iNext * 3],
          tp[iPrev * 3 + 1] - tp[iNext * 3 + 1],
          tp[iPrev * 3 + 2] - tp[iNext * 3 + 2],
        );
        if (_t.lengthSq() < 1e-8) _t.set(0, 0, 1); else _t.normalize();

        const ageP = p < n ? ta[si] : fade[t];
        const u = Math.min(1, ageP / fade[t]);
        const wid = width0[t] + (width1[t] - width0[t]) * u;
        // Fade in over the first knot too, so a newly spawned trail does not
        // pop into existence at full width.
        const a = alphaMul[t] * Math.pow(1 - u, 1.35) * (p < n ? 1 : 0);
        const temp = temp0[t] * Math.pow(1 - u, tempPow[t]);

        for (let s = 0; s < 2; s++) {
          const vi = vb + p * 2 + s;
          const o3 = vi * 3, o4 = vi * 4;
          pos[o3] = x; pos[o3 + 1] = y; pos[o3 + 2] = z;
          tan[o3] = _t.x; tan[o3 + 1] = _t.y; tan[o3 + 2] = _t.z;
          par[o4] = s === 0 ? -1 : 1;
          par[o4 + 1] = wid;
          par[o4 + 2] = a;
          par[o4 + 3] = u;
          col[o3] = cr[t]; col[o3 + 1] = cg[t]; col[o3 + 2] = cb[t];
          tmp[vi] = temp;
        }
      }
      w++;
    }
    aPos.needsUpdate = true; aTan.needsUpdate = true;
    aPar.needsUpdate = true; aCol.needsUpdate = true; aTmp.needsUpdate = true;
    mesh.visible = w > 0;
  }

  function clear() {
    for (let t = 0; t < T; t++) if (used[t]) freeSlot(t);
  }

  function dispose() {
    mesh.removeFromParent();
    geo.dispose();
    mat.dispose();
  }

  return { name, mesh, uniforms, acquire, push, release, update, clear, dispose, valid };
}
