/**
 * geometryKit — hard-surface geometry construction for the fleet.
 *
 * Everything the ship builders use is here. The rules that keep hulls looking
 * *manufactured* rather than "boxes glued together":
 *
 *   1. Nothing has a raw 90° edge. Every box is a `chamferedBox`, every profile
 *      corner is chamfered, so there is always a narrow facet for the key light
 *      to catch. This single rule does more for the read than any texture.
 *   2. Geometry is built by lofting closed profiles along a path. A fuselage is a
 *      stack of chamfered cross-sections that change shape as they run aft — that
 *      is how real airframes are drawn, and it gives silhouettes with character.
 *   3. Every vertex gets a normal and a UV. UVs are laid out in *world metres*
 *      (`texel` = tiles per metre) so hull texture density is identical on a 20 m
 *      fighter and a 900 m carrier. Panel lines line up across part boundaries.
 *   4. Creases are explicit. A profile point flagged `hard` splits its vertex so
 *      the two adjacent faces keep their own normals; unflagged points share a
 *      normal and shade smoothly. This is what lets the same lofting code produce
 *      a faceted Confed hull and a smooth alien carapace.
 *
 * Coordinate convention for every ship in this project: **-Z is forward**, +Y up,
 * +X starboard. That matches the camera convention, so an identity quaternion at
 * the cockpit hardpoint already looks where the pilot looks.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export { mergeGeometries };

const TAU = Math.PI * 2;
/** Default UV density: one texture tile per ~2.9 m of hull. */
export const TEXEL = 0.35;

// ---------------------------------------------------------------- 2D profiles
// A profile is an array of [x, y, hard]. `hard` splits the vertex so the faces
// either side of the point keep their own normals (a crease).

/** Chamfered rectangle — the workhorse cross-section. 8 points, all creased. */
export function rectProfile(w, h, c = Math.min(w, h) * 0.18) {
  const x = w / 2, y = h / 2;
  c = Math.min(c, x * 0.9, y * 0.9);
  return [
    [-x + c, -y, 1], [x - c, -y, 1],
    [x, -y + c, 1], [x, y - c, 1],
    [x - c, y, 1], [-x + c, y, 1],
    [-x, y - c, 1], [-x, -y + c, 1],
  ];
}

/**
 * Fighter fuselage cross-section: flat wide belly, chined sides, narrower flat
 * spine. Reads as an aerospace airframe rather than a tube.
 */
export function hullProfile(w, h, {
  topW = 0.55, botW = 0.75, chineLo = -0.15, chineHi = 0.35, c = 0.12,
} = {}) {
  const x = w / 2, y = h / 2;
  const cx = c * x, cy = c * y;
  return [
    [-botW * x + cx, -y, 1], [botW * x - cx, -y, 1],
    [x - cx * 0.4, chineLo * y - cy, 1],
    [x, chineLo * y + cy * 0.6, 1],
    [x, chineHi * y, 1],
    [topW * x + cx, y, 1],
    [-topW * x - cx, y, 1],
    [-x, chineHi * y, 1],
    [-x, chineLo * y + cy * 0.6, 1],
    [-x + cx * 0.4, chineLo * y - cy, 1],
  ];
}

/** Smooth ellipse — organic hulls, ducts, tubes. */
export function ellipseProfile(w, h, seg = 16, hard = 0) {
  const out = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * TAU;
    out.push([Math.cos(a) * w * 0.5, Math.sin(a) * h * 0.5, hard]);
  }
  return out;
}

/**
 * Teardrop — the alien design language's base section. Broad, soft dorsal curve
 * dropping to a keeled ventral point, so nothing about it reads as extruded box.
 */
export function teardropProfile(w, h, seg = 20, keel = 0.55) {
  const out = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * TAU;
    const s = Math.sin(a);
    // Squash the lower half toward a keel and swell the upper half.
    const ry = s >= 0 ? h * 0.5 : h * 0.5 * keel;
    const bulge = 1 + 0.18 * Math.max(0, s);
    out.push([Math.cos(a) * w * 0.5 * bulge, s * ry - h * 0.08, 0]);
  }
  // Sharpen the ventral keel into a crease.
  const k = Math.round(seg * 0.75) % seg;
  out[k][2] = 1;
  out[k][1] -= h * 0.10;
  return out;
}

/** Symmetric lifting-body/airfoil section for wings and stabilisers. */
export function airfoilProfile(chord, thick, seg = 12, camber = 0) {
  const out = [];
  const half = Math.max(2, Math.round(seg / 2));
  const t = (x) => thick * 0.5 * (1.4845 * Math.sqrt(x) - 0.63 * x - 1.758 * x * x + 1.4215 * x * x * x - 0.5075 * x * x * x * x) / 0.3;
  for (let i = 0; i <= half; i++) {
    const u = i / half;
    const x = u * u; // cluster toward the leading edge
    out.push([(x - 0.35) * chord, t(x) + camber * chord * x * (1 - x) * 2, i === 0 || i === half ? 1 : 0]);
  }
  for (let i = half - 1; i >= 1; i--) {
    const u = i / half;
    const x = u * u;
    out.push([(x - 0.35) * chord, -t(x) + camber * chord * x * (1 - x) * 2, 0]);
  }
  return out;
}

/** Signed area — used to normalise winding so normals always face outward. */
function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a * 0.5;
}

/** Nudge every point of a profile outward along its own normal (shell offset). */
export function offsetProfile(pts, d) {
  const n = pts.length;
  return pts.map((p, i) => {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    let nx = b[1] - a[1], ny = -(b[0] - a[0]);
    const l = Math.hypot(nx, ny) || 1;
    return [p[0] + (nx / l) * d, p[1] + (ny / l) * d, p[2]];
  });
}

export function scaleProfile(pts, sx, sy = sx) {
  return pts.map((p) => [p[0] * sx, p[1] * sy, p[2]]);
}

// ------------------------------------------------------------------- lofting

function sectionMatrix(s) {
  if (s.matrix) return s.matrix;
  const m = new THREE.Matrix4();
  m.makeRotationZ(s.rz || 0);
  if (s.ry) m.multiply(new THREE.Matrix4().makeRotationY(s.ry));
  if (s.rx) m.multiply(new THREE.Matrix4().makeRotationX(s.rx));
  m.scale(new THREE.Vector3(s.sx ?? 1, s.sy ?? 1, 1));
  m.setPosition(s.x || 0, s.y || 0, s.z || 0);
  return m;
}

/**
 * Loft a closed profile through a stack of sections.
 *
 * @param {Array} sections  [{ pts, z, x, y, sx, sy, rz, hard }] ordered along +Z.
 *   `pts` may vary per section but every section must have the same point count
 *   and the same `hard` flags — that is what lets a nose taper into a fuselage
 *   without retopologising. `hard: true` on a section creases the hull across it.
 * @returns {THREE.BufferGeometry} indexed, with position/normal/uv.
 */
export function loft(sections, { capStart = true, capEnd = true, texel = TEXEL, vScale = 1 } = {}) {
  // Duplicate creased rings — the degenerate span between them isolates normals.
  const S = [];
  for (const s of sections) {
    S.push(s);
    if (s.hard) S.push({ ...s, hard: false });
  }
  const base = S[0].pts;
  const N = base.length;
  const flip = signedArea(base) < 0;

  // Slot layout per ring: point 0 is always split so the UV seam can wrap.
  const hard = base.map((p, i) => (i === 0 ? 1 : (p[2] ? 1 : 0)));
  const outSlot = new Int32Array(N);
  const inSlot = new Int32Array(N);
  let k = 0;
  outSlot[0] = k++;
  for (let p = 1; p < N; p++) {
    if (hard[p]) inSlot[p] = k++;
    outSlot[p] = k++;
    if (!hard[p]) inSlot[p] = outSlot[p];
  }
  inSlot[0] = k++;
  const K = k;

  const rings = S.length;
  const pos = new Float32Array(rings * K * 3);
  const uv = new Float32Array(rings * K * 2);
  const v3 = new THREE.Vector3();

  // v runs along the loft; u runs around the profile — both in metres * texel.
  let vAccum = 0;
  const prevCentre = new THREE.Vector3();
  const centre = new THREE.Vector3();

  for (let r = 0; r < rings; r++) {
    const s = S[r];
    const m = sectionMatrix(s);
    const pts = s.pts;
    centre.set(0, 0, 0);
    for (const p of pts) centre.x += p[0], centre.y += p[1];
    centre.multiplyScalar(1 / pts.length);
    centre.z = 0;
    centre.applyMatrix4(m);
    if (r > 0) vAccum += prevCentre.distanceTo(centre);
    prevCentre.copy(centre);

    // Cumulative perimeter for u.
    const world = [];
    for (let p = 0; p < N; p++) {
      v3.set(pts[p][0], pts[p][1], 0).applyMatrix4(m);
      world.push(v3.clone());
    }
    const cum = new Float64Array(N + 1);
    for (let p = 0; p < N; p++) cum[p + 1] = cum[p] + world[p].distanceTo(world[(p + 1) % N]);

    const rb = r * K;
    for (let p = 0; p < N; p++) {
      const w = world[p];
      const write = (slot, uu) => {
        pos[(rb + slot) * 3] = w.x; pos[(rb + slot) * 3 + 1] = w.y; pos[(rb + slot) * 3 + 2] = w.z;
        uv[(rb + slot) * 2] = uu * texel;
        uv[(rb + slot) * 2 + 1] = vAccum * texel * vScale;
      };
      write(outSlot[p], cum[p]);
      if (inSlot[p] !== outSlot[p]) write(inSlot[p], cum[p]);
    }
    // Wrap vertex for point 0 carries the full perimeter so the seam is seamless.
    const w0 = world[0];
    pos[(rb + inSlot[0]) * 3] = w0.x; pos[(rb + inSlot[0]) * 3 + 1] = w0.y; pos[(rb + inSlot[0]) * 3 + 2] = w0.z;
    uv[(rb + inSlot[0]) * 2] = cum[N] * texel;
    uv[(rb + inSlot[0]) * 2 + 1] = vAccum * texel * vScale;
  }

  const idx = [];
  for (let r = 0; r < rings - 1; r++) {
    const a0 = r * K, b0 = (r + 1) * K;
    for (let e = 0; e < N; e++) {
      const e2 = (e + 1) % N;
      const a = a0 + outSlot[e], b = a0 + inSlot[e2];
      const c = b0 + inSlot[e2], d = b0 + outSlot[e];
      if (flip) idx.push(a, c, b, a, d, c);
      else idx.push(a, b, c, a, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  const caps = [];
  if (capStart) caps.push(capGeometry(S[0], false, flip, texel));
  if (capEnd) caps.push(capGeometry(S[S.length - 1], true, flip, texel));
  if (caps.length) return mergeGeometries([geo, ...caps]);
  return geo;
}

/** Flat fan cap for one end of a loft. Convex profiles only — which is all we use. */
function capGeometry(s, isEnd, flip, texel) {
  const m = sectionMatrix(s);
  const pts = s.pts;
  const N = pts.length;
  const pos = new Float32Array((N + 1) * 3);
  const uv = new Float32Array((N + 1) * 2);
  const v3 = new THREE.Vector3();
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  cx /= N; cy /= N;
  v3.set(cx, cy, 0).applyMatrix4(m);
  pos[0] = v3.x; pos[1] = v3.y; pos[2] = v3.z;
  uv[0] = cx * texel; uv[1] = cy * texel;
  for (let i = 0; i < N; i++) {
    v3.set(pts[i][0], pts[i][1], 0).applyMatrix4(m);
    pos[(i + 1) * 3] = v3.x; pos[(i + 1) * 3 + 1] = v3.y; pos[(i + 1) * 3 + 2] = v3.z;
    uv[(i + 1) * 2] = pts[i][0] * texel;
    uv[(i + 1) * 2 + 1] = pts[i][1] * texel;
  }
  const idx = [];
  const forward = isEnd !== flip;
  for (let i = 0; i < N; i++) {
    const a = 1 + i, b = 1 + ((i + 1) % N);
    if (forward) idx.push(0, a, b); else idx.push(0, b, a);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Sweep a profile along an arbitrary 3D path using parallel-transport frames, so
 * the section never barrel-rolls around a curve. Used for spars, ducts, cables,
 * alien ribs and the carrier's spine trusses.
 */
export function extrudeAlongPath(profile, path, {
  scale = null, twist = null, texel = TEXEL, capStart = true, capEnd = true, hardEvery = 0,
} = {}) {
  const pts = path.map((p) => (p.isVector3 ? p.clone() : new THREE.Vector3(p[0], p[1], p[2])));
  const n = pts.length;
  const tangents = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    tangents.push(b.clone().sub(a).normalize());
  }
  // Seed an up vector that is not parallel to the first tangent.
  let up = Math.abs(tangents[0].y) > 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  let normal = up.clone().cross(tangents[0]).normalize();
  const sections = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      // Parallel transport: rotate the frame by the tangent's own delta.
      const q = new THREE.Quaternion().setFromUnitVectors(tangents[i - 1], tangents[i]);
      normal.applyQuaternion(q).normalize();
    }
    const bin = tangents[i].clone().cross(normal).normalize();
    const m = new THREE.Matrix4().makeBasis(normal, bin, tangents[i]);
    if (twist) m.multiply(new THREE.Matrix4().makeRotationZ(twist(i / (n - 1))));
    const s = scale ? scale(i / (n - 1)) : 1;
    const sc = typeof s === 'number' ? [s, s] : s;
    m.multiply(new THREE.Matrix4().makeScale(sc[0], sc[1], 1));
    m.setPosition(pts[i]);
    sections.push({ pts: profile, matrix: m, hard: hardEvery > 0 && i > 0 && i < n - 1 && i % hardEvery === 0 });
  }
  return loft(sections, { capStart, capEnd, texel });
}

/**
 * Revolve a (radius, y) profile around +Y. `hard` on a profile point creases the
 * surface across it — that is how a nozzle lip stays a lip and not a fillet.
 */
export function revolve(profile, { segments = 24, arc = TAU, texel = TEXEL, closeSeam = true } = {}) {
  // Duplicate creased profile points; the degenerate ring isolates their normals.
  const P = [];
  for (const p of profile) {
    P.push(p);
    if (p[2]) P.push([p[0], p[1], 0]);
  }
  const R = P.length;
  const full = Math.abs(arc - TAU) < 1e-6;
  const cols = segments + 1;
  const pos = new Float32Array(cols * R * 3);
  const uv = new Float32Array(cols * R * 2);

  const arcLen = new Float64Array(R);
  for (let j = 1; j < R; j++) {
    arcLen[j] = arcLen[j - 1] + Math.hypot(P[j][0] - P[j - 1][0], P[j][1] - P[j - 1][1]);
  }
  let rMax = 0;
  for (const p of P) rMax = Math.max(rMax, Math.abs(p[0]));

  for (let i = 0; i < cols; i++) {
    const a = (i / segments) * arc;
    const ca = Math.cos(a), sa = Math.sin(a);
    for (let j = 0; j < R; j++) {
      const o = (i * R + j) * 3;
      pos[o] = P[j][0] * ca;
      pos[o + 1] = P[j][1];
      pos[o + 2] = P[j][0] * sa;
      uv[(i * R + j) * 2] = a * rMax * texel;
      uv[(i * R + j) * 2 + 1] = arcLen[j] * texel;
    }
  }
  const idx = [];
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < R - 1; j++) {
      const A = i * R + j, B = (i + 1) * R + j, C = (i + 1) * R + j + 1, D = i * R + j + 1;
      idx.push(A, C, B, A, D, C);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  // Average the duplicated seam column so a full revolve has no shading scar.
  if (full && closeSeam) {
    const nrm = geo.attributes.normal.array;
    for (let j = 0; j < R; j++) {
      const a = j * 3, b = (segments * R + j) * 3;
      const x = (nrm[a] + nrm[b]) * 0.5, y = (nrm[a + 1] + nrm[b + 1]) * 0.5, z = (nrm[a + 2] + nrm[b + 2]) * 0.5;
      const l = Math.hypot(x, y, z) || 1;
      nrm[a] = nrm[b] = x / l; nrm[a + 1] = nrm[b + 1] = y / l; nrm[a + 2] = nrm[b + 2] = z / l;
    }
    geo.attributes.normal.needsUpdate = true;
  }
  return geo;
}

// ------------------------------------------------------------------ primitives

/** The single most-used builder. A box whose every edge is bevelled. */
export function chamferedBox(w, h, d, c = Math.min(w, h, d) * 0.14, opts = {}) {
  c = Math.min(c, w * 0.45, h * 0.45, d * 0.45);
  const p = rectProfile(w, h, opts.profileChamfer ?? c * 1.2);
  const sx = (w - 2 * c) / w, sy = (h - 2 * c) / h;
  return loft([
    { pts: p, z: -d / 2, sx, sy },
    { pts: p, z: -d / 2 + c, hard: true },
    { pts: p, z: d / 2 - c, hard: true },
    { pts: p, z: d / 2, sx, sy },
  ], { texel: opts.texel ?? TEXEL });
}

/** Thin chamfered plate lying in XY — raised armour, access hatches, fins. */
export function plate(w, h, t = 0.08, c = 0.06, opts = {}) {
  return chamferedBox(w, h, t, Math.min(c, t * 0.45), opts);
}

/**
 * A recessed panel: a shallow chamfered pan you sit flush on a hull surface, so
 * the eye reads a real recess with a lit rim rather than a painted-on line.
 * Built facing +Z; its rim sits at z=0 and the floor at z=-depth.
 */
export function panelInset(w, h, depth = 0.12, bevel = 0.1, opts = {}) {
  const outer = rectProfile(w, h, bevel * 2.2);
  const lip = scaleProfile(outer, (w - bevel * 2) / w, (h - bevel * 2) / h);
  const floor = scaleProfile(outer, (w - bevel * 4) / w, (h - bevel * 4) / h);
  return loft([
    { pts: outer, z: 0 },
    { pts: lip, z: -bevel * 0.5, hard: true },
    { pts: floor, z: -depth },
  ], { capStart: false, capEnd: true, texel: opts.texel ?? TEXEL });
}

/**
 * Exhaust nozzle. Returns the metal shell (with a genuine interior you can see
 * down) and the emissive core that sits deep inside it. Exit faces +Z.
 */
export function nozzle(rOuter, len, {
  segments = 24, throat = 0.42, lip = 0.1, flare = 1.16, texel = TEXEL,
} = {}) {
  const rl = rOuter * flare;
  const rt = rOuter * throat;
  // (radius, axis) profile: outer skin out to the lip, over the rim, back down
  // the bell to the throat, then a short floor. Creases at the rim keep it sharp.
  const prof = [
    [rOuter * 0.86, 0, 1],
    [rOuter * 0.95, len * 0.30, 0],
    [rl, len, 1],
    [rl - lip * rOuter, len, 1],
    [rl * 0.80, len * 0.72, 0],
    [rt * 1.25, len * 0.30, 0],
    [rt, len * 0.14, 1],
    [rt * 0.55, len * 0.05, 1],
  ];
  const shell = revolve(prof, { segments, texel });
  shell.rotateX(Math.PI / 2);   // +Y axis -> +Z, exit faces +Z

  // Emissive core: a shallow cone sitting at the throat so it glows *inside*.
  const core = revolve([
    [0, 0, 1],
    [rt * 0.95, len * 0.10, 1],
    [rt * 1.15, len * 0.26, 0],
    [rl * 0.72, len * 0.60, 0],
  ], { segments, texel });
  core.rotateX(Math.PI / 2);
  return { shell, core, radius: rl };
}

/**
 * Intake with a lip of real thickness and a duct that goes somewhere dark.
 * Mouth faces -Z (forward). Returns { lip, duct }.
 */
export function intakeDuct(w, h, depth, {
  wall = 0.14, c = 0.1, taper = 0.7, texel = TEXEL,
} = {}) {
  const outer = rectProfile(w, h, c * 2);
  const inner = scaleProfile(outer, (w - wall * 2) / w, (h - wall * 2) / h);
  // The lip: outer skin rolls over the mouth edge and turns back inside.
  const lip = loft([
    { pts: outer, z: wall * 1.4 },
    { pts: outer, z: 0, hard: true },
    { pts: inner, z: -wall * 0.35, hard: true },
    { pts: inner, z: -wall * 1.2 },
  ], { capStart: false, capEnd: false, texel });
  // The duct interior — narrowing, unlit, reads as depth.
  const deep = scaleProfile(inner, taper, taper);
  const duct = loft([
    { pts: inner, z: -wall * 1.2 },
    { pts: deep, z: -depth },
  ], { capStart: false, capEnd: true, texel });
  invertShell(duct); // we look *into* the duct, so the shell faces inward
  return { lip, duct };
}

/** Round tube — spars, cables, gun barrels, antenna masts. Along +Z. */
export function tube(r, len, { segments = 12, rEnd = null, texel = TEXEL, caps = true } = {}) {
  const p = ellipseProfile(r * 2, r * 2, segments);
  const s = (rEnd ?? r) / r;
  return loft([
    { pts: p, z: 0 },
    { pts: p, z: len, sx: s, sy: s },
  ], { capStart: caps, capEnd: caps, texel });
}

/** Hemispherical sensor dome / turret ball. */
export function dome(r, { segments = 20, rows = 8, squash = 1, texel = TEXEL } = {}) {
  const prof = [];
  for (let i = 0; i <= rows; i++) {
    const a = (i / rows) * (Math.PI / 2);
    prof.push([Math.cos(a) * r, Math.sin(a) * r * squash, i === 0 ? 1 : 0]);
  }
  prof.unshift([r, -r * 0.06, 1]); // a short cylindrical collar so it seats
  return revolve(prof, { segments, texel });
}

/** Flat ring / collar — nozzle surrounds, hatch rims, alien orifices. */
export function ring(rInner, rOuter, thickness, { segments = 24, texel = TEXEL } = {}) {
  const t = thickness / 2;
  const g = revolve([
    [rInner, -t, 1], [rOuter, -t, 1], [rOuter, t, 1], [rInner, t, 1], [rInner, -t, 1],
  ], { segments, texel });
  g.rotateX(Math.PI / 2);
  return g;
}

/**
 * Wing / stabiliser: an airfoil lofted from root to tip with sweep, dihedral and
 * taper. Built in the ship frame — root at x=0, tip at x=+span, chord along Z.
 */
export function wing({
  span, rootChord, tipChord, rootThick, tipThick, sweep = 0, dihedral = 0,
  twist = 0, seg = 12, stations = 4, texel = TEXEL, tipRound = 0.55,
}) {
  const sections = [];
  for (let i = 0; i <= stations; i++) {
    const u = i / stations;
    const chord = rootChord + (tipChord - rootChord) * u;
    const thick = rootThick + (tipThick - rootThick) * u;
    // Round the last station in so the tip is a cap, not a slab.
    const shrink = i === stations ? tipRound : 1;
    const prof = airfoilProfile(chord * shrink, thick * shrink, seg);
    // Profile lives in XY, loft along +Z; rotate into the wing frame afterwards.
    sections.push({
      pts: prof, z: u * span,
      x: u * sweep, y: u * span * Math.tan(dihedral),
      rz: twist * u,
    });
  }
  const g = loft(sections, { texel });
  // The loft ran along +Z with the chord on X. Rotate so the chord lies along Z
  // (leading edge forward, at -Z) and then mirror so the span runs to starboard.
  g.rotateY(-Math.PI / 2);
  g.scale(-1, 1, 1);
  reverseWinding(g);
  return g;
}

// -------------------------------------------------------------- transforms

export function xform(geo, { pos, rot, quat, scale, mirror = false } = {}) {
  const m = new THREE.Matrix4();
  const q = quat ?? (rot ? new THREE.Quaternion().setFromEuler(rot.isEuler ? rot : new THREE.Euler(rot[0], rot[1], rot[2])) : new THREE.Quaternion());
  const s = scale == null ? new THREE.Vector3(1, 1, 1)
    : (typeof scale === 'number' ? new THREE.Vector3(scale, scale, scale) : (scale.isVector3 ? scale : new THREE.Vector3(scale[0], scale[1], scale[2])));
  const p = pos == null ? new THREE.Vector3() : (pos.isVector3 ? pos : new THREE.Vector3(pos[0], pos[1], pos[2]));
  if (mirror) s.x = -s.x;
  m.compose(p, q, s);
  const g = geo.clone();
  g.applyMatrix4(m);
  if (mirror) reverseWinding(g);
  return g;
}

/** Mirror across X and fix the winding — bilateral parts are built once. */
export function mirrorX(geo) {
  const g = geo.clone();
  g.scale(-1, 1, 1);
  reverseWinding(g);
  return g;
}

/**
 * Reverse triangle orientation without touching normals. This is the correct fix
 * after a mirroring transform — `applyMatrix4` already flipped the normals via the
 * normal matrix, only the winding is left inside-out.
 */
export function reverseWinding(geo) {
  const idx = geo.getIndex();
  if (idx) {
    const a = idx.array;
    for (let i = 0; i < a.length; i += 3) { const t = a[i]; a[i] = a[i + 2]; a[i + 2] = t; }
    idx.needsUpdate = true;
  } else {
    const p = geo.attributes.position.array;
    const swap = (arr, itemSize) => {
      for (let i = 0; i < arr.length; i += itemSize * 3) {
        for (let k = 0; k < itemSize; k++) {
          const t = arr[i + k]; arr[i + k] = arr[i + itemSize * 2 + k]; arr[i + itemSize * 2 + k] = t;
        }
      }
    };
    swap(p, 3);
    if (geo.attributes.normal) swap(geo.attributes.normal.array, 3);
    if (geo.attributes.uv) swap(geo.attributes.uv.array, 2);
  }
  return geo;
}

/**
 * Turn a shell inside-out: reverse the winding *and* flip the normals, so an
 * open loft becomes a surface you look into. Duct throats, hangar bays, gear
 * wells — anywhere the camera needs to see the far wall of a recess.
 */
export function invertShell(geo) {
  reverseWinding(geo);
  const n = geo.attributes.normal;
  if (n) { const a = n.array; for (let i = 0; i < a.length; i++) a[i] = -a[i]; n.needsUpdate = true; }
  return geo;
}

/** Attach a flat vertex colour. Per-part tone jitter is what breaks up "one grey". */
export function tint(geo, r, g, b) {
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b; }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

/**
 * Darken vertices that sit low in the part's own bounding box — a one-line
 * cavity approximation that stops recessed geometry reading as flat.
 */
export function shadeCavity(geo, amount = 0.25, axis = 'y') {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const lo = bb.min[axis], hi = bb.max[axis];
  const span = Math.max(1e-4, hi - lo);
  const pos = geo.attributes.position.array;
  let col = geo.attributes.color;
  if (!col) { tint(geo, 1, 1, 1); col = geo.attributes.color; }
  const c = col.array;
  const off = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  for (let i = 0; i < col.count; i++) {
    const t = (pos[i * 3 + off] - lo) / span;
    const f = 1 - amount * (1 - t);
    c[i * 3] *= f; c[i * 3 + 1] *= f; c[i * 3 + 2] *= f;
  }
  col.needsUpdate = true;
  return geo;
}

/** Push vertices along their normals by a noise function — organic asymmetry. */
export function displace(geo, fn) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const p = pos.array, n = nrm.array;
  for (let i = 0; i < pos.count; i++) {
    const d = fn(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
    p[i * 3] += n[i * 3] * d;
    p[i * 3 + 1] += n[i * 3 + 1] * d;
    p[i * 3 + 2] += n[i * 3 + 2] * d;
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Triangle count of a geometry, indexed or not. */
export function triCount(geo) {
  return (geo.getIndex() ? geo.getIndex().count : geo.attributes.position.count) / 3;
}

/** Copy `uv` into `uv1` so aoMap-on-channel-1 materials do not render black. */
export function ensureUV1(geo) {
  if (geo.attributes.uv && !geo.attributes.uv1) {
    geo.setAttribute('uv1', geo.attributes.uv.clone());
  }
  return geo;
}

// ---------------------------------------------------------------- greebles

/**
 * Fallback greeble set — only used when `procgen/greebles.js` has not landed.
 * Deliberately small: eight machined shapes that read as pumps, vents, conduit
 * boxes and hatches at 50 m and dissolve into surface noise at 500 m.
 */
export function fallbackGreebleSet(rng) {
  const out = [];
  const push = (g) => { g.computeBoundingBox(); out.push(g); };
  for (let i = 0; i < 8; i++) {
    const w = rng.range(0.22, 0.75), h = rng.range(0.1, 0.36), d = rng.range(0.22, 0.9);
    const kind = i % 4;
    if (kind === 0) {
      push(chamferedBox(w, h, d, Math.min(w, h, d) * 0.22));
    } else if (kind === 1) {
      // Stacked block with a raised cap — reads as an avionics box.
      const a = chamferedBox(w, h, d, h * 0.22);
      const b = xform(chamferedBox(w * 0.55, h * 0.7, d * 0.6, h * 0.16), { pos: [0, h * 0.72, 0] });
      push(mergeGeometries([a, b]));
    } else if (kind === 2) {
      // Ribbed conduit run.
      const parts = [chamferedBox(w * 0.5, h * 0.5, d, h * 0.12)];
      const ribs = 3 + (i % 3);
      for (let k = 0; k < ribs; k++) {
        parts.push(xform(chamferedBox(w * 0.8, h * 0.85, d * 0.09, h * 0.1),
          { pos: [0, 0, -d / 2 + (d * (k + 0.5)) / ribs] }));
      }
      push(mergeGeometries(parts));
    } else {
      // Capped cylinder — pump, tank, thruster pod.
      const t = tube(h * 0.6, d, { segments: 8 });
      t.rotateY(Math.PI / 2);
      const cap = xform(ring(h * 0.4, h * 0.72, h * 0.22, { segments: 8 }), { pos: [d * 0.3, 0, 0], rot: [0, Math.PI / 2, 0] });
      push(mergeGeometries([xform(t, { pos: [-d / 2, 0, 0] }), cap]));
    }
  }
  return out;
}

/**
 * Scatter greebles over a set of placement frames and merge them into a single
 * buffer. One draw call, no per-object overhead, and it vanishes wholesale at
 * LOD1 which is exactly the collapse behaviour the budget wants.
 */
export function scatterGreebles(set, placements) {
  if (!set?.length || !placements.length) return null;
  const parts = [];
  for (const pl of placements) {
    const g = set[pl.index % set.length];
    parts.push(xform(g, { pos: pl.pos, quat: pl.quat, rot: pl.rot, scale: pl.scale }));
  }
  return mergeGeometries(parts);
}

/**
 * Lay greebles along a line (an engine spine, a hull seam) with jittered scale
 * and orientation so the run never reads as a repeated stamp.
 */
export function greebleRun(set, rng, {
  from, to, count, normal = [0, 1, 0], scale = 1, jitter = 0.25, sink = 0.02,
}) {
  const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
  const n = new THREE.Vector3(...normal).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const p = a.clone().lerp(b, t);
    p.addScaledVector(n, -sink);
    const perp = new THREE.Vector3(0, 0, 1).cross(n);
    if (perp.lengthSq() < 1e-4) perp.set(1, 0, 0);
    perp.normalize().multiplyScalar(rng.gauss(0, jitter));
    p.add(perp);
    const qq = q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, TAU)));
    out.push({ index: rng.int(0, 999), pos: p, quat: qq, scale: scale * rng.range(0.7, 1.35) });
  }
  return out;
}
