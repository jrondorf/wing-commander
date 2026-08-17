/**
 * Greebles — the small hard-surface detail that makes a hull read as machinery.
 *
 * A 20 m fighter modelled as clean lofted volumes looks like a toy at any range
 * closer than 200 m. What sells scale is the *second* level of structure: vent
 * housings, conduit runs, antenna masts, sensor blisters, ladder rungs, RCS
 * clusters and bolted-on armour. All of it is tiny, all of it repeats, so all of
 * it is instanced.
 *
 * Every geometry here is authored around a 1 m footprint, origin at the mounting
 * face, +Y pointing away from the hull. `scatterGreebles` then places them on an
 * arbitrary target surface with that convention, so a caller can build one
 * `InstancedMesh` per type and pay one draw call each.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeRng } from '../core/Rand.js';
import { fbm2, clamp, heightToNormal } from './noise.js';

// ------------------------------------------------------------------- utilities

function place(geo, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1 } = {}) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz));
  m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy, sz));
  geo.applyMatrix4(m);
  return geo;
}

function finish(parts, name) {
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error(`greebles: merge failed for ${name}`);
  merged.computeVertexNormals();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  merged.name = name;
  // UVs come from the primitives; retile them into a small patch of the hull
  // texture so instanced greebles inherit its plating and grime rather than
  // stretching one plate across the whole part.
  const uv = merged.attributes.uv;
  if (uv) {
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) * 0.09 + 0.4, uv.getY(i) * 0.09 + 0.35);
    }
    uv.needsUpdate = true;
  }
  return merged;
}

// --------------------------------------------------------------- part builders

/** Louvred vent housing: a shallow box with angled slats set into it. */
function makeVent(rng) {
  const w = 0.7 + rng() * 0.5, d = 0.4 + rng() * 0.35, h = 0.09 + rng() * 0.07;
  const parts = [place(new THREE.BoxGeometry(w, h, d), { y: h / 2 })];
  const slats = 3 + ((rng() * 4) | 0);
  const pitch = (d * 0.82) / slats;
  for (let i = 0; i < slats; i++) {
    parts.push(place(new THREE.BoxGeometry(w * 0.86, h * 0.55, pitch * 0.45), {
      y: h * 0.95, z: -d * 0.41 + pitch * (i + 0.5), rx: -0.5,
    }));
  }
  // Frame lip.
  parts.push(place(new THREE.BoxGeometry(w * 1.06, h * 0.35, d * 1.06), { y: h * 0.16 }));
  return finish(parts, 'vent');
}

/** Conduit run: straight sections, elbow knuckles and clamp collars. */
function makePipe(rng) {
  const parts = [];
  const segs = 2 + ((rng() * 3) | 0);
  const r = 0.045 + rng() * 0.045;
  let x = -0.45, y = r * 1.6, dir = 0;
  for (let i = 0; i < segs; i++) {
    const len = 0.25 + rng() * 0.4;
    const cyl = new THREE.CylinderGeometry(r, r, len, 10, 1);
    place(cyl, { x: x + Math.cos(dir) * len / 2, y: y + Math.sin(dir) * len / 2, rz: Math.PI / 2 - dir });
    parts.push(cyl);
    // Clamp collars where the run is bracketed to the hull.
    const collar = new THREE.CylinderGeometry(r * 1.5, r * 1.5, r * 0.7, 10, 1);
    place(collar, { x: x + Math.cos(dir) * len * 0.25, y: y + Math.sin(dir) * len * 0.25, rz: Math.PI / 2 - dir });
    parts.push(collar);
    parts.push(place(new THREE.BoxGeometry(r * 2.6, y, r * 1.1), {
      x: x + Math.cos(dir) * len * 0.25, y: y / 2,
    }));
    x += Math.cos(dir) * len;
    y += Math.sin(dir) * len;
    const knuckle = new THREE.SphereGeometry(r * 1.25, 10, 8);
    place(knuckle, { x, y });
    parts.push(knuckle);
    dir += (rng() - 0.5) * 1.1;
  }
  return finish(parts, 'pipe');
}

/** Antenna mast: tapered pole, crossbars, tip emitter. */
function makeAntenna(rng) {
  const h = 0.8 + rng() * 0.7;
  const parts = [
    place(new THREE.CylinderGeometry(0.10, 0.16, 0.09, 10, 1), { y: 0.045 }),
    place(new THREE.CylinderGeometry(0.018, 0.055, h, 8, 1), { y: 0.09 + h / 2 }),
  ];
  const bars = 1 + ((rng() * 3) | 0);
  for (let i = 0; i < bars; i++) {
    const t = 0.35 + (i / bars) * 0.5;
    const len = (0.30 - i * 0.06) * (0.7 + rng() * 0.6);
    parts.push(place(new THREE.BoxGeometry(len, 0.016, 0.016), { y: 0.09 + h * t, ry: rng() * Math.PI }));
  }
  parts.push(place(new THREE.SphereGeometry(0.035, 8, 6), { y: 0.09 + h }));
  return finish(parts, 'antenna');
}

/** Sensor blister: a faceted dome on a machined ring. */
function makeBlister(rng) {
  const r = 0.22 + rng() * 0.16;
  const dome = new THREE.SphereGeometry(r, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.52);
  place(dome, { y: 0.03, sy: 0.6 + rng() * 0.35 });
  const parts = [
    dome,
    place(new THREE.CylinderGeometry(r * 1.16, r * 1.24, 0.06, 16, 1), { y: 0.03 }),
    place(new THREE.CylinderGeometry(r * 0.55, r * 0.55, 0.02, 12, 1), { y: r * 0.62 }),
  ];
  return finish(parts, 'blister');
}

/** Ladder rung / hand-hold: a recessed U bracket. */
function makeRung(rng) {
  const w = 0.28 + rng() * 0.12;
  const parts = [
    place(new THREE.BoxGeometry(w, 0.035, 0.05), { y: 0.16 }),
    place(new THREE.BoxGeometry(0.045, 0.17, 0.05), { x: -w / 2 + 0.02, y: 0.085 }),
    place(new THREE.BoxGeometry(0.045, 0.17, 0.05), { x: w / 2 - 0.02, y: 0.085 }),
    place(new THREE.BoxGeometry(w * 1.35, 0.02, 0.11), { y: 0.01 }),
  ];
  return finish(parts, 'rung');
}

/** RCS / manoeuvring thruster cluster: nozzle cones on a bolted base. */
function makeThrusterCluster(rng) {
  const count = 3 + ((rng() * 2) | 0);
  const parts = [place(new THREE.CylinderGeometry(0.30, 0.34, 0.07, 14, 1), { y: 0.035 })];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rng() * 0.3;
    const rr = 0.15;
    const bell = new THREE.CylinderGeometry(0.085, 0.045, 0.16, 12, 1, true);
    place(bell, { x: Math.cos(a) * rr, z: Math.sin(a) * rr, y: 0.13, rx: Math.cos(a) * 0.22, rz: -Math.sin(a) * 0.22 });
    parts.push(bell);
    const throat = new THREE.CylinderGeometry(0.05, 0.05, 0.07, 10, 1);
    place(throat, { x: Math.cos(a) * rr, z: Math.sin(a) * rr, y: 0.07 });
    parts.push(throat);
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    parts.push(place(new THREE.CylinderGeometry(0.022, 0.022, 0.03, 6, 1), {
      x: Math.cos(a) * 0.28, z: Math.sin(a) * 0.28, y: 0.075,
    }));
  }
  return finish(parts, 'thruster');
}

/** Bolt-on armour plate: chamfered slab with a fastener row. */
function makeArmourPlate(rng) {
  const w = 0.8 + rng() * 0.6, d = 0.5 + rng() * 0.5, h = 0.07 + rng() * 0.05;
  const parts = [
    place(new THREE.BoxGeometry(w, h, d), { y: h / 2 }),
    // Chamfer read: a slightly smaller slab proud of the first.
    place(new THREE.BoxGeometry(w * 0.9, h * 0.55, d * 0.88), { y: h * 1.12 }),
  ];
  const per = 2 + ((rng() * 3) | 0);
  for (let i = 0; i <= per; i++) {
    const bx = -w / 2 + 0.06 + (w - 0.12) * (i / per);
    for (const bz of [-d / 2 + 0.05, d / 2 - 0.05]) {
      parts.push(place(new THREE.CylinderGeometry(0.028, 0.028, h * 0.5, 6, 1), { x: bx, z: bz, y: h * 1.1 }));
    }
  }
  return finish(parts, 'armour');
}

/** Equipment box: a stack of avionics housings with a handle and a label plate. */
function makeTechBox(rng) {
  const parts = [];
  let y = 0;
  const stack = 1 + ((rng() * 3) | 0);
  for (let i = 0; i < stack; i++) {
    const w = (0.45 + rng() * 0.35) * (1 - i * 0.12);
    const d = (0.35 + rng() * 0.3) * (1 - i * 0.12);
    const h = 0.09 + rng() * 0.13;
    parts.push(place(new THREE.BoxGeometry(w, h, d), { y: y + h / 2 }));
    if (rng() < 0.6) {
      parts.push(place(new THREE.BoxGeometry(w * 0.4, h * 0.3, 0.02), { y: y + h * 0.6, z: d / 2 }));
    }
    y += h;
  }
  parts.push(place(new THREE.CylinderGeometry(0.02, 0.02, 0.22, 6, 1), { y: y + 0.03, rz: Math.PI / 2 }));
  return finish(parts, 'techbox');
}

/** Radiator fin stack — reads as heat rejection, breaks up flat dorsal areas. */
function makeRadiator(rng) {
  const fins = 4 + ((rng() * 5) | 0);
  const w = 0.7 + rng() * 0.4;
  const parts = [place(new THREE.BoxGeometry(w * 1.05, 0.05, 0.34), { y: 0.025 })];
  for (let i = 0; i < fins; i++) {
    parts.push(place(new THREE.BoxGeometry(w, 0.13 + rng() * 0.07, 0.018), {
      y: 0.11, z: -0.15 + (0.3 * i) / (fins - 1 || 1),
    }));
  }
  return finish(parts, 'radiator');
}

// -------------------------------------------------------------------- the set

const BUILDERS = {
  vent: makeVent,
  pipe: makePipe,
  antenna: makeAntenna,
  blister: makeBlister,
  rung: makeRung,
  thruster: makeThrusterCluster,
  armour: makeArmourPlate,
  techbox: makeTechBox,
  radiator: makeRadiator,
};

export const GREEBLE_TYPES = Object.keys(BUILDERS);

/**
 * Build one deterministic family of greeble geometries.
 *
 * @param {number} seed
 * @param {object} [opts]
 * @param {string[]} [opts.types] subset of GREEBLE_TYPES
 * @param {number} [opts.variants=1] distinct shapes per type; >1 returns
 *        `${type}${i}` keys as well so a hull is not covered in clones
 * @returns {Record<string, THREE.BufferGeometry>}
 */
export function generateGreebleSet(seed = 1, { types = GREEBLE_TYPES, variants = 1 } = {}) {
  const out = {};
  for (let vi = 0; vi < variants; vi++) {
    for (const t of types) {
      const rng = makeRng(((seed >>> 0) * 2654435761 + t.charCodeAt(0) * 7919 + vi * 104729) >>> 0 || 1);
      const geo = BUILDERS[t](rng);
      out[vi === 0 ? t : `${t}${vi}`] = geo;
    }
  }
  return out;
}

/** Cached variant for callers that go through the registry. */
export function getGreebleSet(engine, seed = 1, opts = {}) {
  const key = `greebles/${seed}/${(opts.types ?? GREEBLE_TYPES).join(',')}/${opts.variants ?? 1}`;
  const build = () => generateGreebleSet(seed, opts);
  return engine?.registry ? engine.registry.get(key, build) : build();
}

// ------------------------------------------------------------------ scattering

const _v0 = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _n = new THREE.Vector3(), _p = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

/**
 * Area-weighted surface scatter with normal alignment and blue-noise-ish
 * rejection, plus a coherent density field so greebles clump into equipment
 * runs rather than dusting the hull evenly.
 *
 * @param {THREE.BufferGeometry} targetGeometry
 * @param {object} opts
 * @param {number} [opts.seed=1]
 * @param {number} [opts.count=48]
 * @param {string[]} [opts.types] type names to draw from (weights below)
 * @param {Record<string,number>} [opts.weights] relative pick weight per type
 * @param {[number,number]} [opts.scale=[0.6,1.4]]
 * @param {number} [opts.minDistance=0] world-space rejection radius
 * @param {number} [opts.upBias=0] 0 = any facing, 1 = only faces pointing +Y
 * @param {(p:THREE.Vector3, n:THREE.Vector3) => boolean} [opts.filter]
 * @returns {Array<{type:string, position:THREE.Vector3, quaternion:THREE.Quaternion,
 *                  scale:THREE.Vector3, matrix:THREE.Matrix4}>}
 */
export function scatterGreebles(targetGeometry, {
  seed = 1, count = 48, types = GREEBLE_TYPES, weights = null,
  scale = [0.6, 1.4], minDistance = 0, upBias = 0, filter = null,
  densityFrequency = 2.4, jitterRotation = true, sink = 0.02,
} = {}) {
  const rng = makeRng((seed >>> 0) || 1);
  const pos = targetGeometry.attributes.position;
  if (!pos) return [];
  const index = targetGeometry.index;
  const triCount = index ? index.count / 3 : pos.count / 3;

  // Cumulative triangle area for uniform-by-area sampling.
  const cum = new Float64Array(triCount);
  let total = 0;
  const ia = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);
  for (let t = 0; t < triCount; t++) {
    _v0.fromBufferAttribute(pos, ia(t, 0));
    _v1.fromBufferAttribute(pos, ia(t, 1));
    _v2.fromBufferAttribute(pos, ia(t, 2));
    total += _v1.clone().sub(_v0).cross(_v2.clone().sub(_v0)).length() * 0.5;
    cum[t] = total;
  }
  if (total <= 0) return [];

  const typeList = types.filter((t) => t in BUILDERS || true);
  const w = typeList.map((t) => (weights?.[t] ?? 1));
  const wTotal = w.reduce((a, b) => a + b, 0);

  const out = [];
  const tries = count * 12;
  for (let i = 0; i < tries && out.length < count; i++) {
    // Binary search the area CDF.
    const target = rng() * total;
    let lo = 0, hi = triCount - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < target) lo = mid + 1; else hi = mid; }
    const t = lo;
    _v0.fromBufferAttribute(pos, ia(t, 0));
    _v1.fromBufferAttribute(pos, ia(t, 1));
    _v2.fromBufferAttribute(pos, ia(t, 2));
    let a = rng(), b = rng();
    if (a + b > 1) { a = 1 - a; b = 1 - b; }
    _p.copy(_v0).addScaledVector(_v1.clone().sub(_v0), a).addScaledVector(_v2.clone().sub(_v0), b);
    _n.copy(_v1).sub(_v0).cross(_v2.clone().sub(_v0)).normalize();

    if (upBias > 0 && _n.y < upBias * 2 - 1) continue;
    // Coherent density: equipment lives in runs and bays, not evenly sprinkled.
    const dens = fbm2(_p.x * densityFrequency, _p.z * densityFrequency, {
      octaves: 3, seed: seed + 77,
    }) * 0.5 + 0.5;
    if (rng() > clamp(dens * 1.5 - 0.15)) continue;
    if (filter && !filter(_p, _n)) continue;

    if (minDistance > 0) {
      let clash = false;
      for (const o of out) { if (o.position.distanceToSquared(_p) < minDistance * minDistance) { clash = true; break; } }
      if (clash) continue;
    }

    let pick = rng() * wTotal, ti = 0;
    for (; ti < typeList.length - 1; ti++) { pick -= w[ti]; if (pick <= 0) break; }

    const q = new THREE.Quaternion().setFromUnitVectors(_up, _n);
    if (jitterRotation) {
      q.multiply(new THREE.Quaternion().setFromAxisAngle(_up, rng() * Math.PI * 2));
    }
    const s = scale[0] + rng() * (scale[1] - scale[0]);
    const position = _p.clone().addScaledVector(_n, -sink * s);
    const sc = new THREE.Vector3(s, s * (0.75 + rng() * 0.5), s);
    out.push({
      type: typeList[ti],
      position,
      quaternion: q.clone(),
      scale: sc,
      matrix: new THREE.Matrix4().compose(position, q, sc),
    });
  }
  return out;
}

/**
 * Turn placements into one InstancedMesh per type — the form ships/ actually
 * wants, and the form that keeps 400 greebles inside a handful of draw calls.
 *
 * @returns {THREE.InstancedMesh[]}
 */
export function buildGreebleInstances(geometries, placements, material) {
  const byType = new Map();
  for (const p of placements) {
    if (!byType.has(p.type)) byType.set(p.type, []);
    byType.get(p.type).push(p);
  }
  const meshes = [];
  for (const [type, list] of byType) {
    const geo = geometries[type];
    if (!geo) continue;
    const mesh = new THREE.InstancedMesh(geo, material, list.length);
    for (let i = 0; i < list.length; i++) mesh.setMatrixAt(i, list[i].matrix);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.name = `greeble-${type}`;
    meshes.push(mesh);
  }
  return meshes;
}

// -------------------------------------------------------------- greeble atlas

/**
 * A tiling "tech detail" atlas: a grid of machined panel motifs (grilles, bolt
 * plates, conduit runs, hatch faces) rendered as a height/AO pair. Cheap way to
 * add a second scale of detail to a flat capital-ship flank without geometry.
 *
 * Declared in ARCHITECTURE §5.2.
 *
 * @returns {{height: THREE.DataTexture, normal: THREE.DataTexture, cells: number}}
 */
export function generateGreebleAtlas({ size = 1024, seed = 1, cells = 4 } = {}) {
  const rng = makeRng((seed >>> 0) || 1);
  const h = new Float32Array(size * size);
  const cell = Math.floor(size / cells);

  const rect = (x0, y0, w, hh, v) => {
    for (let y = y0; y < y0 + hh; y++) {
      if (y < 0 || y >= size) continue;
      for (let x = x0; x < x0 + w; x++) {
        if (x < 0 || x >= size) continue;
        h[y * size + x] = v;
      }
    }
  };

  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const ox = cx * cell, oy = cy * cell;
      const kind = (rng() * 4) | 0;
      rect(ox + 2, oy + 2, cell - 4, cell - 4, 0.5);
      if (kind === 0) {
        const bars = 4 + ((rng() * 6) | 0);
        for (let i = 0; i < bars; i++) {
          rect(ox + 8, oy + 8 + Math.floor((cell - 16) * i / bars), cell - 16,
            Math.max(2, Math.floor((cell - 16) / bars * 0.55)), 0.72);
        }
      } else if (kind === 1) {
        const n = 2 + ((rng() * 3) | 0);
        for (let i = 0; i < n; i++) {
          const w = Math.floor(cell * (0.15 + rng() * 0.3));
          const hh = Math.floor(cell * (0.15 + rng() * 0.3));
          rect(ox + 6 + Math.floor(rng() * (cell - w - 12)), oy + 6 + Math.floor(rng() * (cell - hh - 12)), w, hh, 0.62 + rng() * 0.25);
        }
      } else if (kind === 2) {
        const r = Math.floor(cell * 0.3);
        const cxp = ox + cell / 2, cyp = oy + cell / 2;
        for (let y = -r; y <= r; y++) {
          for (let x = -r; x <= r; x++) {
            const d = Math.hypot(x, y) / r;
            if (d > 1) continue;
            h[((cyp + y) | 0) * size + ((cxp + x) | 0)] = 0.5 + 0.3 * Math.sqrt(1 - d);
          }
        }
      } else {
        const per = 3 + ((rng() * 3) | 0);
        for (let i = 0; i <= per; i++) {
          for (let j = 0; j <= per; j++) {
            const bx = ox + 10 + Math.floor((cell - 20) * i / per);
            const by = oy + 10 + Math.floor((cell - 20) * j / per);
            rect(bx - 2, by - 2, 5, 5, 0.68);
          }
        }
      }
    }
  }

  const hb = new Uint8Array(size * size);
  for (let i = 0; i < hb.length; i++) hb[i] = clamp(h[i]) * 255;
  const heightTex = new THREE.DataTexture(hb, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  heightTex.wrapS = heightTex.wrapT = THREE.RepeatWrapping;
  heightTex.colorSpace = THREE.NoColorSpace;
  heightTex.needsUpdate = true;

  // Reuse the shared sobel kernel rather than reimplementing it here.
  const normalTex = new THREE.DataTexture(
    heightToNormal(h, size, 2.5), size, size, THREE.RGBAFormat, THREE.UnsignedByteType,
  );
  normalTex.wrapS = normalTex.wrapT = THREE.RepeatWrapping;
  normalTex.colorSpace = THREE.NoColorSpace;
  normalTex.needsUpdate = true;
  return { height: heightTex, normal: normalTex, cells };
}
