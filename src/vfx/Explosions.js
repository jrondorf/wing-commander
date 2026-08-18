/**
 * The explosion director.
 *
 * An explosion here is a *schedule*, not a sprite. One `spawnExplosion()` seeds a
 * blast record which then feeds seven layers over the next few seconds:
 *
 *   0.00 s  white-hot flash — over-range in HDR (tint × emissive lands near 30),
 *           gone in 0.14 s. This is what the post stack's bloom turns into the
 *           actual "light" of the detonation.
 *   0.00 s  core fireball — a shell of puffs given radial velocity *and* a strong
 *           curl-noise acceleration, so the interior rolls and folds instead of
 *           drifting outward. Each puff cools on its own exponent, so the ball is
 *           white in the middle, yellow at mid-radius and deep red at the edge at
 *           the same instant rather than changing colour all at once.
 *   0.00 s  shockwave ring in a real world plane, radius going as t^0.42
 *           (decelerating blast front), refracting the sky through its rim.
 *   0.00 s  sparks — velocity-stretched streaks, low drag, long life.
 *   0.00 s  debris — real geometry, tumbling, trailing fire, some fused.
 *   0.05 s  fire tongues — a second, faster, lower-drag population that punches
 *           out through the shell and gives the fireball asymmetry.
 *   0.10 s  smoke — lit by the key light *and* by the fireball itself through the
 *           three fire-light slots, so the cloud has an orange furnace inside it.
 *
 * Every number scales off `intensity`. A fighter (≈1.0) and a capital ship (≈12)
 * differ in radius, particle count, debris mass, ring count, secondary detonation
 * count and duration — not just in size.
 */

import * as THREE from 'three';
import { resetEmit } from './Particles.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dp = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _axis = new THREE.Vector3();

const MAX_BLASTS = 10;

/** Radius of the visible fireball, in metres, for a given intensity. */
export const blastRadius = (intensity) => 13 * Math.pow(Math.max(0.05, intensity), 0.92);

export function createExplosionDirector(engine, ctx) {
  const {
    fire, smoke, sparks, rings, haze, debris, ribbons, lights, rng,
  } = ctx;

  // ---- blast records, preallocated ---------------------------------------
  const B = {
    px: new Float32Array(MAX_BLASTS), py: new Float32Array(MAX_BLASTS), pz: new Float32Array(MAX_BLASTS),
    vx: new Float32Array(MAX_BLASTS), vy: new Float32Array(MAX_BLASTS), vz: new Float32Array(MAX_BLASTS),
    intensity: new Float32Array(MAX_BLASTS),
    radius: new Float32Array(MAX_BLASTS),
    age: new Float32Array(MAX_BLASTS),
    life: new Float32Array(MAX_BLASTS),
    tongueBudget: new Float32Array(MAX_BLASTS),
    smokeBudget: new Float32Array(MAX_BLASTS),
    tongueAcc: new Float32Array(MAX_BLASTS),
    smokeAcc: new Float32Array(MAX_BLASTS),
    burnBudget: new Float32Array(MAX_BLASTS),
    burnAcc: new Float32Array(MAX_BLASTS),
    tintR: new Float32Array(MAX_BLASTS), tintG: new Float32Array(MAX_BLASTS), tintB: new Float32Array(MAX_BLASTS),
    used: new Uint8Array(MAX_BLASTS),
  };
  let liveBlasts = 0;

  const stats = { spawned: 0, live: 0, secondaries: 0 };

  function allocBlast() {
    for (let i = 0; i < MAX_BLASTS; i++) if (!B.used[i]) return i;
    // Saturated: recycle whichever blast is furthest through its life.
    let worst = 0, best = -1;
    for (let i = 0; i < MAX_BLASTS; i++) {
      const t = B.age[i] / B.life[i];
      if (t > worst) { worst = t; best = i; }
    }
    return best < 0 ? 0 : best;
  }

  /** Random unit vector, written into `out`. Uniform on the sphere. */
  function randDir(out) {
    const z = rng.range(-1, 1);
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return out.set(Math.cos(a) * r, Math.sin(a) * r, z);
  }

  // =========================================================================
  // spawn
  // =========================================================================

  /**
   * @param {{position:THREE.Vector3, velocity?:THREE.Vector3, intensity?:number,
   *          tint?:[number,number,number], debris?:boolean, ship?:object,
   *          rings?:number}} o
   */
  function spawn(o) {
    const i = allocBlast();
    const p = o.position;
    const inten = Math.max(0.06, o.intensity ?? 1);
    const R = blastRadius(inten);

    B.used[i] = 1;
    B.px[i] = p.x; B.py[i] = p.y; B.pz[i] = p.z;
    B.vx[i] = o.velocity?.x ?? 0; B.vy[i] = o.velocity?.y ?? 0; B.vz[i] = o.velocity?.z ?? 0;
    B.intensity[i] = inten;
    B.radius[i] = R;
    B.age[i] = 0;
    B.life[i] = 3.0 + Math.min(4.0, Math.pow(inten, 0.5) * 1.4);
    B.tongueAcc[i] = 0;
    B.smokeAcc[i] = 0;
    B.burnAcc[i] = 0;
    B.tongueBudget[i] = Math.round(THREE.MathUtils.clamp(24 * Math.pow(inten, 0.55), 10, 90));
    B.smokeBudget[i] = Math.round(THREE.MathUtils.clamp(54 * Math.pow(inten, 0.62), 20, 190));
    B.burnBudget[i] = Math.round(THREE.MathUtils.clamp(46 * Math.pow(inten, 0.5), 20, 160));
    const tint = o.tint ?? [1, 1, 1];
    B.tintR[i] = tint[0]; B.tintG[i] = tint[1]; B.tintB[i] = tint[2];
    stats.spawned++;

    const big = inten > 3;

    // ---- 1. flash --------------------------------------------------------
    // Three stacked discs at different scales: one at the core, two wider and
    // fractionally later so the flash *blooms outward* over three frames rather
    // than appearing whole.
    for (let k = 0; k < 3; k++) {
      const e = resetEmit();
      randDir(_v).multiplyScalar(R * 0.10 * k);
      e.px = p.x + _v.x; e.py = p.y + _v.y; e.pz = p.z + _v.z;
      e.life = 0.10 + k * 0.045;
      e.delay = k * 0.018;
      e.size0 = R * (0.55 + k * 0.35);
      e.size1 = R * (1.5 + k * 0.95);
      e.temp0 = 1.0; e.tempPow = 0.35;
      e.alpha = 1; e.fadeIn = 0.05; e.fadeOut = 1.5;
      e.drag = 4; e.curlAmp = 0;
      e.erode0 = 0.0; e.erode1 = 0.12;
      e.variant = k & 3; e.seed = rng();
      e.rollSpeed = rng.range(-1.5, 1.5);
      // The flash is the one thing in the frame allowed to be genuinely blinding.
      const boost = 3.6 - k * 0.7;
      e.tr = boost * 1.0; e.tg = boost * 0.98; e.tb = boost * 0.95;
      fire.emit(e);
    }

    // ---- 2. core fireball -------------------------------------------------
    const nCore = Math.round(THREE.MathUtils.clamp(48 * Math.pow(inten, 0.58), 22, 220));
    for (let k = 0; k < nCore; k++) {
      const e = resetEmit();
      randDir(_v);
      // Cube-root radial distribution fills the volume evenly instead of
      // clustering everything in a hollow shell.
      const rr = Math.pow(rng(), 0.34);
      const spread = R * 0.34 * rr;
      e.px = p.x + _v.x * spread; e.py = p.y + _v.y * spread; e.pz = p.z + _v.z * spread;
      // Deliberately slow. A fireball that flies apart at 40 m/s is a firework;
      // the mass has to hang together while it burns, and the *curl* — not the
      // radial velocity — is what makes the interior move.
      const vel = R * rng.range(0.30, 1.05) * (0.4 + rr);
      e.vx = B.vx[i] + _v.x * vel; e.vy = B.vy[i] + _v.y * vel; e.vz = B.vz[i] + _v.z * vel;
      e.life = rng.range(1.7, 3.4) * (big ? 1.5 : 1);
      e.delay = rng() * 0.06;
      e.size0 = R * rng.range(0.40, 0.70);
      e.size1 = e.size0 * rng.range(1.55, 2.35);
      e.temp0 = rng.range(0.88, 1.0);
      // Per-particle cooling exponent — the whole point. Hot cores stay white
      // while the flanks are already deep red in the same frame.
      e.tempPow = rng.range(0.85, 2.4) * (0.65 + rr * 0.85);
      e.alpha = rng.range(0.72, 1.0);
      e.fadeIn = 0.06; e.fadeOut = 1.15;
      e.drag = rng.range(2.4, 4.2);
      e.curlAmp = R * rng.range(3.0, 6.0);
      e.curlScale = 3.0 / R;
      e.rollSpeed = rng.range(-2.2, 2.2);
      e.erode0 = rng.range(0.02, 0.14);
      e.erode1 = rng.range(0.52, 0.8);
      e.variant = rng.int(0, 3); e.seed = rng();
      e.tr = B.tintR[i]; e.tg = B.tintG[i]; e.tb = B.tintB[i];
      fire.emit(e);
    }

    // ---- 3. sparks --------------------------------------------------------
    const nSpark = Math.round(THREE.MathUtils.clamp(62 * Math.pow(inten, 0.5), 26, 240));
    for (let k = 0; k < nSpark; k++) {
      const e = resetEmit();
      randDir(_v);
      e.px = p.x + _v.x * R * 0.2; e.py = p.y + _v.y * R * 0.2; e.pz = p.z + _v.z * R * 0.2;
      const vel = R * rng.range(1.4, 7.0);
      e.vx = B.vx[i] + _v.x * vel; e.vy = B.vy[i] + _v.y * vel; e.vz = B.vz[i] + _v.z * vel;
      e.life = rng.range(0.4, 1.7);
      e.size0 = R * rng.range(0.012, 0.035);
      e.size1 = e.size0 * 0.55;
      e.temp0 = 1.0; e.tempPow = rng.range(0.7, 1.5);
      e.alpha = 1; e.fadeIn = 0.02; e.fadeOut = 0.8;
      e.drag = rng.range(0.15, 0.7);
      e.curlAmp = R * 0.6; e.curlScale = 2.0 / R;
      e.erode0 = 0.0; e.erode1 = 0.25;
      e.stretch = rng.range(0.010, 0.030);
      e.variant = rng.int(0, 3); e.seed = rng();
      e.tr = 1.6; e.tg = 1.35; e.tb = 1.1;
      sparks.emit(e);
    }

    // ---- 4. shock rings ---------------------------------------------------
    const ringCount = o.rings ?? (inten > 5 ? 3 : inten > 1.6 ? 2 : 1);
    for (let k = 0; k < ringCount; k++) {
      randDir(_axis);
      _q.setFromUnitVectors(_v2.set(0, 0, 1), _axis);
      rings.spawn({
        position: p,
        quaternion: _q,
        life: 0.85 + 0.45 * Math.pow(inten, 0.35) + k * 0.22,
        r0: R * 0.30,
        r1: R * (2.9 + k * 1.3),
        strength0: 0.048 / (1 + k * 0.5),
        strength1: 0.003,
        alpha: 1 - k * 0.22,
        fade: 1.9,
        seed: rng(),
        inner: 0.5,
        rimPow: 2.6,
        scroll: 0.7,
        growExp: 0.42,
      });
    }

    // ---- 5. heat haze -----------------------------------------------------
    // Heat haze has to be felt, not seen. Against a structured nebula a wide
    // disc with a strong bend re-renders a whole region of sky at an offset and
    // reads as a giant smear; these are small, weak, and clustered on the core.
    const nHaze = inten > 3 ? 5 : 3;
    for (let k = 0; k < nHaze; k++) {
      randDir(_v).multiplyScalar(R * rng.range(0, 0.45));
      haze.spawn({
        position: _v2.set(p.x + _v.x, p.y + _v.y, p.z + _v.z),
        life: rng.range(0.7, 1.5),
        r0: R * rng.range(0.5, 0.85),
        r1: R * rng.range(1.1, 1.7),
        strength0: 0.011,
        strength1: 0.001,
        alpha: 0.85,
        fade: 1.3,
        seed: rng(),
        inner: 0.0,
        growExp: 0.55,
      });
    }

    // ---- 6. debris --------------------------------------------------------
    if (o.debris !== false && debris) {
      const nDeb = Math.round(THREE.MathUtils.clamp(9 * Math.pow(inten, 0.8), 4, 34));
      for (let k = 0; k < nDeb; k++) {
        randDir(_v);
        const vel = R * rng.range(1.4, 5.2);
        _v2.set(B.vx[i] + _v.x * vel, B.vy[i] + _v.y * vel, B.vz[i] + _v.z * vel);
        _dp.set(p.x + _v.x * R * 0.25, p.y + _v.y * R * 0.25, p.z + _v.z * R * 0.25);
        const size = R * rng.range(0.030, 0.105);
        // Only the first few chunks get a ribbon — the trail pool is shared with
        // missiles and afterburners, and eight burning arcs already read as many.
        let tr = -1;
        if (k < 8 && ribbons) {
          tr = ribbons.acquire({
            width0: size * 0.9,
            width1: size * 4.5,
            fade: rng.range(0.7, 1.5),
            temp: 0.8,
            tempPow: 2.4,
            color: [0.10, 0.085, 0.075],
            minStep: Math.max(0.8, size * 1.2),
            alpha: 0.9,
          });
        }
        const fused = rng() < 0.32;
        debris.spawn({
          position: _dp,
          velocity: _v2,
          spin: rng.range(1.2, 5.5),
          size,
          life: rng.range(3.4, 7.5),
          glow: rng.range(0.9, 2.6),
          glowPow: rng.range(1.1, 2.4),
          trail: tr,
          boomAt: fused ? rng.range(0.4, 3.1) : -1,
          boomPower: inten * rng.range(0.10, 0.26),
          rng,
        });
      }
    }

    // ---- 7. light ---------------------------------------------------------
    lights.add(p, inten, R);

    liveBlasts++;
    return i;
  }

  // =========================================================================
  // per-frame staged emission
  // =========================================================================

  function update(dt) {
    let live = 0;
    for (let i = 0; i < MAX_BLASTS; i++) {
      if (!B.used[i]) continue;
      const a = (B.age[i] += dt);
      const life = B.life[i];
      if (a >= life) { B.used[i] = 0; continue; }
      live++;

      const R = B.radius[i];
      const inten = B.intensity[i];
      const px = B.px[i] + B.vx[i] * a;
      const py = B.py[i] + B.vy[i] * a;
      const pz = B.pz[i] + B.vz[i] * a;

      // -- fire tongues: a short, violent burst just after the flash ---------
      if (a < 0.45 && B.tongueBudget[i] > 0) {
        B.tongueAcc[i] += dt * (B.tongueBudget[i] / 0.45);
        while (B.tongueAcc[i] >= 1 && B.tongueBudget[i] > 0) {
          B.tongueAcc[i] -= 1;
          B.tongueBudget[i] -= 1;
          const e = resetEmit();
          randDir(_v);
          e.px = px + _v.x * R * 0.35; e.py = py + _v.y * R * 0.35; e.pz = pz + _v.z * R * 0.35;
          const vel = R * rng.range(1.1, 3.0);
          e.vx = B.vx[i] + _v.x * vel; e.vy = B.vy[i] + _v.y * vel; e.vz = B.vz[i] + _v.z * vel;
          e.life = rng.range(1.0, 2.2);
          e.size0 = R * rng.range(0.18, 0.36);
          e.size1 = e.size0 * rng.range(2.0, 3.2);
          e.temp0 = rng.range(0.9, 1.0);
          e.tempPow = rng.range(1.1, 2.6);
          e.alpha = rng.range(0.6, 0.95);
          e.fadeIn = 0.04; e.fadeOut = 1.3;
          e.drag = rng.range(1.4, 2.6);
          e.curlAmp = R * rng.range(4.0, 9.0);
          e.curlScale = 3.4 / R;
          e.rollSpeed = rng.range(-3, 3);
          e.erode0 = rng.range(0.04, 0.2);
          e.erode1 = rng.range(0.6, 0.88);
          e.variant = rng.int(0, 3); e.seed = rng();
          e.tr = B.tintR[i]; e.tg = B.tintG[i]; e.tb = B.tintB[i];
          fire.emit(e);
        }
      }

      // -- core burn --------------------------------------------------------
      // What is left of a fighter's reactor and fuel keeps burning for seconds
      // after the initial detonation has cooled. Without this the event is over
      // in a second and a half and any capture past that is just smoke.
      if (a > 0.12 && B.burnBudget[i] > 0) {
        const win = life * 0.68;
        B.burnAcc[i] += dt * (B.burnBudget[i] / win);
        while (B.burnAcc[i] >= 1 && B.burnBudget[i] > 0) {
          B.burnAcc[i] -= 1;
          B.burnBudget[i] -= 1;
          const e = resetEmit();
          randDir(_v);
          const rr = Math.pow(rng(), 0.5);
          e.px = px + _v.x * R * 0.5 * rr;
          e.py = py + _v.y * R * 0.5 * rr;
          e.pz = pz + _v.z * R * 0.5 * rr;
          const vel = R * rng.range(0.15, 0.75);
          e.vx = B.vx[i] + _v.x * vel; e.vy = B.vy[i] + _v.y * vel; e.vz = B.vz[i] + _v.z * vel;
          e.life = rng.range(1.2, 2.6);
          e.size0 = R * rng.range(0.22, 0.48);
          e.size1 = e.size0 * rng.range(1.7, 2.6);
          e.temp0 = rng.range(0.72, 0.98);
          e.tempPow = rng.range(1.0, 2.6);
          e.alpha = rng.range(0.5, 0.9);
          e.fadeIn = 0.1; e.fadeOut = 1.25;
          e.drag = rng.range(2.0, 3.6);
          e.curlAmp = R * rng.range(2.5, 5.5);
          e.curlScale = 2.6 / R;
          e.rollSpeed = rng.range(-1.8, 1.8);
          e.erode0 = rng.range(0.05, 0.2);
          e.erode1 = rng.range(0.6, 0.88);
          e.variant = rng.int(0, 3); e.seed = rng();
          e.tr = B.tintR[i]; e.tg = B.tintG[i]; e.tb = B.tintB[i];
          fire.emit(e);
        }
      }

      // -- smoke: fed in over the whole life so the cloud builds -------------
      if (a > 0.30 && B.smokeBudget[i] > 0) {
        const window = life * 0.75;
        B.smokeAcc[i] += dt * (B.smokeBudget[i] / window);
        while (B.smokeAcc[i] >= 1 && B.smokeBudget[i] > 0) {
          B.smokeAcc[i] -= 1;
          B.smokeBudget[i] -= 1;
          const e = resetEmit();
          randDir(_v);
          const rr = Math.pow(rng(), 0.4);
          e.px = px + _v.x * R * 0.75 * rr;
          e.py = py + _v.y * R * 0.75 * rr;
          e.pz = pz + _v.z * R * 0.75 * rr;
          const vel = R * rng.range(0.3, 1.1);
          e.vx = B.vx[i] + _v.x * vel; e.vy = B.vy[i] + _v.y * vel; e.vz = B.vz[i] + _v.z * vel;
          e.life = rng.range(2.4, 5.5) * (1 + Math.min(1.2, inten * 0.08));
          e.size0 = R * rng.range(0.26, 0.46);
          e.size1 = e.size0 * rng.range(1.9, 2.9);
          // Smoke still glows faintly from within for the first moment.
          e.temp0 = rng.range(0.10, 0.34);
          e.tempPow = rng.range(2.6, 5.0);
          // Thin. A soot cloud at high alpha punches a black hole through a
          // bright nebula; many thin puffs accumulate into depth instead.
          e.alpha = rng.range(0.13, 0.34);
          e.fadeIn = 0.16; e.fadeOut = 1.6;
          e.drag = rng.range(0.9, 1.7);
          e.curlAmp = R * rng.range(1.4, 3.2);
          e.curlScale = 2.2 / R;
          e.rollSpeed = rng.range(-1.1, 1.1);
          e.erode0 = rng.range(0.04, 0.16);
          e.erode1 = rng.range(0.62, 0.9);
          e.variant = rng.int(0, 3); e.seed = rng();
          const s = rng.range(0.75, 1.15);
          e.tr = s; e.tg = s * 0.97; e.tb = s * 0.95;
          smoke.emit(e);
        }
      }
    }
    stats.live = live;
    liveBlasts = live;
  }

  return { spawn, update, stats, get live() { return liveBlasts; } };
}
