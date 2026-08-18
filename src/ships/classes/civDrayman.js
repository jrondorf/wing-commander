/**
 * Drayman-class transport — 172 m civilian freighter.
 *
 * The workhorse. Nothing about it is designed for combat, and that is the point:
 * a pressurised command module at the bow with lit windows, an exposed spine
 * truss, modular cargo containers clamped along it in whatever combination this
 * run happens to carry, radiator panels hanging off the sides, and two big
 * industrial drive bells. It exists to give a mission a target worth protecting
 * and to make a convoy read as commerce rather than as a fleet.
 *
 * The container stack is seeded, so two Draymans never carry the same cargo.
 *
 * -Z forward. 172 m long, 54 m across the radiators.
 */
import * as THREE from 'three';
import {
  loft, rectProfile, hullProfile, chamferedBox, plate, panelInset, tube, dome,
  ring, xform, mergeGeometries, shadeCavity, invertShell, extrudeAlongPath,
  ellipseProfile,
} from '../geometryKit.js';
import {
  engineNozzle, turretGeometry, antennaArray, runningLights, platePatch,
  recessRow, sensorDome, rcsPort,
} from '../parts.js';

export const def = {
  id: 'civ_drayman',
  name: 'Drayman',
  faction: 'civilian',
  role: 'transport',
  style: 'civilian',
  length: 172, span: 54, height: 40,
  capital: true,
  lod: [0, 1600, 7000],
};

export function build(A, rng, greebles) {
  const D = A.detail;
  const amber = A.mats.palette.glow;

  // ------------------------------------------------------- command module
  const P = hullProfile(2, 2, { topW: 0.7, botW: 0.78, chineLo: -0.3, chineHi: 0.42, c: 0.14 });
  A.add('hull', loft([
    { z: -86, sx: 5, sy: 4.4, y: 1 },
    { z: -80, sx: 9, sy: 7.5, y: 1, hard: true },
    { z: -70, sx: 13, sy: 10.5, y: 0.5 },
    { z: -54, sx: 15, sy: 12, y: 0 },
    { z: -40, sx: 14.5, sy: 11.5, y: 0, hard: true },
    { z: -33, sx: 11, sy: 9, y: 0 },
  ].map((s) => ({ ...s, pts: P })), {}), { tone: 1 });

  // Bridge greenhouse — a band of lit windows wrapping the front.
  A.add('panel', chamferedBox(20, 6.5, 12, 1.6), { pos: [0, 9.5, -66], tone: 1.06 });
  A.addEmissive(plate(17, 3.0, 0.5, 0.2), '#ffe6c0', 3.4, { pos: [0, 9.8, -72.2] });
  for (const sx of [-1, 1]) {
    A.addEmissive(plate(0.5, 3.0, 9, 0.2), '#ffe6c0', 3.4, { tone: 0.76, pos: [sx * 10.2, 9.8, -66] });
  }
  sensorDome(A, { pos: [0, 13.4, -58], r: 3.0, tone: 0.92 });
  antennaArray(A, { pos: [-6, 13, -50], height: 20, rng });
  antennaArray(A, { pos: [7, 12, -44], height: 14, rng });

  if (A.fine) {
    recessRow(A, { center: [15.3, 2, -58], normal: [1, 0.1, 0], tangent: [0, 0, -1], w: 8, h: 34, count: 4, depth: 0.8, rng });
    recessRow(A, { center: [-15.3, 2, -58], normal: [-1, 0.1, 0], tangent: [0, 0, -1], w: 8, h: 34, count: 4, depth: 0.8, rng });
    platePatch(A, { center: [0, 12.4, -46], normal: [0, 1, 0], tangent: [0, 0, -1], w: 18, h: 20, cols: 2, rows: 3, thickness: 0.4, gap: 1.0, rng, tone: 1.05 });
  }

  // ------------------------------------------------------------ spine truss
  // Exposed structure — the cheapest possible way to move mass, and it reads as
  // civilian immediately next to an armoured warship.
  const rails = [[-7, 7], [7, 7], [-7, -7], [7, -7]];
  for (const [rx, ry] of rails) {
    A.add('metal', chamferedBox(2.4, 2.4, 108, 0.6), { pos: [rx, ry, 22], tone: 0.8 });
  }
  if (A.mid) {
    const braces = [];
    const n = D === 0 ? 13 : 6;
    for (let i = 0; i < n; i++) {
      const z = -28 + i * (108 / n);
      braces.push(xform(chamferedBox(15.4, 1.4, 1.4, 0.4), { pos: [0, 7, z] }));
      braces.push(xform(chamferedBox(15.4, 1.4, 1.4, 0.4), { pos: [0, -7, z] }));
      braces.push(xform(chamferedBox(1.4, 15.4, 1.4, 0.4), { pos: [7, 0, z] }));
      braces.push(xform(chamferedBox(1.4, 15.4, 1.4, 0.4), { pos: [-7, 0, z] }));
      if (A.fine) {
        braces.push(xform(chamferedBox(19, 0.9, 0.9, 0.3), { pos: [0, 7, z + 4], rot: [0, 0.35, 0] }));
        braces.push(xform(chamferedBox(19, 0.9, 0.9, 0.3), { pos: [0, -7, z + 4], rot: [0, -0.35, 0] }));
      }
    }
    A.add('metal', mergeGeometries(braces), { tone: 0.76 });
  }

  // ---------------------------------------------------------- cargo modules
  // Seeded container stack: sizes, positions and colours vary per hull, so a
  // convoy of five Draymans looks like five different shipments.
  const containers = [];
  const accents = [];
  let z = -22;
  while (z < 66) {
    const len = rng.range(14, 26);
    const skip = rng.bool(0.16);
    if (!skip) {
      const w = rng.range(15, 22), h = rng.range(12, 18);
      containers.push(xform(chamferedBox(w, h, len * 0.94, 1.3), { pos: [rng.range(-1.2, 1.2), rng.range(-1, 1), z + len / 2] }));
      if (A.fine) {
        // End-cap ribs and a door frame — a container has to look like a container.
        containers.push(xform(chamferedBox(w * 1.02, h * 1.02, 1.2, 0.4), { pos: [0, 0, z + 1] }));
        containers.push(xform(chamferedBox(w * 1.02, h * 1.02, 1.2, 0.4), { pos: [0, 0, z + len - 1] }));
        for (let k = 1; k < 4; k++) {
          containers.push(xform(chamferedBox(w * 1.01, h * 1.01, 0.7, 0.25), { pos: [0, 0, z + (len * k) / 4] }));
        }
        accents.push(xform(plate(w * 0.5, h * 0.28, 0.4, 0.15), { pos: [0, h * 0.22, z + len / 2 - h * 0.51], rot: [Math.PI / 2, 0, 0] }));
      }
    }
    z += len + rng.range(1.5, 5);
  }
  if (containers.length) A.add('panel', mergeGeometries(containers), { tone: 0.98, jitter: 0.09 });
  if (accents.length) A.add('accent', mergeGeometries(accents), { tone: 1 });

  // Clamp collars locking the stack to the truss.
  if (A.mid) {
    const clamps = [];
    for (let i = 0; i < (D === 0 ? 6 : 3); i++) {
      const cz = -14 + i * 16;
      clamps.push(xform(chamferedBox(26, 3.0, 3.4, 0.9), { pos: [0, 10.5, cz] }));
      clamps.push(xform(chamferedBox(26, 3.0, 3.4, 0.9), { pos: [0, -10.5, cz] }));
    }
    A.add('metal', mergeGeometries(clamps), { tone: 0.78 });
  }

  // ------------------------------------------------------------- radiators
  // Big flat panels canted off the spine — the most legible "industrial" cue.
  for (const sx of [-1, 1]) {
    for (const cz of [8, 44]) {
      A.add('metal', plate(24, 0.6, 30, 0.25), { pos: [sx * 21, 2, cz], rot: [0, 0, sx * 0.5], tone: 0.84 });
      if (A.fine) {
        const ribs = [];
        for (let i = 0; i < 6; i++) ribs.push(xform(chamferedBox(23, 0.5, 0.6, 0.2), { pos: [0, 0.5, -13 + i * 5.2] }));
        A.add('metal', mergeGeometries(ribs), { pos: [sx * 21, 2, cz], rot: [0, 0, sx * 0.5], tone: 0.7 });
      }
      A.add('metal', chamferedBox(9, 1.6, 2.2, 0.5), { pos: [sx * 11, 2, cz], rot: [0, 0, sx * 0.5], tone: 0.76 });
    }
  }

  // ------------------------------------------------------------ drive block
  A.add('hull', loft([
    { pts: rectProfile(34, 28, 5), z: 62, sx: 0.62, sy: 0.6 },
    { pts: rectProfile(34, 28, 5), z: 72, sx: 0.95, hard: true },
    { pts: rectProfile(34, 28, 5), z: 82, sx: 1.0 },
    { pts: rectProfile(34, 28, 5), z: 86, sx: 0.86, sy: 0.88 },
  ], {}), { tone: 0.97 });
  for (const sx of [-1, 1]) {
    engineNozzle(A, { pos: [sx * 8.5, 0, 86], radius: 6.2, length: 10, glow: amber, intensity: A.mats.palette.glowIntensity, slots: D === 0 ? 8 : 0 });
  }
  if (A.mid) {
    // Fuel/reactant spheres bolted to the drive block — very freighter.
    for (const sx of [-1, 1]) {
      A.add('metal', dome(6.5, { segments: D === 0 ? 16 : 8, rows: 6, squash: 1 }), { pos: [sx * 19, 8, 70], tone: 0.82 });
      A.add('metal', dome(6.5, { segments: D === 0 ? 16 : 8, rows: 6, squash: 1 }), { pos: [sx * 19, 8, 70], rot: [Math.PI, 0, 0], tone: 0.8 });
    }
  }

  // ------------------------------------------------------- defensive turrets
  const tGeo = turretGeometry(2.2, { fine: D === 0 });
  const mats = [];
  const place = (x, y, zz, pitch) => {
    const m = new THREE.Matrix4();
    m.compose(new THREE.Vector3(x, y, zz), new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, 0, 0)), new THREE.Vector3(1, 1, 1));
    mats.push(m);
    A.turret([x, y, zz], Math.PI * 1.2, 'aa');
  };
  place(0, 13.5, -40, 0);
  place(0, -12.5, -44, Math.PI);
  place(0, 15.5, 30, 0);
  place(0, -15.5, 30, Math.PI);
  A.instance(tGeo, 'metal', mats);

  if (A.fine && greebles?.length) {
    const gm = [];
    for (let i = 0; i < 90; i++) {
      const sx = rng.sign();
      const onTop = rng.bool(0.4);
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(onTop ? rng.range(-12, 12) : sx * rng.range(9, 15), onTop ? rng.range(10, 15) : rng.range(-8, 10), rng.range(58, 88)),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rng.range(0, Math.PI * 2), onTop ? 0 : sx * Math.PI / 2)),
        new THREE.Vector3(1, 1, 1).multiplyScalar(rng.range(1.2, 3.4)),
      );
      gm.push(m);
    }
    A.instance(greebles[3 % greebles.length], 'metal', gm);
  }

  // ------------------------------------------------------- lights & markings
  runningLights(A, { from: [16, 12, -76], to: [16, 12, 84], count: D === 0 ? 20 : 8, color: '#ffe6c0', intensity: 3.0, size: 0.7, normal: [1, 0, 0], mirror: true });
  runningLights(A, { from: [0, 16, -30], to: [0, 16, 60], count: D === 0 ? 10 : 4, color: '#ffb44a', intensity: 4.0, size: 0.6 });
  A.navLight([-16.5, 0, -60], '#ff2a1e', 10, 0.9, [-1, 0, 0]);
  A.navLight([16.5, 0, -60], '#22ff55', 10, 0.9, [1, 0, 0]);
  A.navLight([0, 16.8, -60], '#ffffff', 9, 0.8, [0, 1, 0]);
  A.navLight([0, -13.5, 40], '#ff2a1e', 7, 0.8, [0, -1, 0]);
  A.navLight([0, 0, 88], '#ffffff', 6, 0.9, [0, 0, 1]);

  rcsPort(A, { pos: [14, 6, -74], normal: [1, 0.3, 0], size: 2.2, mirror: true });
  rcsPort(A, { pos: [16, 4, 76], normal: [1, 0.3, 0], size: 2.2, mirror: true });
  rcsPort(A, { pos: [0, -12.4, -70], normal: [0, -1, 0], size: 2.0 });

  A.cockpit([0, 10.4, -70], new THREE.Quaternion());
  return A;
}
