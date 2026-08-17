/**
 * F-109 Vampire — Terran Confederation medium space-superiority fighter.
 *
 * The player's ship, and the one whose outline has to be legible in a quarter
 * second. It is a **twin-boom** design, and every proportion serves that read:
 *
 *   nose      a slim chined dart with a bubble canopy standing 1.5 m proud of the
 *             spine and a chin gun pod slung underneath — the front third has all
 *             the vertical drama.
 *   waist     deliberately the *thinnest* part of the ship. 1.7 m across. It only
 *             has to carry the wing; making it skinny is what lets the eye see
 *             through the airframe.
 *   booms     two engine nacelles carried outboard at x = ±3.8, running almost the
 *             whole length. They touch the fuselage nowhere: the only structure
 *             between them is the wing, so there is a slot of open sky forward of
 *             the wing root and a much bigger one aft of it. That negative space
 *             is the silhouette.
 *
 * Forward-swept, outboard-canted intake mouths lead each boom, the cropped delta
 * has real anhedral and wingtip launch rails, and the tails are proper canted
 * vertical fins standing on the booms — not slabs stacked along the axis, which
 * is what makes a tail vanish edge-on.
 *
 * -Z forward, +Y up, +X starboard. 22.1 m long, 17.7 m span, 6.1 m tall.
 */
import * as THREE from 'three';
import {
  chamferedBox, plate, loft, hullProfile, rectProfile, wing, tube, xform,
  mergeGeometries, shadeCavity, ring, invertShell,
} from '../geometryKit.js';
import {
  canopy, engineNozzle, gunMount, missileRail, rcsPort, platePatch, recessRow,
  sensorDome, gearBay, verticalFin, pylon,
} from '../parts.js';

export const def = {
  id: 'confed_vampire',
  name: 'F-109 Vampire',
  faction: 'confed',
  role: 'medium fighter',
  style: 'confed',
  length: 22.1, span: 17.7, height: 6.1,
  lod: [0, 240, 1100],
};

const BX = 3.80;   // boom centreline
const BY = -0.62;  // boom vertical centre — slung low so the spine rides above it

export function build(A, rng, greebles) {
  const D = A.detail;
  const cyan = A.mats.palette.glow;
  const glowI = A.mats.palette.glowIntensity;

  // ------------------------------------------------------- 1. the forebody
  // Chined dart. Widest and deepest under the canopy, then pinched into a waist
  // that is narrower than everything around it.
  const P = hullProfile(2, 2, { topW: 0.44, botW: 0.70, chineLo: -0.24, chineHi: 0.46, c: 0.18 });
  const full = [
    { z: -11.0, sx: 0.09, sy: 0.07, y: -0.34 },
    { z: -10.3, sx: 0.32, sy: 0.21, y: -0.34 },
    { z: -9.2, sx: 0.64, sy: 0.39, y: -0.30, hard: true },
    { z: -7.4, sx: 0.97, sy: 0.59, y: -0.20 },
    { z: -5.6, sx: 1.15, sy: 0.75, y: -0.09, hard: true },
    { z: -3.6, sx: 1.12, sy: 0.79, y: -0.01 },
    { z: -1.8, sx: 0.90, sy: 0.62, y: -0.10, hard: true },
    { z: 1.2, sx: 0.80, sy: 0.52, y: -0.18 },
    { z: 3.4, sx: 0.82, sy: 0.52, y: -0.22, hard: true },
    { z: 5.0, sx: 0.62, sy: 0.42, y: -0.28 },
    { z: 5.7, sx: 0.34, sy: 0.24, y: -0.30 },
  ];
  const coarse = full.filter((_, i) => i % 2 === 0 || i === full.length - 1);
  A.add('hull', loft((D === 2 ? coarse : full).map((s) => ({ ...s, pts: P })), {}), { tone: 1 });

  // Darker radome cap so the point of the ship is a sensor unit, not moulded tip.
  A.add('dark', loft([
    { pts: P, z: -11.05, sx: 0.08, sy: 0.06, y: -0.34 },
    { pts: P, z: -10.4, sx: 0.34, sy: 0.23, y: -0.34 },
    { pts: P, z: -9.9, sx: 0.48, sy: 0.31, y: -0.33 },
  ], {}), { tone: 0.85 });

  // Chin gun pod — hangs a clear 0.9 m below the belly line so the side view has
  // a step under the nose instead of one continuous curve.
  A.add('panel', loft([
    { pts: rectProfile(1.55, 1.0, 0.3), z: -9.8, sx: 0.36, sy: 0.45, y: -1.02 },
    { pts: rectProfile(1.55, 1.0, 0.3), z: -8.8, sx: 0.8, sy: 0.9, y: -1.16, hard: true },
    { pts: rectProfile(1.55, 1.0, 0.3), z: -5.6, sx: 1.0, sy: 1.0, y: -1.26 },
    { pts: rectProfile(1.55, 1.0, 0.3), z: -4.0, sx: 0.72, sy: 0.7, y: -1.12 },
  ], {}), { tone: 1.05 });

  // Dorsal spine aft of the canopy: a raised ridge running to the tail cone.
  A.add('panel', loft([
    { pts: rectProfile(1.05, 0.34, 0.11), z: -3.0, sx: 0.42, sy: 0.5, y: 0.52 },
    { pts: rectProfile(1.05, 0.34, 0.11), z: -1.6, sx: 0.95, y: 0.60, hard: true },
    { pts: rectProfile(1.05, 0.34, 0.11), z: 2.4, sx: 0.9, y: 0.42 },
    { pts: rectProfile(1.05, 0.34, 0.11), z: 4.6, sx: 0.45, sy: 0.5, y: 0.22 },
  ], {}), { tone: 1.08 });

  // ---------------------------------------------------------- 2. the canopy
  // Set forward and standing proud: base 0.60, crest 2.2 — 1.5 m above the spine.
  canopy(A, { zFront: -8.4, zBack: -3.6, width: 2.05, height: 1.34, yBase: 0.72, yLift: 0.50 });
  if (A.fine) {
    A.add('dark', plate(1.35, 1.4, 0.07, 0.05), { pos: [0, 0.66, -9.3], rot: [-0.20, 0, 0], tone: 0.75 });
  }

  // ------------------------------------------------------- 3. engine booms
  // Nothing joins these to the fuselage except the wing. Inner face sits at
  // x = 2.63 against a fuselage half-width of 0.87 — a 1.75 m slot of sky either
  // side, open from z = -5.4 to the wing root and from the wing root to +11.
  const BP = rectProfile(2.30, 1.82, 0.52);
  const boomSections = [
    { pts: BP, z: -6.30, sx: 0.58, sy: 0.60, ry: 0.36, y: -0.34 },
    { pts: BP, z: -5.30, sx: 0.88, sy: 0.90, ry: 0.18, y: -0.20, hard: true },
    { pts: BP, z: -2.20, sx: 1.0, sy: 1.0, y: -0.03 },
    { pts: BP, z: 2.60, sx: 1.02, sy: 0.99 },
    { pts: BP, z: 6.40, sx: 0.97, sy: 0.93, hard: true },
    { pts: BP, z: 9.40, sx: 0.84, sy: 0.80 },
  ];
  const boom = loft(D === 2 ? boomSections.filter((_, i) => i !== 3) : boomSections, {});
  A.addMirrored('hull', boom, { pos: [BX, BY, 0], tone: 1.02 });

  // Forward-swept intake: the mouth ring is rolled so the outboard lip stands
  // ahead of the inboard one. It is the Vampire's most quoted feature.
  if (A.mid) {
    const lipProf = rectProfile(2.02, 1.58, 0.40);
    const lipGeo = loft([
      { pts: lipProf, z: -6.35, sx: 0.60, sy: 0.62, ry: 0.36, y: -0.34 },
      { pts: lipProf, z: -6.00, sx: 0.53, sy: 0.55, ry: 0.32, y: -0.30, hard: true },
      { pts: lipProf, z: -4.7, sx: 0.48, sy: 0.50, ry: 0.18, y: -0.20 },
    ], { capStart: false, capEnd: true });
    A.addMirrored('metal', lipGeo, { pos: [BX, BY, 0], tone: 0.74 });
    const throat = loft([
      { pts: lipProf, z: -6.15, sx: 0.50, sy: 0.52, ry: 0.34, y: -0.32 },
      { pts: lipProf, z: -3.4, sx: 0.32, sy: 0.34, y: -0.12 },
    ], { capStart: false, capEnd: true });
    invertShell(throat);
    A.addMirrored('dark', shadeCavity(throat, 0.6, 'z'), { pos: [BX, BY, 0], tone: 0.55 });
    // Orange intake-lip warning stripe (§7 accent colour).
    A.addMirrored('accent', plate(0.85, 0.3, 0.07, 0.03),
      { pos: [BX + 0.28, BY + 0.28, -6.0], rot: [0.30, 0.36, 0], tone: 1 });
  }

  // Boom dorsal strake — catches the key light and stops the pod reading as tube.
  A.addMirrored('panel', chamferedBox(0.52, 0.26, 8.2, 0.10), { pos: [BX, BY + 0.92, 1.6], tone: 1.06 });

  engineNozzle(A, { pos: [BX, BY, 9.4], radius: 0.92, length: 1.6, glow: cyan, intensity: glowI, slots: D === 0 ? 6 : 0 });
  engineNozzle(A, { pos: [-BX, BY, 9.4], radius: 0.92, length: 1.6, glow: cyan, intensity: glowI, slots: D === 0 ? 6 : 0 });

  // Machinery bedded into the inboard flank of each boom — visible *through* the
  // slot, which is what makes the gap read as structure rather than a modelling gap.
  if (A.fine && greebles?.length) {
    const parts = [];
    for (let i = 0; i < 9; i++) {
      parts.push(xform(greebles[rng.int(0, greebles.length - 1)], {
        pos: [BX - 1.16, BY + rng.range(-0.5, 0.5), -1.6 + i * 1.2],
        rot: [rng.range(-0.2, 0.2), -Math.PI / 2, rng.range(0, Math.PI * 2)],
        scale: rng.range(0.5, 0.9),
      }));
    }
    A.addMirrored('metal', mergeGeometries(parts), { pos: [0, 0, 0], tone: 0.76 });
  }

  // --------------------------------------------------------- 4. wing group
  // Cropped delta, root chord 6.0 from z = -2.6 to +3.4, tip at x = 8.7 with
  // 0.10 rad of anhedral. The booms pass through it at x = 3.8.
  const wg = wing({
    span: 7.7, rootChord: 6.0, tipChord: 2.3, rootThick: 0.86, tipThick: 0.26,
    sweep: 3.1, dihedral: -0.10, stations: D === 2 ? 2 : 4, seg: D === 2 ? 8 : 12,
  });
  A.addMirrored('hull', wg, { pos: [1.0, -0.34, -0.5], tone: 0.98 });

  // Wingtip launch rail: a short vertical fence with the missile rail under it.
  A.addMirrored('panel', chamferedBox(0.22, 1.1, 2.9, 0.08), { pos: [8.55, -0.42, 1.5], rot: [0, 0, 0.14], tone: 1.06 });
  if (A.mid) {
    A.addMirrored('metal', chamferedBox(0.16, 0.5, 3.6, 0.06), { pos: [6.3, -0.55, 1.2], tone: 0.8 });
  }

  // ---------------------------------------------------------- 5. tail fins
  // Standing on the booms, canted 24° outboard, swept. Height 3.0 m, so from the
  // side they are two unmistakable triangles rather than a pair of scratches.
  verticalFin(A, {
    pos: [BX, BY + 0.62, 4.6], span: 3.7, rootChord: 4.5, tipChord: 1.5,
    rootThick: 0.42, tipThick: 0.16, sweep: 1.9, cant: 0.42, tone: 1.05, tipPod: 0.13,
  });
  // Ventral strakes under the booms — completes an X-tail from dead astern.
  verticalFin(A, {
    pos: [BX, BY - 0.76, 6.4], span: 1.35, rootChord: 2.5, tipChord: 1.1,
    rootThick: 0.34, tipThick: 0.14, sweep: 1.2, cant: 0.5, down: true, bucket: 'hull', tone: 0.94,
  });

  // Structural pylon tying each boom to the wing box — visible in the slot.
  pylon(A, { from: [1.25, -0.2, 1.9], to: [2.62, -0.2, 1.9], chord: 2.6, thick: 0.34, tone: 0.8 });

  // ------------------------------------------------------------ 6. weapons
  gunMount(A, { pos: [2.3, -0.5, -3.4], length: 2.8, radius: 0.19, type: 'particle' });
  gunMount(A, { pos: [0.55, -1.42, -6.6], length: 1.9, radius: 0.15, type: 'laser' });
  missileRail(A, { pos: [7.3, -0.72, 2.1], count: 2, spacing: 0.6, length: 2.0, radius: 0.15, type: 'IR' });

  // -------------------------------------------------- 7. functional detail
  if (A.fine) {
    recessRow(A, { center: [1.0, 0.3, -2.0], normal: [1, 0.15, 0], tangent: [0, 0, -1], w: 0.9, h: 2.8, count: 3, depth: 0.09, rng });
    recessRow(A, { center: [-1.0, 0.3, -2.0], normal: [-1, 0.15, 0], tangent: [0, 0, -1], w: 0.9, h: 2.8, count: 3, depth: 0.09, rng });
    platePatch(A, { center: [0, 0.72, 4.6], normal: [0, 1, 0], tangent: [0, 0, -1], w: 1.5, h: 3.4, cols: 2, rows: 3, thickness: 0.05, rng, tone: 1.07 });
    platePatch(A, { center: [BX, BY + 1.06, 4.0], normal: [0, 1, 0], tangent: [0, 0, -1], w: 1.7, h: 5.4, cols: 2, rows: 4, thickness: 0.05, rng, tone: 1.05 });
    platePatch(A, { center: [-BX, BY + 1.06, 4.0], normal: [0, 1, 0], tangent: [0, 0, -1], w: 1.7, h: 5.4, cols: 2, rows: 4, thickness: 0.05, rng, tone: 1.05 });
    platePatch(A, { center: [5.2, -0.5, 1.6], normal: [0, 1, 0.06], tangent: [0, 0, -1], w: 2.6, h: 3.2, cols: 2, rows: 3, thickness: 0.04, rng, tone: 1.05 });
    platePatch(A, { center: [-5.2, -0.5, 1.6], normal: [0, 1, 0.06], tangent: [0, 0, -1], w: 2.6, h: 3.2, cols: 2, rows: 3, thickness: 0.04, rng, tone: 1.05 });

    gearBay(A, { pos: [0, -1.74, -7.2], w: 0.8, l: 1.8, depth: 0.4 });
    gearBay(A, { pos: [BX, BY - 1.02, 0.6], w: 1.1, l: 2.4, depth: 0.5, mirror: true });

    sensorDome(A, { pos: [0, 1.18, -2.2], r: 0.3, tone: 0.9 });
    sensorDome(A, { pos: [0, -1.78, -7.6], r: 0.26, normal: [0, -1, 0], tone: 0.86 });
    A.addMirrored('panel', plate(1.4, 0.5, 0.05, 0.03), { pos: [1.15, 0.16, -4.8], rot: [0, 0, -1.25], tone: 1.1 });
  }

  // RCS ports — nose, waist, boom ends. Each is also an attitude hardpoint.
  rcsPort(A, { pos: [0.85, 0.05, -8.6], normal: [1, 0.25, 0], size: 0.3, mirror: true });
  rcsPort(A, { pos: [0, 1.0, -6.9], normal: [0, 1, 0], size: 0.3 });
  rcsPort(A, { pos: [0, -1.36, -5.0], normal: [0, -1, 0], size: 0.3 });
  rcsPort(A, { pos: [BX + 1.1, BY, 7.6], normal: [1, 0.15, 0], size: 0.32, mirror: true });
  rcsPort(A, { pos: [BX + 1.1, BY - 0.1, -4.2], normal: [1, 0.15, 0], size: 0.28, mirror: true });
  rcsPort(A, { pos: [7.9, -0.75, 3.2], normal: [0, -1, 0], size: 0.26, mirror: true });

  // -------------------------------------------------------- 8. nav lighting
  A.navLight([-8.75, -0.5, 1.6], '#ff2a1e', 8, 0.2, [-1, 0, 0.2]);
  A.navLight([8.75, -0.5, 1.6], '#22ff55', 8, 0.2, [1, 0, 0.2]);
  A.navLight([0, 1.3, 1.0], '#ffffff', 7, 0.15, [0, 1, 0]);
  A.navLight([0, -1.0, 4.6], '#ffffff', 5, 0.14, [0, -1, 0]);
  A.navLight([BX + 1.24, 3.4, 7.4], '#ffd0a0', 6, 0.13, [0, 1, 0]);
  A.navLight([-(BX + 1.24), 3.4, 7.4], '#ffd0a0', 6, 0.13, [0, 1, 0]);
  A.navLight([0, 0.2, -10.7], '#7fe4ff', 5, 0.12, [0, 0, -1]);

  // Formation strips along the boom flanks — cool light readable at distance.
  if (A.mid) {
    for (const sx of [-1, 1]) {
      A.glow(plate(0.06, 0.16, 0.02, 0.008), 0.19, { pos: [sx * (BX + 1.2), BY + 0.4, 4.0], rot: [0, 0, Math.PI / 2], scale: [1, 20, 1] });
    }
  }

  return A;
}
