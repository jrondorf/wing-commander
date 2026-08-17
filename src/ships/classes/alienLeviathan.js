/**
 * Leviathan — Nephilim capital ship, 620 m.
 *
 * The alien answer to a carrier, and it must not read like one. No flight deck,
 * no island, no plating: a segmented chitin body like a deep-sea worm, ribbed
 * dorsal spines running the whole length, four mandible arms cradling a lit maw
 * at the bow that fighters emerge from, blister nodules instead of turret
 * barbettes, and luminous seams between every body segment so the ship glows from
 * the inside along its entire length.
 *
 * -Z forward. 620 m long, 190 m across the mandibles.
 */
import * as THREE from 'three';
import { fbm3 } from '../../procgen/noise.js';
import {
  loft, teardropProfile, ellipseProfile, revolve, dome, xform, displace,
  mergeGeometries, plate, extrudeAlongPath, invertShell, shadeCavity,
} from '../geometryKit.js';
import { runningLights, rcsPort } from '../parts.js';

export const def = {
  id: 'alien_leviathan',
  name: 'Leviathan',
  faction: 'nephilim',
  role: 'capital ship',
  style: 'alien',
  length: 620, span: 190, height: 130,
  capital: true,
  lod: [0, 4200, 18_000],
};

export function build(A, rng, greebles) {
  const D = A.detail;
  const glow = A.mats.palette.glow;
  const glowI = A.mats.palette.glowIntensity;
  const seed = rng.int(1, 1e6);
  const seg = D === 2 ? 12 : D === 1 ? 18 : 26;

  // ------------------------------------------------------------ body segments
  // Eight overlapping carapace segments, each a swollen ring. The overlaps are
  // the ship's entire surface language — no flat panels anywhere.
  const profile = [
    { z: -310, w: 26, h: 20 },
    { z: -250, w: 58, h: 44 },
    { z: -170, w: 84, h: 62 },
    { z: -70, w: 96, h: 72 },
    { z: 40, w: 98, h: 74 },
    { z: 140, w: 88, h: 66 },
    { z: 230, w: 70, h: 53 },
    { z: 300, w: 46, h: 36 },
  ];
  const count = D === 2 ? 4 : 8;
  for (let i = 0; i < count; i++) {
    const a = profile[Math.floor((i / count) * profile.length)];
    const b = profile[Math.min(profile.length - 1, Math.floor((i / count) * profile.length) + 1)];
    const z0 = a.z, z1 = b.z;
    const g = loft([
      { pts: teardropProfile(a.w * 0.9, a.h * 0.88, seg, 0.72), z: z0 },
      { pts: teardropProfile((a.w + b.w) * 0.56, (a.h + b.h) * 0.55, seg, 0.72), z: z0 + (z1 - z0) * 0.42 },
      { pts: teardropProfile(b.w * 0.98, b.h * 0.96, seg, 0.72), z: z1 - (z1 - z0) * 0.1 },
      { pts: teardropProfile(b.w * 0.84, b.h * 0.82, seg, 0.72), z: z1 + 6 },
    ], {});
    if (D < 2) displace(g, (x, y, z) => fbm3(x * 0.012, y * 0.012, z * 0.009, { seed: seed + i, octaves: 3 }) * 3.4);
    A.add('chitin', g, { tone: 1 - i * 0.006, jitter: 0.03 });
    // Luminous joint behind each segment.
    if (A.mid) {
      A.glow(loft([
        { pts: teardropProfile(a.w * 0.87, a.h * 0.85, seg, 0.72), z: z0 - 3 },
        { pts: teardropProfile(a.w * 0.9, a.h * 0.88, seg, 0.72), z: z0 + 1 },
        { pts: teardropProfile(a.w * 0.87, a.h * 0.85, seg, 0.72), z: z0 + 5 },
      ], { capStart: false, capEnd: false }), 0.6);
    }
  }

  // ---------------------------------------------------------- dorsal spines
  const spines = D === 2 ? 4 : D === 1 ? 8 : 16;
  for (let i = 0; i < spines; i++) {
    const t = i / spines;
    const z = -280 + t * 560;
    const hgt = 46 * Math.sin(Math.PI * Math.min(1, t * 1.15)) + 8;
    const lean = -0.35 - t * 0.2;
    const s = loft([
      { pts: ellipseProfile(24 * (1 - t * 0.5), 9, 10), z: 0 },
      { pts: ellipseProfile(14 * (1 - t * 0.5), 5.5, 10), z: hgt * 0.55, x: hgt * 0.16 },
      { pts: ellipseProfile(2.4, 1.6, 10), z: hgt, x: hgt * 0.42 },
    ], {});
    s.rotateX(-Math.PI / 2);
    const y = 32 + 22 * Math.sin(Math.PI * Math.min(1, t * 1.1));
    A.add('chitin', s, { pos: [0, y, z], rot: [lean * 0.1, 0, 0], tone: 0.9 });
    if (A.fine && i % 2 === 0) {
      A.glow(dome(3.2, { segments: 10, rows: 4, squash: 1.6 }), 0.8, { pos: [0, y + hgt * 0.5, z + 2] });
    }
  }
  // A matching, shorter ventral row — the ship reads as an organism from below too.
  if (A.mid) {
    for (let i = 0; i < (D === 0 ? 9 : 4); i++) {
      const t = i / 9;
      const z = -220 + t * 460;
      const s = loft([
        { pts: ellipseProfile(18, 7, 8), z: 0 },
        { pts: ellipseProfile(9, 4, 8), z: 20, x: -6 },
        { pts: ellipseProfile(1.6, 1.2, 8), z: 34, x: -14 },
      ], {});
      s.rotateX(Math.PI / 2);
      A.add('chitin', s, { pos: [0, -34 - 10 * Math.sin(Math.PI * t), z], tone: 0.87 });
    }
  }

  // ------------------------------------------------------------- mandibles
  // Four arms curving forward around the maw. They carry the ship's silhouette.
  const mandible = (len, spread, rise) => {
    const path = [];
    const n = D === 2 ? 5 : 10;
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      path.push(new THREE.Vector3(
        18 + u * spread + u * u * spread * 0.55,
        rise * (Math.sin(u * 1.9) * 26) - u * u * 10,
        -240 - u * len + u * u * len * 0.22,
      ));
    }
    return extrudeAlongPath(ellipseProfile(30, 20, D === 2 ? 8 : 14), path, {
      scale: (u) => 1 - 0.82 * u * u,
    });
  };
  for (const sx of [-1, 1]) {
    const upper = mandible(150, 62, 1);
    A.add('chitin', upper, { scale: [sx, 1, 1], mirror: sx < 0, tone: 0.97 });
    const lower = mandible(126, 48, -1);
    A.add('chitin', lower, { scale: [sx, 1, 1], mirror: sx < 0, tone: 0.94 });
    // Luminous inner edge on every mandible — a maw ringed with light.
    if (A.mid) {
      A.glow(extrudeAlongPath(ellipseProfile(5, 3.4, 6), [
        new THREE.Vector3(sx * 22, 6, -250), new THREE.Vector3(sx * 42, 18, -320),
        new THREE.Vector3(sx * 62, 22, -380), new THREE.Vector3(sx * 78, 14, -420),
      ], { scale: (u) => 1 - 0.6 * u }), 0.9);
    }
  }

  // ------------------------------------------------------------------ maw
  // The launch bay: a lit throat between the mandibles that fighters come out of.
  const throat = loft([
    { pts: teardropProfile(64, 50, seg, 0.8), z: -320 },
    { pts: teardropProfile(56, 44, seg, 0.8), z: -280 },
    { pts: teardropProfile(34, 28, seg, 0.8), z: -200 },
  ], { capStart: false, capEnd: true });
  invertShell(throat);
  A.add('dark', shadeCavity(throat, 0.4, 'z'), { tone: 0.75 });
  for (let i = 0; i < (D === 0 ? 7 : 3); i++) {
    const t = i / Math.max(1, (D === 0 ? 6 : 2));
    const z = -315 + t * 105;
    const s = 1 - t * 0.42;
    A.glow(loft([
      { pts: teardropProfile(58 * s, 45 * s, 14, 0.8), z: z - 2 },
      { pts: teardropProfile(60 * s, 47 * s, 14, 0.8), z },
      { pts: teardropProfile(58 * s, 45 * s, 14, 0.8), z: z + 2 },
    ], { capStart: false, capEnd: false }), 1.5);
  }
  A.hangar([0, 0, -320], [60, 46], [0, 0, -1]);

  // Teeth: chitin spikes ringing the mouth.
  if (A.mid) {
    const teeth = D === 0 ? 14 : 7;
    for (let i = 0; i < teeth; i++) {
      const a = (i / teeth) * Math.PI * 2;
      const r = 34;
      const tooth = loft([
        { pts: ellipseProfile(9, 6, 8), z: 0 },
        { pts: ellipseProfile(4, 3, 8), z: 14 },
        { pts: ellipseProfile(0.9, 0.7, 8), z: 24 },
      ], {});
      A.add('chitin', tooth, {
        pos: [Math.cos(a) * r, Math.sin(a) * r * 0.8, -318],
        rot: [0, 0, 0], scale: [1, 1, -1], tone: 0.85,
      });
    }
  }

  // ------------------------------------------------------- thrust orifices
  const vents = [[0, 6, 316, 30], [-46, -8, 292, 17], [46, -8, 292, 17], [0, 40, 296, 14]];
  for (const [vx, vy, vz, vr] of vents) {
    const lip = revolve([
      [vr * 1.4, 0, 0], [vr * 1.26, vr * 0.5, 0], [vr * 0.9, vr * 0.8, 1],
      [vr * 0.58, vr * 0.42, 0], [vr * 0.46, 0, 1], [vr * 0.32, -vr * 0.5, 1],
    ], { segments: D === 2 ? 10 : 20 });
    lip.rotateX(Math.PI / 2);
    A.add('chitin', lip, { pos: [vx, vy, vz], tone: 0.83 });
    const core = revolve([[0, -vr * 0.8, 1], [vr * 0.38, -vr * 0.2, 0], [vr * 0.5, vr * 0.5, 0]], { segments: D === 2 ? 10 : 20 });
    core.rotateX(Math.PI / 2);
    A.glow(core, 2.0, { pos: [vx, vy, vz] });
    A.engineHp([vx, vy, vz + vr * 0.7], vr * 0.7, [0, 0, 1]);
  }

  // ----------------------------------------------------- weapon nodules
  // Blisters instead of turrets: a chitin bulge with a glowing aperture. Instanced.
  const nodule = mergeGeometries([
    dome(7, { segments: D === 0 ? 14 : 8, rows: 5, squash: 0.85 }),
    xform(dome(3.4, { segments: 10, rows: 4, squash: 1.5 }), { pos: [0, 5.2, 0] }),
  ]);
  const nMats = [];
  const nLights = [];
  const placeNodule = (x, y, z, rx, rz) => {
    const m = new THREE.Matrix4();
    m.compose(new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, 0, rz)),
      new THREE.Vector3(1, 1, 1));
    nMats.push(m);
    nLights.push([x, y, z, rx, rz]);
    A.turret([x, y, z], Math.PI * 1.3, Math.abs(y) > 40 ? 'antiship' : 'aa');
  };
  for (let i = 0; i < 9; i++) {
    const z = -230 + i * 62;
    const s = 1 - Math.abs(z) / 900;
    placeNodule(46 * s, 30 * s, z, 0, -0.9);
    placeNodule(-46 * s, 30 * s, z, 0, 0.9);
    if (i % 2 === 0) {
      placeNodule(30 * s, -34 * s, z, 0, Math.PI - 0.7);
      placeNodule(-30 * s, -34 * s, z, 0, Math.PI + 0.7);
    }
  }
  A.instance(nodule, 'chitin', nMats);
  if (A.mid) {
    for (const [x, y, z, rx, rz] of nLights) {
      const up = new THREE.Vector3(0, 1, 0).applyEuler(new THREE.Euler(rx, 0, rz));
      A.glow(dome(2.4, { segments: 8, rows: 3, squash: 1.2 }), 1.2, {
        pos: [x + up.x * 7.6, y + up.y * 7.6, z + up.z * 7.6],
        rot: [rx, 0, rz],
      });
    }
  }

  // ------------------------------------------------------- luminous seams
  if (A.mid) {
    const seamPts = (sx, yb) => [
      [sx * 30, yb, -280], [sx * 48, yb + 4, -180], [sx * 54, yb + 6, -40],
      [sx * 52, yb + 4, 100], [sx * 40, yb, 220], [sx * 24, yb - 4, 300],
    ];
    for (const sx of [-1, 1]) {
      for (const yb of [22, -14]) {
        const pts = seamPts(sx, yb);
        A.glow(loft(pts.map((p) => ({ pts: ellipseProfile(3.0, 1.4, 6), z: p[2], x: p[0], y: p[1] })), {}),
          yb > 0 ? 0.7 : 0.45);
      }
    }
  }

  // Bio-lights at the extremities: the Nephilim equivalent of nav lights.
  A.navLight([-96, 24, -430], '#c8ff5a', 16, 3.0, [-1, 0.2, -0.4]);
  A.navLight([96, 24, -430], '#8fff9a', 16, 3.0, [1, 0.2, -0.4]);
  A.navLight([0, 78, -40], '#d8ff7a', 14, 2.6, [0, 1, 0]);
  A.navLight([0, -46, 120], '#b8ff4a', 10, 2.2, [0, -1, 0]);
  runningLights(A, { from: [50, 8, -240], to: [30, 4, 300], count: D === 0 ? 22 : 9, color: '#b8ff4a', intensity: 3.0, size: 2.0, normal: [1, 0, 0], mirror: true });

  rcsPort(A, { pos: [52, 20, -260], normal: [1, 0.4, 0], size: 9, mirror: true });
  rcsPort(A, { pos: [46, 18, 260], normal: [1, 0.4, 0], size: 9, mirror: true });

  A.cockpit([0, 34, -200], new THREE.Quaternion());
  return A;
}
