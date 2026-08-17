/**
 * F-103 Panther — Confederation heavy fighter.
 *
 * Where the Vampire is a scalpel, the Panther is a hammer. Broad flattened
 * forebody, a wide low-aspect wing with drooped tips, shoulder-mounted gun pods
 * big enough to see the recoil housings on, and four drives in a 2×2 cluster.
 * The canopy sits low and far forward inside an armoured tub, so the silhouette
 * is a wedge rather than the Vampire's fuselage-plus-nacelles.
 *
 * -Z forward. 27.5 m long, 19 m span.
 */
import * as THREE from 'three';
import {
  loft, hullProfile, rectProfile, chamferedBox, plate, wing, tube, xform,
  mergeGeometries, shadeCavity, invertShell, ring, dome,
} from '../geometryKit.js';
import {
  canopy, engineNozzle, gunMount, missileRail, rcsPort, platePatch, recessRow,
  sensorDome, gearBay,
} from '../parts.js';

export const def = {
  id: 'confed_panther',
  name: 'F-103 Panther',
  faction: 'confed',
  role: 'heavy fighter',
  style: 'confed',
  length: 27.5, span: 19, height: 6.2,
  lod: [0, 280, 1300],
};

export function build(A, rng, greebles) {
  const D = A.detail;
  const cyan = A.mats.palette.glow;
  const glowI = A.mats.palette.glowIntensity;

  // ------------------------------------------------------------- forebody
  // Wide and flat — a lifting body, not a tube.
  const P = hullProfile(2, 2, { topW: 0.62, botW: 0.86, chineLo: -0.28, chineHi: 0.36, c: 0.14 });
  const full = [
    { z: -13.8, sx: 0.5, sy: 0.22, y: -0.5 },
    { z: -13.0, sx: 1.0, sy: 0.42, y: -0.48, hard: true },
    { z: -11.0, sx: 1.8, sy: 0.72, y: -0.4 },
    { z: -8.0, sx: 2.7, sy: 1.05, y: -0.25 },
    { z: -4.5, sx: 3.35, sy: 1.35, y: -0.08, hard: true },
    { z: -0.5, sx: 3.55, sy: 1.62, y: 0.0 },
    { z: 3.5, sx: 3.45, sy: 1.72, y: 0.0 },
    { z: 7.5, sx: 3.15, sy: 1.65, y: -0.05, hard: true },
    { z: 11.0, sx: 2.85, sy: 1.5, y: -0.1 },
    { z: 13.4, sx: 2.55, sy: 1.35, y: -0.1 },
    { z: 13.75, sx: 2.2, sy: 1.15, y: -0.1 },
  ];
  const coarse = full.filter((_, i) => i % 2 === 0 || i === full.length - 1);
  A.add('hull', loft((D === 2 ? coarse : full).map((s) => ({ ...s, pts: P })), {}), { tone: 1 });

  // Armoured nose block with a chin sensor turret bulge.
  A.add('panel', loft([
    { pts: rectProfile(3.6, 1.5, 0.42), z: -13.6, sx: 0.42, sy: 0.5, y: -0.55 },
    { pts: rectProfile(3.6, 1.5, 0.42), z: -12.4, sx: 0.9, y: -0.5, hard: true },
    { pts: rectProfile(3.6, 1.5, 0.42), z: -9.2, sx: 1.05, y: -0.45 },
    { pts: rectProfile(3.6, 1.5, 0.42), z: -7.4, sx: 0.8, sy: 0.85, y: -0.5 },
  ], {}), { tone: 1.06 });
  sensorDome(A, { pos: [0, -1.35, -10.4], r: 0.8, normal: [0, -1, 0.15], tone: 0.9 });

  // Dorsal armour spine, stepped — the Panther's read from above.
  A.add('panel', loft([
    { pts: rectProfile(3.0, 0.7, 0.24), z: -5.5, sx: 0.5, sy: 0.6, y: 1.5 },
    { pts: rectProfile(3.0, 0.7, 0.24), z: -3.0, sx: 0.95, y: 1.75, hard: true },
    { pts: rectProfile(3.0, 0.7, 0.24), z: 5.5, sx: 1.0, y: 1.85 },
    { pts: rectProfile(3.0, 0.7, 0.24), z: 10.5, sx: 0.7, sy: 0.7, y: 1.6 },
  ], {}), { tone: 1.08 });

  // ---------------------------------------------------------------- canopy
  canopy(A, { zFront: -8.6, zBack: -3.0, width: 2.5, height: 1.05, yBase: 1.05, yLift: 0.2 });
  if (A.fine) A.add('dark', plate(2.0, 2.2, 0.08, 0.05), { pos: [0, 1.1, -9.9], rot: [-0.14, 0, 0], tone: 0.75 });

  // ------------------------------------------------------------ wing group
  const wg = wing({
    span: 6.2, rootChord: 8.4, tipChord: 3.6, rootThick: 1.35, tipThick: 0.42,
    sweep: 3.0, dihedral: -0.16, stations: D === 2 ? 2 : 4, seg: D === 2 ? 8 : 12,
  });
  A.addPair('hull', xform(wg, { pos: [3.2, 0.0, 2.0] }), { tone: 0.98 });
  // Drooped wingtip pylons carrying the missile rails.
  A.addPair('panel', chamferedBox(1.5, 1.0, 5.0, 0.3), { pos: [9.0, -1.15, 3.2], rot: [0, 0, 0.28], tone: 1.04 });

  // ---------------------------------------------------- shoulder gun pods
  const pod = loft([
    { pts: rectProfile(2.0, 1.9, 0.5), z: -9.0, sx: 0.45, sy: 0.5 },
    { pts: rectProfile(2.0, 1.9, 0.5), z: -7.5, sx: 0.95, hard: true },
    { pts: rectProfile(2.0, 1.9, 0.5), z: -1.0, sx: 1.0 },
    { pts: rectProfile(2.0, 1.9, 0.5), z: 1.5, sx: 0.7, sy: 0.75 },
  ], {});
  A.addPair('hull', xform(pod, { pos: [3.9, 0.55, 0] }), { tone: 1.02 });
  A.addPair('accent', plate(1.2, 0.4, 0.08, 0.04), { pos: [3.9, 1.5, -6.6], tone: 1 });

  // ------------------------------------------------------- engine cluster
  // Four drives in a 2×2 block inside a common armoured shroud.
  const shroud = loft([
    { pts: rectProfile(6.6, 4.6, 1.0), z: 4.0, sx: 0.8, sy: 0.82 },
    { pts: rectProfile(6.6, 4.6, 1.0), z: 6.5, sx: 1.0, hard: true },
    { pts: rectProfile(6.6, 4.6, 1.0), z: 12.6, sx: 1.0 },
    { pts: rectProfile(6.6, 4.6, 1.0), z: 13.8, sx: 0.88, sy: 0.9 },
  ], {});
  A.add('hull', shroud, { pos: [0, 0.2, 0], tone: 0.96 });
  for (const ex of [-1.75, 1.75]) {
    for (const ey of [-1.05, 1.15]) {
      engineNozzle(A, { pos: [ex, ey + 0.2, 13.7], radius: 1.32, length: 2.1, glow: cyan, intensity: glowI, slots: D === 0 ? 6 : 0 });
    }
  }
  // Intake trunks feeding the cluster, one each side of the fuselage.
  if (A.mid) {
    for (const sx of [-1, 1]) {
      const trunk = loft([
        { pts: rectProfile(1.9, 2.2, 0.5), z: -3.0, sx: 0.9, sy: 0.9 },
        { pts: rectProfile(1.9, 2.2, 0.5), z: 2.0, sx: 1.0 },
        { pts: rectProfile(1.9, 2.2, 0.5), z: 6.0, sx: 0.95, sy: 1.05 },
      ], { capStart: true, capEnd: false });
      A.add('metal', xform(trunk, { pos: [sx * 4.15, 0.1, 0] }), { tone: 0.8 });
      const mouth = loft([
        { pts: rectProfile(1.6, 1.9, 0.42), z: -3.1, sx: 1.0 },
        { pts: rectProfile(1.6, 1.9, 0.42), z: 1.0, sx: 0.6, sy: 0.6 },
      ], { capStart: false, capEnd: true });
      invertShell(mouth);
      A.add('dark', shadeCavity(mouth, 0.6, 'z'), { pos: [sx * 4.15, 0.1, 0], tone: 0.55 });
    }
  }

  // ------------------------------------------------------------- tail fins
  const finProf = rectProfile(1.2, 0.32, 0.1);
  const fin = loft([
    { pts: finProf, z: 7.0, sx: 1.0, y: 0 },
    { pts: finProf, z: 8.4, sx: 0.85, sy: 0.85, y: 1.4 },
    { pts: finProf, z: 10.4, sx: 0.55, sy: 0.6, y: 2.7 },
    { pts: finProf, z: 11.8, sx: 0.28, sy: 0.4, y: 3.4 },
  ], {});
  A.addPair('panel', xform(fin, { pos: [3.2, 1.6, 0], rot: [0, 0, -0.34] }), { tone: 1.04 });
  // Ventral strakes.
  A.addPair('hull', xform(fin, { pos: [2.6, -1.5, 0.5], rot: [Math.PI, 0, -0.3], scale: [0.7, 0.55, 0.8] }), { tone: 0.94 });

  // -------------------------------------------------------------- weapons
  gunMount(A, { pos: [3.9, 0.55, -8.6], length: 3.4, radius: 0.24, type: 'ion' });
  gunMount(A, { pos: [1.5, -1.15, -10.4], length: 2.2, radius: 0.18, type: 'particle' });
  missileRail(A, { pos: [8.6, -1.9, 3.0], count: 3, spacing: 0.7, length: 2.3, radius: 0.17, type: 'FF' });
  missileRail(A, { pos: [5.4, -1.75, 4.6], count: 2, spacing: 0.66, length: 2.6, radius: 0.19, type: 'dumbfire' });

  // ------------------------------------------------------ functional detail
  if (A.fine) {
    platePatch(A, { center: [0, 1.9, 6.0], normal: [0, 1, 0], tangent: [0, 0, -1], w: 4.4, h: 6.0, cols: 2, rows: 4, thickness: 0.07, rng, tone: 1.07 });
    platePatch(A, { center: [5.6, 0.4, 3.6], normal: [0, 1, 0.08], tangent: [0, 0, -1], w: 4.2, h: 5.0, cols: 3, rows: 3, thickness: 0.06, rng, tone: 1.05 });
    platePatch(A, { center: [-5.6, 0.4, 3.6], normal: [0, 1, 0.08], tangent: [0, 0, -1], w: 4.2, h: 5.0, cols: 3, rows: 3, thickness: 0.06, rng, tone: 1.05 });
    platePatch(A, { center: [0, -1.75, 1.0], normal: [0, -1, 0], tangent: [0, 0, -1], w: 4.6, h: 8.0, cols: 3, rows: 5, thickness: 0.06, rng, tone: 0.95 });
    recessRow(A, { center: [3.5, 0.6, -5.0], normal: [1, 0.2, 0], tangent: [0, 0, -1], w: 1.4, h: 4.4, count: 4, depth: 0.12, rng });
    recessRow(A, { center: [-3.5, 0.6, -5.0], normal: [-1, 0.2, 0], tangent: [0, 0, -1], w: 1.4, h: 4.4, count: 4, depth: 0.12, rng });
    gearBay(A, { pos: [0, -1.6, -8.0], w: 1.2, l: 2.6, depth: 0.5 });
    gearBay(A, { pos: [3.0, -1.7, 3.2], w: 1.6, l: 3.0, depth: 0.6, mirror: true });
    sensorDome(A, { pos: [0, 2.25, -6.2], r: 0.42, tone: 0.9 });
    A.addPair('panel', plate(2.0, 0.7, 0.06, 0.04), { pos: [2.6, 0.6, -7.0], rot: [0, 0, -1.25], tone: 1.1 });

    if (greebles?.length) {
      const gm = [];
      for (let i = 0; i < 26; i++) {
        const sx = rng.sign();
        const m = new THREE.Matrix4();
        m.compose(new THREE.Vector3(sx * rng.range(1.0, 3.2), rng.range(1.7, 2.1), rng.range(4.0, 12.0)),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rng.range(0, Math.PI * 2), 0)),
          new THREE.Vector3(1, 1, 1).multiplyScalar(rng.range(0.5, 1.0)));
        gm.push(m);
      }
      A.instance(greebles[1 % greebles.length], 'metal', gm);
    }
  }

  rcsPort(A, { pos: [1.7, 0.2, -11.6], normal: [1, 0.2, 0], size: 0.36, mirror: true });
  rcsPort(A, { pos: [0, 1.9, -9.0], normal: [0, 1, 0], size: 0.36 });
  rcsPort(A, { pos: [0, -1.5, -9.0], normal: [0, -1, 0], size: 0.36 });
  rcsPort(A, { pos: [5.0, 0.2, 9.0], normal: [1, 0.2, 0], size: 0.38, mirror: true });
  rcsPort(A, { pos: [8.6, -0.9, 3.2], normal: [0, -1, 0.2], size: 0.3, mirror: true });

  A.navLight([-9.7, -1.5, 4.2], '#ff2a1e', 8, 0.24, [-1, -0.2, 0]);
  A.navLight([9.7, -1.5, 4.2], '#22ff55', 8, 0.24, [1, -0.2, 0]);
  A.navLight([0, 2.3, 0.0], '#ffffff', 7, 0.18, [0, 1, 0]);
  A.navLight([0, -1.85, 6.0], '#ffffff', 5, 0.16, [0, -1, 0]);
  A.navLight([4.6, 4.1, 11.4], '#ffd0a0', 6, 0.15, [0, 1, 0]);
  A.navLight([-4.6, 4.1, 11.4], '#ffd0a0', 6, 0.15, [0, 1, 0]);

  return A;
}
