import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng } from '../core/Rand.js';
import {
  fbm2, fbm3, ridged2, ridged3, worley2, cellValue,
  heightToNormal, clamp, smoothstep,
} from '../procgen/noise.js';

/**
 * Asteroid fields.
 *
 * Twelve base meshes across three LOD tiers, each an icosphere pushed around by
 * `fbm3`/`ridged3` from procgen/noise and then carved with explicit crater bowls
 * (depressed floor, raised rim) — so silhouettes read as eroded rock, not as
 * lumpy spheres. Big rocks get the 1280-triangle tier, gravel gets the 80, and
 * the size distribution is a power law so most of the field is gravel.
 *
 * Surface detail is triplanar-projected: a UV-mapped icosphere has a pinch at
 * the poles and a seam down one side, both of which are instantly visible on a
 * rock. Triplanar has neither, and it lets one tiling material set serve every
 * base mesh at any scale.
 *
 * Rendering is one `InstancedMesh` per base mesh — 12 draw calls for 600 rocks.
 * Positions are static (only the tumble animates) so the broadphase grid used by
 * `queryAsteroids()` never needs rebuilding.
 */

const DETAIL_SIZE = 384;

// ------------------------------------------------------------ material maps

function generateRockMaps(engine, seed) {
  return engine.registry.get(`world/rock/${DETAIL_SIZE}/${seed}`, () => {
    const N = DETAIL_SIZE;
    const P = 8; // tiling period in noise cells
    const height = new Float32Array(N * N);
    const albedo = new Uint8Array(N * N * 4);
    const orm = new Uint8Array(N * N * 4);

    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        const u = (x / N) * P;
        const v = (y / N) * P;

        let h = 0.5 + 0.40 * fbm2(u, v, { octaves: 6, period: P, seed: seed + 1 });
        h += 0.26 * (ridged2(u * 2, v * 2, { octaves: 5, period: P * 2, seed: seed + 2 }) - 0.48);

        // Micro-craters: worley pits with raised rims.
        const w1 = worley2(u * 3, v * 3, { seed: seed + 3, period: P * 3 });
        const live1 = cellValue(w1.id, 5) > 0.45 ? 1 : 0;
        const d1 = w1.f1;
        h -= live1 * 0.16 * (1 - smoothstep(0.0, 0.30, d1));
        h += live1 * 0.09 * smoothstep(0.42, 0.30, d1) * smoothstep(0.18, 0.30, d1);

        const w2 = worley2(u * 9, v * 9, { seed: seed + 4, period: P * 9 });
        h -= (cellValue(w2.id, 9) > 0.62 ? 1 : 0) * 0.07 * (1 - smoothstep(0.0, 0.26, w2.f1));

        h += 0.05 * fbm2(u * 6, v * 6, { octaves: 3, period: P * 6, seed: seed + 5 });
        height[i] = clamp(h, 0, 1);
      }
    }

    const normal = heightToNormal(height, N, 2.6);

    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        const u = (x / N) * P;
        const v = (y / N) * P;
        const h = height[i];

        // Cavity: compare against a blurred neighbourhood so pits darken.
        const around = (height[((y + 3) % N) * N + x] + height[((y - 3 + N) % N) * N + x]
          + height[y * N + ((x + 3) % N)] + height[y * N + ((x - 3 + N) % N)]) * 0.25;
        const cavity = clamp(1 - (around - h) * 5.5, 0.25, 1);

        // Per-patch mineral tone so the albedo is never a constant grey.
        const patch = worley2(u * 2.2, v * 2.2, { seed: seed + 7, period: P * 2 });
        const tone = cellValue(patch.id, 11);
        const dust = 0.5 + 0.5 * fbm2(u * 14, v * 14, { octaves: 3, period: P * 14, seed: seed + 8 });

        const base = 0.20 + 0.30 * h * cavity;
        const warm = 0.86 + 0.30 * tone;
        const r = clamp(base * warm * (0.85 + 0.3 * dust), 0, 1);
        const g = clamp(base * (0.90 + 0.12 * tone) * (0.85 + 0.3 * dust), 0, 1);
        const b = clamp(base * (0.86 - 0.06 * tone) * (0.85 + 0.3 * dust), 0, 1);

        const j = i * 4;
        // Stored as sRGB albedo; three decodes with an sRGB internal format.
        albedo[j] = Math.pow(r, 1 / 2.2) * 255;
        albedo[j + 1] = Math.pow(g, 1 / 2.2) * 255;
        albedo[j + 2] = Math.pow(b, 1 / 2.2) * 255;
        albedo[j + 3] = 255;

        // R = cavity AO, G = roughness, B = metal mask.
        const rough = clamp(0.62 + 0.34 * (1 - h) - 0.20 * tone + 0.12 * dust, 0.18, 1);
        const metal = clamp(smoothstep(0.72, 0.94, tone) * (0.4 + 0.6 * h), 0, 1);
        orm[j] = cavity * 255;
        orm[j + 1] = rough * 255;
        orm[j + 2] = metal * 255;
        orm[j + 3] = 255;
      }
    }

    const mk = (data, colorSpace) => {
      const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = Math.min(8, engine.maxAnisotropy);
      t.colorSpace = colorSpace;
      t.needsUpdate = true;
      return t;
    };

    return {
      albedo: mk(albedo, THREE.SRGBColorSpace),
      normal: mk(normal, THREE.NoColorSpace),
      orm: mk(orm, THREE.NoColorSpace),
    };
  });
}

// ------------------------------------------------------------- base meshes

function buildAsteroidGeometry(detail, seed) {
  let geo = new THREE.IcosahedronGeometry(1, detail);
  geo = mergeVertices(geo, 1e-5);

  const rng = makeRng(seed >>> 0);
  const ax = rng.range(0.62, 1.05);
  const ay = rng.range(0.55, 0.95);
  const az = rng.range(0.68, 1.10);

  const craters = [];
  const nC = rng.int(3, 9);
  for (let i = 0; i < nC; i++) {
    const z = rng() * 2 - 1;
    const a = rng() * Math.PI * 2;
    const s = Math.sqrt(Math.max(0, 1 - z * z));
    craters.push({
      dir: new THREE.Vector3(s * Math.cos(a), z, s * Math.sin(a)),
      R: rng.range(0.20, 0.62),
      d: rng.range(0.07, 0.20),
    });
  }

  const pos = geo.attributes.position;
  const n = new THREE.Vector3();
  let maxR = 0;
  for (let i = 0; i < pos.count; i++) {
    n.fromBufferAttribute(pos, i).normalize();
    let r = 1;
    r += 0.30 * fbm3(n.x * 1.7, n.y * 1.7, n.z * 1.7, { octaves: 4, seed });
    r += 0.22 * (ridged3(n.x * 2.6, n.y * 2.6, n.z * 2.6, { octaves: 5, seed: seed + 7 }) - 0.46);
    r += 0.075 * fbm3(n.x * 6.2, n.y * 6.2, n.z * 6.2, { octaves: 3, seed: seed + 31 });

    for (const c of craters) {
      const d = Math.acos(clamp(n.dot(c.dir), -1, 1));
      if (d < c.R * 1.25) {
        const t = d / c.R;
        if (t < 1) r -= c.d * (1 - t * t) * (1 - t * 0.35);
        // Raised rim just outside the bowl.
        r += c.d * 0.5 * Math.exp(-((t - 1.0) ** 2) / 0.02);
      }
    }

    r = Math.max(0.38, r);
    const px = n.x * r * ax, py = n.y * r * ay, pz = n.z * r * az;
    pos.setXYZ(i, px, py, pz);
    maxR = Math.max(maxR, Math.hypot(px, py, pz));
  }

  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  geo.userData.maxRadius = maxR;
  return geo;
}

// ------------------------------------------------------------------ shader

const TRIPLANAR_PARS = /* glsl */ `
uniform sampler2D uAlbedo;
uniform sampler2D uNormalT;
uniform sampler2D uORM;
uniform float uTriScale;
uniform float uNormalStrength;
varying vec3 vTriPos;
varying vec3 vTriNrm;
varying vec3 vTint;
varying float vVariantF;
varying mat3 vObjToView;

vec3 wcTriWeights(vec3 n) {
  vec3 w = pow(abs(n), vec3(4.0));
  return w / max(w.x + w.y + w.z, 1e-5);
}

vec4 wcTriSample(sampler2D tex, vec3 p, vec3 w) {
  return texture2D(tex, p.yz) * w.x + texture2D(tex, p.zx) * w.y + texture2D(tex, p.xy) * w.z;
}
`;

export function createAsteroidField(engine, {
  center = new THREE.Vector3(),
  radius = 3000,
  count = 600,
  seed = 1,
  minSize = 6.5,
  maxSize = 190,
} = {}) {
  const t0 = performance.now();
  const rng = makeRng((seed ^ 0x2b17) >>> 0);
  const maps = generateRockMaps(engine, 91);

  // ---- 12 base meshes over three LOD tiers ---------------------------------
  const tiers = [
    { detail: 3, n: 4 },   // 1280 tris — the hero rocks
    { detail: 2, n: 4 },   // 320 tris
    { detail: 1, n: 4 },   // 80 tris — gravel
  ];
  const bases = [];
  for (const tier of tiers) {
    for (let i = 0; i < tier.n; i++) {
      const key = `world/asteroid/${tier.detail}/${i}`;
      const geo = engine.registry.get(key, () => buildAsteroidGeometry(tier.detail, 3701 + tier.detail * 97 + i * 13));
      bases.push({ geo: geo.clone(), tier: tier.detail, maxRadius: geo.userData.maxRadius });
    }
  }

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.85,
    metalness: 0.0,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uAlbedo = { value: maps.albedo };
    shader.uniforms.uNormalT = { value: maps.normal };
    shader.uniforms.uORM = { value: maps.orm };
    shader.uniforms.uTriScale = { value: 0.55 };
    shader.uniforms.uNormalStrength = { value: 1.15 };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aRock;
        attribute vec3 aTint;
        varying vec3 vTriPos;
        varying vec3 vTriNrm;
        varying vec3 vTint;
        varying float vVariantF;
        varying mat3 vObjToView;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vTriPos = position + aRock.yzw;
        vTriNrm = normal;
        vTint = aTint;
        vVariantF = aRock.x;
        #ifdef USE_INSTANCING
          mat3 wcIm = mat3(instanceMatrix);
          wcIm[0] = normalize(wcIm[0]); wcIm[1] = normalize(wcIm[1]); wcIm[2] = normalize(wcIm[2]);
          vObjToView = normalMatrix * wcIm;
        #else
          vObjToView = normalMatrix;
        #endif`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${TRIPLANAR_PARS}`)
      .replace('#include <map_fragment>', `
        vec3 triP = vTriPos * uTriScale;
        vec3 triW = wcTriWeights(normalize(vTriNrm));
        vec4 rockAlbedo = wcTriSample(uAlbedo, triP, triW);
        vec4 rockORM = wcTriSample(uORM, triP, triW);
        diffuseColor.rgb *= rockAlbedo.rgb * vTint * rockORM.r;
      `)
      .replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = roughness * (0.55 + 0.95 * rockORM.g);
        if (vVariantF > 1.5) roughnessFactor *= 0.30;        // ice
        else if (vVariantF > 0.5) roughnessFactor *= 0.60;   // metallic
        roughnessFactor = clamp(roughnessFactor, 0.05, 1.0);
      `)
      .replace('#include <metalnessmap_fragment>', `
        float metalnessFactor = 0.02 + 0.35 * rockORM.b;
        if (vVariantF > 0.5 && vVariantF < 1.5) metalnessFactor = 0.55 + 0.42 * rockORM.b;
        else if (vVariantF > 1.5) metalnessFactor = 0.02;
      `)
      .replace('#include <normal_fragment_maps>', `
        vec3 gN = normalize(vTriNrm);
        vec3 s = sign(gN);
        vec3 tnx = texture2D(uNormalT, triP.yz).xyz * 2.0 - 1.0;
        vec3 tny = texture2D(uNormalT, triP.zx).xyz * 2.0 - 1.0;
        vec3 tnz = texture2D(uNormalT, triP.xy).xyz * 2.0 - 1.0;
        vec3 dOx = vec3(tnx.z * s.x, tnx.x, tnx.y);
        vec3 dOy = vec3(tny.y, tny.z * s.y, tny.x);
        vec3 dOz = vec3(tnz.x, tnz.y, tnz.z * s.z);
        vec3 det = dOx * triW.x + dOy * triW.y + dOz * triW.z;
        vec3 tangential = det - gN * dot(det, gN);
        vec3 nObj = normalize(gN + tangential * uNormalStrength);
        normal = normalize(vObjToView * nObj);
      `);

    material.userData.shader = shader;
  };
  material.customProgramCacheKey = () => 'wc-asteroid-triplanar';

  // ---- instance distribution ----------------------------------------------
  const group = new THREE.Group();
  group.name = 'asteroid-field';

  const buckets = bases.map(() => []);
  const records = [];

  for (let i = 0; i < count; i++) {
    // Power-law size: many gravel, few monsters.
    const u = Math.max(1e-4, rng());
    let size = minSize * Math.pow(u, -1 / 1.55);
    size = Math.min(size, maxSize);

    // Flattened ellipsoid cloud with a soft-centre density.
    const z = rng() * 2 - 1;
    const a = rng() * Math.PI * 2;
    const s = Math.sqrt(Math.max(0, 1 - z * z));
    const rr = radius * Math.pow(rng(), 0.42);
    const p = new THREE.Vector3(
      center.x + s * Math.cos(a) * rr,
      center.y + z * rr * 0.5,
      center.z + s * Math.sin(a) * rr,
    );
    // Break the perfect ellipsoid up with a low-frequency clumping field.
    const clump = fbm3(p.x * 0.0006, p.y * 0.0006, p.z * 0.0006, { octaves: 3, seed: seed + 3 });
    p.addScaledVector(new THREE.Vector3(clump, -clump * 0.5, clump * 0.8), radius * 0.20);

    let tierBase;
    if (size > 34) tierBase = rng.int(0, 3);
    else if (size > 12) tierBase = 4 + rng.int(0, 3);
    else tierBase = 8 + rng.int(0, 3);

    const variant = rng() < 0.12 ? 1 : (rng() < 0.09 ? 2 : 0);
    const tint = variant === 2
      ? new THREE.Color(0.78, 0.86, 0.95)
      : variant === 1
        ? new THREE.Color(0.72, 0.68, 0.62)
        : new THREE.Color(0.72 + rng.range(-0.14, 0.20), 0.68 + rng.range(-0.13, 0.17), 0.62 + rng.range(-0.12, 0.15));

    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rng() * 6.28, rng() * 6.28, rng() * 6.28));
    const spinAxis = new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize();
    // Big rocks tumble slowly — angular momentum scales badly with size.
    const spinRate = rng.range(0.02, 0.55) * Math.pow(12 / size, 0.55);

    const rec = {
      position: p,
      radius: size * bases[tierBase].maxRadius,
      size,
      quaternion: q,
      spinAxis,
      spinRate,
      base: tierBase,
      slot: buckets[tierBase].length,
      variant,
      tint,
    };
    buckets[tierBase].push(rec);
    records.push(rec);
  }

  const meshes = [];
  let triangles = 0;
  for (let b = 0; b < bases.length; b++) {
    const list = buckets[b];
    if (!list.length) continue;
    const geo = bases[b].geo;
    const inst = new THREE.InstancedMesh(geo, material, list.length);
    inst.name = `asteroids-${b}`;
    inst.frustumCulled = false;

    const rockAttr = new Float32Array(list.length * 4);
    const tintAttr = new Float32Array(list.length * 3);
    const m = new THREE.Matrix4();
    const sv = new THREE.Vector3();
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      sv.setScalar(r.size);
      m.compose(r.position, r.quaternion, sv);
      inst.setMatrixAt(i, m);
      rockAttr[i * 4] = r.variant;
      rockAttr[i * 4 + 1] = rng.range(-40, 40);
      rockAttr[i * 4 + 2] = rng.range(-40, 40);
      rockAttr[i * 4 + 3] = rng.range(-40, 40);
      tintAttr[i * 3] = r.tint.r;
      tintAttr[i * 3 + 1] = r.tint.g;
      tintAttr[i * 3 + 2] = r.tint.b;
    }
    geo.setAttribute('aRock', new THREE.InstancedBufferAttribute(rockAttr, 4));
    geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tintAttr, 3));
    inst.instanceMatrix.needsUpdate = true;
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(inst);
    meshes.push({ inst, list });
    triangles += (geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3) * list.length;
  }

  // ---- broadphase grid for collision queries -------------------------------
  const cellSize = Math.max(120, radius / 12);
  const grid = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  for (const r of records) {
    const cx = Math.floor(r.position.x / cellSize);
    const cy = Math.floor(r.position.y / cellSize);
    const cz = Math.floor(r.position.z / cellSize);
    const k = key(cx, cy, cz);
    let arr = grid.get(k);
    if (!arr) grid.set(k, (arr = []));
    arr.push(r);
  }

  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3();

  return {
    object3D: group,
    records,
    count: records.length,
    triangles,
    drawCalls: meshes.length,
    ms: +(performance.now() - t0).toFixed(1),

    update(dt) {
      for (const { inst, list } of meshes) {
        for (let i = 0; i < list.length; i++) {
          const r = list[i];
          _q.setFromAxisAngle(r.spinAxis, r.spinRate * dt);
          r.quaternion.premultiply(_q).normalize();
          _s.setScalar(r.size);
          _m.compose(r.position, r.quaternion, _s);
          inst.setMatrixAt(i, _m);
        }
        inst.instanceMatrix.needsUpdate = true;
      }
    },

    /** @param {THREE.Sphere} sphere @returns {Array<{position:THREE.Vector3, radius:number}>} */
    query(sphere, out = []) {
      const r = sphere.radius;
      const c = sphere.center;
      const x0 = Math.floor((c.x - r) / cellSize), x1 = Math.floor((c.x + r) / cellSize);
      const y0 = Math.floor((c.y - r) / cellSize), y1 = Math.floor((c.y + r) / cellSize);
      const z0 = Math.floor((c.z - r) / cellSize), z1 = Math.floor((c.z + r) / cellSize);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          for (let z = z0; z <= z1; z++) {
            const arr = grid.get(key(x, y, z));
            if (!arr) continue;
            for (const a of arr) {
              const d = a.position.distanceTo(c);
              if (d <= r + a.radius) out.push(a);
            }
          }
        }
      }
      return out;
    },

    dispose() {
      for (const { inst } of meshes) {
        inst.geometry.dispose();
        inst.dispose();
      }
      material.dispose();
    },
  };
}
