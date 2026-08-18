/**
 * Manta — Nephilim light fighter.
 *
 * A different *species* of design, not a repainted Confed hull, and the outline
 * has to prove it before the texture gets a chance. Every Confederation fighter in
 * the fleet is an assembly: a fuselage, plus wings, plus nacelles, plus fins, bolted
 * together with visible joints. The Manta is a **single surface**. The entire
 * airframe is one carapace lofted from port wingtip to starboard wingtip in one
 * pass — there is no fuselage, because the body *is* the middle of the wing.
 *
 *   plan      a broad crescent. The leading edge sweeps back 8.6 m from a blunt
 *             snout; the trailing edge sweeps *forward* into a deep central notch,
 *             leaving two swept lobes and a scythe tip either side.
 *   side      a sliver. 2.6 m thick at the spine, 0.15 m at the tips — a fifth the
 *             depth of any Confed hull at the same length. The dorsal hump and the
 *             long upswept tail spine are the only vertical events.
 *   front     the wings fall away 2.8 m to downturned tips. Nothing on a Confed
 *             airframe droops like that.
 *
 * Two cephalic horns reach forward past the snout either side of the mouth, and a
 * whip tail runs out of the trailing notch. Detail is deliberately unilateral — one
 * wing carries a barbed vane, the eye cluster is off-centre — because bilateral
 * symmetry with asymmetric detail is what reads as grown rather than built.
 *
 * -Z forward. 19.5 m long, 19.2 m span, 4.9 m tall.
 */
import * as THREE from 'three';
import { fbm3 } from '../../procgen/noise.js';
import {
  loft, ellipseProfile, airfoilProfile, revolve, dome, xform, displace,
  mergeGeometries, plate, extrudeAlongPath,
} from '../geometryKit.js';
import { rcsPort } from '../parts.js';

export const def = {
  id: 'alien_manta',
  name: 'Manta',
  faction: 'nephilim',
  role: 'light fighter',
  style: 'alien',
  length: 19.5, span: 19.2, height: 4.9,
  lod: [0, 220, 1000],
};

const TIP = 9.6;

/**
 * One span station of the carapace. A cambered lens: round leading edge, knife
 * trailing edge, domed dorsally. Rotated so index 0 lands on the trailing edge —
 * `loft` always splits vertex 0 for the UV seam, and the one crease this hull is
 * allowed is the knife edge, never the leading edge.
 */
function section(chord, thick, seg, camber) {
  const p = airfoilProfile(chord, thick, seg, camber);
  const half = Math.max(2, Math.round(seg / 2));
  const out = p.slice(half).concat(p.slice(0, half)).map((q) => [q[0], q[1], 0]);
  out[0][2] = 1;
  return out;
}

/** Leading / trailing edge and thickness laws, in metres, as functions of |span|. */
const zLead = (u) => -7.4 + 8.2 * Math.pow(u, 1.20);
const zTrail = (u) => 1.6 + 5.4 * Math.pow(u, 0.50) - 5.6 * Math.pow(u, 1.90);
const thickAt = (u) => 2.15 * Math.pow(1 - u, 1.30) + 0.08;
const droop = (u) => 0.34 * Math.sin(u * 2.4) - 2.9 * Math.pow(u, 2.4);

export function build(A, rng, greebles) {
  const D = A.detail;
  const glow = A.mats.palette.glow;         // sickly green-yellow
  const glowI = A.mats.palette.glowIntensity;
  const seed = rng.int(1, 1e6);

  // ------------------------------------------------- 1. the whole carapace
  // One loft, wingtip to wingtip. Body and wing are the same surface.
  const seg = D === 2 ? 8 : D === 1 ? 12 : 16;
  const half = D === 2 ? 5 : D === 1 ? 8 : 13;
  const secs = [];
  for (let i = -half; i <= half; i++) {
    const s = i / half;
    const u = Math.abs(s);
    const chord = zTrail(u) - zLead(u);
    const thick = thickAt(u);
    secs.push({
      pts: section(chord, thick, seg, 0.030),
      z: s * TIP,
      x: zLead(u) + 0.35 * chord,
      y: droop(u),
      rz: 0.26 * Math.pow(u, 1.5),
    });
  }
  const body = loft(secs, {});
  body.rotateY(-Math.PI / 2);   // span onto X, chord onto Z (leading edge forward)
  if (D < 2) {
    displace(body, (x, y, z) => fbm3(x * 0.20, y * 0.24, z * 0.15, { seed, octaves: 3 }) * 0.16);
  }
  A.add('chitin', body, { tone: 1, jitter: 0.03 });

  // -------------------------------------------------- 2. snout and cephalics
  // A blunt head grown onto the front of the carapace, and the two forward horns
  // that make the plan view unmistakable.
  const headSecs = [
    { pts: ellipseProfile(1.0, 0.55, seg), z: -9.7, y: -0.30 },
    { pts: ellipseProfile(2.4, 1.35, seg), z: -8.9, y: -0.16 },
    { pts: ellipseProfile(3.4, 1.80, seg), z: -7.8, y: -0.02 },
    { pts: ellipseProfile(4.0, 2.10, seg), z: -6.6, y: 0.06 },
  ];
  const head = loft(headSecs, {});
  if (D < 2) displace(head, (x, y, z) => fbm3(x * 0.3, y * 0.3, z * 0.2, { seed: seed + 5, octaves: 2 }) * 0.13);
  A.add('chitin', head, { tone: 0.95, jitter: 0.03 });

  // Cephalic horns: curved, tapering, reaching 0.5 m past the snout.
  const hornPath = [];
  for (let i = 0; i <= (D === 2 ? 3 : 7); i++) {
    const t = i / (D === 2 ? 3 : 7);
    hornPath.push([1.55 - 0.55 * t * t, -0.25 - 0.30 * t + 0.22 * Math.sin(t * 2.2), -7.1 - 3.1 * t]);
  }
  const horn = extrudeAlongPath(ellipseProfile(0.76, 0.62, D === 2 ? 6 : 10), hornPath, {
    scale: (t) => 1 - 0.86 * Math.pow(t, 0.85),
  });
  A.addMirrored('chitin', horn, { pos: [0, 0, 0], tone: 0.9, jitter: 0.03 });

  // The mouth: a dark slot under the snout with a lit throat.
  A.add('dark', loft([
    { pts: ellipseProfile(2.5, 0.6, 10), z: -9.0, y: -0.62 },
    { pts: ellipseProfile(2.1, 0.5, 10), z: -7.9, y: -0.72 },
  ], { capStart: true, capEnd: true }), { tone: 0.5 });
  A.glow(loft([
    { pts: ellipseProfile(2.1, 0.28, 10), z: -8.9, y: -0.62 },
    { pts: ellipseProfile(1.7, 0.2, 10), z: -8.1, y: -0.68 },
  ], {}), 0.9);

  // ------------------------------------------------------- 3. dorsal crest
  // A raised chitin ridge, taller than anything else on the ship, so the side
  // view has one deliberate vertical event and nothing else.
  if (A.mid) {
    const crest = loft([
      { pts: ellipseProfile(1.3, 0.44, 10), z: -6.2, y: 0.62, sx: 0.4, sy: 0.35 },
      { pts: ellipseProfile(1.3, 0.44, 10), z: -4.0, y: 1.12, sx: 0.9, sy: 1.0 },
      { pts: ellipseProfile(1.3, 0.44, 10), z: -0.4, y: 1.34, sx: 1.0, sy: 1.15 },
      { pts: ellipseProfile(1.3, 0.44, 10), z: 2.4, y: 1.06, sx: 0.72, sy: 0.85 },
    ], {});
    A.add('chitin', crest, { tone: 0.92, jitter: 0.02 });
  }

  // Overlapping elytra plates either side of the crest — beetle wing-cases.
  if (A.mid) {
    const plates = [];
    const n = A.fine ? 4 : 2;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const z = -4.6 + t * 6.4;
      const w = 4.6 * (1 - 0.34 * Math.abs(t - 0.3));
      plates.push(xform(loft([
        { pts: ellipseProfile(w, 0.45, 12), z: 0, sx: 0.6, sy: 0.5 },
        { pts: ellipseProfile(w, 0.45, 12), z: 1.4 },
        { pts: ellipseProfile(w, 0.45, 12), z: 2.7, sx: 0.84, sy: 0.78 },
      ], {}), { pos: [0, 0.72 + 0.2 * Math.sin(t * 3), z], rot: [-0.09 + t * 0.05, 0, 0] }));
    }
    A.add('chitin', mergeGeometries(plates), { tone: 0.88, jitter: 0.02 });
  }

  // -------------------------------------------------------- 4. the tail whip
  // Grows out of the trailing notch and rises. In profile it is the one line that
  // no Confederation ship in the fleet has anywhere.
  const tailPath = [];
  const tn = D === 2 ? 4 : 9;
  for (let i = 0; i <= tn; i++) {
    const t = i / tn;
    tailPath.push([0, 0.42 + 1.55 * Math.pow(t, 1.35), 0.9 + 8.4 * t]);
  }
  const tail = extrudeAlongPath(ellipseProfile(1.05, 0.85, D === 2 ? 6 : 10), tailPath, {
    scale: (t) => 1 - 0.93 * Math.pow(t, 0.8),
  });
  A.add('chitin', tail, { tone: 0.93, jitter: 0.02 });
  // Barbs along the whip — the reason it reads as a stinger and not an antenna.
  if (A.mid) {
    const barbs = [];
    for (let i = 0; i < (A.fine ? 5 : 2); i++) {
      const t = 0.18 + i * 0.17;
      const y = 0.42 + 1.55 * Math.pow(t, 1.35), z = 0.9 + 8.4 * t;
      const sc = 1 - 0.8 * t;
      for (const sx of [-1, 1]) {
        barbs.push(xform(loft([
          { pts: ellipseProfile(0.5, 0.34, 8), z: 0 },
          { pts: ellipseProfile(0.12, 0.09, 8), z: 1.15 },
        ], {}), { pos: [sx * 0.25, y - 0.05, z], rot: [-0.5, sx * 1.15, 0], scale: sc }));
      }
    }
    A.add('chitin', mergeGeometries(barbs), { tone: 0.86, jitter: 0.02 });
  }

  // ------------------------------------------------------- 5. eyes & sensors
  const eyes = [
    [0.95, 0.52, -7.4, 0.32], [-0.80, 0.62, -7.5, 0.27], [1.45, 0.18, -6.7, 0.23],
    [-1.62, 0.26, -6.5, 0.18], [0.20, 0.86, -7.0, 0.21], [-0.20, 0.10, -8.1, 0.28],
  ];
  for (const [ex, ey, ez, er] of eyes) {
    if (D === 2) break;
    A.add('chitin', dome(er * 1.5, { segments: 10, rows: 4, squash: 0.5 }), { pos: [ex, ey, ez], rot: [-0.5, 0, 0], tone: 0.85 });
    A.glow(dome(er, { segments: 10, rows: 4, squash: 0.9 }), 0.75, { pos: [ex, ey + er * 0.3, ez - er * 0.2], rot: [-0.5, 0, 0] });
  }

  // ------------------------------------------------------ 6. luminous seams
  // Thin glowing ribbons along the joints. The ship is lit from inside; this does
  // more for the alien read than any texture can.
  if (A.mid) {
    const seam = (pts, wdt, tone) => {
      const secsL = pts.map((p) => ({ pts: ellipseProfile(wdt, wdt * 0.42, 6), z: p[2], x: p[0], y: p[1] }));
      A.glow(loft(secsL, {}), tone);
    };
    for (const sx of [1, -1]) {
      seam([[sx * 2.4, 0.42, -5.6], [sx * 3.6, 0.28, -3.0], [sx * 4.6, 0.02, 0.2], [sx * 5.2, -0.42, 2.8], [sx * 5.6, -0.95, 4.0]], 0.2, 0.7);
      seam([[sx * 1.3, -0.55, -6.8], [sx * 2.6, -0.72, -3.6], [sx * 3.4, -0.86, -0.4]], 0.14, 0.45);
    }
    seam([[0, 1.78, -3.4], [0, 1.95, -0.4], [0, 1.62, 2.2]], 0.16, 0.55);
  }

  // ----------------------------------------------------- 7. thrust orifices
  // Puckered vents, not machined bells: a chitin sphincter with a hot core.
  const vents = [[0, 0.42, 1.2, 1.1], [2.8, -0.14, 3.2, 0.78], [-2.8, -0.14, 3.2, 0.78]];
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

  // ------------------------------------------------------------ 8. weapons
  // Organic emitters grown out of the leading edge — barbs, not barrels.
  for (const sx of [-1, 1]) {
    const barb = loft([
      { pts: ellipseProfile(0.72, 0.58, 10), z: 0 },
      { pts: ellipseProfile(0.46, 0.36, 10), z: -1.6 },
      { pts: ellipseProfile(0.1, 0.08, 10), z: -2.8 },
    ], {});
    A.add('chitin', barb, { pos: [sx * 3.9, -0.34, -3.6], rot: [0.05, sx * 0.10, 0], tone: 0.88 });
    A.glow(dome(0.13, { segments: 8, rows: 3, squash: 1.2 }), 1.6,
      { pos: [sx * 3.9, -0.34, -6.3], rot: [-Math.PI / 2, 0, 0] });
    A.gun([sx * 3.9, -0.34, -6.4], [0, 0, -1], 'plasma');
  }
  A.missile([0, -1.1, -2.6], [0, 0, -1], 3, 'bio-seeker');

  // Ventral ovipositor pod carrying the seekers — one side only, deliberately.
  if (A.mid) {
    const pod = loft([
      { pts: ellipseProfile(1.0, 0.75, 10), z: -4.2 },
      { pts: ellipseProfile(1.6, 1.15, 10), z: -1.6 },
      { pts: ellipseProfile(1.25, 0.9, 10), z: 1.4 },
      { pts: ellipseProfile(0.35, 0.26, 10), z: 3.0 },
    ], {});
    A.add('chitin', pod, { pos: [0.62, -1.35, -0.4], tone: 0.9 });
    A.glow(plate(0.9, 0.1, 0.04, 0.02), 0.6, { pos: [0.62, -2.05, -1.2] });
  }

  // Asymmetric spur: the port wing carries a barbed sensor vane, the other does not.
  if (A.mid) {
    const spur = loft([
      { pts: ellipseProfile(1.5, 0.55, 10), z: 0 },
      { pts: ellipseProfile(0.9, 0.34, 10), z: 1.9, y: 1.0 },
      { pts: ellipseProfile(0.18, 0.1, 10), z: 3.4, y: 2.5, x: -0.35 },
    ], {});
    A.add('chitin', xform(spur, { pos: [-6.2, -0.85, -0.6], rot: [0, 0.22, -0.24] }), { tone: 0.94 });
  }

  // -------------------------------------------------------- 9. attitude jets
  rcsPort(A, { pos: [1.9, 0.75, -6.4], normal: [0.5, 0.85, 0], size: 0.24, mirror: true });
  rcsPort(A, { pos: [6.6, -1.35, 1.2], normal: [0, -1, 0], size: 0.22, mirror: true });
  rcsPort(A, { pos: [2.4, 0.9, 2.6], normal: [0, 1, 0], size: 0.22, mirror: true });

  // Bio-lights instead of regulation nav lights — same job, alien grammar.
  A.navLight([-9.2, -2.6, 1.6], '#c8ff5a', 6, 0.2, [-1, -0.4, 0]);
  A.navLight([9.2, -2.6, 1.6], '#8fff9a', 6, 0.2, [1, -0.4, 0]);
  A.navLight([0, 1.9, 0.4], '#d8ff7a', 4, 0.16, [0, 1, 0]);
  A.navLight([0, 1.95, 8.6], '#d8ff7a', 4, 0.14, [0, 1, 0]);

  A.cockpit([0, 0.62, -5.4], new THREE.Quaternion());
  return A;
}
