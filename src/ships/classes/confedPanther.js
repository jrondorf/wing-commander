/**
 * F-103 Panther — Confederation heavy fighter.
 *
 * Where the Vampire is a scalpel, the Panther is a hammer, and the outline says so
 * before the paint does. Its signature is the **forked nose**: two gun booms
 * carried on the shoulders that run 2.3 m *ahead* of the nose tip, leaving a pair of
 * deep slots of open sky down either side of the forebody. Nothing else in the
 * fleet has that plan view.
 *
 *   nose      slim chiselled prow set back between the two prongs, cockpit low
 *             and far forward inside an armoured tub — a shallow faceted canopy,
 *             not the Vampire's bubble.
 *   body      a broad flat wedge that widens continuously aft to 7.2 m across.
 *   tail      two square engine blocks with two drives stacked in each, split by a
 *             1.8 m channel down the centreline, standing clear of the body's tail
 *             and stepping proud of it top and bottom.
 *
 * Low-aspect wing with 0.22 rad of anhedral and drooped tip pylons; canted fins on
 * the outboard corners of the engine blocks with matching ventral strakes, so from
 * astern the tail is an X.
 *
 * -Z forward. 29.1 m long, 20.4 m span, 9.4 m tall.
 */
import * as THREE from 'three';
import {
  loft, hullProfile, rectProfile, chamferedBox, plate, wing, shadeCavity,
  invertShell, ring,
} from '../geometryKit.js';
import {
  canopy, engineNozzle, gunMount, missileRail, rcsPort, platePatch, recessRow,
  sensorDome, gearBay, verticalFin,
} from '../parts.js';

export const def = {
  id: 'confed_panther',
  name: 'F-103 Panther',
  faction: 'confed',
  role: 'heavy fighter',
  style: 'confed',
  length: 29.1, span: 20.4, height: 9.4,
  lod: [0, 280, 1300],
};

const GX = 3.15;   // gun-boom centreline
const EX = 3.05;   // engine-block centreline

export function build(A, rng, greebles) {
  const D = A.detail;
  const cyan = A.mats.palette.glow;
  const glowI = A.mats.palette.glowIntensity;

  // -------------------------------------------------------------- 1. wedge
  // Flat and broad, widening all the way aft. A lifting body, not a tube.
  const P = hullProfile(2, 2, { topW: 0.66, botW: 0.88, chineLo: -0.30, chineHi: 0.34, c: 0.13 });
  const full = [
    { z: -11.6, sx: 0.26, sy: 0.18, y: -0.46 },
    { z: -10.6, sx: 0.80, sy: 0.40, y: -0.44, hard: true },
    { z: -8.2, sx: 1.62, sy: 0.76, y: -0.32 },
    { z: -4.8, sx: 2.55, sy: 1.14, y: -0.14, hard: true },
    { z: -0.8, sx: 3.28, sy: 1.44, y: 0.0 },
    { z: 3.4, sx: 3.60, sy: 1.56, y: 0.0, hard: true },
    { z: 6.8, sx: 3.32, sy: 1.44, y: -0.06 },
    { z: 8.6, sx: 2.55, sy: 1.12, y: -0.12 },
  ];
  const coarse = full.filter((_, i) => i % 2 === 0 || i === full.length - 1);
  A.add('hull', loft((D === 2 ? coarse : full).map((s) => ({ ...s, pts: P })), {}), { tone: 1 });

  // Armoured prow with a chin sensor turret.
  A.add('panel', loft([
    { pts: rectProfile(2.6, 1.35, 0.34), z: -11.5, sx: 0.30, sy: 0.42, y: -0.50 },
    { pts: rectProfile(2.6, 1.35, 0.34), z: -10.2, sx: 0.85, y: -0.46, hard: true },
    { pts: rectProfile(2.6, 1.35, 0.34), z: -7.6, sx: 1.05, y: -0.40 },
    { pts: rectProfile(2.6, 1.35, 0.34), z: -6.0, sx: 0.78, sy: 0.82, y: -0.44 },
  ], {}), { tone: 1.06 });
  sensorDome(A, { pos: [0, -1.16, -8.8], r: 0.66, normal: [0, -1, 0.15], tone: 0.9 });

  // Stepped dorsal armour deck — the Panther's read from the side is a long low
  // nose that steps *up* behind the canopy, the opposite rhythm to the Vampire.
  A.add('panel', loft([
    { pts: rectProfile(3.1, 0.8, 0.26), z: -5.0, sx: 0.40, sy: 0.42, y: 1.25 },
    { pts: rectProfile(3.1, 0.8, 0.26), z: -3.2, sx: 0.88, sy: 0.92, y: 1.52, hard: true },
    { pts: rectProfile(3.1, 0.8, 0.26), z: 1.8, sx: 0.94, sy: 0.9, y: 1.42 },
    { pts: rectProfile(3.1, 0.8, 0.26), z: 5.2, sx: 0.6, sy: 0.55, y: 1.15 },
  ], {}), { tone: 1.08 });

  // ------------------------------------------------------ 2. the forked nose
  // The prongs reach z = -13.9, a clear 2.3 m ahead of the nose tip, and their
  // inboard faces stand off the forebody — two long slots of sky in plan view.
  const GP = rectProfile(1.62, 1.56, 0.40);
  const boomSec = [
    { pts: GP, z: -13.9, sx: 0.56, sy: 0.54, y: 0.06 },
    { pts: GP, z: -13.1, sx: 0.86, sy: 0.86, y: 0.04, hard: true },
    { pts: GP, z: -11.8, sx: 0.98, sy: 0.98 },
    { pts: GP, z: -7.0, sx: 1.10, sy: 1.10 },
    { pts: GP, z: -3.4, sx: 1.28, sy: 1.34, hard: true },
    { pts: GP, z: -1.0, sx: 1.20, sy: 1.20 },
  ];
  A.addMirrored('hull', loft(D === 2 ? boomSec.filter((_, i) => i !== 3) : boomSec, {}),
    { pos: [GX, 0.10, 0], tone: 1.02 });
  // Muzzle shroud rings and an outboard intake scoop feeding the boom.
  if (A.mid) {
    A.addMirrored('metal', ring(0.46, 0.70, 0.42, { segments: A.fine ? 16 : 8 }),
      { pos: [GX, 0.10, -13.6], tone: 0.72 });
    const scoop = loft([
      { pts: rectProfile(0.9, 1.15, 0.24), z: -6.4, sx: 1.0, sy: 1.0 },
      { pts: rectProfile(0.9, 1.15, 0.24), z: -4.6, sx: 0.9, sy: 0.95, hard: true },
      { pts: rectProfile(0.9, 1.15, 0.24), z: -1.4, sx: 0.7, sy: 0.8 },
    ], {});
    A.addMirrored('metal', scoop, { pos: [GX + 0.92, 0.10, 0], tone: 0.8 });
    const throat = loft([
      { pts: rectProfile(0.7, 0.95, 0.2), z: -6.3, sx: 1.0 },
      { pts: rectProfile(0.7, 0.95, 0.2), z: -3.8, sx: 0.5, sy: 0.5 },
    ], { capStart: false, capEnd: true });
    invertShell(throat);
    A.addMirrored('dark', shadeCavity(throat, 0.6, 'z'), { pos: [GX + 0.92, 0.10, 0], tone: 0.55 });
    A.addMirrored('accent', plate(1.0, 0.34, 0.07, 0.03), { pos: [GX, 0.92, -11.9], tone: 1 });
  }

  // ---------------------------------------------------------- 3. the canopy
  // Low, far forward, sunk into the armour deck. Reads as a slot, not a bubble.
  canopy(A, { zFront: -10.0, zBack: -5.2, width: 2.42, height: 0.9, yBase: 0.72, yLift: 0.16 });
  if (A.fine) A.add('dark', plate(1.9, 2.0, 0.08, 0.05), { pos: [0, 0.82, -11.0], rot: [-0.2, 0, 0], tone: 0.75 });

  // ----------------------------------------------------------- 4. the wing
  // Low aspect, huge chord, hard anhedral. Root chord 9.0 (z -3.65 .. +5.35).
  const wg = wing({
    span: 6.6, rootChord: 9.0, tipChord: 3.4, rootThick: 1.30, tipThick: 0.42,
    sweep: 3.4, dihedral: -0.22, stations: D === 2 ? 2 : 4, seg: D === 2 ? 8 : 12,
  });
  A.addMirrored('hull', wg, { pos: [2.9, -0.20, 0.85], tone: 0.98 });
  // Drooped tip pylons hanging below the wingtips, carrying the heavy ordnance.
  A.addMirrored('panel', chamferedBox(1.1, 1.9, 4.6, 0.3), { pos: [9.0, -2.55, 3.2], rot: [0, 0, 0.34], tone: 1.04 });

  // -------------------------------------------------- 5. the engine blocks
  // Two square blocks with a 1.8 m channel between them. They stand proud of the
  // body top and bottom, so the aft third is unmistakably a different mass.
  const EP = rectProfile(4.2, 4.55, 0.9);
  const block = loft([
    { pts: EP, z: 2.2, sx: 0.62, sy: 0.60 },
    { pts: EP, z: 4.6, sx: 0.94, sy: 0.95, hard: true },
    { pts: EP, z: 11.2, sx: 1.0, sy: 1.0 },
    { pts: EP, z: 12.7, sx: 0.88, sy: 0.90, hard: true },
  ], {});
  A.addMirrored('hull', block, { pos: [EX, 0.42, 0], tone: 0.96 });

  for (const ex of [-EX, EX]) {
    for (const ey of [-1.15, 1.25]) {
      engineNozzle(A, {
        pos: [ex, ey + 0.42, 12.7], radius: 0.98, length: 1.55,
        glow: cyan, intensity: glowI, slots: D === 0 ? 6 : 0,
      });
    }
  }
  // Intake trunks on the outboard face of each block.
  if (A.mid) {
    const mouth = loft([
      { pts: rectProfile(1.15, 3.2, 0.5), z: 2.4, sx: 1.0 },
      { pts: rectProfile(1.15, 3.2, 0.5), z: 6.4, sx: 0.55, sy: 0.6 },
    ], { capStart: false, capEnd: true });
    invertShell(mouth);
    A.addMirrored('dark', shadeCavity(mouth, 0.6, 'z'), { pos: [EX + 1.35, 0.5, 0], tone: 0.55 });
    A.addMirrored('metal', loft([
      { pts: rectProfile(1.45, 3.2, 0.55), z: 2.3, sx: 1.0 },
      { pts: rectProfile(1.45, 3.2, 0.55), z: 3.0, sx: 0.92, hard: true },
      { pts: rectProfile(1.45, 3.2, 0.55), z: 7.0, sx: 0.8, sy: 0.9 },
    ], { capStart: false, capEnd: false }), { pos: [EX + 1.35, 0.5, 0], tone: 0.8 });
  }

  // ------------------------------------------------------------ 6. the tail
  verticalFin(A, {
    pos: [EX + 1.6, 2.45, 5.8], span: 2.9, rootChord: 5.0, tipChord: 1.9,
    rootThick: 0.5, tipThick: 0.2, sweep: 2.2, cant: 0.40, tone: 1.05, tipPod: 0.14,
  });
  verticalFin(A, {
    pos: [EX + 1.5, -1.72, 7.4], span: 1.8, rootChord: 3.0, tipChord: 1.3,
    rootThick: 0.42, tipThick: 0.16, sweep: 1.4, cant: 0.46, down: true, bucket: 'hull', tone: 0.94,
  });

  // -------------------------------------------------------------- 7. weapons
  gunMount(A, { pos: [GX, 0.10, -13.7], length: 1.1, radius: 0.26, type: 'ion', housing: false });
  gunMount(A, { pos: [1.1, -1.05, -10.6], length: 2.2, radius: 0.18, type: 'particle' });
  missileRail(A, { pos: [9.0, -3.7, 3.0], count: 3, spacing: 0.7, length: 2.3, radius: 0.17, type: 'FF' });
  missileRail(A, { pos: [5.6, -1.95, 4.4], count: 2, spacing: 0.66, length: 2.6, radius: 0.19, type: 'dumbfire' });

  // -------------------------------------------------- 8. functional detail
  if (A.fine) {
    platePatch(A, { center: [0, 1.5, 2.0], normal: [0, 1, 0], tangent: [0, 0, -1], w: 2.8, h: 7.0, cols: 2, rows: 4, thickness: 0.07, rng, tone: 1.07 });
    platePatch(A, { center: [5.4, -0.6, 2.0], normal: [0, 1, 0.1], tangent: [0, 0, -1], w: 3.6, h: 5.4, cols: 3, rows: 3, thickness: 0.06, rng, tone: 1.05 });
    platePatch(A, { center: [-5.4, -0.6, 2.0], normal: [0, 1, 0.1], tangent: [0, 0, -1], w: 3.6, h: 5.4, cols: 3, rows: 3, thickness: 0.06, rng, tone: 1.05 });
    platePatch(A, { center: [0, -1.6, 0.0], normal: [0, -1, 0], tangent: [0, 0, -1], w: 4.2, h: 7.4, cols: 3, rows: 4, thickness: 0.06, rng, tone: 0.95 });
    platePatch(A, { center: [EX, 2.72, 8.0], normal: [0, 1, 0], tangent: [0, 0, -1], w: 3.4, h: 6.4, cols: 2, rows: 4, thickness: 0.07, rng, tone: 1.06 });
    platePatch(A, { center: [-EX, 2.72, 8.0], normal: [0, 1, 0], tangent: [0, 0, -1], w: 3.4, h: 6.4, cols: 2, rows: 4, thickness: 0.07, rng, tone: 1.06 });
    recessRow(A, { center: [GX, 0.9, -9.6], normal: [0, 1, 0], tangent: [0, 0, -1], w: 1.2, h: 4.0, count: 3, depth: 0.1, rng });
    recessRow(A, { center: [-GX, 0.9, -9.6], normal: [0, 1, 0], tangent: [0, 0, -1], w: 1.2, h: 4.0, count: 3, depth: 0.1, rng });
    gearBay(A, { pos: [0, -1.5, -7.4], w: 1.2, l: 2.6, depth: 0.5 });
    gearBay(A, { pos: [3.2, -1.5, 2.6], w: 1.6, l: 3.0, depth: 0.6, mirror: true });
    sensorDome(A, { pos: [0, 2.02, -4.0], r: 0.4, tone: 0.9 });
    A.addMirrored('panel', plate(1.9, 0.65, 0.06, 0.04), { pos: [2.1, 0.5, -7.4], rot: [0, 0, -1.3], tone: 1.1 });

    if (greebles?.length) {
      const gm = [];
      for (let i = 0; i < 24; i++) {
        const sx = rng.sign();
        const m = new THREE.Matrix4();
        m.compose(new THREE.Vector3(sx * (EX + rng.range(-1.4, 1.4)), 2.3, rng.range(5.0, 11.5)),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rng.range(0, Math.PI * 2), 0)),
          new THREE.Vector3(1, 1, 1).multiplyScalar(rng.range(0.5, 1.0)));
        gm.push(m);
      }
      A.instance(greebles[1 % greebles.length], 'metal', gm);
    }
  }

  rcsPort(A, { pos: [GX + 0.9, 0.1, -12.2], normal: [1, 0.2, 0], size: 0.32, mirror: true });
  rcsPort(A, { pos: [0, 1.7, -6.4], normal: [0, 1, 0], size: 0.36 });
  rcsPort(A, { pos: [0, -1.5, -6.4], normal: [0, -1, 0], size: 0.36 });
  rcsPort(A, { pos: [EX + 1.5, 0.42, 10.4], normal: [1, 0.2, 0], size: 0.38, mirror: true });
  rcsPort(A, { pos: [9.0, -3.4, 3.2], normal: [0, -1, 0.2], size: 0.3, mirror: true });

  A.navLight([-9.6, -1.7, 2.4], '#ff2a1e', 8, 0.24, [-1, -0.3, 0]);
  A.navLight([9.6, -1.7, 2.4], '#22ff55', 8, 0.24, [1, -0.3, 0]);
  A.navLight([0, 2.0, 0.0], '#ffffff', 7, 0.18, [0, 1, 0]);
  A.navLight([0, -1.7, 5.0], '#ffffff', 5, 0.16, [0, -1, 0]);
  A.navLight([EX + 2.6, 5.1, 8.4], '#ffd0a0', 6, 0.15, [0, 1, 0]);
  A.navLight([-(EX + 2.6), 5.1, 8.4], '#ffd0a0', 6, 0.15, [0, 1, 0]);
  A.navLight([GX, 0.85, -13.8], '#7fe4ff', 5, 0.13, [0, 0, -1]);
  A.navLight([-GX, 0.85, -13.8], '#7fe4ff', 5, 0.13, [0, 0, -1]);

  return A;
}
