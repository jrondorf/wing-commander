/**
 * src/vfx/VFXSystem.js — the VFX subsystem (ARCHITECTURE §3, priority 600).
 *
 * Runs after combat (300) and damage (350) so every event it consumes has already
 * been resolved this frame, and before the camera rig (700) so a blast that shakes
 * the camera is already on record.
 *
 * ## Layers, and why each is separate
 * Every layer below is one instanced draw call with its own blend mode and depth
 * policy. They are separate because blending is not a detail:
 *
 *   fire / sparks / tracers / plumes / shields   additive, depthWrite off
 *   smoke / ribbons                              premultiplied over, sorted
 *   rings / haze                                 pure additive sky-refraction delta
 *   debris                                       opaque, depth-written, in the
 *                                                velocity buffer so it motion-blurs
 *
 * ## Soft particles
 * Everything that is not opaque fades against scene depth read from the post
 * stack's velocity G-buffer (`post.targets.vel`, `.b` = view depth / camera.far).
 * That fade is what stops a sprite showing a razor intersection line where it
 * meets a hull — the single tell that turns a particle system into "obvious
 * camera-facing discs". Every VFX object is flagged `userData.noVelocity` so it
 * stays out of that buffer and reads the *opaque* world behind itself.
 *
 * ## Allocation
 * `update()` allocates nothing. Pools are preallocated typed arrays, emission
 * goes through the shared `EMIT` descriptor, and the only objects touched per
 * frame are module-scope scratch vectors.
 */

import * as THREE from 'three';
import { makeRng } from '../core/Rand.js';
import { createParticleLayer, resetEmit } from './Particles.js';
import { createDistortLayer } from './Distortion.js';
import { createRibbonLayer } from './Ribbons.js';
import { createDebrisField } from './Debris.js';
import { createExhaustSystem } from './Exhaust.js';
import { createShieldSystem } from './Shields.js';
import { createBoltLayer } from './Weapons.js';
import { createExplosionDirector, blastRadius } from './Explosions.js';
import { getCurlField } from './curl.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _camX = new THREE.Vector3();
const _camY = new THREE.Vector3();
const _camZ = new THREE.Vector3();
// spawnDebris() is reachable from an event handler that already owns _v3, so it
// gets its own pair rather than aliasing the caller's position vector.
const _dp = new THREE.Vector3();
const _dv = new THREE.Vector3();

/** Weapon tracer colours by faction — never a pure saturated primary (§7). */
const BOLT_COLOR = {
  confed: [0.35, 0.85, 1.0],
  nephilim: [0.72, 1.0, 0.30],
  kilrathi: [1.0, 0.62, 0.20],
  pirate: [1.0, 0.55, 0.18],
};

const FIRE_SLOTS = 3;

/**
 * @param {object} engine
 * @param {{seed?:number, budget?:number}} [opts]
 */
export function createVFXSystem(engine, opts = {}) {
  const scene = engine.scene;
  const rng = makeRng(opts.seed ?? 0x5eed17);
  const curlField = getCurlField(engine, { size: 20, seed: 20789 });

  const root = new THREE.Group();
  root.name = 'vfx';
  root.matrixAutoUpdate = false;
  root.frustumCulled = false;
  scene.add(root);

  // -------------------------------------------------------------- layers
  const fire = createParticleLayer(engine, {
    name: 'vfx:fire', capacity: 900, mode: 'additive', lit: false, sorted: false,
    emissive: 9.0, warp: 0.085, rim: 1.9, detail: 0.75, renderOrder: 10,
    softScale: 0.55, curlField,
  });
  const smoke = createParticleLayer(engine, {
    name: 'vfx:smoke', capacity: 620, mode: 'premult', lit: true, sorted: true,
    emissive: 3.2, warp: 0.07, rim: 0.9, detail: 0.45, renderOrder: 12,
    softScale: 0.5, curlField,
    albedo: [0.085, 0.080, 0.078], ambient: [0.045, 0.052, 0.070],
  });
  const sparks = createParticleLayer(engine, {
    name: 'vfx:sparks', capacity: 1100, mode: 'additive', lit: false, sorted: false,
    stretch: true, emissive: 14, warp: 0.02, rim: 0.5, detail: 0.15,
    renderOrder: 13, softScale: 2.0, curlField,
  });

  const rings = createDistortLayer(engine, {
    name: 'vfx:shock', capacity: 20, kind: 'ring', renderOrder: 14,
    refract: 0.9, rimColor: [1.0, 0.66, 0.36], rimIntensity: 9,
  });
  const haze = createDistortLayer(engine, {
    name: 'vfx:haze', capacity: 40, kind: 'haze', renderOrder: 15,
    refract: 0.7, rimColor: [1, 1, 1], rimIntensity: 0,
  });

  const ribbons = createRibbonLayer(engine, { name: 'vfx:trails', trails: 30, points: 22, renderOrder: 11 });
  const debris = createDebrisField(engine, { kinds: 3, perKind: 34 });
  const exhaust = createExhaustSystem(engine, { capacity: 72 });
  const shields = createShieldSystem(engine, { capacity: 4 });
  const bolts = createBoltLayer(engine, { capacity: 320 });

  root.add(
    fire.mesh, smoke.mesh, sparks.mesh, rings.mesh, haze.mesh,
    ribbons.mesh, debris.object3D, exhaust.object3D, shields.object3D, bolts.mesh,
  );
  // Debris is real lit geometry — it belongs in the velocity buffer so it
  // motion-blurs and so particles can soft-fade against it.
  debris.object3D.userData.noVelocity = false;

  // Every uniform block that needs the per-frame shared state.
  const shared = [
    fire.uniforms, smoke.uniforms, sparks.uniforms,
    rings.uniforms, haze.uniforms, ribbons.uniforms, bolts.uniforms,
    ...exhaust.layers.map((l) => l.uniforms),
    ...shields.uniformsList,
  ];

  // ------------------------------------------------------------ fire lights
  // Three shader slots feeding smoke self-illumination, plus two real point
  // lights so hulls and debris near a blast are genuinely lit by it. The point
  // lights are created **now**, at zero intensity, rather than on detonation:
  // adding a light to a scene later invalidates every lit material's program.
  const fireSlots = [];
  for (let i = 0; i < FIRE_SLOTS; i++) {
    fireSlots.push({ pos: new THREE.Vector3(), age: 1e9, life: 1, peak: 0, radius: 1 });
  }
  const pointLights = [];
  for (let i = 0; i < 2; i++) {
    const l = new THREE.PointLight(0xff7a30, 0, 100, 2);
    l.name = `vfx:blastLight${i}`;
    l.castShadow = false;
    l.visible = true;
    root.add(l);
    pointLights.push(l);
  }
  // A short-lived light snapped to the most recent muzzle flash. One light, not
  // one per gun: a recoil flash is a single-frame event and nobody can tell.
  const muzzleLight = new THREE.PointLight(0x9fd8ff, 0, 90, 2);
  muzzleLight.name = 'vfx:muzzleLight';
  root.add(muzzleLight);
  let muzzleAge = 1e9, muzzlePeak = 0;

  const fireLights = {
    add(p, intensity, radius) {
      let best = 0, bestScore = Infinity;
      for (let i = 0; i < FIRE_SLOTS; i++) {
        const s = fireSlots[i];
        const remaining = s.peak * Math.max(0, 1 - s.age / s.life);
        if (remaining < bestScore) { bestScore = remaining; best = i; }
      }
      const s = fireSlots[best];
      s.pos.copy(p);
      s.age = 0;
      s.life = 0.55 + Math.min(2.4, Math.pow(intensity, 0.45) * 0.85);
      s.radius = radius * 3.2;
      // Irradiance ~ peak/d². Sized so the fireball reads as the dominant light
      // source out to a couple of blast radii, against a key light of 3–6.
      s.peak = radius * radius * 20 * Math.pow(intensity, 0.25);
    },
    update(dt, camera) {
      const uPos = smoke.uniforms.uFireLightPos.value;
      const uCol = smoke.uniforms.uFireLightCol.value;
      const view = camera.matrixWorldInverse;
      let ranked = 0;
      for (let i = 0; i < FIRE_SLOTS; i++) {
        const s = fireSlots[i];
        s.age += dt;
        const t = s.age / s.life;
        if (t >= 1 || s.peak <= 0) {
          uCol[i].setRGB(0, 0, 0);
          uPos[i].set(0, 0, 0, 1);
          continue;
        }
        // Two-stage envelope: a violent white spike, then a long orange burn.
        const spike = Math.exp(-t * 26) * 1.9;
        const burn = Math.pow(1 - t, 2.1);
        const e = spike + burn;
        const white = Math.min(1, spike * 0.9);
        const r = 1.0;
        const g = 0.34 + white * 0.56;
        const b = 0.10 + white * 0.72;
        // Smoke lighting works in view space so the fragment shader stays free
        // of matrices.
        _v.copy(s.pos).applyMatrix4(view);
        uPos[i].set(_v.x, _v.y, _v.z, 1 / (s.radius * s.radius));
        const mag = e * 0.9;
        uCol[i].setRGB(r * mag, g * mag, b * mag);

        if (ranked < pointLights.length) {
          const l = pointLights[ranked++];
          l.position.copy(s.pos);
          l.color.setRGB(r, g, b);
          l.intensity = s.peak * e;
          l.distance = s.radius * 4;
        }
      }
      for (let i = ranked; i < pointLights.length; i++) pointLights[i].intensity = 0;

      muzzleAge += dt;
      muzzleLight.intensity = muzzleAge < 0.07 ? muzzlePeak * (1 - muzzleAge / 0.07) : 0;
    },
  };

  // --------------------------------------------------------------- director
  const director = createExplosionDirector(engine, {
    fire, smoke, sparks, rings, haze, debris, ribbons, lights: fireLights, rng,
  });

  // ----------------------------------------------------------- trail owners
  /** ship -> ribbon handle, for afterburner streaks. */
  const burnerTrails = new Map();
  /** missile -> { trail, acc } */
  const missileTrails = new Map();
  /** debris index -> ribbon handle is stored inside the debris field itself. */

  const debrisCallbacks = {
    onTrail(handle, x, y, z) { ribbons.push(handle, x, y, z); },
    onEmber(i, x, y, z, vx, vy, vz, glow, size) {
      const e = resetEmit();
      e.px = x; e.py = y; e.pz = z;
      e.vx = vx * 0.35 + rng.gauss(0, 2.5);
      e.vy = vy * 0.35 + rng.gauss(0, 2.5);
      e.vz = vz * 0.35 + rng.gauss(0, 2.5);
      e.life = rng.range(0.35, 0.95);
      e.size0 = size * rng.range(0.5, 1.3);
      e.size1 = e.size0 * 2.4;
      e.temp0 = Math.min(1, 0.5 + glow * 0.06);
      e.tempPow = rng.range(1.6, 3.0);
      e.alpha = rng.range(0.35, 0.7);
      e.fadeIn = 0.05; e.fadeOut = 1.4;
      e.drag = 1.6;
      e.curlAmp = 8; e.curlScale = 0.12;
      e.erode0 = 0.08; e.erode1 = 0.7;
      e.variant = rng.int(0, 3); e.seed = rng();
      fire.emit(e);
    },
    onBoom(i, x, y, z, power) {
      director.stats.secondaries++;
      _v3.set(x, y, z);
      director.spawn({ position: _v3, intensity: Math.max(0.10, power), debris: power > 0.6 });
    },
    onEnd(i, trail) { if (trail >= 0) ribbons.release(trail); },
  };

  // ================================================================== events
  const events = engine.events;
  const unsubs = [];
  const on = (type, fn) => { if (events?.on) unsubs.push(events.on(type, fn)); };

  /** True when combat/ is drawing its own bolts, so we do not double up. */
  function combatOwnsBolts() {
    const c = engine.game?.combat;
    return !!(c && (c.projectiles || c.bolts));
  }

  function factionOf(x) {
    return x?.faction ?? x?.ship?.faction ?? x?.group?.userData?.faction ?? 'confed';
  }

  on('ship:destroyed', (p) => {
    if (!p) return;
    const ship = p.ship;
    const pos = p.position ?? ship?.group?.position ?? ship?.body?.position;
    if (!pos) return;
    const inten = p.scale ?? p.size ?? 1;
    _v3.copy(pos);
    if (ship?.body?.velocity) _v2.copy(ship.body.velocity); else _v2.set(0, 0, 0);
    const alien = factionOf(ship) !== 'confed';
    director.spawn({
      position: _v3,
      velocity: _v2,
      intensity: inten,
      // Alien drives burn dirty: a faint sickly cast through the fireball's own
      // blackbody, never a flat green ball.
      tint: alien ? [0.94, 1.05, 0.86] : [1, 1, 1],
      debris: true,
      ship,
    });
    // The hull is gone; the flash covers the swap. Reversible — we only clear
    // the visibility flag, we do not touch anything ships/ owns.
    if (ship?.group) ship.group.visible = false;
    const t = burnerTrails.get(ship);
    if (t !== undefined) { ribbons.release(t); burnerTrails.delete(ship); }
  });

  on('explosion', (p) => {
    if (!p?.position && !p?.point) return;
    _v3.copy(p.position ?? p.point);
    director.spawn({
      position: _v3,
      intensity: p.intensity ?? p.size ?? p.scale ?? 1,
      debris: (p.size ?? p.scale ?? 1) > 1.2,
    });
  });

  on('weapon:hit', (p) => {
    if (!p) return;
    const pt = p.point ?? p.position;
    if (!pt) return;
    _v3.copy(pt);
    _v.copy(p.normal ?? _v.set(0, 1, 0));
    spawnImpact({
      position: _v3,
      normal: _v,
      strength: Math.min(2.5, (p.damage ?? 20) / 28),
      shielded: !!p.shielded,
      color: BOLT_COLOR[factionOf(p.shooter)] ?? BOLT_COLOR.confed,
    });
  });

  on('shield:impact', (p) => { if (p) shields.impact(p, time); });

  on('collision', (p) => {
    if (!p?.point) return;
    _v3.copy(p.point);
    _v.copy(p.normal ?? _v.set(0, 1, 0));
    spawnImpact({
      position: _v3, normal: _v,
      strength: Math.min(3, (p.relativeSpeed ?? 40) / 45),
      color: [1.0, 0.72, 0.35],
    });
  });

  on('weapon:fired', (p) => {
    if (!p?.position) return;
    const col = BOLT_COLOR[factionOf(p.ship ?? p.shooter)] ?? BOLT_COLOR.confed;
    _v3.copy(p.position);
    _v.copy(p.direction ?? _v.set(0, 0, -1)).normalize();

    // Muzzle flash: a stubby hot puff pushed just off the barrel, plus the
    // shared recoil light.
    const e = resetEmit();
    e.px = _v3.x + _v.x * 1.6; e.py = _v3.y + _v.y * 1.6; e.pz = _v3.z + _v.z * 1.6;
    e.vx = _v.x * 14; e.vy = _v.y * 14; e.vz = _v.z * 14;
    // Bigger and a touch longer-lived than it was: at 0.075 s / 4.2 m the flash
    // was under five frames of a two-pixel puff on a wingtip, which is to say
    // invisible. The gun going off has to be legible from the cockpit.
    e.life = 0.11;
    e.size0 = 2.6; e.size1 = 7.4;
    e.temp0 = 1; e.tempPow = 0.6;
    e.alpha = 1; e.fadeIn = 0.05; e.fadeOut = 1.2;
    e.drag = 9;
    e.erode0 = 0; e.erode1 = 0.3;
    e.variant = rng.int(0, 3); e.seed = rng();
    e.tr = col[0] * 2.2 + 0.9; e.tg = col[1] * 2.2 + 0.9; e.tb = col[2] * 2.2 + 0.9;
    fire.emit(e);

    muzzleLight.position.copy(_v3);
    muzzleLight.color.setRGB(col[0], col[1], col[2]);
    muzzlePeak = 2600;
    muzzleAge = 0;

    if (!combatOwnsBolts()) {
      const speed = p.speed ?? 1600;
      bolts.spawn({
        position: _v3,
        direction: _v,
        speed,
        length: Math.max(9, speed * 0.011),
        radius: 0.34,
        intensity: 5.5,
        life: Math.min(2.6, (p.range ?? 2600) / speed),
        color: col,
      });
    }
  });

  on('missile:launched', (p) => {
    const m = p?.missile ?? p?.projectile;
    if (!m) return;
    const col = BOLT_COLOR[factionOf(p.ship ?? p.shooter)] ?? BOLT_COLOR.confed;
    if (p.position) {
      _v3.copy(p.position);
      _v.copy(p.direction ?? _v.set(0, 0, -1)).normalize();
      for (let k = 0; k < 6; k++) {
        const e = resetEmit();
        e.px = _v3.x; e.py = _v3.y; e.pz = _v3.z;
        e.vx = -_v.x * rng.range(8, 26) + rng.gauss(0, 5);
        e.vy = -_v.y * rng.range(8, 26) + rng.gauss(0, 5);
        e.vz = -_v.z * rng.range(8, 26) + rng.gauss(0, 5);
        e.life = rng.range(0.25, 0.6);
        e.size0 = 1.2; e.size1 = 5.5;
        e.temp0 = rng.range(0.7, 1.0); e.tempPow = 2.2;
        e.alpha = 0.8; e.drag = 3;
        e.variant = rng.int(0, 3); e.seed = rng();
        e.tr = col[0] + 0.6; e.tg = col[1] + 0.5; e.tb = col[2] + 0.4;
        fire.emit(e);
      }
    }
    const t = ribbons.acquire({
      width0: 0.5, width1: 6.5, fade: 2.6, temp: 0.55, tempPow: 3.2,
      color: [0.16, 0.155, 0.15], minStep: 4, alpha: 0.8,
    });
    if (t >= 0) missileTrails.set(m, t);
  });

  const dropMissile = (p) => {
    const m = p?.missile ?? p?.projectile;
    if (!m) return;
    const t = missileTrails.get(m);
    if (t !== undefined) { ribbons.release(t); missileTrails.delete(m); }
  };
  on('missile:destroyed', dropMissile);
  on('missile:expired', dropMissile);

  on('debris:spawn', (p) => {
    if (!p?.position) return;
    _v3.copy(p.position);
    spawnDebris({
      position: _v3,
      velocity: p.velocity ?? null,
      count: p.count ?? 6,
      intensity: p.scale ?? p.size ?? 1,
    });
  });

  // ================================================================== public
  /**
   * @param {{position:THREE.Vector3, velocity?:THREE.Vector3, intensity?:number,
   *          tint?:number[], debris?:boolean}} o
   */
  function spawnExplosion(o) {
    if (!o?.position) return;
    director.spawn(o);
  }

  /**
   * @param {{position:THREE.Vector3, normal?:THREE.Vector3, strength?:number,
   *          shielded?:boolean, color?:number[]}} o
   */
  function spawnImpact(o) {
    const p = o.position;
    const n = o.normal ?? _v.set(0, 1, 0);
    const s = THREE.MathUtils.clamp(o.strength ?? 1, 0.15, 3);
    const col = o.color ?? [1, 0.8, 0.55];

    // Flash right at the contact patch.
    const f = resetEmit();
    f.px = p.x + n.x * 0.4; f.py = p.y + n.y * 0.4; f.pz = p.z + n.z * 0.4;
    f.life = 0.085 + s * 0.03;
    f.size0 = 1.1 * s; f.size1 = 4.5 * s;
    f.temp0 = 1; f.tempPow = 0.55;
    f.alpha = 1; f.fadeIn = 0.04; f.fadeOut = 1.4;
    f.drag = 8; f.erode0 = 0; f.erode1 = 0.25;
    f.variant = rng.int(0, 3); f.seed = rng();
    const boost = o.shielded ? 1.6 : 2.6;
    f.tr = col[0] * boost + 0.7; f.tg = col[1] * boost + 0.7; f.tb = col[2] * boost + 0.7;
    fire.emit(f);

    // Sparks spray back along the surface normal in a cone — a hit throws
    // material *off* the hull, it does not puff symmetrically.
    const n2 = Math.round(THREE.MathUtils.clamp(14 * s, 5, 48));
    for (let k = 0; k < n2; k++) {
      const e = resetEmit();
      e.px = p.x; e.py = p.y; e.pz = p.z;
      const sx = rng.gauss(0, 0.62), sy = rng.gauss(0, 0.62), sz = rng.gauss(0, 0.62);
      const speed = rng.range(9, 55) * s;
      e.vx = (n.x + sx) * speed; e.vy = (n.y + sy) * speed; e.vz = (n.z + sz) * speed;
      e.life = rng.range(0.22, 0.85);
      e.size0 = rng.range(0.10, 0.30); e.size1 = e.size0 * 0.5;
      e.temp0 = 1; e.tempPow = rng.range(0.9, 1.8);
      e.alpha = 1; e.fadeIn = 0.02; e.fadeOut = 0.9;
      e.drag = rng.range(0.3, 1.2);
      e.stretch = rng.range(0.012, 0.03);
      e.variant = rng.int(0, 3); e.seed = rng();
      e.tr = 1.5; e.tg = 1.25; e.tb = 1.0;
      sparks.emit(e);
    }

    // Armour hits punch a puff of vaporised hull; shield hits do not.
    if (!o.shielded) {
      for (let k = 0; k < 3; k++) {
        const e = resetEmit();
        e.px = p.x + n.x * 0.8; e.py = p.y + n.y * 0.8; e.pz = p.z + n.z * 0.8;
        e.vx = n.x * rng.range(3, 11); e.vy = n.y * rng.range(3, 11); e.vz = n.z * rng.range(3, 11);
        e.life = rng.range(0.7, 1.6);
        e.size0 = 1.2 * s; e.size1 = 5.5 * s;
        e.temp0 = rng.range(0.15, 0.4); e.tempPow = 3.2;
        e.alpha = rng.range(0.25, 0.5);
        e.fadeIn = 0.12; e.fadeOut = 1.6;
        e.drag = 1.4;
        e.curlAmp = 5; e.curlScale = 0.2;
        e.variant = rng.int(0, 3); e.seed = rng();
        smoke.emit(e);
      }
    }
  }

  /** @param {{ship:object, point?:THREE.Vector3, normal?:THREE.Vector3, strength?:number}} o */
  function spawnShieldRipple(o) { shields.impact(o, time); }

  /**
   * @param {{position:THREE.Vector3, velocity?:THREE.Vector3, count?:number,
   *          intensity?:number, burning?:boolean}} o
   */
  function spawnDebris(o) {
    const p = o.position;
    const inten = o.intensity ?? 1;
    const R = blastRadius(inten);
    const n = Math.round(THREE.MathUtils.clamp(o.count ?? 6, 1, 30));
    for (let k = 0; k < n; k++) {
      const z = rng.range(-1, 1);
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      _dv.set(Math.cos(a) * r, Math.sin(a) * r, z);
      _dp.set(p.x + _dv.x * R * 0.2, p.y + _dv.y * R * 0.2, p.z + _dv.z * R * 0.2);
      const vel = R * rng.range(1.0, 3.6);
      _dv.multiplyScalar(vel);
      if (o.velocity) _dv.add(o.velocity);
      const size = R * rng.range(0.05, 0.18);
      debris.spawn({
        position: _dp, velocity: _dv,
        spin: rng.range(1, 5), size,
        life: rng.range(2.5, 6),
        glow: o.burning === false ? 0.2 : rng.range(1.5, 6),
        glowPow: 2.4,
        trail: -1,
        boomAt: -1, boomPower: 0,
        rng,
      });
    }
  }

  // ================================================================== frame
  let time = 0;
  let keyLight = null;
  let lightScan = 0;

  function findKeyLight() {
    let best = null;
    scene.traverse((o) => {
      if (!o.isDirectionalLight || !o.visible) return;
      if (!best || o.intensity > best.intensity) best = o;
    });
    keyLight = best;
  }

  function updateShared(camera) {
    const post = engine.post;
    const depthTex = post?.targets?.vel?.texture ?? null;
    const size = post?.internalSize;
    const w = size?.w ?? engine.renderer.domElement.width ?? 1920;
    const h = size?.h ?? engine.renderer.domElement.height ?? 1080;

    // Key light in view space, for the lit smoke layer.
    if (keyLight) {
      _v.copy(keyLight.position);
      if (keyLight.target) _v.sub(keyLight.target.position);
      if (_v.lengthSq() < 1e-8) _v.set(0, 0, 1);
      _v.normalize().transformDirection(camera.matrixWorldInverse);
    } else {
      _v.set(0.3, 0.5, 0.8).normalize();
    }

    const sky = scene.background && scene.background.isCubeTexture ? scene.background : null;
    camera.matrixWorld.extractBasis(_camX, _camY, _camZ);

    for (const u of shared) {
      if (u.tSceneDepth) u.tSceneDepth.value = depthTex;
      if (u.uHasDepth) u.uHasDepth.value = depthTex ? 1 : 0;
      if (u.uInvRes) u.uInvRes.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
      if (u.uCameraFar) u.uCameraFar.value = camera.far;
      if (u.uCameraNear) u.uCameraNear.value = camera.near;
      if (u.uTime) u.uTime.value = time;
      if (u.uKeyDirView) u.uKeyDirView.value.copy(_v);
      if (u.uKeyColor && keyLight) {
        u.uKeyColor.value.copy(keyLight.color).multiplyScalar(keyLight.intensity * 0.16);
      }
      if (u.uCamRight) u.uCamRight.value.copy(_camX);
      if (u.uCamUp) u.uCamUp.value.copy(_camY);
      if (u.uCamZ) u.uCamZ.value.copy(_camZ);
      if (u.uSky) {
        u.uSky.value = sky;
        u.uHasSky.value = sky ? 1 : 0;
        u.uSkyFlip.value = sky?.isRenderTargetTexture ? 1 : -1;
      }
    }
  }

  /** Trails and venting flame driven off live ship/missile state. */
  function updateEmitters(dt) {
    const ships = engine.game?.ships;
    if (ships) {
      for (let i = 0; i < ships.length; i++) {
        const ship = ships[i];
        const g = ship?.group;
        const body = ship?.body;
        if (!g) continue;

        // -- afterburner ribbon -------------------------------------------
        const burn = body?.burnLevel ?? (body?.afterburner ? 1 : 0);
        let bt = burnerTrails.get(ship);
        if (burn > 0.25 && ship.alive !== false && g.visible !== false) {
          if (bt === undefined) {
            const hp = ship.hardpoints?.engines?.[0] ?? g.userData?.hardpoints?.engines?.[0];
            const rad = hp?.radius ?? 1.2;
            bt = ribbons.acquire({
              width0: rad * 0.8, width1: rad * 5.5, fade: 0.85,
              temp: 0.85, tempPow: 2.6, color: [0.12, 0.13, 0.15],
              minStep: 6, alpha: 0.55,
            });
            if (bt >= 0) burnerTrails.set(ship, bt);
          }
          if (bt !== undefined && bt >= 0) {
            const hp = ship.hardpoints?.engines?.[0] ?? g.userData?.hardpoints?.engines?.[0];
            if (hp) {
              _v.copy(hp.pos).applyQuaternion(g.quaternion).add(g.position);
              ribbons.push(bt, _v.x, _v.y, _v.z);
            }
          }
        } else if (bt !== undefined) {
          ribbons.release(bt);
          burnerTrails.delete(ship);
        }

        // -- battle damage: venting flame ---------------------------------
        const hull = ship.hullFrac ?? 1;
        if (ship.alive !== false && hull < 0.45 && g.visible !== false) {
          ship.__vfxVent = (ship.__vfxVent ?? 0) + dt * (2 + (0.45 - hull) * 26);
          while (ship.__vfxVent >= 1) {
            ship.__vfxVent -= 1;
            const rad = g.userData?.radius ?? 10;
            _v.set(rng.gauss(0, 0.5), rng.gauss(0, 0.4), rng.gauss(0, 0.7))
              .normalize().multiplyScalar(rad * 0.5)
              .applyQuaternion(g.quaternion).add(g.position);
            const e = resetEmit();
            e.px = _v.x; e.py = _v.y; e.pz = _v.z;
            const bv = body?.velocity;
            e.vx = (bv?.x ?? 0) * 0.6 + rng.gauss(0, 6);
            e.vy = (bv?.y ?? 0) * 0.6 + rng.gauss(0, 6);
            e.vz = (bv?.z ?? 0) * 0.6 + rng.gauss(0, 6);
            e.life = rng.range(0.4, 1.1);
            e.size0 = rad * 0.10; e.size1 = rad * 0.4;
            e.temp0 = rng.range(0.75, 1.0); e.tempPow = rng.range(1.6, 3.0);
            e.alpha = rng.range(0.5, 0.9);
            e.drag = 2.2;
            e.curlAmp = 22; e.curlScale = 0.1;
            e.erode0 = 0.06; e.erode1 = 0.7;
            e.variant = rng.int(0, 3); e.seed = rng();
            fire.emit(e);
          }
        }
      }
    }

    // -- missile plumes + trails -----------------------------------------
    if (missileTrails.size) {
      for (const [m, t] of missileTrails) {
        const alive = m.alive !== false && m.dead !== true;
        const pos = m.position;
        if (!alive || !pos) { ribbons.release(t); missileTrails.delete(m); continue; }
        ribbons.push(t, pos.x, pos.y, pos.z);
        m.__vfxAcc = (m.__vfxAcc ?? 0) + dt * 26;
        while (m.__vfxAcc >= 1) {
          m.__vfxAcc -= 1;
          const e = resetEmit();
          e.px = pos.x; e.py = pos.y; e.pz = pos.z;
          e.vx = rng.gauss(0, 3); e.vy = rng.gauss(0, 3); e.vz = rng.gauss(0, 3);
          e.life = rng.range(0.18, 0.4);
          e.size0 = 0.7; e.size1 = 2.6;
          e.temp0 = rng.range(0.85, 1.0); e.tempPow = 2.4;
          e.alpha = 0.75; e.drag = 4;
          e.variant = rng.int(0, 3); e.seed = rng();
          fire.emit(e);
        }
      }
    }
  }

  function update(dt, eng) {
    const camera = eng.camera;
    time += dt;

    if (--lightScan <= 0) { findKeyLight(); lightScan = 60; }

    director.update(dt);
    updateEmitters(dt);
    debris.update(dt, debrisCallbacks);
    fireLights.update(dt, camera);

    fire.update(dt, camera);
    smoke.update(dt, camera);
    sparks.update(dt, camera);
    rings.update(dt);
    haze.update(dt);
    ribbons.update(dt, camera);
    bolts.update(dt);
    exhaust.update(dt, eng.game?.ships, time);
    shields.update(dt, time);

    updateShared(camera);
  }

  function dispose() {
    for (const off of unsubs) off?.();
    unsubs.length = 0;
    burnerTrails.clear();
    missileTrails.clear();
    fire.dispose(); smoke.dispose(); sparks.dispose();
    rings.dispose(); haze.dispose();
    ribbons.dispose(); debris.dispose(); exhaust.dispose();
    shields.dispose(); bolts.dispose();
    for (const l of pointLights) l.removeFromParent();
    muzzleLight.removeFromParent();
    root.removeFromParent();
  }

  return {
    name: 'vfx',
    priority: 600,
    update,
    dispose,
    spawnExplosion,
    spawnImpact,
    spawnShieldRipple,
    spawnDebris,
    /** Live counts, for the diagnostic overlay and the performance budget. */
    get stats() {
      return {
        fire: fire.stats.live,
        smoke: smoke.stats.live,
        sparks: sparks.stats.live,
        debris: debris.count,
        tracers: bolts.count,
        rings: rings.count,
        haze: haze.count,
        plumes: exhaust.stats.plumes,
        blasts: director.stats.live,
        secondaries: director.stats.secondaries,
        dropped: fire.stats.dropped + smoke.stats.dropped + sparks.stats.dropped,
      };
    },
    layers: { fire, smoke, sparks, rings, haze, ribbons, debris, exhaust, shields, bolts },
    root,
  };
}
