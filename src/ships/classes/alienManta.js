/**
 * Manta — Nephilim light fighter.
 *
 * A different *species* of design, not a repainted Confed hull. Where the Vampire
 * is a bolted assembly of chamfered boxes, the Manta is grown: one continuous
 * carapace, smooth-shaded, with overlapping chitin plates like elytra, curved
 * membranous wings that sweep and droop, a cluster of asymmetric eye pods, and
 * bio-luminescent seams that glow along every joint. No flat panels, no rivets,
 * no visible fasteners. The thrust vents are puckered orifices, not machined bells.
 *
 * Deliberately asymmetric in detail: the port wing carries a spur the starboard
 * one does not, and the sensor cluster is off-centre. Bilateral symmetry with
 * unilateral detail is what makes it read as an organism.
 *
 * -Z forward. 19 m long, 17 m span.
 */
import * as THREE from 'three';
import { fbm3 } from '../../procgen/noise.js';
import {
  loft, teardropProfile, ellipseProfile, revolve, tube, dome, xform, mirrorX,
  displace, mergeGeometries, plate, ring, scaleProfile, reverseWinding,
} from '../geometryKit.js';
import { rcsPort } from '../parts.js';

export const def = {
  id: 'alien_manta',
  name: 'Manta',
  faction: 'nephilim',
  role: 'light fighter',
  style: 'alien',
  length: 19, span: 17, height: 4.2,
  lod: [0, 220, 1000],
};

/** Organic wing: lens sections lofted outboard along a drooping, sweeping arc. */
function membraneWing(stations, seg) {
  const sections = [];
  for (let i = 0; i <= stations; i++) {
    const u = i / stations;
    // Chord shrinks and the section thins toward a blade-like tip.
    const chord = 7.4 * (1 - 0.72 * u * u) + 0.4;
    const thick = 1.05 * Math.pow(1 - u, 1.5) + 0.06;
    const prof = ellipseProfile(chord, thick, seg);
    // Bias the leading edge forward so the plan view is a scythe, not a triangle.
    for (const p of prof) p[0] += Math.pow(Math.max(0, -p[0] / chord), 2) * chord * 0.22;
    sections.push({
      pts: prof,
      z: u * 8.5,
      x: 1.1 + u * 3.4 + u * u * 1.6,       // sweep (chord axis)
      y: 0.35 * Math.sin(u * 2.6) - u * u * 1.5, // rise then droop
      rz: -0.22 * u,
    });
  }
  const g = loft(sections, {});
  // Built with span on +Z and chord on X; rotate the chord aft, then mirror so
  // the span runs to starboard (the port wing is the mirror of this one).
  g.rotateY(-Math.PI / 2);
  g.scale(-1, 1, 1);
  reverseWinding(g);
  return g;
}

export function build(A, rng, greebles) {
  const D = A.detail;
  const glow = A.mats.palette.glow;         // sickly green-yellow
  const glowI = A.mats.palette.glowIntensity;
  const seed = rng.int(1, 1e6);

  // ------------------------------------------------------------- carapace
  const seg = D === 2 ? 10 : D === 1 ? 14 : 22;
  const T = (w, h) => teardropProfile(w, h, seg, 0.62);
  const body = loft([
    { pts: T(0.5, 0.4), z: -9.5, y: -0.35 },
    { pts: T(1.7, 1.0), z: -8.4, y: -0.28 },
    { pts: T(3.1, 1.9), z: -6.6, y: -0.15 },
    { pts: T(4.3, 2.7), z: -4.0, y: 0.0 },
    { pts: T(4.9, 3.1), z: -1.0, y: 0.05 },
    { pts: T(4.7, 3.0), z: 2.0, y: 0.0 },
    { pts: T(4.0, 2.5), z: 5.0, y: -0.08 },
    { pts: T(3.0, 1.85), z: 7.4, y: -0.15 },
    { pts: T(2.1, 1.3), z: 9.0, y: -0.2 },
  ], {});
  // Organic irregularity — low-frequency swell so no two spots read identical.
  if (D < 2) {
    displace(body, (x, y, z) => fbm3(x * 0.22, y * 0.22, z * 0.16, { seed, octaves: 3 }) * 0.19);
  }
  A.add('chitin', body, { tone: 1, jitter: 0.03 });

  // ------------------------------------------------------------ elytra plates
  // Overlapping dorsal plates, each a shallow shell — beetle wing-cases.
  if (A.mid) {
    const plates = [];
    const n = A.fine ? 5 : 3;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const z = -5.4 + t * 9.6;
      const w = 4.4 * (1 - 0.42 * Math.abs(t - 0.35));
      const shell = loft([
        { pts: ellipseProfile(w, 0.55, 12), z: 0, sx: 0.62, sy: 0.5 },
        { pts: ellipseProfile(w, 0.55, 12), z: 1.5 },
        { pts: ellipseProfile(w, 0.55, 12), z: 2.9, sx: 0.86, sy: 0.8 },
      ], {});
      plates.push(xform(shell, { pos: [0, 1.05 + 0.28 * Math.sin(t * 3), z], rot: [-0.10 + t * 0.05, 0, 0] }));
    }
    A.add('chitin', mergeGeometries(plates), { tone: 0.9, jitter: 0.02 });
  }

  // ---------------------------------------------------------------- wings
  const w = membraneWing(D === 2 ? 3 : 6, D === 2 ? 8 : 14);
  A.add('chitin', xform(w, { pos: [0, 0.1, 0.4] }), { tone: 1.02 });
  A.add('chitin', mirrorX(xform(w, { pos: [0, 0.1, 0.4] })), { tone: 0.99 });

  // Asymmetric spur: the port wing carries a barbed sensor vane, the other does not.
  if (A.mid) {
    const spur = loft([
      { pts: ellipseProfile(1.3, 0.5, 10), z: 0 },
      { pts: ellipseProfile(0.8, 0.32, 10), z: 1.8, y: 0.9 },
      { pts: ellipseProfile(0.18, 0.1, 10), z: 3.2, y: 2.3, x: -0.3 },
    ], {});
    A.add('chitin', xform(spur, { pos: [-5.6, 0.15, 0.6], rot: [0, 0.25, -0.18] }), { tone: 0.94 });
  }

  // ------------------------------------------------------------- head / eyes
  const head = dome(1.55, { segments: seg, rows: 7, squash: 0.62 });
  A.add('chitin', xform(head, { pos: [0, 0.5, -5.4], rot: [-0.22, 0, 0] }), { tone: 0.93 });
  // Eye cluster — asymmetric, unevenly sized, glowing from inside a chitin socket.
  const eyes = [
    [0.85, 0.62, -6.5, 0.34], [-0.72, 0.7, -6.6, 0.28], [1.35, 0.28, -5.9, 0.24],
    [-1.5, 0.34, -5.8, 0.19], [0.15, 0.95, -6.2, 0.22], [-0.15, 0.2, -7.0, 0.3],
  ];
  for (const [ex, ey, ez, er] of eyes) {
    if (D === 2) break;
    A.add('chitin', dome(er * 1.5, { segments: 10, rows: 4, squash: 0.5 }), { pos: [ex, ey, ez], rot: [-0.5, 0, 0], tone: 0.85 });
    A.glow(dome(er, { segments: 10, rows: 4, squash: 0.9 }), 0.75, { pos: [ex, ey + er * 0.3, ez - er * 0.2], rot: [-0.5, 0, 0] });
  }

  // ------------------------------------------------------- luminous seams
  // Thin glowing ribbons that follow the joints between body and wings. These do
  // more for the alien read than any texture — the ship is lit from inside.
  if (A.mid) {
    const seam = (pts, wdt, tone) => {
      const secs = pts.map((p) => ({ pts: ellipseProfile(wdt, wdt * 0.42, 6), z: p[2], x: p[0], y: p[1] }));
      A.glow(loft(secs, {}), tone);
    };
    seam([[2.1, 0.5, -5.2], [3.0, 0.42, -2.4], [3.5, 0.24, 0.8], [3.4, 0.0, 4.0], [2.7, -0.2, 6.6]], 0.2, 0.7);
    seam([[-2.1, 0.5, -5.2], [-3.0, 0.42, -2.4], [-3.5, 0.24, 0.8], [-3.4, 0.0, 4.0], [-2.7, -0.2, 6.6]], 0.2, 0.7);
    seam([[0, 1.55, -3.2], [0, 1.72, 0.4], [0, 1.6, 4.0], [0, 1.25, 7.2]], 0.16, 0.5);
    seam([[0, -1.5, -4.0], [0, -1.72, 0.5], [0, -1.55, 5.0]], 0.14, 0.4);
  }

  // ------------------------------------------------------- thrust orifices
  // Puckered vents rather than machined bells: a chitin sphincter with a hot core.
  const vents = [[0, 0.15, 9.0, 1.25], [2.35, -0.15, 8.1, 0.8], [-2.35, -0.15, 8.1, 0.8]];
  for (const [vx, vy, vz, vr] of vents) {
    const lipProf = [
      [vr * 1.5, 0, 0], [vr * 1.35, vr * 0.55, 0], [vr * 0.95, vr * 0.78, 1],
      [vr * 0.62, vr * 0.4, 0], [vr * 0.5, 0, 1], [vr * 0.36, -vr * 0.5, 1],
    ];
    const lip = revolve(lipProf, { segments: D === 2 ? 8 : 16 });
    lip.rotateX(Math.PI / 2);
    A.add('chitin', lip, { pos: [vx, vy, vz], tone: 0.82 });
    const core = revolve([[0, -vr * 0.7, 1], [vr * 0.42, -vr * 0.2, 0], [vr * 0.52, vr * 0.5, 0]], { segments: D === 2 ? 8 : 16 });
    core.rotateX(Math.PI / 2);
    A.glow(core, 2.4, { pos: [vx, vy, vz] });
    A.engineHp([vx, vy, vz + vr * 0.8], vr * 0.7, [0, 0, 1]);
  }

  // ------------------------------------------------------------- weapons
  // Organic emitters set into the wing roots — barbs, not barrels.
  for (const sx of [-1, 1]) {
    const barb = loft([
      { pts: ellipseProfile(0.62, 0.5, 10), z: 0 },
      { pts: ellipseProfile(0.42, 0.34, 10), z: -1.5 },
      { pts: ellipseProfile(0.1, 0.08, 10), z: -2.6 },
    ], {});
    A.add('chitin', barb, { pos: [sx * 3.35, -0.25, -4.6], rot: [0, sx * 0.05, 0], tone: 0.88 });
    A.glow(dome(0.13, { segments: 8, rows: 3, squash: 1.2 }), 1.6,
      { pos: [sx * 3.35, -0.25, -7.05], rot: [-Math.PI / 2, 0, 0] });
    A.gun([sx * 3.35, -0.25, -7.2], [0, 0, -1], 'plasma');
  }
  A.missile([0, -1.4, -2.0], [0, 0, -1], 3, 'bio-seeker');

  // Ventral ovipositor pod that carries the seekers — asymmetric, one side only.
  if (A.mid) {
    const pod = loft([
      { pts: ellipseProfile(1.0, 0.8, 10), z: -3.6 },
      { pts: ellipseProfile(1.5, 1.15, 10), z: -1.2 },
      { pts: ellipseProfile(1.2, 0.95, 10), z: 1.8 },
      { pts: ellipseProfile(0.4, 0.3, 10), z: 3.4 },
    ], {});
    A.add('chitin', pod, { pos: [0.55, -1.65, -0.6], tone: 0.9 });
    A.glow(plate(0.9, 0.1, 0.04, 0.02), 0.6, { pos: [0.55, -2.35, -1.4], rot: [0, 0, 0] });
  }

  // ---------------------------------------------------------- attitude jets
  rcsPort(A, { pos: [1.9, 0.9, -6.2], normal: [0.5, 0.85, 0], size: 0.24, mirror: true });
  rcsPort(A, { pos: [7.0, -0.5, 2.6], normal: [0, -1, 0], size: 0.22, mirror: true });
  rcsPort(A, { pos: [2.2, 1.1, 7.0], normal: [0, 1, 0], size: 0.22, mirror: true });

  // Bio-lights instead of regulation nav lights — same job, alien grammar.
  A.navLight([-8.4, -1.2, 2.6], '#c8ff5a', 6, 0.2, [-1, -0.2, 0]);
  A.navLight([8.4, -1.2, 2.6], '#8fff9a', 6, 0.2, [1, -0.2, 0]);
  A.navLight([0, 1.9, 5.6], '#d8ff7a', 4, 0.16, [0, 1, 0]);

  A.cockpit([0, 0.55, -5.0], new THREE.Quaternion());
  return A;
}
