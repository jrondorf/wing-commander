/**
 * TB-80 Devastator — Confederation heavy bomber.
 *
 * The fleet's answer to "what does slow and survivable look like". Nothing about
 * it is a scaled-up fighter: it borrows its whole grammar from strategic
 * aircraft, and that is precisely why it can never be confused with one.
 *
 *   fuselage  a deep slab with a stepped **flight-deck hump** set far forward —
 *             two crew, not one, and the outline says so.
 *   wing      long, straight, high aspect, shoulder-mounted with slight *dihedral*
 *             where every Confed fighter has anhedral.
 *   engines   two oversized nacelles slung **under the wing on short pylons**, so
 *             there is a metre of daylight running the length of each pod. This is
 *             the shape's loudest single statement.
 *   tail      twin booms carrying an H-tail well aft of the fuselage, framing a
 *             6 × 8 m rectangle of empty sky. From any angle you can see straight
 *             through the back of the ship.
 *   bay       the ventral weapons bay stands open with its doors swung wide and
 *             torpedoes on the rails — the reason the ship exists.
 *
 * -Z forward. 35.4 m long, 27.5 m span, 10.6 m tall.
 */
import * as THREE from 'three';
import {
  loft, hullProfile, rectProfile, chamferedBox, plate, wing, tube,
  xform, mergeGeometries, shadeCavity, invertShell, ring, dome,
} from '../geometryKit.js';
import {
  canopy, engineNozzle, gunMount, rcsPort, platePatch, recessRow, sensorDome,
  gearBay, turretGeometry, verticalFin, pylon,
} from '../parts.js';

export const def = {
  id: 'confed_devastator',
  name: 'TB-80 Devastator',
  faction: 'confed',
  role: 'bomber',
  style: 'confed',
  length: 35.4, span: 27.5, height: 10.6,
  lod: [0, 320, 1500],
};

const NX = 8.45;    // nacelle centreline
const NY = -2.55;   // nacelle vertical centre
const TX = 4.90;    // tail-boom centreline
const TY = 1.65;

export function build(A, rng, greebles) {
  const D = A.detail;
  const cyan = A.mats.palette.glow;
  const glowI = A.mats.palette.glowIntensity;

  // ----------------------------------------------------------- 1. fuselage
  const P = hullProfile(2, 2, { topW: 0.74, botW: 0.80, chineLo: -0.32, chineHi: 0.42, c: 0.09 });
  const full = [
    { z: -18.0, sx: 1.10, sy: 1.00, y: -0.25 },
    { z: -16.6, sx: 1.95, sy: 1.55, y: -0.20, hard: true },
    { z: -13.6, sx: 2.70, sy: 2.05, y: -0.10 },
    { z: -9.0, sx: 3.10, sy: 2.40, y: 0.0 },
    { z: -3.5, sx: 3.22, sy: 2.55, y: 0.05, hard: true },
    { z: 2.5, sx: 3.20, sy: 2.55, y: 0.05 },
    { z: 7.0, sx: 2.85, sy: 2.15, y: 0.10, hard: true },
    { z: 9.6, sx: 2.10, sy: 1.45, y: 0.35 },
    { z: 10.8, sx: 1.40, sy: 0.95, y: 0.45 },
  ];
  const coarse = full.filter((_, i) => i % 2 === 0 || i === full.length - 1);
  A.add('hull', loft((D === 2 ? coarse : full).map((s) => ({ ...s, pts: P })), {}), { tone: 1 });

  // Bolted frontal glacis and the bombardier's ventral glazing.
  A.add('panel', loft([
    { pts: rectProfile(5.4, 3.8, 0.85), z: -17.9, sx: 0.34, sy: 0.44, y: -0.2 },
    { pts: rectProfile(5.4, 3.8, 0.85), z: -16.2, sx: 0.82, sy: 0.86, y: -0.15, hard: true },
    { pts: rectProfile(5.4, 3.8, 0.85), z: -12.0, sx: 1.05, sy: 1.0, y: -0.05 },
    { pts: rectProfile(5.4, 3.8, 0.85), z: -10.0, sx: 0.84, sy: 0.9, y: 0 },
  ], {}), { tone: 1.07 });
  A.add('glass', dome(1.05, { segments: A.fine ? 16 : 8, rows: 5, squash: 0.55 }),
    { pos: [0, -2.05, -15.2], rot: [Math.PI, 0, 0], tone: 1, jitter: 0 });

  // ------------------------------------------------- 2. the flight-deck hump
  // Stepped up out of the spine and set well forward. Two seats abreast.
  A.add('hull', loft([
    { pts: rectProfile(3.9, 2.6, 0.55), z: -15.8, sx: 0.42, sy: 0.35, y: 1.85 },
    { pts: rectProfile(3.9, 2.6, 0.55), z: -14.4, sx: 0.86, sy: 0.96, y: 2.52, hard: true },
    { pts: rectProfile(3.9, 2.6, 0.55), z: -10.2, sx: 1.0, sy: 1.12, y: 2.72 },
    { pts: rectProfile(3.9, 2.6, 0.55), z: -8.8, sx: 0.80, sy: 0.50, y: 1.95, hard: true },
    { pts: rectProfile(3.9, 2.6, 0.55), z: -7.0, sx: 0.55, sy: 0.30, y: 1.70 },
  ], {}), { tone: 1.02 });
  canopy(A, { zFront: -15.2, zBack: -10.4, width: 3.05, height: 1.2, yBase: 3.32, yLift: 0.3 });
  if (A.fine) A.add('dark', plate(2.5, 2.2, 0.09, 0.06), { pos: [0, 3.4, -16.3], rot: [-0.26, 0, 0], tone: 0.75 });

  // Dorsal armour spine running back from the deck to the turret ring.
  A.add('panel', loft([
    { pts: rectProfile(3.4, 0.7, 0.22), z: -6.4, sx: 0.6, sy: 0.6, y: 2.30 },
    { pts: rectProfile(3.4, 0.7, 0.22), z: -3.4, sx: 1.0, y: 2.48, hard: true },
    { pts: rectProfile(3.4, 0.7, 0.22), z: 5.0, sx: 0.95, y: 2.36 },
    { pts: rectProfile(3.4, 0.7, 0.22), z: 8.2, sx: 0.55, sy: 0.55, y: 1.85 },
  ], {}), { tone: 1.08 });

  // ------------------------------------------------------ 3. open weapons bay
  const bayW = 5.0, bayL = 13.5, bayD = 2.1;
  const bay = loft([
    { pts: rectProfile(bayW, bayL, 0.5), z: 0 },
    { pts: rectProfile(bayW, bayL, 0.5), z: bayD * 0.6, sx: 0.97, sy: 0.99 },
    { pts: rectProfile(bayW, bayL, 0.5), z: bayD, sx: 0.9, sy: 0.96 },
  ], { capStart: false, capEnd: true });
  invertShell(bay);
  A.add('dark', shadeCavity(bay, 0.5, 'z'), { pos: [0, -2.45, -0.5], rot: [Math.PI / 2, 0, 0], tone: 0.7 });

  if (A.mid) {
    for (const sx of [-1, 1]) {
      const parts = [];
      parts.push(xform(tube(0.44, 6.6, { segments: A.fine ? 10 : 6 }), { pos: [0, 0, -3.3] }));
      parts.push(xform(tube(0.44, 1.2, { segments: A.fine ? 10 : 6, rEnd: 0.06 }), { pos: [0, 0, -4.5] }));
      for (let f = 0; f < 4 && A.fine; f++) {
        const a = (f / 4) * Math.PI * 2 + Math.PI / 4;
        parts.push(xform(plate(0.95, 0.07, 1.0, 0.03), { pos: [Math.cos(a) * 0.58, Math.sin(a) * 0.58, 2.8], rot: [0, 0, a] }));
      }
      A.add('metal', mergeGeometries(parts), { pos: [sx * 1.2, -3.35, -0.5], tone: 0.86 });
      A.addEmissive(ring(0.16, 0.3, 0.06, { segments: 10 }), '#ffb44a', 5.0, { tone: 0.8, pos: [sx * 1.2, -3.35, 2.9] });
    }
    for (let i = 0; i < (A.fine ? 5 : 2); i++) {
      A.addEmissive(plate(3.6, 0.12, 0.05, 0.02), '#ffb44a', 5.0, { pos: [0, -2.42, -5.5 + i * 2.7] });
    }
    // Doors swung wide: two big slabs standing clear of the belly, so the front
    // view has daylight between the hull sides and the doors.
    A.addMirrored('panel', chamferedBox(0.3, 3.0, bayL * 0.96, 0.12),
      { pos: [3.9, -3.35, -0.5], rot: [0, 0, -0.95], tone: 1.03 });
  }
  A.missile([0, -3.4, -3.8], [0, 0, -1], 4, 'torpedo');

  // ---------------------------------------------------------- 4. the wing
  // Shoulder-mounted, straight, high aspect, +dihedral. Root chord 9.6 spanning
  // z = -1.36 .. +8.24; tips at x = 13.5.
  const wg = wing({
    span: 10.6, rootChord: 9.6, tipChord: 4.2, rootThick: 1.55, tipThick: 0.5,
    sweep: 1.9, dihedral: 0.045, stations: D === 2 ? 2 : 4, seg: D === 2 ? 8 : 12,
  });
  A.addMirrored('hull', wg, { pos: [2.9, 1.30, 2.0], tone: 0.98 });
  A.addMirrored('panel', chamferedBox(4.6, 0.36, 2.2, 0.12), { pos: [11.0, 1.72, 6.4], tone: 1.06 });

  // --------------------------------------------- 5. under-wing engine pods
  // A metre of sky between the wing and each nacelle, and the pylon chord is a
  // third of the pod length, so the gap is visible fore and aft of it.
  const EP = rectProfile(3.85, 3.70, 0.9);
  for (const sx of [-1, 1]) {
    const pod = loft([
      { pts: EP, z: -3.4, sx: 0.58, sy: 0.60 },
      { pts: EP, z: -1.2, sx: 0.94, sy: 0.95, hard: true },
      { pts: EP, z: 8.4, sx: 1.0, sy: 1.0 },
      { pts: EP, z: 12.4, sx: 0.84, sy: 0.86, hard: true },
    ], {});
    A.add('hull', xform(pod, { pos: [sx * NX, NY, 0] }), { tone: 0.97 });
    engineNozzle(A, { pos: [sx * NX, NY, 12.4], radius: 1.62, length: 2.6, glow: cyan, intensity: glowI, slots: D === 0 ? 8 : 0 });
    if (A.mid) {
      const mouth = loft([
        { pts: rectProfile(2.9, 2.8, 0.7), z: -3.3, sx: 0.72 },
        { pts: rectProfile(2.9, 2.8, 0.7), z: 1.0, sx: 0.5, sy: 0.5 },
      ], { capStart: false, capEnd: true });
      invertShell(mouth);
      A.add('dark', shadeCavity(mouth, 0.6, 'z'), { pos: [sx * NX, NY, 0], tone: 0.55 });
      A.add('metal', ring(0.98, 1.22, 0.36, { segments: A.fine ? 20 : 10 }), { pos: [sx * NX, NY, -3.35], tone: 0.78 });
    }
  }
  pylon(A, { from: [NX, 0.55, 2.0], to: [NX, -0.85, 2.0], chord: 4.8, thick: 0.85, tone: 0.84, taper: 1.0 });

  // ------------------------------------------------ 6. twin booms & H-tail
  const BP = rectProfile(1.75, 1.65, 0.42);
  const boom = loft([
    { pts: BP, z: 0.6, sx: 0.7, sy: 0.7 },
    { pts: BP, z: 3.0, sx: 1.0, sy: 1.0, hard: true },
    { pts: BP, z: 11.0, sx: 1.0, sy: 1.0 },
    { pts: BP, z: 15.0, sx: 0.86, sy: 0.9, hard: true },
    { pts: BP, z: 17.0, sx: 0.6, sy: 0.66 },
  ], {});
  A.addMirrored('hull', boom, { pos: [TX, TY, 0], tone: 0.99 });

  verticalFin(A, {
    pos: [TX, TY + 0.72, 11.2], span: 3.6, rootChord: 5.2, tipChord: 2.2,
    rootThick: 0.55, tipThick: 0.22, sweep: 2.4, cant: 0.26, tone: 1.05, tipPod: 0.16,
  });
  // Horizontal stabiliser strung between the fins — the H that closes the frame
  // around the big rectangle of sky under it.
  A.addMirrored('panel', wing({
    span: 5.05, rootChord: 3.4, tipChord: 2.5, rootThick: 0.44, tipThick: 0.3,
    sweep: 0.6, dihedral: 0, stations: D === 2 ? 2 : 3, seg: D === 2 ? 8 : 10,
  }), { pos: [0, 4.62, 15.2], tone: 1.04 });

  // ---------------------------------------------------------- 7. turrets
  A.add('metal', turretGeometry(1.2, { fine: A.fine }), { pos: [0, 2.70, 3.4], rot: [0, Math.PI, 0], tone: 0.8 });
  A.add('glass', dome(1.05, { segments: A.fine ? 16 : 8, rows: 5, squash: 0.8 }), { pos: [0, 3.14, 3.4], tone: 1, jitter: 0 });
  A.turret([0, 3.14, 3.4], Math.PI * 1.5, 'aa');
  A.gun([0, 3.14, 1.4], [0, 0.1, -1], 'turret');
  if (A.mid) {
    A.add('metal', turretGeometry(0.9, { fine: A.fine }), { pos: [0, -2.35, 8.4], rot: [Math.PI, 0, 0], tone: 0.78 });
    A.turret([0, -2.7, 8.4], Math.PI, 'aa');
  }

  // -------------------------------------------------------------- 8. weapons
  gunMount(A, { pos: [2.0, -1.95, -14.4], length: 2.6, radius: 0.2, type: 'particle' });

  // -------------------------------------------------- 9. functional detail
  if (A.fine) {
    platePatch(A, { center: [0, 2.52, 1.0], normal: [0, 1, 0], tangent: [0, 0, -1], w: 3.2, h: 9.0, cols: 2, rows: 4, thickness: 0.09, rng, tone: 1.07 });
    platePatch(A, { center: [3.3, 0.4, -2.0], normal: [1, 0.12, 0], tangent: [0, 0, -1], w: 4.4, h: 13.0, cols: 2, rows: 5, thickness: 0.09, rng, tone: 1.03 });
    platePatch(A, { center: [-3.3, 0.4, -2.0], normal: [-1, 0.12, 0], tangent: [0, 0, -1], w: 4.4, h: 13.0, cols: 2, rows: 5, thickness: 0.09, rng, tone: 1.03 });
    platePatch(A, { center: [9.6, 1.72, 3.0], normal: [0, 1, 0], tangent: [0, 0, -1], w: 4.6, h: 7.0, cols: 2, rows: 3, thickness: 0.07, rng, tone: 1.05 });
    platePatch(A, { center: [-9.6, 1.72, 3.0], normal: [0, 1, 0], tangent: [0, 0, -1], w: 4.6, h: 7.0, cols: 2, rows: 3, thickness: 0.07, rng, tone: 1.05 });
    platePatch(A, { center: [NX, NY + 1.9, 5.0], normal: [0, 1, 0], tangent: [0, 0, -1], w: 3.0, h: 6.0, cols: 2, rows: 3, thickness: 0.07, rng, tone: 1.04 });
    platePatch(A, { center: [-NX, NY + 1.9, 5.0], normal: [0, 1, 0], tangent: [0, 0, -1], w: 3.0, h: 6.0, cols: 2, rows: 3, thickness: 0.07, rng, tone: 1.04 });
    recessRow(A, { center: [3.4, 1.4, -8.0], normal: [1, 0.3, 0], tangent: [0, 0, -1], w: 1.7, h: 5.5, count: 4, depth: 0.16, rng });
    recessRow(A, { center: [-3.4, 1.4, -8.0], normal: [-1, 0.3, 0], tangent: [0, 0, -1], w: 1.7, h: 5.5, count: 4, depth: 0.16, rng });
    gearBay(A, { pos: [0, -2.2, -12.4], w: 1.5, l: 3.0, depth: 0.6 });
    gearBay(A, { pos: [NX, NY - 1.72, 1.0], w: 1.8, l: 3.2, depth: 0.6, mirror: true });
    sensorDome(A, { pos: [0, 2.5, -6.6], r: 0.5, tone: 0.9 });
    A.addMirrored('accent', plate(2.4, 0.5, 0.07, 0.04), { pos: [3.4, 1.9, -11.0], rot: [0, 0, -1.3], tone: 1 });

    if (greebles?.length) {
      const gm = [];
      for (let i = 0; i < 36; i++) {
        const sx = rng.sign();
        const m = new THREE.Matrix4();
        m.compose(new THREE.Vector3(sx * (NX + rng.range(-1.3, 1.3)), NY + 1.85, rng.range(-1.0, 8.0)),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rng.range(0, Math.PI * 2), 0)),
          new THREE.Vector3(1, 1, 1).multiplyScalar(rng.range(0.6, 1.2)));
        gm.push(m);
      }
      A.instance(greebles[2 % greebles.length], 'metal', gm);
    }
  }

  rcsPort(A, { pos: [3.0, 0.4, -15.4], normal: [1, 0.2, 0], size: 0.44, mirror: true });
  rcsPort(A, { pos: [0, 2.6, -12.0], normal: [0, 1, 0], size: 0.44 });
  rcsPort(A, { pos: [0, -2.4, -13.4], normal: [0, -1, 0], size: 0.44 });
  rcsPort(A, { pos: [TX + 0.9, TY, 13.4], normal: [1, 0.2, 0], size: 0.4, mirror: true });
  rcsPort(A, { pos: [12.4, 1.9, 4.0], normal: [0, 1, 0], size: 0.36, mirror: true });

  A.navLight([-13.7, 1.6, 5.6], '#ff2a1e', 9, 0.3, [-1, 0, 0]);
  A.navLight([13.7, 1.6, 5.6], '#22ff55', 9, 0.3, [1, 0, 0]);
  A.navLight([TX + 1.2, 5.5, 14.2], '#ffffff', 8, 0.22, [0, 1, 0]);
  A.navLight([-(TX + 1.2), 5.5, 14.2], '#ffffff', 8, 0.22, [0, 1, 0]);
  A.navLight([0, 2.7, -4.0], '#ffffff', 6, 0.2, [0, 1, 0]);
  A.navLight([0, -2.6, 6.0], '#ff2a1e', 5, 0.2, [0, -1, 0]);

  return A;
}
