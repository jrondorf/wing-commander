/**
 * CVS Midway-class fleet carrier — 900 m.
 *
 * The scale-cue ship. Everything about its construction exists to say "this is
 * nine hundred metres long": armour plating sized to a human deck rather than to
 * the whole hull, hundreds of running lights at a spacing the eye reads as
 * windows, turret barbettes small enough that you count them, a flight deck with
 * a lit interior you can see into, and an engine bank whose nozzles are each
 * bigger than the fighters flying past them.
 *
 * Layout: blunt armoured bow with two launch tubes, long spine with a starboard
 * island superstructure, flank sponsons carrying the AA batteries, a recovery
 * hangar in the stern flanked by six main drives.
 *
 * -Z forward. 900 m long, 118 m beam, 96 m tall including the island.
 */
import * as THREE from 'three';
import {
  loft, hullProfile, rectProfile, chamferedBox, plate, panelInset, tube, dome,
  ring, xform, mergeGeometries, mirrorX, shadeCavity, invertShell, scaleProfile,
} from '../geometryKit.js';
import {
  engineNozzle, turretGeometry, antennaArray, runningLights, hangarBay,
  platePatch, recessRow, sensorDome, rcsPort,
} from '../parts.js';

export const def = {
  id: 'confed_carrier',
  name: 'CVS Midway',
  faction: 'confed',
  role: 'fleet carrier',
  style: 'capital',
  length: 900, span: 118, height: 96,
  capital: true,
  lod: [0, 5200, 22_000],
};

export function build(A, rng, greebles) {
  const D = A.detail;
  const cyan = A.mats.palette.glow;
  const amber = '#ffb44a';

  // ------------------------------------------------------------- main hull
  const P = hullProfile(2, 2, { topW: 0.80, botW: 0.70, chineLo: -0.34, chineHi: 0.48, c: 0.10 });
  const full = [
    { z: -450, sx: 17, sy: 13, y: -2 },
    { z: -436, sx: 26, sy: 19, y: -1, hard: true },
    { z: -400, sx: 37, sy: 26, y: 0 },
    { z: -330, sx: 46, sy: 32, y: 1 },
    { z: -230, sx: 53, sy: 37, y: 2, hard: true },
    { z: -90, sx: 58, sy: 40, y: 2 },
    { z: 60, sx: 59, sy: 41, y: 2 },
    { z: 190, sx: 57, sy: 40, y: 1 },
    { z: 300, sx: 53, sy: 38, y: 0, hard: true },
    { z: 400, sx: 47, sy: 35, y: -1 },
    { z: 450, sx: 41, sy: 31, y: -2 },
  ];
  const coarse = full.filter((_, i) => i % 2 === 0 || i === full.length - 1);
  A.add('hull', loft((D === 2 ? coarse : full).map((s) => ({ ...s, pts: P })), {}), { tone: 1 });

  // ------------------------------------------------------- armoured bow cap
  A.add('panel', loft([
    { pts: rectProfile(30, 24, 5), z: -452, sx: 0.7, sy: 0.7 },
    { pts: rectProfile(30, 24, 5), z: -440, hard: true },
    { pts: rectProfile(30, 24, 5), z: -415, sx: 1.35, sy: 1.3 },
  ], {}), { tone: 1.05 });

  // ------------------------------------------------------------ flight deck
  // A raised angled deck running most of the spine, offset to port so the island
  // has somewhere to stand. Its overhang throws a long shadow line down the hull.
  const deckProf = rectProfile(74, 11, 2.6);
  A.add('panel', loft([
    { pts: deckProf, z: -395, sx: 0.55, sy: 0.7, x: -6 },
    { pts: deckProf, z: -350, sx: 0.86, x: -8, hard: true },
    { pts: deckProf, z: -40, sx: 1.0, x: -9 },
    { pts: deckProf, z: 240, sx: 0.96, x: -8 },
    { pts: deckProf, z: 300, sx: 0.7, sy: 0.8, x: -7 },
  ], {}), { pos: [0, 44, 0], tone: 1.06 });

  // Deck edge kerb + catapult tracks, and the long chain of deck lighting.
  if (A.mid) {
    for (const sx of [-1, 1]) {
      A.add('metal', chamferedBox(3.4, 3.2, 620, 1.0), { pos: [sx * 37 - 9, 50.5, -45], tone: 0.8 });
    }
    A.add('metal', chamferedBox(4.5, 1.2, 560, 0.5), { pos: [-24, 50.2, -70], tone: 0.72 });
    A.add('metal', chamferedBox(4.5, 1.2, 560, 0.5), { pos: [6, 50.2, -70], tone: 0.72 });
  }
  runningLights(A, { from: [-45, 51.4, -350], to: [-45, 51.4, 280], count: D === 0 ? 34 : 14, color: amber, intensity: 5.5, size: 1.1 });
  runningLights(A, { from: [27, 51.4, -350], to: [27, 51.4, 280], count: D === 0 ? 34 : 14, color: '#8fd8ff', intensity: 5.0, size: 1.1 });

  // ------------------------------------------------------------ bow launch tubes
  for (const sx of [-1, 1]) {
    hangarBay(A, {
      pos: [sx * 24, 6, -452], w: 26, h: 15, depth: 70, glow: amber, dir: [0, 0, -1], rng,
    });
  }

  // ------------------------------------------------------- stern recovery bay
  hangarBay(A, {
    pos: [0, -12, 452], w: 62, h: 30, depth: 120, glow: amber, dir: [0, 0, 1], rng,
  });

  // ------------------------------------------------------------ engine bank
  // Six drives: four large in a row above the recovery bay, two outboard.
  const mains = [[-33, 26], [-11, 26], [11, 26], [33, 26]];
  for (const [ex, ey] of mains) {
    A.add('metal', loft([
      { pts: rectProfile(21, 21, 5), z: 380, sx: 0.8, sy: 0.8 },
      { pts: rectProfile(21, 21, 5), z: 420, hard: true },
      { pts: rectProfile(21, 21, 5), z: 452, sx: 0.95, sy: 0.95 },
    ], {}), { pos: [ex, ey, 0], tone: 0.82 });
    engineNozzle(A, { pos: [ex, ey, 452], radius: 8.6, length: 15, glow: cyan, intensity: 13, slots: D === 0 ? 8 : 0 });
  }
  for (const sx of [-1, 1]) {
    engineNozzle(A, { pos: [sx * 50, -4, 442], radius: 5.4, length: 10, glow: cyan, intensity: 13, slots: 0 });
  }

  // --------------------------------------------------------------- island
  // Command superstructure on the starboard shoulder: stacked bridge decks with
  // lit windows, a mast farm and a phased-array face.
  const ib = [30, 46, -60];
  A.add('hull', loft([
    { pts: rectProfile(30, 30, 5), z: -110, sx: 0.7, sy: 0.55, y: 0 },
    { pts: rectProfile(30, 30, 5), z: -85, sx: 0.95, sy: 0.9, y: 6, hard: true },
    { pts: rectProfile(30, 30, 5), z: 10, sx: 1.0, sy: 1.0, y: 8 },
    { pts: rectProfile(30, 30, 5), z: 60, sx: 0.8, sy: 0.85, y: 6, hard: true },
    { pts: rectProfile(30, 30, 5), z: 80, sx: 0.5, sy: 0.6, y: 3 },
  ], {}), { pos: [ib[0], ib[1], ib[2]], tone: 0.97 });
  // Bridge box with a wraparound window band.
  A.add('panel', chamferedBox(26, 9, 34, 2.2), { pos: [ib[0], ib[1] + 22, ib[2] - 18], tone: 1.06 });
  A.addEmissive(plate(24, 4.4, 0.6, 0.25), '#bfe6ff', 4.0, { pos: [ib[0], ib[1] + 22, ib[2] - 35.4] });
  for (const sx of [-1, 1]) {
    A.addEmissive(plate(0.6, 4.4, 30, 0.25), '#bfe6ff', 4.0, { tone: 0.8, pos: [ib[0] + sx * 13.2, ib[1] + 22, ib[2] - 19] });
  }
  // Secondary control tower, offset — asymmetry at the top of the silhouette.
  A.add('hull', chamferedBox(13, 26, 15, 2.0), { pos: [ib[0] - 3, ib[1] + 34, ib[2] + 22], tone: 0.95 });
  A.addEmissive(plate(9, 2.4, 0.5, 0.2), amber, 7, { tone: 0.43, pos: [ib[0] - 3, ib[1] + 42, ib[2] + 14.4] });

  antennaArray(A, { pos: [ib[0] + 7, ib[1] + 45, ib[2] + 26], height: 46, rng });
  antennaArray(A, { pos: [ib[0] - 9, ib[1] + 40, ib[2] - 34], height: 30, rng });
  sensorDome(A, { pos: [ib[0], ib[1] + 40, ib[2] - 4], r: 7.5, tone: 0.9 });
  sensorDome(A, { pos: [ib[0] + 10, ib[1] + 30, ib[2] + 6], r: 4.2, tone: 0.9 });
  // Phased-array radar face, canted.
  A.add('dark', plate(18, 18, 1.2, 0.5), { pos: [ib[0] + 13, ib[1] + 26, ib[2] - 6], rot: [0, 0.9, 0.15], tone: 0.7 });

  // ------------------------------------------------------------- sponsons
  // Flank blisters. They carry the AA batteries and break the hull's straight run.
  for (const z of [-250, -80, 100, 260]) {
    const s = z === -80 || z === 100 ? 1.0 : 0.8;
    const sp = loft([
      { pts: rectProfile(26, 20, 4), z: z - 46 * s, sx: 0.35, sy: 0.45 },
      { pts: rectProfile(26, 20, 4), z: z - 26 * s, sx: 0.9, sy: 0.95, hard: true },
      { pts: rectProfile(26, 20, 4), z: z + 26 * s, sx: 0.9, sy: 0.95, hard: true },
      { pts: rectProfile(26, 20, 4), z: z + 46 * s, sx: 0.35, sy: 0.45 },
    ], {});
    A.addPair('hull', xform(sp, { pos: [58, 2, 0], rot: [0, 0, -0.22] }), { tone: 0.96 });
  }

  // -------------------------------------------------------- turret batteries
  // One instanced mesh for the whole battery. The turrets are ~9 m — small enough
  // against the hull that counting them tells you how big the ship is.
  const tGeo = turretGeometry(4.5, { fine: D === 0 });
  const mats = [];
  const place = (x, y, z, yaw, pitch = 0) => {
    const m = new THREE.Matrix4();
    m.compose(new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0)),
      new THREE.Vector3(1, 1, 1));
    mats.push(m);
    A.turret([x, y, z], Math.PI * 1.2, Math.abs(y) > 30 ? 'aa' : 'antiship');
  };
  // Dorsal spine batteries either side of the flight deck.
  for (let i = 0; i < 7; i++) {
    const z = -330 + i * 105;
    place(-52, 40 - Math.abs(z) * 0.004, z, 0);
    place(52, 40 - Math.abs(z) * 0.004, z, 0);
  }
  // Ventral batteries, inverted.
  for (let i = 0; i < 6; i++) {
    const z = -300 + i * 115;
    place(-28, -40, z, 0, Math.PI);
    place(28, -40, z, 0, Math.PI);
  }
  // Sponson-mounted heavies, facing outboard.
  for (const z of [-250, -80, 100, 260]) {
    place(74, 4, z, Math.PI / 2);
    place(-74, 4, z, -Math.PI / 2);
  }
  // Bow chase and stern chase.
  place(0, 26, -404, 0);
  place(0, -22, -400, 0, Math.PI);
  A.instance(tGeo, 'metal', mats);

  // ------------------------------------------------------------ hull detail
  if (A.fine) {
    // Armour plating fields — sized so a plate reads as several decks tall.
    for (const sx of [-1, 1]) {
      platePatch(A, {
        center: [sx * 59, 6, -160], normal: [sx, 0.12, 0], tangent: [0, 0, -1],
        w: 46, h: 300, cols: 3, rows: 9, thickness: 0.9, gap: 2.2, rng, tone: 1.04, skip: 0.22,
      });
      platePatch(A, {
        center: [sx * 57, 6, 200], normal: [sx, 0.12, 0], tangent: [0, 0, -1],
        w: 44, h: 260, cols: 3, rows: 8, thickness: 0.9, gap: 2.2, rng, tone: 1.02, skip: 0.25,
      });
      platePatch(A, {
        center: [sx * 30, -41, 60], normal: [0, -1, 0], tangent: [0, 0, -1],
        w: 40, h: 460, cols: 2, rows: 10, thickness: 0.8, gap: 2.4, rng, tone: 0.94, skip: 0.3,
      });
      recessRow(A, {
        center: [sx * 60, 22, -20], normal: [sx, 0.3, 0], tangent: [0, 0, -1],
        w: 16, h: 240, count: 6, depth: 1.6, rng,
      });
    }
    platePatch(A, {
      center: [40, 45, 180], normal: [0, 1, 0], tangent: [0, 0, -1],
      w: 30, h: 220, cols: 2, rows: 6, thickness: 0.8, gap: 2.0, rng, tone: 1.05,
    });

    // Greeble fields: machinery clusters bedded into the dorsal and stern.
    if (greebles?.length) {
      const gm = [];
      for (let i = 0; i < 240; i++) {
        const side = rng.sign();
        const z = rng.range(-380, 430);
        const onTop = rng.bool(0.45);
        const x = onTop ? rng.range(-58, 58) : side * rng.range(48, 60);
        const y = onTop ? 41 + rng.range(-1, 1) : rng.range(-30, 30);
        const m = new THREE.Matrix4();
        m.compose(new THREE.Vector3(x, y, z),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rng.range(0, Math.PI * 2), onTop ? 0 : side * Math.PI / 2)),
          new THREE.Vector3(1, 1, 1).multiplyScalar(rng.range(4, 11)));
        gm.push(m);
      }
      A.instance(greebles[0], 'metal', gm);
      const gm2 = [];
      for (let i = 0; i < 150; i++) {
        const m = new THREE.Matrix4();
        m.compose(new THREE.Vector3(rng.range(-56, 56), rng.range(10, 44), rng.range(300, 448)),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(rng.range(-0.3, 0.3), rng.range(0, Math.PI * 2), 0)),
          new THREE.Vector3(1, 1, 1).multiplyScalar(rng.range(3, 9)));
        gm2.push(m);
      }
      A.instance(greebles[Math.min(3, greebles.length - 1)], 'metal', gm2);
    }
  }

  // Missile cell hatches along the bow shoulders.
  if (A.mid) {
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 6; i++) {
        A.add('panel', panelInset(9, 9, 1.2, 0.9), { pos: [sx * (22 + (i % 2) * 13), 40, -370 + i * 22], rot: [-Math.PI / 2, 0, 0], tone: 0.92 });
      }
      A.missile([sx * 28, 42, -330], [0, 1, -0.3], 12, 'capship-missile');
    }
  }

  // ------------------------------------------------------- lights & markings
  // Hull running lights. At this length the eye reads them as window rows, which
  // is exactly the scale cue we want.
  const N = D === 0 ? 46 : 18;
  runningLights(A, { from: [59, 18, -390], to: [59, 18, 400], count: N, color: '#ffe6c0', intensity: 3.4, size: 1.3, normal: [1, 0, 0], mirror: true });
  runningLights(A, { from: [57, -14, -360], to: [57, -14, 390], count: Math.round(N * 0.7), color: '#ffe6c0', intensity: 2.6, size: 1.1, normal: [1, 0, 0], mirror: true });
  runningLights(A, { from: [-44, 51.6, -380], to: [44, 51.6, -380], count: 10, color: '#ffffff', intensity: 6, size: 1.4 });
  A.navLight([-62, 8, -60], '#ff2a1e', 12, 2.0, [-1, 0, 0]);
  A.navLight([62, 8, -60], '#22ff55', 12, 2.0, [1, 0, 0]);
  A.navLight([0, 92, -34], '#ffffff', 14, 1.8, [0, 1, 0]);
  A.navLight([0, 52, 300], '#ffffff', 9, 1.6, [0, 1, 0]);
  A.navLight([0, -42, 0], '#ff2a1e', 8, 1.6, [0, -1, 0]);

  // Manoeuvring thruster clusters, sized for a capital ship.
  rcsPort(A, { pos: [58, 30, -380], normal: [1, 0.3, 0], size: 7, mirror: true });
  rcsPort(A, { pos: [58, 30, 380], normal: [1, 0.3, 0], size: 7, mirror: true });
  rcsPort(A, { pos: [40, -41, -300], normal: [0, -1, 0], size: 6, mirror: true });
  rcsPort(A, { pos: [40, -41, 340], normal: [0, -1, 0], size: 6, mirror: true });

  A.cockpit([ib[0], ib[1] + 24, ib[2] - 30], new THREE.Quaternion());
  return A;
}
