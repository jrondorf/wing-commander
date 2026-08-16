/**
 * Panel layout synthesis.
 *
 * Hull plating is a two-tier structure and both tiers matter:
 *
 *  1. **Macro sections** — irregular worley cells. These are the big structural
 *     regions of the airframe (nose, spine, wing root, engine deck). Their seams
 *     are wide and deep, and each section runs its plating at its own angle and
 *     gauge, which is the single biggest thing that stops a hull texture reading
 *     as wallpaper.
 *  2. **Plates** — inside each section, a recursive binary space partition with
 *     mostly-axis-aligned but occasionally raked cuts. Structural cuts happen at
 *     shallow tree depth and get wide seams; the fine scribe lines are the deep
 *     ones. Branches stop subdividing at random depths, so big plates and small
 *     plates coexist instead of forming a uniform grid.
 *
 * Both are queried per texel through flat typed arrays, so the inner loop is a
 * handful of multiply-adds and no allocation. That is what keeps a 2048² set
 * inside the load-time budget.
 *
 * The query returns, per texel:
 *   panel index (stable, for per-plate attribute lookup),
 *   `q`  — distance to the nearest bounding cut, normalised by that cut's width,
 *   `amp` — how structural that cut is (drives seam depth),
 *   `t`  — arc-length along that cut, which is what lets rivet rows follow seams.
 */

import { makeRng } from '../core/Rand.js';
import { cellValue, clamp } from './noise.js';

// ------------------------------------------------------------------ BSP builder

/** Clip a convex polygon against the half-plane dot(n,p) <= c. */
function clipHalfPlane(poly, nx, ny, c, keepFront) {
  const out = [];
  const sgn = keepFront ? 1 : -1;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const ax = poly[i][0], ay = poly[i][1];
    const bx = poly[(i + 1) % n][0], by = poly[(i + 1) % n][1];
    const da = (ax * nx + ay * ny - c) * sgn;
    const db = (bx * nx + by * ny - c) * sgn;
    if (da >= 0) out.push([ax, ay]);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
    }
  }
  return out;
}

function polyBounds(poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) * 0.5;
}

function polyCentroid(poly) {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    const cr = x0 * y1 - x1 * y0;
    a += cr; cx += (x0 + x1) * cr; cy += (y0 + y1) * cr;
  }
  if (Math.abs(a) < 1e-9) {
    const b = polyBounds(poly);
    return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  }
  a *= 0.5;
  return [cx / (6 * a), cy / (6 * a)];
}

/**
 * Build one plating tree over the unit square.
 *
 * @returns flat arrays: nx, ny, cc (cut line), half (seam half-width in domain
 *   units), amp (0..1 structural weight), front/back child links where a negative
 *   value `-(leaf+1)` terminates, plus `leafCount`.
 */
export function buildPlateTree(seed, {
  maxDepth = 7,
  minEdge = 0.075,
  stopChance = 0.16,
  rakeChance = 0.18,
  seamWide = 0.0075,
  seamFine = 0.0028,
  aspectBias = 1,
} = {}) {
  const rng = makeRng(seed >>> 0 || 1);
  const nx = [], ny = [], cc = [], half = [], amp = [], front = [], back = [];
  let leafCount = 0;
  const leafCentre = [];
  const leafSize = [];

  const build = (poly, depth) => {
    const [bx0, by0, bx1, by1] = polyBounds(poly);
    const w = bx1 - bx0, h = by1 - by0;
    const small = Math.min(w, h) < minEdge * 2 || polyArea(poly) < minEdge * minEdge * 1.6;
    const stop = depth >= maxDepth || small || (depth >= 2 && rng() < stopChance);
    if (stop) {
      const c = polyCentroid(poly);
      leafCentre.push(c[0], c[1]);
      leafSize.push(Math.max(w, h));
      return -(leafCount++) - 1;
    }

    // Cut across the long axis so plates stay reasonably chunky rather than slivered.
    let angle;
    const longIsX = w * aspectBias > h;
    if (rng() < rakeChance && depth >= 1) {
      // Raked cut: 20–40° off the axis. Real airframes are full of these where a
      // panel wraps a curved section.
      const base = longIsX ? 0 : Math.PI / 2;
      angle = base + (rng() < 0.5 ? 1 : -1) * (0.34 + rng() * 0.36);
    } else {
      angle = longIsX ? 0 : Math.PI / 2;
      angle += rng.gauss(0, 0.012); // never perfectly true — a hand-built hull
    }
    const cnx = Math.cos(angle), cny = Math.sin(angle);

    // Project the polygon onto the cut normal, split somewhere near the middle.
    let lo = Infinity, hi = -Infinity;
    for (const [px, py] of poly) {
      const d = px * cnx + py * cny;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    const span = hi - lo;
    if (span < minEdge * 2) {
      const c = polyCentroid(poly);
      leafCentre.push(c[0], c[1]);
      leafSize.push(Math.max(w, h));
      return -(leafCount++) - 1;
    }
    const frac = 0.5 + rng.gauss(0, 0.13);
    const c = lo + span * clamp(frac, minEdge / span, 1 - minEdge / span);

    // Shallow cuts are structural joints: wide, deep, riveted. Deep cuts are the
    // fine scribe lines between individual plates.
    const dt = depth / maxDepth;
    const width = seamWide + (seamFine - seamWide) * Math.pow(dt, 0.65);
    const structural = Math.pow(1 - dt, 1.4);

    const idx = nx.length;
    nx.push(cnx); ny.push(cny); cc.push(c);
    half.push(width * 0.5);
    amp.push(0.28 + 0.72 * structural);
    front.push(0); back.push(0);

    front[idx] = build(clipHalfPlane(poly, cnx, cny, c, true), depth + 1);
    back[idx] = build(clipHalfPlane(poly, cnx, cny, c, false), depth + 1);
    return idx;
  };

  const root = build([[0, 0], [1, 0], [1, 1], [0, 1]], 0);

  return {
    nx: Float32Array.from(nx),
    ny: Float32Array.from(ny),
    cc: Float32Array.from(cc),
    half: Float32Array.from(half),
    amp: Float32Array.from(amp),
    front: Int32Array.from(front),
    back: Int32Array.from(back),
    root,
    leafCount: Math.max(1, leafCount),
    leafCentre: Float32Array.from(leafCentre),
    leafSize: Float32Array.from(leafSize),
  };
}

// -------------------------------------------------------------- macro sections

/**
 * Worley feature points baked into flat arrays. Precomputing kills ~18 hash calls
 * per texel; the whole macro layer then costs 9 squared-distance tests.
 */
export function buildMacroCells(seed, cells, jitter = 0.85) {
  const px = new Float32Array(cells * cells);
  const py = new Float32Array(cells * cells);
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const i = y * cells + x;
      // Reuse the project hash so macro cells stay in the same visual family as
      // everything else driven by noise.js.
      const a = cellValue((x * 73856093) ^ (y * 19349663), seed);
      const b = cellValue((x * 19349663) ^ (y * 83492791), seed + 977);
      px[i] = x + 0.5 + (a - 0.5) * jitter;
      py[i] = y + 0.5 + (b - 0.5) * jitter;
    }
  }
  return { px, py, cells };
}

