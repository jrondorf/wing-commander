/**
 * Moray — Nephilim heavy fighter / gunboat.
 *
 * The Manta's bigger relative. Where the Manta is a ray, the Moray is a segmented
 * invertebrate: a ribbed abdomen of overlapping carapace segments, four limb-like
 * spars that arch out and forward, a bio-lance emitter glowing in a socket at the
 * head, and a cluster of three thrust orifices at the tail. Every joint between
 * segments leaks light.
 *
 * -Z forward. 30 m long, 21 m span.
 */
import * as THREE from 'three';
import { fbm3 } from '../../procgen/noise.js';
import {
  loft, teardropProfile, ellipseProfile, revolve, tube, dome, xform, mirrorX,
  displace, mergeGeometries, plate, extrudeAlongPath, reverseWinding,
} from '../geometryKit.js';
import { rcsPort } from '../parts.js';

export const def = {
  id: 'alien_moray',
  name: 'Moray',
  faction: 'nephilim',
  role: 'heavy fighter',
  style: 'alien',
  length: 30, span: 21, height: 7.5,
  lod: [0, 260, 1200],
};

/** One carapace segment: a swollen ring that overlaps the one behind it. */
function segment(w, h, len, seg) {
  return loft([
    { pts: ellipseProfile(w * 0.86, h * 0.82, seg), z: 0 },
    { pts: ellipseProfile(w, h, seg), z: len * 0.34 },
    { pts: ellipseProfile(w * 0.98, h * 0.95, seg), z: len * 0.78 },
    { pts: ellipseProfile(w * 0.8, h * 0.76, seg), z: len },
  ], {});
}

export function build(A, rng, greebles) {
  const D = A.detail;
  const glow = A.mats.palette.glow;
  const glowI = A.mats.palette.glowIntensity;
  const seed = rng.int(1, 1e6);
  const seg = D === 2 ? 10 : D === 1 ? 14 : 20;

  // ------------------------------------------------------- head / thorax
  const head = loft([
    { pts: teardropProfile(1.0, 0.8, seg, 0.7), z: -15.0, y: -0.4 },
    { pts: teardropProfile(3.0, 2.3, seg, 0.7), z: -13.2, y: -0.3 },
    { pts: teardropProfile(5.2, 4.0, seg, 0.7), z: -10.4, y: -0.1 },
    { pts: teardropProfile(6.6, 5.0, seg, 0.7), z: -7.0, y: 0.1 },
    { pts: teardropProfile(6.9, 5.2, seg, 0.7), z: -3.5, y: 0.15 },
    { pts: teardropProfile(6.2, 4.7, seg, 0.7), z: -0.5, y: 0.1 },
  ], {});
  if (D < 2) displace(head, (x, y, z) => fbm3(x * 0.2, y * 0.2, z * 0.15, { seed, octaves: 3 }) * 0.24);
  A.add('chitin', head, { tone: 1, jitter: 0.03 });

  // ---------------------------------------------------- segmented abdomen
  const segs = D === 2 ? 3 : 5;
  for (let i = 0; i < segs; i++) {
    const t = i / segs;
    const z = -0.8 + i * (15.5 / segs);
    const w = 6.0 * (1 - 0.5 * t) + 0.4;
    const h = 4.5 * (1 - 0.52 * t) + 0.3;
    const g = segment(w, h, 15.5 / segs + 1.0, seg);
    if (D < 2) displace(g, (x, y, zz) => fbm3(x * 0.24, y * 0.24, (zz + z) * 0.2, { seed: seed + i, octaves: 2 }) * 0.16);
    A.add('chitin', g, { pos: [0, 0.1 - t * 0.4, z], tone: 0.98 - t * 0.05, jitter: 0.03 });
    // Light leaks from the joint behind every segment.
    if (A.mid) {
      A.glow(revolveRing(w * 0.83, h * 0.79, seg), 0.55, { pos: [0, 0.1 - t * 0.4, z - 0.25] });
    }
  }

  // ------------------------------------------------------------ dorsal spines
  if (A.mid) {
    const spines = A.fine ? 7 : 3;
    for (let i = 0; i < spines; i++) {
      const t = i / spines;
      const z = -8.0 + t * 18.0;
      const hgt = 2.6 * (1 - 0.45 * Math.abs(t - 0.3) * 2) + 0.7;
      const s = loft([
        { pts: ellipseProfile(1.5, 0.6, 8), z: 0 },
        { pts: ellipseProfile(0.9, 0.4, 8), z: hgt * 0.6, x: 0.3 },
        { pts: ellipseProfile(0.14, 0.1, 8), z: hgt, x: 0.9 },
      ], {});
      s.rotateX(-Math.PI / 2);
      A.add('chitin', s, { pos: [0, 2.3 - t * 0.9, z], rot: [0, 0, 0], tone: 0.9 });
    }
  }

  // ------------------------------------------------------------- limb spars
  // Four arched spars, upper pair sweeping forward, lower pair aft. They give the
  // Moray its crab-like plan view.
  const spar = (len, up, fwd, thick) => {
    const path = [];
    const n = D === 2 ? 4 : 7;
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      path.push(new THREE.Vector3(
        2.4 + u * len,
        up * (Math.sin(u * 2.2) * 2.2 - u * u * 1.2),
        fwd * (u * u * 5.6) - u * 1.2,
      ));
    }
    return extrudeAlongPath(ellipseProfile(thick, thick * 0.62, D === 2 ? 6 : 10), path, {
      scale: (u) => 1 - 0.72 * u * u,
    });
  };
  for (const sx of [-1, 1]) {
    const upper = spar(8.2, 1, -1, 2.2);
    A.add('chitin', upper, { pos: [0, 1.2, -5.0], scale: [sx, 1, 1], mirror: sx < 0, tone: 1.0 });
    const lower = spar(7.0, -1, 1, 1.8);
    A.add('chitin', lower, { pos: [0, -0.6, 1.0], scale: [sx, 1, 1], mirror: sx < 0, tone: 0.96 });
  }

  // Membrane webbing between the upper spars and the body.
  if (A.mid) {
    for (const sx of [-1, 1]) {
      const web = loft([
        { pts: ellipseProfile(4.6, 0.5, 10), z: -8.0, x: sx * 3.4, y: 0.6 },
        { pts: ellipseProfile(5.4, 0.42, 10), z: -3.0, x: sx * 6.0, y: 0.9 },
        { pts: ellipseProfile(3.4, 0.3, 10), z: 1.6, x: sx * 7.6, y: 0.6 },
        { pts: ellipseProfile(1.0, 0.2, 10), z: 4.0, x: sx * 8.2, y: 0.2 },
      ], {});
      A.add('chitin', web, { tone: 0.94 });
    }
  }

  // ----------------------------------------------------------- bio-lance
  const socket = revolve([
    [1.9, 0, 0], [1.7, 0.9, 0], [1.1, 1.5, 1], [0.75, 1.1, 0], [0.7, 0, 1],
  ], { segments: seg });
  socket.rotateX(-Math.PI / 2);
  A.add('chitin', socket, { pos: [0, -0.2, -14.4], tone: 0.86 });
  A.glow(dome(0.85, { segments: seg, rows: 5, squash: 1.3 }), 2.2,
    { pos: [0, -0.2, -14.9], rot: [Math.PI / 2, 0, 0] });
  A.gun([0, -0.2, -15.6], [0, 0, -1], 'bio-lance');

  // Eye clusters — asymmetric, six on one side and four on the other.
  const eyes = [
    [1.9, 1.4, -11.6, 0.4], [-1.6, 1.5, -11.9, 0.32], [2.7, 0.7, -10.6, 0.3],
    [-2.6, 0.6, -10.4, 0.26], [1.1, 2.0, -10.2, 0.24], [-0.9, 1.9, -10.6, 0.2],
    [3.1, -0.3, -9.6, 0.22], [0.4, 2.3, -9.0, 0.18],
  ];
  if (D < 2) {
    for (const [ex, ey, ez, er] of eyes) {
      A.add('chitin', dome(er * 1.55, { segments: 10, rows: 4, squash: 0.55 }), { pos: [ex, ey, ez], rot: [-0.55, 0, 0], tone: 0.84 });
      A.glow(dome(er, { segments: 10, rows: 3, squash: 0.95 }), 0.7, { pos: [ex, ey + er * 0.3, ez - er * 0.25], rot: [-0.55, 0, 0] });
    }
  }

  // ------------------------------------------------------ plasma emitters
  for (const sx of [-1, 1]) {
    const barb = loft([
      { pts: ellipseProfile(1.1, 0.85, 10), z: 0 },
      { pts: ellipseProfile(0.7, 0.55, 10), z: -2.4 },
      { pts: ellipseProfile(0.16, 0.13, 10), z: -4.0 },
    ], {});
    A.add('chitin', barb, { pos: [sx * 5.0, 0.5, -9.0], rot: [0, sx * 0.04, 0], tone: 0.9 });
    A.glow(dome(0.2, { segments: 8, rows: 3, squash: 1.2 }), 1.7, { pos: [sx * 5.0, 0.5, -13.1], rot: [-Math.PI / 2, 0, 0] });
    A.gun([sx * 5.0, 0.5, -13.3], [0, 0, -1], 'plasma');
  }

  // Egg-sac seeker pods on the ventral surface — asymmetric count per side.
  if (A.mid) {
    const pods = [[1.5, -2.6, -2.0, 1.0], [-1.7, -2.5, 0.5, 0.9], [1.3, -2.4, 3.2, 0.8], [-1.4, -2.2, 5.6, 0.7]];
    for (const [px, py, pz, pr] of pods) {
      A.add('chitin', dome(pr, { segments: 10, rows: 4, squash: 1.4 }), { pos: [px, py, pz], rot: [Math.PI, 0, 0], tone: 0.88 });
      A.glow(dome(pr * 0.4, { segments: 8, rows: 3, squash: 1.0 }), 0.9, { pos: [px, py - pr * 0.9, pz], rot: [Math.PI, 0, 0] });
    }
  }
  A.missile([0, -2.6, -1.0], [0, 0, -1], 6, 'bio-seeker');

  // ------------------------------------------------------- thrust orifices
  const vents = [[0, 0.2, 15.6, 1.9], [2.9, -0.9, 14.2, 1.15], [-2.9, -0.9, 14.2, 1.15]];
  for (const [vx, vy, vz, vr] of vents) {
    const lip = revolve([
      [vr * 1.45, 0, 0], [vr * 1.3, vr * 0.6, 0], [vr * 0.92, vr * 0.85, 1],
      [vr * 0.6, vr * 0.45, 0], [vr * 0.48, 0, 1], [vr * 0.34, -vr * 0.55, 1],
    ], { segments: D === 2 ? 8 : 16 });
    lip.rotateX(Math.PI / 2);
    A.add('chitin', lip, { pos: [vx, vy, vz], tone: 0.82 });
    const core = revolve([[0, -vr * 0.8, 1], [vr * 0.4, -vr * 0.2, 0], [vr * 0.5, vr * 0.55, 0]], { segments: D === 2 ? 8 : 16 });
    core.rotateX(Math.PI / 2);
    A.glow(core, 2.3, { pos: [vx, vy, vz] });
    A.engineHp([vx, vy, vz + vr * 0.8], vr * 0.72, [0, 0, 1]);
  }

  // ------------------------------------------------------ luminous seams
  if (A.mid) {
    const seam = (pts, wdt, tone) => {
      const secs = pts.map((p) => ({ pts: ellipseProfile(wdt, wdt * 0.4, 6), z: p[2], x: p[0], y: p[1] }));
      A.glow(loft(secs, {}), tone);
    };
    for (const sx of [-1, 1]) {
      seam([[sx * 3.2, 1.2, -12.0], [sx * 3.7, 1.4, -7.0], [sx * 3.6, 1.2, -1.0], [sx * 2.8, 0.7, 6.0], [sx * 1.8, 0.3, 12.0]], 0.28, 0.65);
      seam([[sx * 2.6, -1.9, -10.0], [sx * 3.0, -2.1, -3.0], [sx * 2.4, -1.9, 5.0]], 0.22, 0.45);
    }
    seam([[0, 2.6, -9.0], [0, 2.9, -2.0], [0, 2.4, 6.0], [0, 1.6, 13.0]], 0.24, 0.5);
  }

  rcsPort(A, { pos: [3.0, 1.8, -12.0], normal: [0.5, 0.85, 0], size: 0.4, mirror: true });
  rcsPort(A, { pos: [9.4, -0.8, 1.0], normal: [0, -1, 0], size: 0.34, mirror: true });
  rcsPort(A, { pos: [2.6, 1.8, 12.0], normal: [0, 1, 0], size: 0.36, mirror: true });

  A.navLight([-10.6, -1.6, 1.6], '#c8ff5a', 7, 0.3, [-1, -0.2, 0]);
  A.navLight([10.6, -1.6, 1.6], '#8fff9a', 7, 0.3, [1, -0.2, 0]);
  A.navLight([0, 3.4, 9.0], '#d8ff7a', 5, 0.24, [0, 1, 0]);

  A.cockpit([0, 1.0, -9.5], new THREE.Quaternion());
  return A;
}

/** A thin luminous band matching an abdomen segment's cross-section. */
function revolveRing(w, h, seg) {
  return loft([
    { pts: ellipseProfile(w, h, seg), z: 0 },
    { pts: ellipseProfile(w * 1.02, h * 1.02, seg), z: 0.22 },
    { pts: ellipseProfile(w, h, seg), z: 0.44 },
  ], { capStart: false, capEnd: false });
}
