/**
 * F-109 Vampire — Terran Confederation medium space-superiority fighter.
 *
 * The player's ship. Prophecy-era Confed design language: a long chined forebody
 * with a chin gun pod, a raised bubble canopy set well forward, forward-swept
 * intake shoulders feeding twin outboard nacelles, cropped delta wings and canted
 * twin tails. Every mass is a different shape from its neighbour so the ship is
 * still identifiable as a pure black silhouette.
 *
 * -Z forward, +Y up, +X starboard. 22 m long, 16.6 m span.
 */
import * as THREE from 'three';
import {
  chamferedBox, plate, panelInset, loft, hullProfile, rectProfile, wing, tube,
  xform, mergeGeometries, mirrorX, shadeCavity, ring, dome, ellipseProfile, invertShell,
} from '../geometryKit.js';
import {
  canopy, engineNacelle, gunMount, missileRail, rcsPort, platePatch, recessRow,
  sensorDome, gearBay,
} from '../parts.js';

export const def = {
  id: 'confed_vampire',
  name: 'F-109 Vampire',
  faction: 'confed',
  role: 'medium fighter',
  style: 'confed',
  length: 22, span: 16.6, height: 5.4,
  lod: [0, 240, 1100],
};

export function build(A, rng, greebles) {
  const D = A.detail;
  const cyan = A.mats.palette.glow;
  const glowI = A.mats.palette.glowIntensity;

  // ------------------------------------------------------------ fuselage
  const P = hullProfile(2, 2, { topW: 0.52, botW: 0.8, chineLo: -0.22, chineHi: 0.42, c: 0.17 });
  const full = [
    { z: -11.0, sx: 0.15, sy: 0.12, y: -0.28 },
    { z: -10.3, sx: 0.42, sy: 0.31, y: -0.27 },
    { z: -9.1, sx: 0.76, sy: 0.53, y: -0.22, hard: true },
    { z: -7.0, sx: 1.12, sy: 0.78, y: -0.12 },
    { z: -4.9, sx: 1.44, sy: 0.99, y: -0.02 },
    { z: -2.6, sx: 1.71, sy: 1.19, y: 0.04, hard: true },
    { z: 0.2, sx: 1.86, sy: 1.31, y: 0.04 },
    { z: 3.0, sx: 1.84, sy: 1.28, y: 0.0 },
    { z: 5.8, sx: 1.68, sy: 1.14, y: -0.05 },
    { z: 8.4, sx: 1.48, sy: 0.98, y: -0.09, hard: true },
    { z: 10.5, sx: 1.33, sy: 0.88, y: -0.09 },
    { z: 11.0, sx: 1.14, sy: 0.72, y: -0.09 },
  ];
  const coarse = full.filter((_, i) => i % 2 === 0 || i === full.length - 1);
  const sections = (D === 2 ? coarse : full).map((s) => ({ ...s, pts: P }));
  A.add('hull', loft(sections, {}), { tone: 1 });

  // Nose: a separate darker radome cap so the point of the ship is not the same
  // colour as the body — reads as a sensor unit, not a moulded tip.
  A.add('dark', loft([
    { pts: P, z: -11.05, sx: 0.14, sy: 0.11, y: -0.28 },
    { pts: P, z: -10.4, sx: 0.44, sy: 0.33, y: -0.27 },
    { pts: P, z: -9.9, sx: 0.56, sy: 0.40, y: -0.26 },
  ], {}), { tone: 0.85 });

  // ------------------------------------------------- dorsal & ventral spines
  // A raised spine down the back gives the top surface a highlight line.
  A.add('panel', loft([
    { pts: rectProfile(1.5, 0.36, 0.13), z: -3.4, sx: 0.45, sy: 0.5, y: 1.05 },
    { pts: rectProfile(1.5, 0.36, 0.13), z: -1.0, sx: 0.9, y: 1.2, hard: true },
    { pts: rectProfile(1.5, 0.36, 0.13), z: 5.4, sx: 1.0, y: 1.18 },
    { pts: rectProfile(1.5, 0.36, 0.13), z: 9.2, sx: 0.66, sy: 0.7, y: 0.95 },
  ], {}), { tone: 1.08 });

  // Ventral keel strake — the belly needs a shape too.
  A.add('hull', loft([
    { pts: rectProfile(1.9, 0.5, 0.16), z: -6.6, sx: 0.4, sy: 0.4, y: -0.9 },
    { pts: rectProfile(1.9, 0.5, 0.16), z: -3.6, sx: 0.9, y: -1.15, hard: true },
    { pts: rectProfile(1.9, 0.5, 0.16), z: 4.0, sx: 1.0, y: -1.2 },
    { pts: rectProfile(1.9, 0.5, 0.16), z: 8.0, sx: 0.55, sy: 0.6, y: -1.0 },
  ], {}), { tone: 0.94 });

  // ---------------------------------------------------------------- canopy
  canopy(A, { zFront: -6.4, zBack: -1.3, width: 2.15, height: 1.0, yBase: 0.75, yLift: 0.22, glow: '#7fe4ff' });
  // Anti-glare shield ahead of the windscreen — matte black, unmistakably a fighter.
  if (A.fine) {
    A.add('dark', plate(1.6, 2.0, 0.07, 0.05), { pos: [0, 0.86, -7.6], rot: [-0.10, 0, 0], tone: 0.75 });
  }

  // ------------------------------------------------------------ wing group
  const wg = wing({
    span: 6.9, rootChord: 5.6, tipChord: 2.3, rootThick: 0.92, tipThick: 0.3,
    sweep: 2.5, dihedral: -0.055, stations: D === 2 ? 2 : 4, seg: D === 2 ? 8 : 12,
  });
  A.addPair('hull', xform(wg, { pos: [1.55, -0.16, 1.1] }), { tone: 0.98 });

  // Wing fences / control surfaces in the lighter panel colour.
  if (A.mid) {
    A.addPair('panel', chamferedBox(4.1, 0.2, 1.25, 0.07), { pos: [5.2, -0.24, 3.55], rot: [0, -0.11, -0.05], tone: 1.06 });
    A.addPair('metal', chamferedBox(0.14, 0.55, 2.1, 0.05), { pos: [4.6, 0.12, 2.2], tone: 0.8 });
  }

  // ---------------------------------------------------- intakes & nacelles
  // The intake shoulders sweep *forward* of the wing leading edge — the Vampire's
  // most recognisable feature and the thing that keeps its plan view from being a
  // plain delta.
  const shoulder = loft([
    { pts: rectProfile(2.3, 1.9, 0.5), z: -3.9, sx: 0.55, sy: 0.62, x: 3.42, y: -0.05 },
    { pts: rectProfile(2.3, 1.9, 0.5), z: -2.9, sx: 0.86, sy: 0.9, x: 3.12, y: -0.08, hard: true },
    { pts: rectProfile(2.3, 1.9, 0.5), z: -1.4, sx: 1.0, sy: 1.0, x: 3.0, y: -0.1 },
  ], {});
  A.addPair('hull', shoulder, { tone: 1.02 });
  // Orange intake-lip warning stripe — the accent colour §7 asks for.
  A.addPair('accent', plate(0.9, 0.34, 0.07, 0.03), { pos: [3.42, 0.52, -3.86], rot: [0.35, 0, 0], tone: 1 });

  engineNacelle(A, {
    x: 3.0, y: -0.1, zFront: -1.5, zBack: 10.4, r: 1.06,
    glow: cyan, intensity: glowI, greebles, rng, intake: false, tone: 1.0,
  });
  engineNacelle(A, {
    x: -3.0, y: -0.1, zFront: -1.5, zBack: 10.4, r: 1.06,
    glow: cyan, intensity: glowI, greebles, rng, intake: false, tone: 1.0,
  });

  // Forward-swept intake mouths, canted outboard.
  if (A.mid) {
    const mouth = loft([
      { pts: rectProfile(1.9, 1.5, 0.36), z: -4.0, sx: 1.0, sy: 1.0, x: 3.35, ry: 0.0 },
      { pts: rectProfile(1.9, 1.5, 0.36), z: -3.85, sx: 0.86, sy: 0.86, x: 3.3, hard: true },
      { pts: rectProfile(1.9, 1.5, 0.36), z: -2.3, sx: 0.7, sy: 0.7, x: 3.15 },
    ], { capStart: false, capEnd: true });
    A.addPair('metal', mouth, { tone: 0.74 });
    const throat = loft([
      { pts: rectProfile(1.62, 1.26, 0.3), z: -3.8, sx: 1, sy: 1, x: 3.3 },
      { pts: rectProfile(1.62, 1.26, 0.3), z: -1.6, sx: 0.62, sy: 0.62, x: 3.1 },
    ], { capStart: false, capEnd: true });
    invertShell(throat);
    A.addPair('dark', shadeCavity(throat, 0.6, 'z'), { tone: 0.55 });
  }

  // ------------------------------------------------------------ tail fins
  const finProf = rectProfile(0.9, 0.24, 0.07);
  const fin = loft([
    { pts: finProf, z: 6.2, sx: 1.0, sy: 1.0, y: 0.0 },
    { pts: finProf, z: 6.9, sx: 0.9, sy: 0.85, y: 1.1, hard: false },
    { pts: finProf, z: 8.0, sx: 0.62, sy: 0.62, y: 2.2 },
    { pts: finProf, z: 9.1, sx: 0.3, sy: 0.4, y: 2.85 },
  ], {});
  A.addPair('panel', xform(fin, { pos: [3.0, 0.75, 0], rot: [0, 0, -0.42] }), { tone: 1.04 });
  // Fin-tip ECM pods.
  if (A.fine) {
    A.addPair('metal', xform(tube(0.16, 1.4, { segments: 8, rEnd: 0.09 }), { pos: [0, 0, -0.7] }),
      { pos: [4.2, 3.35, 8.5], tone: 0.78 });
  }

  // -------------------------------------------------------------- weapons
  gunMount(A, { pos: [2.62, -0.42, -2.6], length: 2.7, radius: 0.19, type: 'particle' });
  gunMount(A, { pos: [0.82, -1.02, -6.0], length: 1.9, radius: 0.15, type: 'laser' });
  missileRail(A, { pos: [5.1, -0.62, 2.0], count: 2, spacing: 0.62, length: 2.0, radius: 0.15, type: 'IR' });

  // ------------------------------------------------------ functional detail
  if (A.fine) {
    // Recessed avionics bays down the flanks, plating on the spine and wings.
    recessRow(A, { center: [1.9, 0.35, -1.6], normal: [1, 0.15, 0], tangent: [0, 0, -1], w: 1.0, h: 3.0, count: 3, depth: 0.09, rng });
    recessRow(A, { center: [-1.9, 0.35, -1.6], normal: [-1, 0.15, 0], tangent: [0, 0, -1], w: 1.0, h: 3.0, count: 3, depth: 0.09, rng });
    platePatch(A, { center: [0, 1.34, 4.0], normal: [0, 1, 0], tangent: [0, 0, -1], w: 2.2, h: 5.4, cols: 2, rows: 4, thickness: 0.05, rng, tone: 1.07 });
    platePatch(A, { center: [4.4, 0.16, 2.6], normal: [0, 1, 0.06], tangent: [0, 0, -1], w: 3.6, h: 3.4, cols: 3, rows: 3, thickness: 0.04, rng, tone: 1.05 });
    platePatch(A, { center: [-4.4, 0.16, 2.6], normal: [0, 1, 0.06], tangent: [0, 0, -1], w: 3.6, h: 3.4, cols: 3, rows: 3, thickness: 0.04, rng, tone: 1.05 });
    platePatch(A, { center: [0, -1.42, 1.0], normal: [0, -1, 0], tangent: [0, 0, -1], w: 1.7, h: 4.2, cols: 2, rows: 3, thickness: 0.04, rng, tone: 0.96 });

    // Gear bays: nose wheel forward, mains under the wing roots.
    gearBay(A, { pos: [0, -1.22, -5.6], w: 0.85, l: 1.9, depth: 0.42 });
    gearBay(A, { pos: [1.9, -1.05, 2.4], w: 1.15, l: 2.3, depth: 0.5, mirror: true });

    sensorDome(A, { pos: [0, 1.42, -8.0], r: 0.34, tone: 0.9 });
    sensorDome(A, { pos: [0, -1.25, -7.2], r: 0.3, normal: [0, -1, 0], tone: 0.86 });

    // Squadron-block hull plate below the canopy rail (a marking surface).
    A.addPair('panel', plate(1.5, 0.55, 0.05, 0.03), { pos: [1.55, 0.3, -4.3], rot: [0, 0, -1.2], tone: 1.1 });
  }

  // RCS ports — nose, waist and tail. Each one is also an attitude hardpoint.
  rcsPort(A, { pos: [0.95, 0.12, -8.4], normal: [1, 0.25, 0], size: 0.3, mirror: true });
  rcsPort(A, { pos: [0, 1.3, -6.9], normal: [0, 1, 0], size: 0.3 });
  rcsPort(A, { pos: [0, -1.15, -6.9], normal: [0, -1, 0], size: 0.3 });
  rcsPort(A, { pos: [4.05, 0.05, 6.6], normal: [1, 0.15, 0], size: 0.32, mirror: true });
  rcsPort(A, { pos: [7.6, 0.0, 3.4], normal: [0, 1, 0], size: 0.26, mirror: true });
  rcsPort(A, { pos: [1.6, 1.3, 8.2], normal: [0, 1, 0], size: 0.28, mirror: true });

  // --------------------------------------------------------- nav lighting
  A.navLight([-8.25, -0.2, 3.6], '#ff2a1e', 8, 0.2, [-1, 0, 0.2]);
  A.navLight([8.25, -0.2, 3.6], '#22ff55', 8, 0.2, [1, 0, 0.2]);
  A.navLight([0, 1.46, 1.2], '#ffffff', 7, 0.15, [0, 1, 0]);
  A.navLight([0, -1.42, 4.6], '#ffffff', 5, 0.14, [0, -1, 0]);
  A.navLight([4.35, 3.5, 8.7], '#ffd0a0', 6, 0.13, [0, 1, 0]);
  A.navLight([-4.35, 3.5, 8.7], '#ffd0a0', 6, 0.13, [0, 1, 0]);
  A.navLight([0, 0.4, -10.7], '#7fe4ff', 5, 0.12, [0, 0, -1]);

  // Formation strips along the nacelle flanks — cool light that reads at distance.
  if (A.mid) {
    for (const sx of [-1, 1]) {
      A.glow(plate(0.06, 0.16, 0.02, 0.008), 0.19, { pos: [sx * 4.08, 0.35, 5.0], rot: [0, 0, Math.PI / 2], scale: [1, 22, 1] });
    }
  }

  return A;
}
