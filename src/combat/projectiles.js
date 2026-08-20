/**
 * src/combat/projectiles.js — pooled, instanced, swept-collision gun bolts.
 *
 * ## Pooling
 *
 * A forty-ship furball fires several hundred rounds a second. Nothing here
 * allocates after construction: positions and velocities live in typed arrays,
 * slots come off a free list, and the whole flight of bolts draws in two
 * instanced calls (a hot core and a wider halo).
 *
 * ## Collision — the important part
 *
 * Bolts are tested as a **swept sphere along the frame's travel segment**, in
 * the target's moving frame, against the ship's oriented bounding box.
 *
 * Why it has to be that way: a tachyon bolt does 2200 m/s. At 60 fps that is
 * 37 m of travel in one step. A Vampire is 22 m long. A point test asks "is the
 * bolt inside the ship *right now*" twice — once 20 m short of the nose and once
 * 17 m past the tail — and answers "no" both times. Every fast weapon in the
 * game would pass straight through every fighter in the game. The sweep asks
 * instead "did the *segment* the bolt travelled intersect the hull", which is
 * the only question with a correct answer.
 *
 * The segment is taken in the target's frame (relative velocity), so a fighter
 * crossing at 500 m/s cannot slide out from under the test either.
 *
 * ## Ballistics
 *
 * Muzzle velocity is `shipVelocity + boresight * weapon.speed`. That single line
 * is why deflection shooting works: your own speed is in the shot, so a shot
 * fired while turning hard leads the target for free, and the ITTS solution in
 * targeting.js accounts for it by solving in relative space.
 */
import * as THREE from 'three';
import {
  segmentVsOBB, segmentNearSphere, segmentClosestT, makeHitRef, isAlive,
} from './util.js';
import { rangeFalloff } from './weapons.js';

const _p1 = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 0, 1);
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _p0 = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _bufSize = new THREE.Vector2();

/*
 * ---------------------------------------------------------------------------
 * Tracer legibility
 * ---------------------------------------------------------------------------
 * A particle bolt leaves the muzzle at 1500 m/s and an ion cannon at 3000. At
 * 60 fps that is 25-50 m of travel between one rendered frame and the next,
 * against a bolt 12-26 m long: the stream renders as isolated dots with gaps
 * two to four times their own length, and the first frame a shot is ever drawn
 * it is already 25-50 m clear of the gun. Measured in the cockpit, a five-second
 * burst put nine live bolts within 1.4 px of the reticle centre and not one
 * pixel of tracer anywhere in frame.
 *
 * The fix is the same one every gun camera has: draw the *swept segment*, not
 * the projectile. Each bolt is stretched over the ground it actually covered
 * this frame, so one round's successive frames abut and it reads as a streak
 * instead of a dot hopping 30 m at a time. Its cross-section is floored in
 * *screen* space too, so a tracer at 3 km is a few pixels wide instead of
 * vanishing. Measured broadside, a burst now reads as a line of bright dashes
 * crossing the frame — the gaps between *separate rounds* are real (8 rounds a
 * second at 1900 m/s is one every 240 m) and are meant to be there; what is
 * gone is the gap inside a single round's own trace.
 *
 * Only the rendering changes. `rad[i]` still drives collision, so none of this
 * moves a hit by a millimetre.
 */
/** Longest streak a single frame may draw, metres. Caps a post-stall dt spike. */
const MAX_STREAK = 320;
/** Floor on the core's on-screen radius, in pixels at the current framebuffer. */
const MIN_CORE_PX = 1.4;
/** Floor on the halo's on-screen radius. This is what actually reads at range. */
const MIN_HALO_PX = 4.0;

/** Elongated bipyramid along +Z, unit length, radius 0.5. 2*seg triangles. */
function boltGeometry(seg = 8) {
  const pos = [];
  const idx = [];
  pos.push(0, 0, 0.5); // 0: nose
  pos.push(0, 0, -0.5); // 1: tail
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pos.push(Math.cos(a) * 0.5, Math.sin(a) * 0.5, 0);
  }
  for (let i = 0; i < seg; i++) {
    const a = 2 + i;
    const b = 2 + ((i + 1) % seg);
    idx.push(0, a, b);
    idx.push(1, b, a);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function cachedBoltAssets(engine) {
  const reg = engine?.registry;
  const make = () => {
    const geo = boltGeometry(8);
    const core = new THREE.MeshBasicMaterial({
      color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false,
      transparent: true, opacity: 1, toneMapped: false, side: THREE.DoubleSide,
    });
    const halo = new THREE.MeshBasicMaterial({
      color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false,
      transparent: true, opacity: 0.32, toneMapped: false, side: THREE.DoubleSide,
    });
    return { geo, core, halo };
  };
  return reg ? reg.get('combat/bolt/assets', make) : make();
}

/**
 * @param {object} engine
 * @param {{capacity?:number}} opts
 */
export function createProjectilePool(engine, { capacity = 2048 } = {}) {
  const N = capacity;

  // ---- state, all preallocated -------------------------------------------
  const px = new Float64Array(N);
  const py = new Float64Array(N);
  const pz = new Float64Array(N);
  const vx = new Float32Array(N);
  const vy = new Float32Array(N);
  const vz = new Float32Array(N);
  const life = new Float32Array(N);
  const travelled = new Float32Array(N);
  /** Ground covered by this bolt during the frame just integrated — the streak. */
  const swept = new Float32Array(N);
  const dmg = new Float32Array(N);
  const rad = new Float32Array(N);
  const len = new Float32Array(N);
  const cr = new Float32Array(N);
  const cg = new Float32Array(N);
  const cb = new Float32Array(N);
  const owners = new Array(N).fill(null);
  const weapons = new Array(N).fill(null);
  const targets = new Array(N).fill(null);
  const kinds = new Array(N).fill('gun');

  const free = new Int32Array(N);
  for (let i = 0; i < N; i++) free[i] = N - 1 - i;
  let freeCount = N;

  const active = new Int32Array(N);
  const slotAt = new Int32Array(N).fill(-1);
  let count = 0;

  const hit = makeHitRef();

  // ---- rendering ----------------------------------------------------------
  const { geo, core, halo } = cachedBoltAssets(engine);
  const coreMesh = new THREE.InstancedMesh(geo, core, N);
  const haloMesh = new THREE.InstancedMesh(geo, halo, N);
  for (const m of [coreMesh, haloMesh]) {
    m.frustumCulled = false;
    m.castShadow = false;
    m.receiveShadow = false;
    m.count = 0;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.name = m === coreMesh ? 'combat:bolts' : 'combat:bolts:halo';
  }
  coreMesh.renderOrder = 6;
  haloMesh.renderOrder = 5;
  // instanceColor has to exist before the first setColorAt, and three keys the
  // shader define off its presence.
  const colBuf = new Float32Array(N * 3);
  const colBufHalo = new Float32Array(N * 3);
  coreMesh.instanceColor = new THREE.InstancedBufferAttribute(colBuf, 3);
  haloMesh.instanceColor = new THREE.InstancedBufferAttribute(colBufHalo, 3);
  coreMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  haloMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  engine?.scene?.add(coreMesh);
  engine?.scene?.add(haloMesh);

  const stats = { live: 0, spawned: 0, hits: 0, expired: 0, overflow: 0 };

  // =======================================================================
  // spawn
  // =======================================================================

  /**
   * @param {{position:THREE.Vector3, direction:THREE.Vector3, weapon:object,
   *          owner:object, ownerVelocity?:THREE.Vector3, damage?:number,
   *          target?:object, kind?:string, speed?:number, jitter?:number,
   *          rng?:Function}} o
   * @returns {number} slot index, or -1 when the pool is saturated
   */
  function spawn(o) {
    if (freeCount === 0) { stats.overflow++; return -1; }
    const i = free[--freeCount];

    const w = o.weapon;
    const speed = o.speed ?? w.speed;

    _dir.copy(o.direction).normalize();
    // Dispersion: a deterministic cone, so the same seed makes the same burst.
    const spread = o.jitter ?? w.spread ?? 0;
    if (spread > 0 && o.rng) {
      const a = o.rng() * Math.PI * 2;
      const r = Math.sqrt(o.rng()) * spread;
      // Build a perpendicular basis without allocating.
      const ax = Math.abs(_dir.x) < 0.8 ? 1 : 0;
      _rel.set(ax, ax ? 0 : 1, 0).cross(_dir).normalize();
      _p1.copy(_dir).cross(_rel);
      _dir.addScaledVector(_rel, Math.cos(a) * r).addScaledVector(_p1, Math.sin(a) * r).normalize();
    }

    px[i] = o.position.x; py[i] = o.position.y; pz[i] = o.position.z;
    vx[i] = _dir.x * speed; vy[i] = _dir.y * speed; vz[i] = _dir.z * speed;
    if (o.ownerVelocity) {
      // Inherit the platform's velocity — real ballistics, and the reason a
      // deflection shot from a turning fighter still tracks.
      vx[i] += o.ownerVelocity.x; vy[i] += o.ownerVelocity.y; vz[i] += o.ownerVelocity.z;
    }

    life[i] = w.lifetime ?? Math.max(0.2, w.range / Math.max(1, speed));
    travelled[i] = 0;
    swept[i] = 0;
    dmg[i] = o.damage ?? w.damage;
    rad[i] = w.radius;
    len[i] = w.boltLength ?? 12;
    const rgb = w.rgb ?? [1, 1, 1];
    const glow = w.glow ?? 2;
    cr[i] = rgb[0] * glow; cg[i] = rgb[1] * glow; cb[i] = rgb[2] * glow;
    owners[i] = o.owner ?? null;
    weapons[i] = w;
    targets[i] = o.target ?? null;
    kinds[i] = o.kind ?? 'gun';

    slotAt[i] = count;
    active[count++] = i;
    stats.spawned++;
    return i;
  }

  function release(i) {
    const at = slotAt[i];
    if (at < 0) return;
    const last = active[--count];
    active[at] = last;
    slotAt[last] = at;
    slotAt[i] = -1;
    owners[i] = null;
    weapons[i] = null;
    targets[i] = null;
    free[freeCount++] = i;
  }

  // =======================================================================
  // frame
  // =======================================================================

  /**
   * Integrate every bolt, resolve hits, retire the dead.
   *
   * @param {number} dt
   * @param {{hulls:Array, softTargets?:Array, onHit:Function, onMissileHit?:Function}} ctx
   */
  function update(dt, ctx) {
    if (dt <= 0) { syncInstances(); return; }
    const hulls = ctx.hulls ?? [];
    const soft = ctx.softTargets ?? null;

    for (let k = count - 1; k >= 0; k--) {
      const i = active[k];

      _p0.set(px[i], py[i], pz[i]);
      _p1.set(px[i] + vx[i] * dt, py[i] + vy[i] * dt, pz[i] + vz[i] * dt);

      let bestT = Infinity;
      let bestHull = null;

      // --- ships ----------------------------------------------------------
      for (let h = 0; h < hulls.length; h++) {
        const hull = hulls[h];
        if (!hull.ok || hull.ship === owners[i] || !isAlive(hull.ship)) continue;

        // Sweep in the target's frame: subtract its travel from ours.
        _rel.copy(_p1).addScaledVector(hull.velocity, -dt);
        if (!segmentNearSphere(_p0, _rel, hull.center, hull.radius + rad[i])) continue;
        if (!segmentVsOBB(_p0, _rel, hull.center, hull.quat, hull.half, rad[i], hit)) continue;
        if (hit.t < bestT) {
          bestT = hit.t;
          bestHull = hull;
          _pos.copy(hit.point);
          _dir.copy(hit.normal);
        }
      }

      // --- soft targets (missiles, decoys): point defence ------------------
      let bestSoft = null;
      if (soft) {
        for (let s = 0; s < soft.length; s++) {
          const t = soft[s];
          if (!t.alive || t.shooter === owners[i]) continue;
          _rel.copy(_p1);
          if (t.velocity) _rel.addScaledVector(t.velocity, -dt);
          if (!segmentNearSphere(_p0, _rel, t.position, (t.hitRadius ?? 2) + rad[i])) continue;
          const d = segmentClosestT(_p0, _rel, t.position);
          if (d < bestT) { bestT = d; bestSoft = t; bestHull = null; _pos.copy(t.position); _dir.set(0, 1, 0); }
        }
      }

      if (bestHull || bestSoft) {
        const travelledNow = travelled[i] + _p0.distanceTo(_p1) * Math.max(0, Math.min(1, bestT));
        const scale = rangeFalloff(weapons[i], travelledNow);
        stats.hits++;
        if (bestHull) {
          ctx.onHit({
            target: bestHull.ship,
            shooter: owners[i],
            weapon: weapons[i],
            damage: dmg[i] * scale,
            point: _pos,
            normal: _dir,
            direction: _rel.set(vx[i], vy[i], vz[i]).normalize(),
            kind: kinds[i],
            travelled: travelledNow,
          });
        } else if (ctx.onMissileHit) {
          ctx.onMissileHit(bestSoft, dmg[i] * scale, owners[i], _pos);
        }
        release(i);
        continue;
      }

      // --- no hit: advance -------------------------------------------------
      const step = _p0.distanceTo(_p1);
      px[i] = _p1.x; py[i] = _p1.y; pz[i] = _p1.z;
      travelled[i] += step;
      // The streak spans this frame's travel, so frame N's tail meets frame
      // N-1's nose and a burst draws as one unbroken line rather than beads.
      swept[i] = step;
      life[i] -= dt;
      if (life[i] <= 0) { stats.expired++; release(i); }
    }

    syncInstances();
    stats.live = count;
  }

  /**
   * Write the instance matrices. One pass, no allocation.
   *
   * Each bolt is drawn as the segment it swept during the frame just integrated,
   * floored at its own length, and its cross-section is floored in screen space
   * so distance never erases it. See the constants at the top of this file for
   * the measurement behind those two rules.
   */
  function syncInstances() {
    const n = count;
    if (n === 0) { coreMesh.count = 0; haloMesh.count = 0; return; }

    // Screen-space floor needs to know how many pixels a radian is worth. Both
    // are read once per frame, and both degrade to "no floor" rather than to a
    // wrong one if the engine has not published a camera yet.
    const cam = engine?.camera ?? null;
    let pxPerRad = 0;
    if (cam?.isPerspectiveCamera) {
      cam.getWorldPosition(_camPos);
      const h = engine?.renderer?.getDrawingBufferSize?.(_bufSize)?.y ?? 0;
      if (h > 0) pxPerRad = h / (2 * Math.tan((cam.fov * Math.PI) / 360));
    }
    // Scale-to-radius is 0.5 (the bipyramid is built at radius 0.5), so the
    // angular floor is doubled on its way into the scale.
    const coreFloorAng = pxPerRad > 0 ? (2 * MIN_CORE_PX) / pxPerRad : 0;
    const haloFloorAng = pxPerRad > 0 ? (2 * MIN_HALO_PX) / pxPerRad : 0;

    for (let k = 0; k < n; k++) {
      const i = active[k];
      _dir.set(vx[i], vy[i], vz[i]);
      const sp = _dir.length();
      if (sp > 1e-4) _dir.multiplyScalar(1 / sp); else _dir.set(0, 0, 1);
      _q.setFromUnitVectors(_up, _dir);

      // Streak: from where the bolt was at the start of the frame to where it is
      // now, never shorter than the bolt itself and never longer than MAX_STREAK.
      const L = Math.min(MAX_STREAK, Math.max(len[i], swept[i]));
      // The segment trails *behind* the point the bolt has actually reached.
      _pos.set(px[i] - _dir.x * L * 0.5, py[i] - _dir.y * L * 0.5, pz[i] - _dir.z * L * 0.5);

      const dist = pxPerRad > 0 ? _pos.distanceTo(_camPos) : 0;
      const r = rad[i];
      const coreR = Math.max(r * 2.8, dist * coreFloorAng);
      _s.set(coreR, coreR, L);
      _m.compose(_pos, _q, _s);
      coreMesh.setMatrixAt(k, _m);
      // Halo is what actually reads at combat range. At 5.5x the bolt was a
      // hairline in frame even with 26 rounds in flight; Wing Commander's tracers
      // were unapologetically chunky because a dogfight has to be legible at a
      // glance, not physically scaled.
      const haloR = Math.max(r * 9.0, dist * haloFloorAng);
      _s.set(haloR, haloR, L * 1.12);
      _m.compose(_pos, _q, _s);
      haloMesh.setMatrixAt(k, _m);
      const o = k * 3;
      colBuf[o] = cr[i]; colBuf[o + 1] = cg[i]; colBuf[o + 2] = cb[i];
      colBufHalo[o] = cr[i] * 0.55; colBufHalo[o + 1] = cg[i] * 0.55; colBufHalo[o + 2] = cb[i] * 0.55;
    }
    coreMesh.count = n;
    haloMesh.count = n;
    if (n > 0) {
      coreMesh.instanceMatrix.needsUpdate = true;
      haloMesh.instanceMatrix.needsUpdate = true;
      coreMesh.instanceColor.needsUpdate = true;
      haloMesh.instanceColor.needsUpdate = true;
    }
  }

  function clear() {
    for (let k = count - 1; k >= 0; k--) release(active[k]);
    coreMesh.count = 0;
    haloMesh.count = 0;
  }

  function dispose() {
    clear();
    coreMesh.removeFromParent();
    haloMesh.removeFromParent();
    coreMesh.dispose();
    haloMesh.dispose();
    // geo/materials are registry-owned and shared; the registry disposes them.
  }

  /** Read-only view of one live bolt — used by the self-test and debug HUD. */
  function read(i, out = {}) {
    out.position = out.position ?? new THREE.Vector3();
    out.velocity = out.velocity ?? new THREE.Vector3();
    out.position.set(px[i], py[i], pz[i]);
    out.velocity.set(vx[i], vy[i], vz[i]);
    out.life = life[i];
    out.damage = dmg[i];
    out.weapon = weapons[i];
    out.owner = owners[i];
    return out;
  }

  return {
    spawn, update, clear, dispose, read, release,
    get count() { return count; },
    get capacity() { return N; },
    active,
    stats,
    meshes: [coreMesh, haloMesh],
  };
}
