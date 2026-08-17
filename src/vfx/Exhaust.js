/**
 * Engine exhaust plumes.
 *
 * The plume is a **lathed bell**, not a billboard cone: an instanced surface of
 * revolution oriented along the hardpoint's exhaust vector, so it foreshortens
 * correctly when you fly past a ship and vanishes to a bright dot when you look
 * straight up its tailpipe. The fragment shader brightens the silhouette by
 * Fresnel (edge-on paths are optically longer through the gas), tears the flow
 * apart downstream with scrolling noise, and under afterburner lays a train of
 * shock diamonds along the axis.
 *
 * Two instanced draws per frame for the whole fleet:
 *   core  a small, short, near-white bell at the throat
 *   glow  a wider, longer, cooler envelope in the drive's own colour
 *
 * Throttle drives length, radius, temperature and flicker together, which is
 * what makes a ship look like it is *accelerating* rather than like it has a
 * lamp bolted to its rear.
 */

import * as THREE from 'three';
import { GLSL_COMMON, GLSL_SOFT_DEPTH, PLUME_VERT, PLUME_FRAG } from './glsl.js';
import { getNoiseTexture, getBlackbodyRamp } from './Textures.js';

const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 0, 1);

/** Drive colours straight out of ARCHITECTURE §7. */
const DRIVE_COLOR = {
  confed: [0.20, 0.62, 1.0],
  nephilim: [0.62, 1.0, 0.18],
  kilrathi: [0.62, 1.0, 0.18],
  pirate: [1.0, 0.55, 0.16],
  civilian: [1.0, 0.62, 0.22],
  neutral: [1.0, 0.62, 0.22],
};

/** Unit bell: xy is a unit-radius profile, z runs 0 (throat) to 1 (tip). */
function plumeGeometry(segments = 14, rows = 10) {
  const pos = [], nrm = [], uv = [], idx = [];
  const radiusAt = (z) => {
    // Slight over-expansion right at the lip, then a long taper: a real nozzle
    // plume is fattest just outside the bell, not at the throat.
    const bulge = 1.0 + 0.26 * Math.exp(-Math.pow((z - 0.12) / 0.16, 2));
    return bulge * Math.pow(1 - z * 0.985, 0.62);
  };
  for (let r = 0; r <= rows; r++) {
    const z = r / rows;
    const rad = radiusAt(z);
    const dz = 0.004;
    const slope = (radiusAt(Math.min(1, z + dz)) - radiusAt(Math.max(0, z - dz))) / (2 * dz);
    for (let s = 0; s <= segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      pos.push(ca * rad, sa * rad, z);
      // Surface normal of the lathe: radial component, minus the profile slope
      // along the axis.
      const n = new THREE.Vector3(ca, sa, -slope).normalize();
      nrm.push(n.x, n.y, n.z);
      uv.push(z, s / segments);
    }
  }
  const row = segments + 1;
  for (let r = 0; r < rows; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * row + s, b = (r + 1) * row + s;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

function createPlumeLayer(engine, base, { name, capacity, intensity, shock, renderOrder, softScale }) {
  const N = capacity;
  const geo = new THREE.InstancedBufferGeometry();
  geo.setIndex(base.index);
  geo.setAttribute('position', base.attributes.position);
  geo.setAttribute('normal', base.attributes.normal);
  geo.setAttribute('uv', base.attributes.uv);
  geo.instanceCount = 0;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

  const bPos = new Float32Array(N * 3);
  const bQuat = new Float32Array(N * 4);
  const bA = new Float32Array(N * 4);
  const bB = new Float32Array(N * 4);
  const bCol = new Float32Array(N * 3);
  const attrs = {
    iPos: new THREE.InstancedBufferAttribute(bPos, 3).setUsage(THREE.DynamicDrawUsage),
    iQuat: new THREE.InstancedBufferAttribute(bQuat, 4).setUsage(THREE.DynamicDrawUsage),
    iA: new THREE.InstancedBufferAttribute(bA, 4).setUsage(THREE.DynamicDrawUsage),
    iB: new THREE.InstancedBufferAttribute(bB, 4).setUsage(THREE.DynamicDrawUsage),
    iCol: new THREE.InstancedBufferAttribute(bCol, 3).setUsage(THREE.DynamicDrawUsage),
  };
  for (const k in attrs) geo.setAttribute(k, attrs[k]);

  const uniforms = {
    uNoise: { value: getNoiseTexture(engine) },
    uRamp: { value: getBlackbodyRamp(engine) },
    uTime: { value: 0 },
    uIntensity: { value: intensity },
    uShock: { value: shock },
    tSceneDepth: { value: null },
    uInvRes: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    uCameraFar: { value: 8e6 },
    uCameraNear: { value: 1 },
    uHasDepth: { value: 0 },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: GLSL_COMMON + PLUME_VERT,
    fragmentShader: GLSL_COMMON + GLSL_SOFT_DEPTH + PLUME_FRAG,
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
  void softScale;

  let w = 0;
  return {
    mesh, uniforms,
    begin() { w = 0; },
    /** @returns {boolean} false when the layer is full */
    add(pos, quat, radius, length, power, seed, burn, flicker, coreTemp, col) {
      if (w >= N) return false;
      const o3 = w * 3, o4 = w * 4;
      bPos[o3] = pos.x; bPos[o3 + 1] = pos.y; bPos[o3 + 2] = pos.z;
      bQuat[o4] = quat.x; bQuat[o4 + 1] = quat.y; bQuat[o4 + 2] = quat.z; bQuat[o4 + 3] = quat.w;
      bA[o4] = radius; bA[o4 + 1] = length; bA[o4 + 2] = power; bA[o4 + 3] = seed;
      bB[o4] = burn; bB[o4 + 1] = flicker; bB[o4 + 2] = coreTemp; bB[o4 + 3] = 0;
      bCol[o3] = col[0]; bCol[o3 + 1] = col[1]; bCol[o3 + 2] = col[2];
      w++;
      return true;
    },
    end() {
      geo.instanceCount = w;
      if (w > 0) for (const k in attrs) attrs[k].needsUpdate = true;
    },
    dispose() {
      mesh.removeFromParent();
      geo.dispose();
      mat.dispose();
    },
  };
}

export function createExhaustSystem(engine, { capacity = 64 } = {}) {
  const base = plumeGeometry(14, 10);
  const core = createPlumeLayer(engine, base, {
    name: 'vfx:plume:core', capacity, intensity: 5.5, shock: 2.2, renderOrder: 8, softScale: 1.2,
  });
  const glow = createPlumeLayer(engine, base, {
    name: 'vfx:plume:glow', capacity, intensity: 1.5, shock: 1.0, renderOrder: 7, softScale: 1.6,
  });

  const group = new THREE.Group();
  group.name = 'vfx:exhaust';
  group.matrixAutoUpdate = false;
  group.userData.noVelocity = true;
  group.add(glow.mesh, core.mesh);

  const stats = { plumes: 0 };

  function driveColor(ship) {
    const f = ship?.faction ?? ship?.group?.userData?.faction ?? 'confed';
    return DRIVE_COLOR[f] ?? DRIVE_COLOR.confed;
  }

  /**
   * Rebuild every plume from the live ship list. Nothing persists between
   * frames, which is exactly right: a plume has no state, it is a readout of
   * the throttle this instant.
   */
  function update(dt, ships, time) {
    core.begin(); glow.begin();
    stats.plumes = 0;
    core.uniforms.uTime.value = time;
    glow.uniforms.uTime.value = time;

    if (ships) {
      for (let s = 0; s < ships.length; s++) {
        const ship = ships[s];
        const group3 = ship?.group;
        const hps = ship?.hardpoints?.engines ?? group3?.userData?.hardpoints?.engines;
        if (!group3 || !hps || hps.length === 0 || group3.visible === false) continue;

        const body = ship.body;
        const dead = ship.alive === false;
        // FlightBody publishes `enginePower` (0..1 on the main drive, up to 3 on
        // burners) precisely for this; fall back to commanded throttle when the
        // flight system has not attached a body yet.
        let throttle = body
          ? Math.max(body.enginePower ?? 0, body.controls?.throttle ?? 0)
          : 0.55;
        throttle = Math.max(throttle, body?.idleGlow ?? 0.12);
        const burn = body ? (body.abThrottle ?? (body.afterburner ? 1 : 0)) : 0;
        if (dead) throttle = 0;
        if (throttle <= 0.001 && burn <= 0.001) continue;

        const col = driveColor(ship);
        const power = Math.min(3, 0.35 + throttle * 2.0 + burn * 1.1);
        const seedBase = (group3.id % 97) * 0.113;

        for (let e = 0; e < hps.length; e++) {
          const hp = hps[e];
          _p.copy(hp.pos).applyQuaternion(group3.quaternion).add(group3.position);
          _d.copy(hp.dir ?? _up).applyQuaternion(group3.quaternion).normalize();
          _q.setFromUnitVectors(_up, _d);
          const r = (hp.radius ?? 1) * 0.98;
          // Length is the readable throttle cue: idle is a stub, military power
          // is ~7 radii, afterburner nearly doubles it again.
          const len = r * (1.4 + throttle * 6.2 + burn * 5.4);
          const seed = seedBase + e * 0.37;
          const flick = 0.35 + burn * 0.5;

          core.add(_p, _q, r * 0.66, len * 0.68, power, seed, burn, flick, 0.99, col);
          glow.add(_p, _q, r * 1.18, len, power * 0.85, seed + 0.21, burn, flick * 0.6, 0.62, col);
          stats.plumes++;
        }
      }
    }
    core.end(); glow.end();
    void dt;
  }

  return {
    object3D: group,
    layers: [core, glow],
    update,
    stats,
    dispose() {
      core.dispose(); glow.dispose();
      base.dispose();
      group.removeFromParent();
    },
  };
}
