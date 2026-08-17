/**
 * Debris chunks — real geometry, not sprites.
 *
 * The brief's "explosions that are just an orange sphere" failure is mostly a
 * failure of *scale cues*: a fireball with nothing recognisable flying out of it
 * has no size. Chunks fix that. They are lit by the same key light and nebula
 * environment as the hulls they came from, they tumble on a real angular
 * velocity, they drag a burning ribbon, and roughly a third of them carry a
 * delayed secondary detonation so the event keeps going off after the initial
 * flash has decayed.
 *
 * Three shard geometries × one InstancedMesh each = three draw calls for the
 * whole field. Per-instance heat is injected into the standard material through
 * `onBeforeCompile` — an instanced attribute multiplying `totalEmissiveRadiance`
 * — because a chunk torn out of a reactor is glowing along its sheared edges and
 * cools over a couple of seconds.
 */

import * as THREE from 'three';
import { makeRng } from '../core/Rand.js';
import { getDebrisMaterialMaps } from './Textures.js';

const _q = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/**
 * An irregular hull shard: an icosahedron pushed around by hashed noise, then
 * sliced flat on one side so it reads as a torn panel rather than a rock.
 */
function shardGeometry(seed, detail = 1) {
  const rng = makeRng(seed);
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  const nx = rng.range(-1, 1), ny = rng.range(-1, 1), nz = rng.range(-1, 1);
  const inv = 1 / Math.hypot(nx, ny, nz);
  const cx = nx * inv, cy = ny * inv, cz = nz * inv;
  const cut = rng.range(-0.15, 0.35);
  // Independent axis scales: a hull fragment is a plate or a spar, never a ball.
  const ax = rng.range(0.45, 1.5), ay = rng.range(0.3, 1.1), az = rng.range(0.6, 1.9);
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const lumpy = 0.55 + 0.9 * ((Math.sin(x * 7.3 + seed) * Math.cos(y * 5.1 - seed) + Math.sin(z * 6.7)) * 0.25 + 0.5);
    x *= ax * lumpy; y *= ay * lumpy; z *= az * lumpy;
    // Flatten everything past the cut plane onto it — the shear face.
    const d = x * cx + y * cy + z * cz - cut;
    if (d > 0) { x -= cx * d; y -= cy * d; z -= cz * d; }
    p.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

export function createDebrisField(engine, {
  name = 'vfx:debris',
  kinds = 3,
  perKind = 34,
  renderOrder = 4,
} = {}) {
  const N = kinds * perKind;
  const { map, orm } = getDebrisMaterialMaps(engine);

  const group = new THREE.Group();
  group.name = name;
  group.matrixAutoUpdate = false;

  const meshes = [];
  const glowBufs = [];
  const geos = [];

  for (let k = 0; k < kinds; k++) {
    const geo = shardGeometry(9137 + k * 613, k === 2 ? 0 : 1);
    geos.push(geo);
    const mat = new THREE.MeshStandardMaterial({
      map,
      roughnessMap: orm,
      metalnessMap: orm,
      roughness: 1,
      metalness: 1,
      emissive: new THREE.Color(1.0, 0.34, 0.08),
      emissiveIntensity: 1,
      envMapIntensity: 1,
    });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float instanceGlow;\nvarying float vGlowD;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlowD = instanceGlow;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vGlowD;')
        .replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vGlowD;',
        );
    };
    // Distinguish the program from every other MeshStandardMaterial in the frame.
    mat.customProgramCacheKey = () => 'vfx-debris-glow';

    const mesh = new THREE.InstancedMesh(geo, mat, perKind);
    mesh.name = `${name}:${k}`;
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = renderOrder;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const glow = new Float32Array(perKind);
    const attr = new THREE.InstancedBufferAttribute(glow, 1).setUsage(THREE.DynamicDrawUsage);
    mesh.geometry.setAttribute('instanceGlow', attr);
    glowBufs.push(attr);
    meshes.push(mesh);
    group.add(mesh);
  }

  // ---- CPU state ----------------------------------------------------------
  const px = new Float32Array(N), py = new Float32Array(N), pz = new Float32Array(N);
  const vx = new Float32Array(N), vy = new Float32Array(N), vz = new Float32Array(N);
  const qx = new Float32Array(N), qy = new Float32Array(N), qz = new Float32Array(N), qw = new Float32Array(N);
  const wx = new Float32Array(N), wy = new Float32Array(N), wz = new Float32Array(N);
  const scale = new Float32Array(N);
  const age = new Float32Array(N), life = new Float32Array(N);
  const glow0 = new Float32Array(N), glowPow = new Float32Array(N);
  const kindOf = new Int8Array(N);
  const trail = new Int32Array(N).fill(-1);
  const boomAt = new Float32Array(N), boomPower = new Float32Array(N);
  const emitAcc = new Float32Array(N);

  const free = new Int32Array(N);
  for (let i = 0; i < N; i++) free[i] = N - 1 - i;
  let freeCount = N;
  const activeList = new Int32Array(N);
  const slotAt = new Int32Array(N).fill(-1);
  let count = 0;

  /**
   * @param {{position, velocity, spin:number, size:number, life:number,
   *          glow?:number, glowPow?:number, kind?:number, trail?:number,
   *          boomAt?:number, boomPower?:number, rng:Function}} o
   */
  function spawn(o) {
    if (freeCount === 0) return -1;
    const i = free[--freeCount];
    const rng = o.rng;
    px[i] = o.position.x; py[i] = o.position.y; pz[i] = o.position.z;
    vx[i] = o.velocity.x; vy[i] = o.velocity.y; vz[i] = o.velocity.z;
    // Random orientation, uniform on the sphere of rotations.
    const u1 = rng(), u2 = rng() * Math.PI * 2, u3 = rng() * Math.PI * 2;
    const r1 = Math.sqrt(1 - u1), r2 = Math.sqrt(u1);
    qx[i] = r1 * Math.sin(u2); qy[i] = r1 * Math.cos(u2);
    qz[i] = r2 * Math.sin(u3); qw[i] = r2 * Math.cos(u3);
    wx[i] = rng.gauss(0, o.spin); wy[i] = rng.gauss(0, o.spin); wz[i] = rng.gauss(0, o.spin);
    scale[i] = o.size;
    age[i] = 0; life[i] = o.life;
    glow0[i] = o.glow ?? 6; glowPow[i] = o.glowPow ?? 2.2;
    kindOf[i] = o.kind ?? (rng.int(0, kinds - 1));
    trail[i] = o.trail ?? -1;
    boomAt[i] = o.boomAt ?? -1;
    boomPower[i] = o.boomPower ?? 0;
    emitAcc[i] = 0;
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
    trail[i] = -1;
    free[freeCount++] = i;
  }

  /**
   * @param {number} dt
   * @param {{onTrail(i,x,y,z,glow), onEmber(i,x,y,z,vx,vy,vz,glow), onBoom(i,x,y,z,power), onEnd(i)}} cb
   */
  function update(dt, cb) {
    if (dt > 0) {
      for (let k = count - 1; k >= 0; k--) {
        const i = activeList[k];
        age[i] += dt;
        px[i] += vx[i] * dt; py[i] += vy[i] * dt; pz[i] += vz[i] * dt;
        // Light drag: chunks thrown through the expanding gas of their own
        // fireball do shed speed before they leave it.
        const kd = 1 / (1 + 0.16 * dt);
        vx[i] *= kd; vy[i] *= kd; vz[i] *= kd;

        // Integrate the tumble as a proper quaternion derivative.
        _q.set(qx[i], qy[i], qz[i], qw[i]);
        _dq.set(wx[i] * dt * 0.5, wy[i] * dt * 0.5, wz[i] * dt * 0.5, 1).normalize();
        _q.multiply(_dq).normalize();
        qx[i] = _q.x; qy[i] = _q.y; qz[i] = _q.z; qw[i] = _q.w;

        const t = age[i] / life[i];
        const g = glow0[i] * Math.pow(Math.max(0, 1 - t), glowPow[i]);

        if (trail[i] >= 0) cb.onTrail(trail[i], px[i], py[i], pz[i]);

        // Burning chunks shed embers along their path.
        if (g > 0.35) {
          emitAcc[i] += dt * (6 + g * 2.5);
          while (emitAcc[i] >= 1) {
            emitAcc[i] -= 1;
            cb.onEmber(i, px[i], py[i], pz[i], vx[i], vy[i], vz[i], g, scale[i]);
          }
        }

        if (boomAt[i] >= 0 && age[i] >= boomAt[i]) {
          boomAt[i] = -1;
          cb.onBoom(i, px[i], py[i], pz[i], boomPower[i]);
        }

        if (age[i] >= life[i]) { cb.onEnd(i, trail[i]); release(i); }
      }
    }

    // ---- write instance matrices, grouped by geometry kind ----------------
    for (let k = 0; k < kinds; k++) meshes[k].count = 0;
    for (let a = 0; a < count; a++) {
      const i = activeList[a];
      const k = kindOf[i];
      const mesh = meshes[k];
      const at = mesh.count++;
      _p.set(px[i], py[i], pz[i]);
      _q.set(qx[i], qy[i], qz[i], qw[i]);
      _s.setScalar(scale[i]);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(at, _m);
      const t = age[i] / life[i];
      glowBufs[k].array[at] = glow0[i] * Math.pow(Math.max(0, 1 - t), glowPow[i]);
    }
    for (let k = 0; k < kinds; k++) {
      if (meshes[k].count > 0) {
        meshes[k].instanceMatrix.needsUpdate = true;
        glowBufs[k].needsUpdate = true;
      }
    }
  }

  function trailOf(i) { return trail[i]; }

  function clear() {
    for (let k = count - 1; k >= 0; k--) release(activeList[k]);
    for (const m of meshes) m.count = 0;
  }

  function dispose() {
    group.removeFromParent();
    for (const m of meshes) { m.dispose(); m.material.dispose(); }
    for (const g of geos) g.dispose();
  }

  return {
    name, object3D: group, spawn, update, clear, dispose, trailOf,
    get count() { return count; },
    get capacity() { return N; },
  };
}
