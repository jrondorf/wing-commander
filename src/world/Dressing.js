import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng } from '../core/Rand.js';
import { NOISE_GLSL } from './glsl/noise.glsl.js';
import { fbm3, clamp } from '../procgen/noise.js';

/**
 * Set dressing — the things that make space feel occupied and moving.
 *
 * Dust motes are the cheapest and by far the highest-value item here: a few
 * thousand sub-pixel specks streaming past the canopy give the eye a parallax
 * reference, which is the difference between "the ship is moving" and "the
 * background is scrolling". They live in a box that wraps around the camera in
 * the vertex shader, so they cost one draw call and never need respawning.
 *
 * Beyond that: tumbling wreckage in the near field, distant capital-ship
 * silhouettes at 10–30 km for scale, and a jump point.
 */

// ------------------------------------------------------------------ dust motes

const MOTE_VERT = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
uniform vec3 uCamPos;
uniform float uBox;
uniform float uTime;
uniform float uPixelScale;
varying vec3 vColor;

void main() {
  // Slow ambient churn so the field is never a rigid lattice.
  vec3 p = position + vec3(
    sin(uTime * 0.21 + position.y * 0.03),
    cos(uTime * 0.17 + position.z * 0.03),
    sin(uTime * 0.13 + position.x * 0.03)) * 2.5;

  // Wrap into a box centred on the camera: infinite field, fixed cost.
  vec3 rel = mod(p - uCamPos + uBox * 0.5, uBox) - uBox * 0.5;
  vec4 mv = viewMatrix * vec4(uCamPos + rel, 1.0);
  gl_Position = projectionMatrix * mv;

  float d = max(-mv.z, 0.001);
  gl_PointSize = clamp(aSize * uPixelScale * (55.0 / max(d, 3.0)), 0.6, 7.0);
  float fade = smoothstep(uBox * 0.52, uBox * 0.22, d) * smoothstep(2.0, 12.0, d);
  vColor = aColor * fade;
}
`;

const MOTE_FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = exp(-dot(c, c) * 22.0);
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * a, 1.0);
}
`;

/**
 * Near-camera dust motes — cheap parallax that sells motion.
 *
 * Brightness here was authored against a tone-map exposure of 1.0. Exposure is now
 * 3.2 (see the calibrated-constants table in ARCHITECTURE.md), which turned these
 * into hard white specks scattered over every frame, reading as dead pixels or a
 * dirty lens rather than dust. Values below are scaled back accordingly, and the
 * count is reduced: motes should be felt as motion, not counted.
 */
function createDustMotes(engine, { seed = 1, count = 1100, box = 460 } = {}) {
  const rng = makeRng((seed ^ 0xd05) >>> 0);
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    pos[i * 3] = rng() * box;
    pos[i * 3 + 1] = rng() * box;
    pos[i * 3 + 2] = rng() * box;
    const b = 0.028 + 0.16 * Math.pow(rng(), 2.4);
    // Very slightly cool rather than neutral: dust is lit by the nebula, and pure
    // grey specks read as a compression artefact.
    col[i * 3] = b * 0.92;
    col[i * 3 + 1] = b * 0.97;
    col[i * 3 + 2] = b;
    size[i] = 0.6 + rng() * 1.4;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uCamPos: { value: new THREE.Vector3() },
      uBox: { value: box },
      uTime: { value: 0 },
      uPixelScale: { value: 1 },
    },
    vertexShader: MOTE_VERT,
    fragmentShader: MOTE_FRAG,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 20;
  points.name = 'dust-motes';

  const baseColor = new THREE.Color(1, 1, 1);
  return {
    object3D: points,
    setTint(c) {
      baseColor.copy(c);
      const a = geo.getAttribute('aColor');
      for (let i = 0; i < count; i++) {
        const b = a.array[i * 3];
        // Keep the per-mote brightness, restate the hue.
        const lum = b;
        a.array[i * 3] = c.r * lum;
        a.array[i * 3 + 1] = c.g * lum;
        a.array[i * 3 + 2] = c.b * lum;
      }
      a.needsUpdate = true;
    },
    update(dt, camera) {
      mat.uniforms.uTime.value += dt;
      mat.uniforms.uCamPos.value.copy(camera.position);
    },
    resize(w, h) { mat.uniforms.uPixelScale.value = Math.max(0.7, h / 900); },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}

// ---------------------------------------------------------------- debris field

function chunkGeometry(seed, kind) {
  const rng = makeRng(seed >>> 0);
  let geo;
  if (kind === 0) {
    geo = new THREE.IcosahedronGeometry(1, 1);
  } else if (kind === 1) {
    geo = new THREE.BoxGeometry(1.9, 0.16, 1.2, 2, 1, 2); // hull plating
  } else {
    geo = new THREE.CylinderGeometry(0.35, 0.5, 2.2, 6, 1);
  }
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = fbm3(v.x * 2.4, v.y * 2.4, v.z * 2.4, { octaves: 3, seed });
    v.multiplyScalar(1 + n * 0.35);
    v.x += rng.range(-0.04, 0.04);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

function createDebris(engine, { seed = 1, count = 110, box = 2200 } = {}) {
  const rng = makeRng((seed ^ 0xdeb) >>> 0);
  const material = new THREE.MeshStandardMaterial({
    color: 0x4b525c,
    roughness: 0.72,
    metalness: 0.55,
  });

  const kinds = [0, 1, 2].map((k) => engine.registry.get(`world/debris/${k}`, () => chunkGeometry(1500 + k * 37, k)));
  const per = Math.ceil(count / 3);
  const meshes = [];
  const records = [];

  for (let k = 0; k < 3; k++) {
    const inst = new THREE.InstancedMesh(kinds[k], material, per);
    inst.frustumCulled = false;
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    inst.name = `debris-${k}`;
    const list = [];
    for (let i = 0; i < per; i++) {
      list.push({
        home: new THREE.Vector3(rng() * box, rng() * box, rng() * box),
        quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(rng() * 6.28, rng() * 6.28, rng() * 6.28)),
        spinAxis: new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize(),
        spinRate: rng.range(0.05, 0.5),
        scale: rng.range(0.5, 4.2) * (rng() < 0.12 ? 3.2 : 1),
        drift: new THREE.Vector3(rng.range(-4, 4), rng.range(-2, 2), rng.range(-4, 4)),
      });
    }
    meshes.push({ inst, list });
    records.push(...list);
  }

  const group = new THREE.Group();
  group.name = 'debris';
  for (const m of meshes) group.add(m.inst);

  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3();
  const _p = new THREE.Vector3();
  let time = 0;

  return {
    object3D: group,
    update(dt, camera) {
      time += dt;
      const c = camera.position;
      for (const { inst, list } of meshes) {
        for (let i = 0; i < list.length; i++) {
          const r = list[i];
          _q.setFromAxisAngle(r.spinAxis, r.spinRate * dt);
          r.quaternion.premultiply(_q).normalize();
          // Wrap the drifting home position into a box around the camera.
          _p.copy(r.home).addScaledVector(r.drift, time);
          _p.x = ((_p.x - c.x + box * 0.5) % box + box) % box - box * 0.5 + c.x;
          _p.y = ((_p.y - c.y + box * 0.5) % box + box) % box - box * 0.5 + c.y;
          _p.z = ((_p.z - c.z + box * 0.5) % box + box) % box - box * 0.5 + c.z;
          _s.setScalar(r.scale);
          _m.compose(_p, r.quaternion, _s);
          inst.setMatrixAt(i, _m);
        }
        inst.instanceMatrix.needsUpdate = true;
      }
    },
    dispose() {
      for (const { inst } of meshes) inst.dispose();
      material.dispose();
    },
  };
}

// --------------------------------------------------- distant capital silhouettes

function capitalSilhouette(seed) {
  const rng = makeRng(seed >>> 0);
  const parts = [];
  const glow = [];
  const L = rng.range(420, 1150);
  const W = L * rng.range(0.12, 0.20);
  const H = L * rng.range(0.10, 0.16);

  const push = (arr, g, x, y, z, rx = 0, ry = 0) => {
    g.translate(x, y, z);
    if (rx || ry) {
      g.rotateX(rx);
      g.rotateY(ry);
    }
    arr.push(g);
  };

  // Spine.
  push(parts, new THREE.BoxGeometry(W, H, L), 0, 0, 0);
  // Bow wedge.
  push(parts, new THREE.CylinderGeometry(0.001, W * 0.55, L * 0.24, 4, 1).rotateX(-Math.PI / 2), 0, 0, -L * 0.60);
  // Engine block.
  push(parts, new THREE.BoxGeometry(W * 1.25, H * 1.1, L * 0.16), 0, 0, L * 0.52);
  // Flight deck slab.
  push(parts, new THREE.BoxGeometry(W * 1.9, H * 0.42, L * 0.55), 0, -H * 0.42, -L * 0.05);
  // Superstructure.
  const towers = rng.int(2, 4);
  for (let i = 0; i < towers; i++) {
    const t = rng.range(-0.35, 0.35);
    push(parts, new THREE.BoxGeometry(W * rng.range(0.22, 0.45), H * rng.range(0.5, 1.3), L * rng.range(0.05, 0.13)),
      rng.range(-W * 0.3, W * 0.3), H * 0.7, L * t);
  }
  // Sponsons.
  for (let s = -1; s <= 1; s += 2) {
    push(parts, new THREE.BoxGeometry(W * 0.4, H * 0.4, L * 0.30), s * W * 0.75, -H * 0.1, L * 0.1);
  }
  // Greeble strip.
  for (let i = 0; i < 16; i++) {
    push(parts, new THREE.BoxGeometry(W * rng.range(0.05, 0.16), H * rng.range(0.08, 0.3), L * rng.range(0.01, 0.05)),
      rng.range(-W * 0.5, W * 0.5), rng.range(-H * 0.5, H * 0.6), rng.range(-L * 0.45, L * 0.45));
  }

  // Emissive window rows + engine bells.
  for (let i = 0; i < 26; i++) {
    push(glow, new THREE.BoxGeometry(W * 0.02, H * 0.035, L * rng.range(0.02, 0.08)),
      (rng.bool() ? 1 : -1) * W * 0.505, rng.range(-H * 0.35, H * 0.42), rng.range(-L * 0.42, L * 0.42));
  }
  for (let i = 0; i < 4; i++) {
    push(glow, new THREE.CylinderGeometry(W * 0.14, W * 0.14, L * 0.012, 10, 1).rotateX(Math.PI / 2),
      (i - 1.5) * W * 0.42, 0, L * 0.605);
  }

  return {
    hull: mergeGeometries(parts, false),
    glow: mergeGeometries(glow, false),
    length: L,
  };
}

function createCapitals(engine, { seed = 1, count = 3 } = {}) {
  const rng = makeRng((seed ^ 0xca9) >>> 0);
  const group = new THREE.Group();
  group.name = 'distant-capitals';

  const hullMat = new THREE.MeshStandardMaterial({
    color: 0x2c333c,
    roughness: 0.62,
    metalness: 0.35,
  });
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xffcf8a, toneMapped: false });
  glowMat.color.multiplyScalar(2.4);

  const built = [];
  for (let i = 0; i < count; i++) {
    const s = capitalSilhouette(6100 + i * 271);
    const hull = new THREE.Mesh(s.hull, hullMat);
    const glow = new THREE.Mesh(s.glow, glowMat);
    const ship = new THREE.Group();
    ship.add(hull, glow);

    const dist = rng.range(9000, 30000);
    const dir = new THREE.Vector3(rng.range(-1, 1), rng.range(-0.24, 0.24), rng.range(-1, -0.15)).normalize();
    ship.position.copy(dir).multiplyScalar(dist);
    ship.rotation.set(rng.range(-0.2, 0.2), rng.range(0, Math.PI * 2), rng.range(-0.12, 0.12));
    group.add(ship);
    built.push({ ship, drift: rng.range(0.4, 1.6), yaw: rng.range(-0.004, 0.004) });
  }

  return {
    object3D: group,
    update(dt) {
      for (const b of built) {
        b.ship.rotateY(b.yaw * dt);
        b.ship.position.z -= b.drift * dt;
      }
    },
    dispose() {
      hullMat.dispose();
      glowMat.dispose();
      group.traverse((o) => o.geometry?.dispose?.());
    },
  };
}

// ------------------------------------------------------------------ jump point

const JUMP_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUvJ;
uniform float uTime;
uniform vec3 uColA;
uniform vec3 uColB;

${NOISE_GLSL}

void main() {
  vec2 q = vUvJ * 2.0 - 1.0;
  float r = length(q);
  if (r > 1.0) discard;
  float ang = atan(q.y, q.x);

  // Accretion spiral: phase winds up as it approaches the throat.
  float spiral = sin(ang * 3.0 + 9.0 / max(r, 0.10) - uTime * 1.8) * 0.5 + 0.5;
  float turb = wcFbm(vec3(q * 3.4, uTime * 0.22), 4) * 0.5 + 0.5;

  float ring = smoothstep(1.0, 0.72, r) * smoothstep(0.16, 0.46, r);
  float core = exp(-r * r * 16.0);
  float a = ring * (0.35 + 0.85 * spiral) * (0.35 + 0.9 * turb) + core * 1.8;

  vec3 col = mix(uColA, uColB, turb * spiral) * a;
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

const JUMP_VERT = /* glsl */ `
varying vec2 vUvJ;
void main() {
  vUvJ = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

function createJumpPoint(engine, { seed = 1, position = new THREE.Vector3(-9000, 1800, -13000), radius = 520 } = {}) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColA: { value: new THREE.Vector3(0.25, 0.85, 1.5) },
      uColB: { value: new THREE.Vector3(1.1, 0.45, 1.6) },
    },
    vertexShader: JUMP_VERT,
    fragmentShader: JUMP_FRAG,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2), mat);
  mesh.position.copy(position);
  mesh.name = 'jump-point';
  mesh.renderOrder = 3;

  return {
    object3D: mesh,
    update(dt, camera) {
      mat.uniforms.uTime.value += dt;
      mesh.quaternion.copy(camera.quaternion);
    },
    setColors(a, b) {
      mat.uniforms.uColA.value.copy(a);
      mat.uniforms.uColB.value.copy(b);
    },
    dispose() { mesh.geometry.dispose(); mat.dispose(); },
  };
}

/** Assemble every set-dressing element into one handle. */
export function createDressing(engine, { seed = 1337 } = {}) {
  const t0 = performance.now();
  const motes = createDustMotes(engine, { seed });
  const debris = createDebris(engine, { seed });
  const capitals = createCapitals(engine, { seed });
  const jump = createJumpPoint(engine, { seed });

  const group = new THREE.Group();
  group.name = 'set-dressing';
  group.add(motes.object3D, debris.object3D, capitals.object3D, jump.object3D);

  return {
    object3D: group,
    ms: +(performance.now() - t0).toFixed(1),
    setTint(color) {
      motes.setTint(color);
    },
    update(dt, camera) {
      motes.update(dt, camera);
      debris.update(dt, camera);
      capitals.update(dt);
      jump.update(dt, camera);
    },
    resize(w, h) { motes.resize(w, h); },
    dispose() {
      motes.dispose();
      debris.dispose();
      capitals.dispose();
      jump.dispose();
    },
  };
}

export { clamp };
