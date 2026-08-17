/**
 * TB-80 Devastator — Confederation heavy bomber.
 *
 * Built around an internal weapons bay, and it shows: a deep slab-sided hull with
 * the ventral bay doors open and torpedoes visible on their launch rails, a
 * gunner's turret blister on the spine, huge armour slabs bolted over everything
 * important, and two oversized drives hung on stub pylons. Slow, ugly, survivable
 * — the silhouette is a brick with a bay in it and reads instantly against the
 * fighters escorting it.
 *
 * -Z forward. 34 m long, 26 m span.
 */
import * as THREE from 'three';
import {
  loft, hullProfile, rectProfile, chamferedBox, plate, panelInset, wing, tube,
  xform, mergeGeometries, shadeCavity, invertShell, ring, dome, ellipseProfile,
} from '../geometryKit.js';
import {
  canopy, engineNozzle, gunMount, rcsPort, platePatch, recessRow, sensorDome,
  gearBay, turretGeometry,
} from '../parts.js';

export const def = {
  id: 'confed_devastator',
  name: 'TB-80 Devastator',
  faction: 'confed',
  role: 'bomber',
  style: 'confed',
  length: 34, span: 26, height: 8.5,
  lod: [0, 320, 1500],
};

export function build(A, rng, greebles) {
  const D = A.detail;
  const cyan = A.mats.palette.glow;
  const glowI = A.mats.palette.glowIntensity;

  // ---------------------------------------------------------------- hull
  const P = hullProfile(2, 2, { topW: 0.72, botW: 0.82, chineLo: -0.3, chineHi: 0.4, c: 0.1 });
  const full = [
    { z: -17.0, sx: 1.0, sy: 0.9, y: -0.3 },
    { z: -15.8, sx: 1.9, sy: 1.5, y: -0.25, hard: true },
    { z: -13.0, sx: 3.0, sy: 2.2, y: -0.15 },
    { z: -8.5, sx: 3.9, sy: 2.7, y: 0.0 },
    { z: -3.0, sx: 4.4, sy: 3.0, y: 0.05, hard: true },
    { z: 3.0, sx: 4.5, sy: 3.05, y: 0.05 },
    { z: 8.5, sx: 4.3, sy: 2.9, y: 0.0, hard: true },
    { z: 13.5, sx: 3.8, sy: 2.5, y: -0.1 },
    { z: 16.5, sx: 3.3, sy: 2.1, y: -0.15 },
    { z: 17.0, sx: 2.9, sy: 1.8, y: -0.15 },
  ];
  const coarse = full.filter((_, i) => i % 2 === 0 || i === full.length - 1);
  A.add('hull', loft((D === 2 ? coarse : full).map((s) => ({ ...s, pts: P })), {}), { tone: 1 });

  // Bolted-on frontal armour glacis — the bomber's defining shape.
  A.add('panel', loft([
    { pts: rectProfile(6.6, 4.4, 1.0), z: -16.8, sx: 0.35, sy: 0.42, y: -0.2 },
    { pts: rectProfile(6.6, 4.4, 1.0), z: -15.0, sx: 0.8, sy: 0.85, y: -0.15, hard: true },
    { pts: rectProfile(6.6, 4.4, 1.0), z: -10.0, sx: 1.05, sy: 1.0, y: -0.05 },
    { pts: rectProfile(6.6, 4.4, 1.0), z: -7.6, sx: 0.85, sy: 0.9, y: 0 },
  ], {}), { tone: 1.07 });

  // -------------------------------------------------------- weapons bay
  // Open ventral bay: a lit recess with torpedoes on rails and split doors that
  // stand proud of the hull. This is the ship's whole reason to exist.
  const bayW = 4.6, bayL = 13.0, bayD = 2.2;
  const bay = loft([
    { pts: rectProfile(bayW, bayL, 0.5), z: 0 },
    { pts: rectProfile(bayW, bayL, 0.5), z: bayD * 0.6, sx: 0.97, sy: 0.99 },
    { pts: rectProfile(bayW, bayL, 0.5), z: bayD, sx: 0.9, sy: 0.96 },
  ], { capStart: false, capEnd: true });
  invertShell(bay);
  A.add('dark', shadeCavity(bay, 0.5, 'z'), { pos: [0, -3.05, 0.5], rot: [Math.PI / 2, 0, 0], tone: 0.7 });

  if (A.mid) {
    // Torpedoes on their rails, nose-forward inside the bay.
    for (const sx of [-1, 1]) {
      const parts = [];
      const body = tube(0.42, 6.4, { segments: A.fine ? 10 : 6 });
      parts.push(xform(body, { pos: [0, 0, -3.2] }));
      parts.push(xform(tube(0.42, 1.1, { segments: A.fine ? 10 : 6, rEnd: 0.06 }), { pos: [0, 0, -4.3] }));
      for (let f = 0; f < 4 && A.fine; f++) {
        const a = (f / 4) * Math.PI * 2 + Math.PI / 4;
        parts.push(xform(plate(0.9, 0.07, 1.0, 0.03), { pos: [Math.cos(a) * 0.55, Math.sin(a) * 0.55, 2.7], rot: [0, 0, a] }));
      }
      A.add('metal', mergeGeometries(parts), { pos: [sx * 1.15, -3.9, 1.0], tone: 0.86 });
      A.addEmissive(ring(0.16, 0.3, 0.06, { segments: 10 }), '#ffb44a', 5.0, { tone: 0.8, pos: [sx * 1.15, -3.9, 4.25] });
    }
    // Bay lighting strips.
    for (let i = 0; i < (A.fine ? 5 : 2); i++) {
      A.addEmissive(plate(3.4, 0.12, 0.05, 0.02), '#ffb44a', 5.0, { pos: [0, -3.0, -5.0 + i * 2.6] });
    }
    // Door halves, hinged open.
    for (const sx of [-1, 1]) {
      A.add('panel', chamferedBox(2.5, 0.28, bayL * 0.98, 0.1), {
        pos: [sx * 3.35, -3.5, 0.5], rot: [0, 0, sx * 0.65], tone: 1.03,
      });
    }
  }
  A.missile([0, -4.2, -3.0], [0, 0, -1], 4, 'torpedo');

  // ---------------------------------------------------------------- canopy
  canopy(A, { zFront: -12.4, zBack: -6.8, width: 3.2, height: 1.15, yBase: 2.1, yLift: 0.28 });
  if (A.fine) A.add('dark', plate(2.6, 2.4, 0.09, 0.06), { pos: [0, 2.2, -13.8], rot: [-0.16, 0, 0], tone: 0.75 });

  // ------------------------------------------------------------ wing group
  const wg = wing({
    span: 8.6, rootChord: 10.5, tipChord: 5.0, rootThick: 1.7, tipThick: 0.6,
    sweep: 2.2, dihedral: 0.03, stations: D === 2 ? 2 : 4, seg: D === 2 ? 8 : 12,
  });
  A.addPair('hull', xform(wg, { pos: [4.2, -0.4, 2.0] }), { tone: 0.98 });
  A.addPair('panel', chamferedBox(6.0, 0.34, 2.4, 0.12), { pos: [8.6, -0.5, 6.2], tone: 1.06 });

  // ------------------------------------------------------- engine pylons
  for (const sx of [-1, 1]) {
    A.add('metal', chamferedBox(1.1, 2.6, 6.0, 0.35), { pos: [sx * 6.6, 0.4, 8.0], tone: 0.82 });
    const pod = loft([
      { pts: rectProfile(4.2, 4.0, 1.0), z: 2.0, sx: 0.62, sy: 0.6 },
      { pts: rectProfile(4.2, 4.0, 1.0), z: 5.0, sx: 0.95, hard: true },
      { pts: rectProfile(4.2, 4.0, 1.0), z: 15.0, sx: 1.0 },
      { pts: rectProfile(4.2, 4.0, 1.0), z: 16.8, sx: 0.85, sy: 0.88 },
    ], {});
    A.add('hull', xform(pod, { pos: [sx * 6.6, 0.3, 0] }), { tone: 0.97 });
    engineNozzle(A, { pos: [sx * 6.6, 0.3, 16.8], radius: 1.85, length: 3.0, glow: cyan, intensity: glowI, slots: D === 0 ? 8 : 0 });
    if (A.mid) {
      const mouth = loft([
        { pts: rectProfile(3.2, 3.0, 0.8), z: 2.1, sx: 0.72 },
        { pts: rectProfile(3.2, 3.0, 0.8), z: 6.5, sx: 0.5, sy: 0.5 },
      ], { capStart: false, capEnd: true });
      invertShell(mouth);
      A.add('dark', shadeCavity(mouth, 0.6, 'z'), { pos: [sx * 6.6, 0.3, 0], tone: 0.55 });
    }
  }

  // ---------------------------------------------------------- dorsal turret
  // A real gunner's blister: barbette, glazed cupola, twin barrels.
  A.add('metal', turretGeometry(1.15, { fine: A.fine }), { pos: [0, 3.1, 4.5], rot: [0, Math.PI, 0], tone: 0.8 });
  A.add('glass', dome(1.0, { segments: A.fine ? 16 : 8, rows: 5, squash: 0.8 }), { pos: [0, 3.5, 4.5], tone: 1, jitter: 0 });
  A.turret([0, 3.5, 4.5], Math.PI * 1.5, 'aa');
  A.gun([0, 3.5, 2.6], [0, 0.1, -1], 'turret');

  // Ventral tail-gun blister.
  if (A.mid) {
    A.add('metal', turretGeometry(0.85, { fine: A.fine }), { pos: [0, -2.9, 12.0], rot: [Math.PI, 0, 0], tone: 0.78 });
    A.turret([0, -3.2, 12.0], Math.PI, 'aa');
  }

  // ------------------------------------------------------------- tail fin
  const finProf = rectProfile(1.6, 0.5, 0.16);
  A.add('panel', loft([
    { pts: finProf, z: 10.0, sx: 1.0, y: 2.4 },
    { pts: finProf, z: 11.6, sx: 0.85, sy: 0.85, y: 4.2 },
    { pts: finProf, z: 14.0, sx: 0.5, sy: 0.6, y: 5.6 },
    { pts: finProf, z: 15.6, sx: 0.24, sy: 0.4, y: 6.2 },
  ], {}), { tone: 1.04 });

  // -------------------------------------------------------------- weapons
  gunMount(A, { pos: [2.2, -2.0, -13.0], length: 2.6, radius: 0.2, type: 'particle' });

  // ------------------------------------------------------ functional detail
  if (A.fine) {
    platePatch(A, { center: [0, 3.05, -1.0], normal: [0, 1, 0], tangent: [0, 0, -1], w: 5.4, h: 9.0, cols: 2, rows: 4, thickness: 0.09, rng, tone: 1.07 });
    platePatch(A, { center: [4.4, 0.4, 0.0], normal: [1, 0.15, 0], tangent: [0, 0, -1], w: 5.2, h: 14.0, cols: 2, rows: 5, thickness: 0.09, rng, tone: 1.03 });
    platePatch(A, { center: [-4.4, 0.4, 0.0], normal: [-1, 0.15, 0], tangent: [0, 0, -1], w: 5.2, h: 14.0, cols: 2, rows: 5, thickness: 0.09, rng, tone: 1.03 });
    platePatch(A, { center: [9.5, -0.35, 3.0], normal: [0, 1, 0], tangent: [0, 0, -1], w: 5.0, h: 7.0, cols: 2, rows: 3, thickness: 0.07, rng, tone: 1.05 });
    platePatch(A, { center: [-9.5, -0.35, 3.0], normal: [0, 1, 0], tangent: [0, 0, -1], w: 5.0, h: 7.0, cols: 2, rows: 3, thickness: 0.07, rng, tone: 1.05 });
    recessRow(A, { center: [4.2, 1.4, -8.0], normal: [1, 0.3, 0], tangent: [0, 0, -1], w: 1.8, h: 5.5, count: 4, depth: 0.16, rng });
    recessRow(A, { center: [-4.2, 1.4, -8.0], normal: [-1, 0.3, 0], tangent: [0, 0, -1], w: 1.8, h: 5.5, count: 4, depth: 0.16, rng });
    gearBay(A, { pos: [0, -2.6, -11.5], w: 1.5, l: 3.0, depth: 0.6 });
    gearBay(A, { pos: [5.4, -1.9, 6.5], w: 2.0, l: 3.4, depth: 0.7, mirror: true });
    sensorDome(A, { pos: [0, 3.2, -8.6], r: 0.55, tone: 0.9 });
    A.addPair('accent', plate(2.6, 0.5, 0.07, 0.04), { pos: [4.5, 1.9, -11.0], rot: [0, 0, -1.3], tone: 1 });

    if (greebles?.length) {
      const gm = [];
      for (let i = 0; i < 40; i++) {
        const sx = rng.sign();
        const m = new THREE.Matrix4();
        m.compose(new THREE.Vector3(sx * rng.range(4.8, 8.4), rng.range(1.6, 2.4), rng.range(4.0, 15.0)),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rng.range(0, Math.PI * 2), 0)),
          new THREE.Vector3(1, 1, 1).multiplyScalar(rng.range(0.6, 1.3)));
        gm.push(m);
      }
      A.instance(greebles[2 % greebles.length], 'metal', gm);
    }
  }

  rcsPort(A, { pos: [3.0, 0.4, -14.5], normal: [1, 0.2, 0], size: 0.44, mirror: true });
  rcsPort(A, { pos: [0, 3.0, -11.0], normal: [0, 1, 0], size: 0.44 });
  rcsPort(A, { pos: [0, -2.9, -13.0], normal: [0, -1, 0], size: 0.44 });
  rcsPort(A, { pos: [4.6, 0.4, 12.0], normal: [1, 0.2, 0], size: 0.46, mirror: true });
  rcsPort(A, { pos: [12.0, -0.5, 5.0], normal: [0, 1, 0], size: 0.36, mirror: true });

  A.navLight([-13.3, -0.6, 6.6], '#ff2a1e', 9, 0.3, [-1, 0, 0]);
  A.navLight([13.3, -0.6, 6.6], '#22ff55', 9, 0.3, [1, 0, 0]);
  A.navLight([0, 6.5, 15.4], '#ffffff', 8, 0.22, [0, 1, 0]);
  A.navLight([0, 3.3, -3.0], '#ffffff', 6, 0.2, [0, 1, 0]);
  A.navLight([0, -3.1, 8.0], '#ff2a1e', 5, 0.2, [0, -1, 0]);

  return A;
}
