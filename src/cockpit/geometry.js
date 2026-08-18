/**
 * Cockpit geometry — the physical tub the pilot sits in.
 *
 * Everything here is real 3D with depth: an extruded, bevelled instrument panel,
 * a lofted glareshield hood, canted side consoles, a swept canopy bow that
 * genuinely occludes the world, and sixteen toggle switches with metal levers.
 *
 * ## Frames of reference
 * Cockpit space is metres with the origin at the pilot's eye, **-Z forward**,
 * +Y up, +X starboard — see layout.js. Panel space is the plane of the main
 * instrument panel; `panelMatrix()` maps one into the other and is the *only*
 * place that transform is written down.
 *
 * ## Why one merged mesh
 * The whole static tub shares the 2048² atlas from atlas.js, so every piece is
 * built with UVs already mapped into its atlas region and then merged into a
 * single BufferGeometry. The result is one draw call for the entire interior.
 * Animated parts (stick, throttle) and shader-driven parts (glass, MFD screens,
 * radar) stay separate because they cannot share that material.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng } from '../core/Rand.js';
import {
  PANEL, MFD, RADAR, STACK, SWITCHES, KNOBS, COAMING, CONSOLE, THROTTLE, STICK, CANOPY,
} from './layout.js';
import { uvRect } from './atlas.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ss = (a, b, t) => { const x = clamp01((t - a) / (b - a)); return x * x * (3 - 2 * x); };

// ---------------------------------------------------------------------------
// UV plumbing
// ---------------------------------------------------------------------------

/**
 * Squeeze a geometry's [0,1] UVs into one atlas region.
 * `inset` keeps bilinear taps off the neighbouring region at low mip levels.
 */
export function toRegion(geo, name, { inset = 0.004, uRange = [0, 1], vRange = [0, 1] } = {}) {
  const r = uvRect(name);
  const du = (r.u1 - r.u0);
  const dv = (r.v1 - r.v0);
  const u0 = r.u0 + du * inset;
  const v0 = r.v0 + dv * inset;
  const su = du * (1 - inset * 2);
  const sv = dv * (1 - inset * 2);
  const uv = geo.getAttribute('uv');
  const [ua, ub] = uRange;
  const [va, vb] = vRange;
  for (let i = 0; i < uv.count; i++) {
    const u = ua + clamp01(uv.getX(i)) * (ub - ua);
    const v = va + clamp01(uv.getY(i)) * (vb - va);
    uv.setXY(i, u0 + u * su, v0 + v * sv);
  }
  uv.needsUpdate = true;
  return geo;
}

/**
 * Planar-map an extruded solid: faces whose normal points along ±Z take the
 * front region with true panel-space UVs, everything else (walls, bevels) takes
 * a quieter region so the paint reads as the same box, folded.
 */
function planarUV(geo, { front, side, w, h, cx = 0, cy = 0, sideScale = 2.4 }) {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const uv = new Float32Array(pos.count * 2);
  const fr = uvRect(front);
  const sr = uvRect(side);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nz = Math.abs(nrm.getZ(i));
    let u;
    let v;
    if (nz >= 0.55) {
      u = fr.u0 + clamp01((x - cx) / w + 0.5) * (fr.u1 - fr.u0);
      v = fr.v0 + clamp01((y - cy) / h + 0.5) * (fr.v1 - fr.v0);
    } else {
      // Walls get a narrow slice of the grey region; they are 5 cm strips seen
      // almost edge-on, so all they must do is not read as untextured plastic.
      u = sr.u0 + clamp01(0.5 + (x * 0.6 + y * 0.4) * sideScale * 0.35) * (sr.u1 - sr.u0);
      v = sr.v0 + clamp01(0.5 + z * sideScale) * (sr.v1 - sr.v0);
    }
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.clearGroups();
  return geo;
}

/**
 * Put a geometry into the one shape `mergeGeometries` accepts: position/normal/uv
 * only, no groups, no morphs, and **non-indexed**.
 *
 * The last part is not optional. ExtrudeGeometry comes back non-indexed while
 * TubeGeometry, the primitives and the lofts come back indexed, and merging a
 * mixture returns `null` rather than throwing — which surfaces four calls later
 * as an unrelated TypeError. Flattening everything here makes the mixture legal
 * and costs a few thousand duplicated vertices on a mesh drawn once.
 */
function normalize(geo) {
  let g = geo;
  for (const k of Object.keys(g.attributes)) {
    if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
  }
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  g.clearGroups();
  g.morphAttributes = {};
  if (g.index) {
    const flat = g.toNonIndexed();
    g.dispose();
    g = flat;
    g.clearGroups();
  }
  return g;
}

/** `mergeGeometries` returns null on a mismatch; make that fail loudly, here. */
function merge(parts, where) {
  const out = mergeGeometries(parts.map(normalize), false);
  if (!out) throw new Error(`cockpit/geometry: merge failed in ${where}`);
  return out;
}

// ---------------------------------------------------------------------------
// primitive builders
// ---------------------------------------------------------------------------

/** Rounded rectangle centred on the origin, in the XY plane. */
function roundedRect(w, h, r) {
  const s = new THREE.Shape();
  const x = w / 2;
  const y = h / 2;
  const k = Math.min(r, x * 0.95, y * 0.95);
  s.moveTo(-x + k, -y);
  s.lineTo(x - k, -y);
  s.quadraticCurveTo(x, -y, x, -y + k);
  s.lineTo(x, y - k);
  s.quadraticCurveTo(x, y, x - k, y);
  s.lineTo(-x + k, y);
  s.quadraticCurveTo(-x, y, -x, y - k);
  s.lineTo(-x, -y + k);
  s.quadraticCurveTo(-x, -y, -x + k, -y);
  return s;
}

function roundedHole(w, h, r) {
  const p = new THREE.Path();
  const x = w / 2;
  const y = h / 2;
  const k = Math.min(r, x * 0.95, y * 0.95);
  // Holes must wind opposite the outline.
  p.moveTo(-x + k, -y);
  p.quadraticCurveTo(-x, -y, -x, -y + k);
  p.lineTo(-x, y - k);
  p.quadraticCurveTo(-x, y, -x + k, y);
  p.lineTo(x - k, y);
  p.quadraticCurveTo(x, y, x, y - k);
  p.lineTo(x, -y + k);
  p.quadraticCurveTo(x, -y, x - k, -y);
  p.closePath();
  return p;
}

/**
 * Extrude a shape with a real bevel and drop the front face onto z = 0 so the
 * caller positions the *visible* surface rather than an arbitrary origin.
 */
function slab(shape, { depth = 0.05, bevel = 0.008, bevelSize = 0.010, segments = 2, curve = 5 } = {}) {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize,
    bevelOffset: 0,
    bevelSegments: segments,
    curveSegments: curve,
    steps: 1,
  });
  geo.computeBoundingBox();
  geo.translate(0, 0, -geo.boundingBox.max.z);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Loft a grid of rows into an indexed surface. `rows[i][j]` is a Vector3;
 * i runs along v, j along u.
 */
function loft(rows, { closeU = false, flip = false, vStops = null } = {}) {
  const nR = rows.length;
  const nC = rows[0].length;
  const cols = closeU ? nC : nC;
  const pos = new Float32Array(nR * nC * 3);
  const uv = new Float32Array(nR * nC * 2);
  for (let i = 0; i < nR; i++) {
    for (let j = 0; j < nC; j++) {
      const p = rows[i][j];
      const o = (i * nC + j) * 3;
      pos[o] = p.x; pos[o + 1] = p.y; pos[o + 2] = p.z;
      const q = (i * nC + j) * 2;
      uv[q] = j / (nC - 1);
      uv[q + 1] = vStops ? vStops[i] : i / (nR - 1);
    }
  }
  const idx = [];
  const wrap = closeU ? nC : nC - 1;
  for (let i = 0; i < nR - 1; i++) {
    for (let j = 0; j < wrap; j++) {
      const a = i * nC + j;
      const b = i * nC + ((j + 1) % nC);
      const c = (i + 1) * nC + j;
      const d = (i + 1) * nC + ((j + 1) % nC);
      if (flip) idx.push(a, b, c, b, d, c);
      else idx.push(a, c, b, b, c, d);
    }
  }
  void cols;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** A swept tube along a polyline, for canopy bows and rails. */
function sweep(points, radius, { radial = 8, region = 'frame', tubular = null } = {}) {
  const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.4);
  const geo = new THREE.TubeGeometry(curve, tubular ?? Math.max(8, points.length * 3), radius, radial, false);
  return toRegion(normalize(geo), region);
}

// ---------------------------------------------------------------------------
// panel space
// ---------------------------------------------------------------------------

/** Panel space -> cockpit space. */
export function panelMatrix() {
  const m = new THREE.Matrix4();
  m.makeRotationX(PANEL.tilt);
  m.setPosition(PANEL.position[0], PANEL.position[1], PANEL.position[2]);
  return m;
}

/** A point in panel space (x, y, out-of-face z) resolved into cockpit space. */
export function panelPoint(x, y, z = 0, out = new THREE.Vector3()) {
  return out.set(x, y, z).applyMatrix4(panelMatrix());
}

/** Unit normal of the panel face, pointing at the pilot. */
export function panelNormal(out = new THREE.Vector3()) {
  return out.set(0, 0, 1).applyMatrix4(new THREE.Matrix4().makeRotationX(PANEL.tilt)).normalize();
}

// ---------------------------------------------------------------------------
// the pieces
// ---------------------------------------------------------------------------

function buildPanel() {
  const geo = slab(roundedRect(PANEL.w, PANEL.h, 0.030), {
    depth: PANEL.thickness, bevel: 0.010, bevelSize: 0.012, segments: 2, curve: 5,
  });
  planarUV(geo, { front: 'main', side: 'grey', w: PANEL.w, h: PANEL.h });
  geo.applyMatrix4(panelMatrix());
  return normalize(geo);
}

/** Raised centre stack — carries the radar well and the annunciators. */
function buildStack() {
  const w = STACK.halfWidth * 2;
  const h = PANEL.h - 0.050;
  const geo = slab(roundedRect(w, h, 0.018), { depth: 0.030, bevel: 0.006, bevelSize: 0.007, segments: 2, curve: 4 });
  planarUV(geo, {
    front: 'main', side: 'trim', w: PANEL.w, h: PANEL.h,
  });
  const m = panelMatrix().multiply(new THREE.Matrix4().makeTranslation(0, 0, 0.012));
  geo.applyMatrix4(m);
  return normalize(geo);
}

/** MFD bezel: a proud frame with a bevelled inner lip. */
function buildMfdBezel(cx) {
  const outer = roundedRect(MFD.size + MFD.bezel * 2, MFD.size + MFD.bezel * 2, 0.020);
  outer.holes.push(roundedHole(MFD.size - 0.004, MFD.size - 0.004, 0.012));
  const geo = slab(outer, { depth: MFD.relief + 0.010, bevel: 0.005, bevelSize: 0.006, segments: 2, curve: 4 });
  planarUV(geo, { front: 'plate', side: 'trim', w: MFD.size + MFD.bezel * 2, h: MFD.size + MFD.bezel * 2 });
  const m = panelMatrix().multiply(new THREE.Matrix4().makeTranslation(cx, MFD.y, MFD.relief));
  geo.applyMatrix4(m);
  return normalize(geo);
}

/** Machined ring around the radar well. */
function buildRadarBezel() {
  const outer = new THREE.Shape();
  outer.absarc(0, 0, RADAR.r + RADAR.bezel, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, RADAR.r, 0, Math.PI * 2, true);
  outer.holes.push(hole);
  const geo = slab(outer, { depth: RADAR.relief + 0.008, bevel: 0.004, bevelSize: 0.005, segments: 2, curve: 24 });
  planarUV(geo, { front: 'trim', side: 'trim', w: (RADAR.r + RADAR.bezel) * 2, h: (RADAR.r + RADAR.bezel) * 2 });
  const m = panelMatrix().multiply(new THREE.Matrix4().makeTranslation(RADAR.x, RADAR.y, RADAR.relief + 0.012));
  geo.applyMatrix4(m);
  return normalize(geo);
}

/** Glareshield hood: a lofted solid with rising, splayed outboard corners. */
function buildCoaming() {
  const N = 41;
  const rows = [];
  const section = (u) => {
    const rise = COAMING.cornerRise * ss(0.45, 1, Math.abs(u));
    const splay = COAMING.cornerSplay * ss(0.4, 1, Math.abs(u)) * Math.sign(u || 1);
    const x = u * COAMING.halfWidth + splay;
    const top = COAMING.nearY + rise;
    const frontTop = COAMING.farY + rise * 0.82;
    return [
      new THREE.Vector3(x, top, COAMING.nearZ),
      new THREE.Vector3(x, frontTop, COAMING.farZ),
      new THREE.Vector3(x, frontTop - COAMING.lipDrop, COAMING.farZ + 0.014),
      new THREE.Vector3(x * 0.995, top - COAMING.thickness, COAMING.nearZ + 0.008),
    ];
  };
  // rows = profile stations, cols = across the width.
  for (let p = 0; p < 4; p++) {
    const row = [];
    for (let j = 0; j < N; j++) row.push(section((j / (N - 1)) * 2 - 1)[p]);
    rows.push(row);
  }
  rows.push(rows[0].map((v) => v.clone()));  // close the loop
  // The deck (station 0 -> 1) is the only face the pilot sees, so it gets 70 %
  // of the region's height; the front lip and underside share the rest.
  const geo = loft(rows, { flip: true, vStops: [0, 0.70, 0.85, 0.97, 1] });
  toRegion(geo, 'coaming');

  // End caps so the hood is a solid, not a shell.
  const caps = [];
  for (const j of [0, N - 1]) {
    const quad = new THREE.BufferGeometry();
    const p = rows.slice(0, 4).map((r) => r[j]);
    const v = new Float32Array([
      p[0].x, p[0].y, p[0].z, p[1].x, p[1].y, p[1].z, p[2].x, p[2].y, p[2].z,
      p[0].x, p[0].y, p[0].z, p[2].x, p[2].y, p[2].z, p[3].x, p[3].y, p[3].z,
    ]);
    quad.setAttribute('position', new THREE.BufferAttribute(v, 3));
    quad.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]), 2));
    quad.computeVertexNormals();
    caps.push(toRegion(quad, 'grey'));
  }
  return merge([geo, ...caps], 'coaming');
}

/** Side console deck, canted outboard, with a raised switch plate. */
function buildConsole(sign) {
  const len = CONSOLE.backZ - CONSOLE.frontZ;
  const width = CONSOLE.outerX - CONSOLE.innerX;
  const shape = roundedRect(width, len, 0.030);
  const geo = slab(shape, { depth: CONSOLE.drop, bevel: 0.010, bevelSize: 0.012, segments: 2, curve: 4 });
  planarUV(geo, { front: 'console', side: 'grey', w: width, h: len, sideScale: 1.4 });
  // The slab is built face-up in XY; lay it flat, cant it outboard, and slide it
  // out to the cockpit wall.
  const m = new THREE.Matrix4();
  m.makeRotationX(-Math.PI / 2);
  const cant = new THREE.Matrix4().makeRotationZ(-CONSOLE.cant * sign);
  const place = new THREE.Matrix4().makeTranslation(
    sign * (CONSOLE.innerX + width / 2),
    CONSOLE.topY - Math.sin(CONSOLE.cant) * width * 0.5,
    (CONSOLE.frontZ + CONSOLE.backZ) / 2,
  );
  geo.applyMatrix4(m);
  geo.applyMatrix4(cant);
  geo.applyMatrix4(place);
  // Mirror the starboard console's UVs into the other half of the region so the
  // two decks do not read as a copy-paste.
  const uv = geo.getAttribute('uv');
  if (sign > 0) {
    const r = uvRect('console');
    for (let i = 0; i < uv.count; i++) uv.setX(i, r.u0 + r.u1 - uv.getX(i));
    uv.needsUpdate = true;
  }
  return normalize(geo);
}

/** Cheek walls closing the gap between the consoles and the panel. */
function buildCheek(sign) {
  const rows = [];
  const zs = [CONSOLE.frontZ, -0.62, -0.40, CONSOLE.backZ];
  const tops = [-0.075, -0.145, -0.205, -0.250];
  for (let i = 0; i < 2; i++) {
    const row = [];
    for (let j = 0; j < zs.length; j++) {
      const t = i === 0 ? tops[j] : CONSOLE.topY - 0.02;
      const x = sign * (CONSOLE.innerX + (i === 0 ? 0.035 : 0.010));
      row.push(new THREE.Vector3(x, t, zs[j]));
    }
    rows.push(row);
  }
  const geo = loft(rows, { flip: sign < 0 });
  return normalize(toRegion(geo, 'grey'));
}

/** Sixteen toggles: a pocket ring, a metal bat lever, and a nylon boot. */
function buildSwitches(rng) {
  const parts = [];
  const spots = [];
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < SWITCHES.rows; i++) {
      spots.push([(c === 0 ? -1 : 1) * SWITCHES.colX, SWITCHES.topY - i * SWITCHES.pitch]);
    }
  }
  void STACK;

  const M = panelMatrix();
  for (const [x, y] of spots) {
    const up = rng.bool(0.45);
    const tilt = up ? -0.42 : 0.42;
    const boot = new THREE.CylinderGeometry(0.0075, 0.0105, 0.008, 10, 1, false);
    boot.translate(0, 0.004, 0);
    toRegion(boot, 'detail', { uRange: [0.05, 0.3], vRange: [0.55, 0.9] });

    const lever = new THREE.CylinderGeometry(0.0022, 0.0034, 0.020, 7, 1, false);
    lever.translate(0, 0.010, 0);
    const tip = new THREE.SphereGeometry(0.0036, 8, 6);
    tip.translate(0, 0.020, 0);
    const bat = merge([lever, tip], 'switch-bat');
    bat.rotateX(tilt);
    bat.translate(0, 0.007, 0);
    toRegion(bat, 'trim', { uRange: [0.2, 0.45], vRange: [0.3, 0.6] });

    const one = merge([boot, bat], 'switch');
    // Panel space has the switch axis along +Z (out of the face); the parts were
    // built along +Y.
    one.rotateX(Math.PI / 2);
    one.translate(x, y, 0.004);
    one.applyMatrix4(M);
    parts.push(normalize(one));
  }

  // Two guarded covers over the arming switches — the shape reads instantly.
  for (const x of [-0.150, 0.150]) {
    const g = new THREE.BoxGeometry(0.030, 0.014, 0.026);
    g.translate(0, 0.009, 0);
    g.rotateX(-0.5);
    toRegion(g, 'trim', { uRange: [0.5, 0.8], vRange: [0.1, 0.4] });
    g.rotateX(Math.PI / 2);
    g.translate(x, -0.118, 0.006);
    g.applyMatrix4(M);
    parts.push(normalize(g));
  }
  return merge(parts, 'switches');
}

/** Rotary knobs on the outboard strips: contrast, brightness, gain, volume. */
function buildKnobs(rng) {
  const parts = [];
  const M = panelMatrix();
  for (const sx of [-1, 1]) {
    for (let i = 0; i < KNOBS.ys.length; i++) {
      const body = new THREE.CylinderGeometry(KNOBS.r * 0.80, KNOBS.r * 0.90, 0.020, 14, 1, false);
      body.translate(0, 0.010, 0);
      const skirt = new THREE.CylinderGeometry(KNOBS.r, KNOBS.r, 0.005, 16, 1, false);
      skirt.translate(0, 0.0025, 0);
      const mark = new THREE.BoxGeometry(0.0026, 0.021, KNOBS.r * 0.75);
      mark.translate(0, 0.011, KNOBS.r * 0.42);
      const k = merge([body, skirt, mark], 'knob');
      toRegion(k, 'detail', { uRange: [0.55, 0.95], vRange: [0.1, 0.5] });
      k.rotateY(rng.range(-0.9, 0.9));
      k.rotateX(Math.PI / 2);
      k.translate(sx * KNOBS.x, KNOBS.ys[i], 0.002);
      k.applyMatrix4(M);
      parts.push(normalize(k));
    }
  }
  return merge(parts, 'knobs');
}

// ---------------------------------------------------------------------------
// canopy
// ---------------------------------------------------------------------------

/** Parametric point on the canopy bow. `t` in [-1, 1] across the arch. */
export function bowPoint(t, out = new THREE.Vector3()) {
  const th = t * CANOPY.sweep;
  const k = Math.pow(Math.abs(t), 1.5);
  return out.set(
    CANOPY.a * Math.sin(th),
    CANOPY.centreY + CANOPY.b * Math.cos(th),
    CANOPY.apexZ + (CANOPY.sillZ - CANOPY.apexZ) * k,
  );
}

/** Where the windscreen dies into the nose deck — below the coaming, unseen. */
function noseRing(t, out = new THREE.Vector3()) {
  const th = t * CANOPY.sweep;
  return out.set(
    CANOPY.a * 0.60 * Math.sin(th),
    CANOPY.centreY - 0.315 + CANOPY.b * 0.36 * Math.cos(th),
    -1.66,
  );
}

/** Windscreen transparency, lofted from the bow forward to the nose ring. */
export function buildCanopyGlass() {
  const NU = 33;
  const NV = 9;
  const rows = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (let i = 0; i < NV; i++) {
    const s = i / (NV - 1);
    const row = [];
    for (let j = 0; j < NU; j++) {
      const t = (j / (NU - 1)) * 2 - 1;
      bowPoint(t, a);
      noseRing(t, b);
      // Bulge the middle of the sweep so the glass is a curved shell, not a cone.
      const bulge = Math.sin(s * Math.PI) * 0.055 * (1 - Math.abs(t) * 0.45);
      row.push(new THREE.Vector3(
        a.x + (b.x - a.x) * s,
        a.y + (b.y - a.y) * s + bulge * 0.35,
        a.z + (b.z - a.z) * s - bulge,
      ));
    }
    rows.push(row);
  }
  const geo = loft(rows, { flip: true });
  return normalize(geo);
}

/** Bow, windscreen side rails, aft sills and two ribs. */
function buildCanopyFrame() {
  const parts = [];
  const bow = [];
  for (let i = 0; i <= 26; i++) bow.push(bowPoint((i / 26) * 2 - 1));
  parts.push(sweep(bow, CANOPY.tubeRadius, { radial: 9, tubular: 60 }));

  // Windscreen edge rails: they trace the visible lower edge of the glass.
  for (const s of [-1, 1]) {
    const pts = [];
    for (let i = 0; i <= 6; i++) {
      const u = i / 6;
      const A = bowPoint(s);
      const B = noseRing(s);
      const bulge = Math.sin(u * Math.PI) * 0.030;
      pts.push(new THREE.Vector3(
        A.x + (B.x - A.x) * u,
        A.y + (B.y - A.y) * u + bulge * 0.3,
        A.z + (B.z - A.z) * u - bulge,
      ));
    }
    parts.push(sweep(pts, CANOPY.tubeRadius * 0.82, { radial: 8, tubular: 22 }));
  }

  // Aft sill rails running back past the pilot's shoulders.
  for (const s of [-1, 1]) {
    const A = bowPoint(s);
    parts.push(sweep([
      A.clone(),
      new THREE.Vector3(A.x * 1.005, A.y - 0.020, -0.45),
      new THREE.Vector3(A.x * 0.97, A.y - 0.055, 0.10),
      new THREE.Vector3(A.x * 0.90, A.y - 0.090, CANOPY.railBackZ),
    ], CANOPY.tubeRadius * 0.9, { radial: 8, tubular: 24 }));
  }

  // Structural ribs tying the bow to the sills — fasteners come from the atlas.
  for (const s of [-1, 1]) {
    const A = bowPoint(s * 0.72);
    parts.push(sweep([
      A.clone(),
      new THREE.Vector3(A.x * 1.02, A.y - 0.16, A.z + 0.10),
      new THREE.Vector3(A.x * 1.03, A.y - 0.30, A.z + 0.24),
    ], CANOPY.tubeRadius * 0.55, { radial: 6, tubular: 10 }));
  }
  return merge(parts, 'canopy-frame');
}

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

/** Side-stick: a moulded grip on a boot, pivoting at STICK.pivot. */
export function buildStick() {
  const parts = [];
  const shaft = new THREE.CylinderGeometry(0.017, 0.021, STICK.length * 0.62, 12, 1, false);
  shaft.translate(0, STICK.length * 0.31, 0);
  const grip = new THREE.CylinderGeometry(0.026, 0.023, STICK.length * 0.46, 14, 1, false);
  grip.translate(0, STICK.length * 0.72, 0);
  const head = new THREE.SphereGeometry(0.026, 14, 10);
  head.scale(1, 0.8, 1.05);
  head.translate(0, STICK.length * 0.95, 0);
  const merged = merge([shaft, grip, head], 'stick-grip');
  toRegion(merged, 'detail', { uRange: [0.02, 0.55], vRange: [0.05, 0.95] });
  parts.push(normalize(merged));

  const boot = new THREE.CylinderGeometry(0.040, 0.058, 0.038, 14, 1, false);
  boot.translate(0, 0.019, 0);
  toRegion(boot, 'grey', { uRange: [0.1, 0.6], vRange: [0.1, 0.5] });
  parts.push(normalize(boot));

  // Trigger and the thumb hat — the details that say "this is a fighter stick".
  const trig = new THREE.BoxGeometry(0.011, 0.028, 0.010);
  trig.translate(0, STICK.length * 0.70, 0.026);
  toRegion(trig, 'trim', { uRange: [0.6, 0.8], vRange: [0.6, 0.8] });
  parts.push(normalize(trig));
  const hat = new THREE.CylinderGeometry(0.010, 0.010, 0.008, 8, 1, false);
  hat.rotateX(0.5);
  hat.translate(0.0, STICK.length * 0.98, 0.016);
  toRegion(hat, 'trim', { uRange: [0.3, 0.5], vRange: [0.6, 0.8] });
  parts.push(normalize(hat));

  return merge(parts, 'stick');
}

/** Throttle quadrant: a slotted deck plate and a lever with a knurled grip. */
export function buildThrottleLever() {
  const parts = [];
  const arm = new THREE.BoxGeometry(0.026, THROTTLE.armLength * 0.9, 0.020);
  arm.translate(0, THROTTLE.armLength * 0.45, 0);
  toRegion(arm, 'trim', { uRange: [0.05, 0.35], vRange: [0.2, 0.8] });
  parts.push(normalize(arm));
  const grip = new THREE.CylinderGeometry(0.030, 0.026, 0.085, 14, 1, false);
  grip.rotateZ(0.25);
  grip.translate(0, THROTTLE.armLength * 0.94, 0.006);
  toRegion(grip, 'detail', { uRange: [0.55, 0.98], vRange: [0.5, 0.98] });
  parts.push(normalize(grip));
  const detent = new THREE.BoxGeometry(0.034, 0.010, 0.026);
  detent.translate(0, THROTTLE.armLength * 0.72, 0);
  toRegion(detent, 'trim', { uRange: [0.4, 0.6], vRange: [0.1, 0.3] });
  parts.push(normalize(detent));
  return merge(parts, 'throttle');
}

/** The fixed slot plate the throttle rides in. */
function buildThrottleDeck() {
  const shape = roundedRect(0.085, 0.215, 0.020);
  const geo = slab(shape, { depth: 0.020, bevel: 0.005, bevelSize: 0.006, segments: 1, curve: 3 });
  planarUV(geo, { front: 'trim', side: 'grey', w: 0.085, h: 0.215 });
  geo.rotateX(-Math.PI / 2 + 0.22);
  geo.translate(THROTTLE.pivot[0], THROTTLE.pivot[1] + 0.012, THROTTLE.pivot[2] - 0.020);
  return normalize(geo);
}

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

/**
 * Build every static piece of the tub, merged into one geometry.
 * @returns {{tub: THREE.BufferGeometry, glass: THREE.BufferGeometry,
 *            stick: THREE.BufferGeometry, throttle: THREE.BufferGeometry,
 *            stats: {triangles:number}}}
 */
export function buildCockpitGeometry(engine, { seed = 7717 } = {}) {
  const key = `cockpit/geo/${seed}`;
  const make = () => {
    const rng = makeRng(seed);
    const parts = [
      buildPanel(),
      buildStack(),
      buildMfdBezel(MFD.leftX),
      buildMfdBezel(MFD.rightX),
      buildRadarBezel(),
      buildCoaming(),
      buildConsole(-1),
      buildConsole(1),
      buildCheek(-1),
      buildCheek(1),
      buildSwitches(rng),
      buildKnobs(rng),
      buildCanopyFrame(),
      buildThrottleDeck(),
    ].map(normalize);

    const tub = merge(parts, 'tub');
    for (const p of parts) p.dispose();
    tub.computeBoundingSphere();

    const glass = buildCanopyGlass();
    const stick = normalize(buildStick());
    const throttle = normalize(buildThrottleLever());

    const tris = (g) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    return {
      tub,
      glass,
      stick,
      throttle,
      stats: { triangles: Math.round(tris(tub) + tris(glass) + tris(stick) + tris(throttle)) },
    };
  };
  return engine?.registry ? engine.registry.get(key, make) : make();
}
