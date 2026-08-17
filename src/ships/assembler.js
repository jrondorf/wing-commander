/**
 * ShipAssembler — the accumulator every ship builder writes into.
 *
 * Builders never create Meshes. They push geometry into named material buckets
 * and declare hardpoints; the assembler merges each bucket into exactly one
 * draw call, instances anything repeated, and hands back a Group. That is what
 * keeps a 40 k-triangle fighter down to single-digit draw calls while still
 * being built from a few hundred individually placed parts.
 *
 * Buckets map to the resolved material set:
 *   hull   painted composite (the ship's body colour)
 *   panel  off-white/light plating — armour plates, control surfaces
 *   metal  bare structural metal — nacelles, spars, gun barrels, gear
 *   dark   unlit interiors — duct throats, gear bays, hangar recesses
 *   glass  canopy
 *   chitin alien carapace (falls back to hull for Confed builds)
 *   emis:* emissive, keyed by colour+intensity
 *   lights nav lights, one merged unlit mesh with colours in vertex data
 */
import * as THREE from 'three';
import { mergeGeometries, tint, ensureUV1, triCount, mirrorX, xform, plate } from './geometryKit.js';

const V3 = (v) => (v?.isVector3 ? v.clone() : new THREE.Vector3(v?.[0] ?? 0, v?.[1] ?? 0, v?.[2] ?? 0));

export class ShipAssembler {
  /**
   * @param {object} o
   * @param {number} o.detail 0 = hero, 1 = mid, 2 = distant silhouette
   */
  constructor({ engine, rng, mats, detail = 0, collectHardpoints = true }) {
    this.engine = engine;
    this.rng = rng;
    this.mats = mats;
    this.detail = detail;
    this.buckets = new Map();
    this.instances = [];
    this.collect = collectHardpoints;
    this.hardpoints = {
      guns: [], missiles: [], engines: [], thrusters: [], turrets: [], cockpit: null,
      hangars: [], docks: [],
    };
    this._lightGeos = [];
  }

  /** True when this LOD should still carry small surface detail. */
  get fine() { return this.detail === 0; }
  get mid() { return this.detail <= 1; }

  _bucket(name) {
    let b = this.buckets.get(name);
    if (!b) { b = []; this.buckets.set(name, b); }
    return b;
  }

  /**
   * Push geometry into a bucket. `tone` multiplies the vertex colour; leaving it
   * out applies a small random tone jitter, which is what stops a merged hull
   * reading as one flat grey mass.
   */
  add(bucket, geo, { tone = null, jitter = 0.05, pos, rot, quat, scale, mirror = false } = {}) {
    if (!geo) return this;
    let g = (pos || rot || quat || scale || mirror) ? xform(geo, { pos, rot, quat, scale, mirror }) : geo;
    if (g === geo) g = geo.clone();
    let t = tone;
    if (t == null) {
      const j = 1 + this.rng.gauss(0, jitter);
      t = [j, j, j];
    } else if (typeof t === 'number') t = [t, t, t];
    tint(g, t[0], t[1], t[2]);
    this._bucket(bucket).push(g);
    return this;
  }

  /** Add a part and its mirror image across the centreline. */
  addPair(bucket, geo, opts = {}) {
    this.add(bucket, geo, opts);
    this.add(bucket, mirrorX(geo), opts);
    return this;
  }

  /**
   * Emissive geometry. Intensity runs 4–30 and the post stack blooms it.
   *
   * Every emitter on a ship should share one (colour, intensity) pair and vary its
   * brightness through `tone`, which rides in the vertex colours — that keeps the
   * whole glowing side of a hull inside a single draw call instead of one per
   * brightness level.
   */
  addEmissive(geo, color, intensity, opts = {}) {
    if (!geo) return this;
    return this.add(`emis:${color}|${intensity}`, geo, { tone: 1, jitter: 0, ...opts });
  }

  /** Emissive in the ship's own glow colour — the common case. */
  glow(geo, tone = 1, opts = {}) {
    const p = this.mats.palette;
    return this.addEmissive(geo, p.glow, p.glowIntensity, { tone, ...opts });
  }

  /**
   * Instanced geometry. Calls that share a geometry and a bucket are folded into
   * one InstancedMesh, so a ship can scatter greebles from several places without
   * paying a draw call for each site.
   */
  instance(geo, bucket, matrices, { castShadow = true } = {}) {
    if (!geo || !matrices.length) return this;
    const existing = this.instances.find((i) => i.geo === geo && i.bucket === bucket);
    if (existing) { existing.matrices.push(...matrices); return this; }
    this.instances.push({ geo, bucket, matrices: [...matrices], castShadow });
    return this;
  }

  // ------------------------------------------------------------- hardpoints

  gun(pos, dir, type = 'laser', opts = {}) {
    if (this.collect) this.hardpoints.guns.push({ pos: V3(pos), dir: V3(dir).normalize(), type, ...opts });
    return this;
  }

  missile(pos, dir, capacity = 1, type = 'IR', opts = {}) {
    if (this.collect) this.hardpoints.missiles.push({ pos: V3(pos), dir: V3(dir).normalize(), capacity, type, ...opts });
    return this;
  }

  engineHp(pos, radius, dir = [0, 0, 1], opts = {}) {
    if (this.collect) this.hardpoints.engines.push({ pos: V3(pos), radius, dir: V3(dir).normalize(), ...opts });
    return this;
  }

  thruster(pos, dir, opts = {}) {
    if (this.collect) this.hardpoints.thrusters.push({ pos: V3(pos), dir: V3(dir).normalize(), ...opts });
    return this;
  }

  turret(pos, arc, cls = 'aa', opts = {}) {
    if (this.collect) this.hardpoints.turrets.push({ pos: V3(pos), arc, class: cls, ...opts });
    return this;
  }

  cockpit(pos, quaternion = new THREE.Quaternion()) {
    if (this.collect) this.hardpoints.cockpit = { pos: V3(pos), quaternion: quaternion.clone() };
    return this;
  }

  hangar(pos, size, dir) {
    if (this.collect) this.hardpoints.hangars.push({ pos: V3(pos), size, dir: V3(dir).normalize() });
    return this;
  }

  /**
   * Navigation light — a tiny emissive quad. Red to port, green to starboard,
   * white strobes on the spine and belly. Colour × intensity lives in the vertex
   * colours so every light on the ship is one draw call.
   */
  navLight(pos, color, intensity = 6, size = 0.16, normal = [0, 1, 0]) {
    if (this.detail > 1) return this;
    const c = new THREE.Color(color).multiplyScalar(intensity);
    const g = plate(size * 2, size * 2, size * 0.5, size * 0.35);
    const n = V3(normal).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    const t = xform(g, { pos, quat: q });
    tint(t, c.r, c.g, c.b);
    this._lightGeos.push(t);
    return this;
  }

  // ----------------------------------------------------------------- output

  build() {
    const root = new THREE.Group();
    let tris = 0;
    let draws = 0;

    for (const [name, list] of this.buckets) {
      if (!list.length) continue;
      const merged = list.length === 1 ? list[0] : mergeGeometries(list);
      if (!merged) { console.warn(`[ships] merge failed for bucket "${name}"`); continue; }
      ensureUV1(merged);
      merged.computeBoundingSphere();
      const mat = this._material(name);
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (name === 'glass') { mesh.renderOrder = 2; }
      root.add(mesh);
      tris += triCount(merged);
      draws++;
      for (const g of list) if (g !== merged) g.dispose?.();
    }

    if (this._lightGeos.length) {
      const merged = mergeGeometries(this._lightGeos);
      ensureUV1(merged);
      const mesh = new THREE.Mesh(merged, this.mats.lights);
      mesh.name = 'navlights';
      mesh.renderOrder = 3;
      root.add(mesh);
      tris += triCount(merged);
      draws++;
    }

    for (const inst of this.instances) {
      ensureUV1(inst.geo);
      if (!inst.geo.attributes.color) tint(inst.geo, 1, 1, 1);
      const im = new THREE.InstancedMesh(inst.geo, this._material(inst.bucket), inst.matrices.length);
      for (let i = 0; i < inst.matrices.length; i++) im.setMatrixAt(i, inst.matrices[i]);
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = inst.castShadow;
      im.receiveShadow = true;
      im.frustumCulled = true;
      im.name = `inst:${inst.bucket}`;
      root.add(im);
      tris += triCount(inst.geo) * inst.matrices.length;
      draws++;
    }

    root.userData.tris = Math.round(tris);
    root.userData.draws = draws;
    return { object: root, tris: Math.round(tris), draws };
  }

  _material(name) {
    if (name.startsWith('emis:')) {
      const [color, intensity] = name.slice(5).split('|');
      return this.mats.emissive(color, Number(intensity));
    }
    return this.mats[name] ?? this.mats.hull;
  }
}
