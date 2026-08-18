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
  rakeChance = 0.08,
  seamWide = 0.0040,
  seamFine = 0.0017,
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
    // Rakes only on structural cuts. A raked scribe line between two small
    // plates just produces slivers, and slivers are what makes a plating layout
    // read as shattered glass instead of an airframe.
    if (rng() < rakeChance && depth >= 1 && depth <= 2) {
      // Raked cut: 20–40° off the axis. Real airframes are full of these where a
      // panel wraps a curved section.
      const base = longIsX ? 0 : Math.PI / 2;
      angle = base + (rng() < 0.5 ? 1 : -1) * (0.42 + rng() * 0.28);
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

// ------------------------------------------------------------------ field build

/**
 * Rasterise the whole plating layout in one pass.
 *
 * Everything the later texture passes need about *layout* comes out of here, in
 * the smallest types that survive the job — 2048² fields are 4 MB per byte of
 * stride, so `panel` is a Uint16 and `edgePx` is a clamped byte.
 *
 * @param {number} size texture edge in texels
 * @returns {{
 *   panel: Uint16Array,      // stable plate index, for per-plate attribute tables
 *   macro: Uint8Array,       // structural section index
 *   seam: Float32Array,      // 0..1 groove profile (1 = centre of the cut)
 *   seamAmp: Uint8Array,     // 0..255 how structural the winning cut is
 *   rivet: Float32Array,     // 0..1 fastener dome
 *   edgePx: Uint8Array,      // texels to nearest cut, clamped at 255
 *   along: Uint8Array,       // arc length along that cut, wrapped to 256 texels
 *   panelCount: number, macroCount: number
 * }}
 */
export function buildPanelField(size, {
  seed = 1,
  panelScale = 1,
  macroCells = 7,
  treeCount = 4,
  treeOpts = {},
  rivetSpacing = 15,
  rivetRadius = 2.15,
  rivetInset = 6.5,
  rivetChance = 0.55,
} = {}) {
  const S = size / 2048; // fastener geometry is authored at 2048²
  const trees = [];
  for (let i = 0; i < treeCount; i++) {
    trees.push(buildPlateTree(seed * 7919 + i * 104729 + 13, treeOpts));
  }
  const maxLeaves = trees.reduce((m, t) => Math.max(m, t.leafCount), 1);
  const { px: mpx, py: mpy } = buildMacroCells(seed, macroCells, 0.88);

  const n = size * size;
  const panel = new Uint16Array(n);
  const macroOut = new Uint8Array(n);
  const seamOut = new Float32Array(n);
  const seamAmpOut = new Uint8Array(n);
  const rivetOut = new Float32Array(n);
  const edgeOut = new Uint8Array(n);
  const alongOut = new Uint8Array(n);

  // Per-section constants: which plating tree, at what angle, at what gauge.
  const nCells = macroCells * macroCells;
  const cellTree = new Int32Array(nCells);
  const cellCos = new Float32Array(nCells);
  const cellSin = new Float32Array(nCells);
  const cellRep = new Float32Array(nCells);
  const cellOffX = new Float32Array(nCells);
  const cellOffY = new Float32Array(nCells);
  for (let i = 0; i < nCells; i++) {
    cellTree[i] = (cellValue(i, seed + 31) * treeCount) | 0;
    // A small weighted set of structural axes, biased hard toward 0. Twelve free
    // directions read as scattered; a real airframe runs its plating along a
    // handful of frames and stringers.
    const AX = [0, 0, 0, 0.436, 0.873, 1.222, 0.218, 1.396];
    const a = AX[(cellValue(i, seed + 57) * AX.length) | 0];
    cellCos[i] = Math.cos(a);
    cellSin[i] = Math.sin(a);
    cellRep[i] = (2.15 / Math.max(0.2, panelScale)) * (0.74 + cellValue(i, seed + 83) * 0.8);
    cellOffX[i] = cellValue(i, seed + 101) * 3.7;
    cellOffY[i] = cellValue(i, seed + 149) * 2.3;
  }

  // Fastener geometry, resolution-aware: below ~1.9 texels a rivet is a shimmering
  // dot rather than a bolt head, so it fades out of the height field entirely and
  // survives only as roughness breakup.
  const rr = Math.max(0.85, rivetRadius * S);
  // Below ~1.6 texels a bolt head cannot hold a shading gradient, so its push on
  // the height field tapers off and it survives as albedo/roughness breakup only.
  const rivFade = Math.min(1, Math.max(0, (rr - 0.8) / 0.8));
  const spacing = Math.max(rr * 3.4, rivetSpacing * S);
  const inset = Math.max(rr * 2.1, rivetInset * S);
  const invSpacing = 1 / spacing;

  const cellPx = size / macroCells;
  const inv = 1 / size;
  const macroSeamPx = 1.5 * Math.max(0.35, S) + 0.8;

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) * inv;
    const my = v * macroCells;
    const myi = Math.floor(my);
    const rowBase = y * size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) * inv;
      const mx = u * macroCells;
      const mxi = Math.floor(mx);

      // --- macro worley (3×3 wrapped neighbourhood) --------------------------
      let f1 = 1e9, f2 = 1e9, bestCell = 0;
      for (let oy = -1; oy <= 1; oy++) {
        const gy = myi + oy;
        const wy = ((gy % macroCells) + macroCells) % macroCells;
        const row = wy * macroCells;
        const shiftY = gy - wy;
        for (let ox = -1; ox <= 1; ox++) {
          const gx = mxi + ox;
          const wx = ((gx % macroCells) + macroCells) % macroCells;
          const ci = row + wx;
          const dx = mpx[ci] + (gx - wx) - mx;
          const dy = mpy[ci] + shiftY - my;
          const d2 = dx * dx + dy * dy;
          if (d2 < f1) { f2 = f1; f1 = d2; bestCell = ci; }
          else if (d2 < f2) f2 = d2;
        }
      }
      const macroEdgePx = (Math.sqrt(f2) - Math.sqrt(f1)) * 0.5 * cellPx;

      // --- plating tree inside the section -----------------------------------
      const ca = cellCos[bestCell], sa = cellSin[bestCell];
      const rep = cellRep[bestCell];
      let ru = (u * ca - v * sa) * rep + cellOffX[bestCell];
      let rv = (u * sa + v * ca) * rep + cellOffY[bestCell];
      const tileU = Math.floor(ru), tileV = Math.floor(rv);
      ru -= tileU; rv -= tileV;

      const ti = cellTree[bestCell];
      const tr = trees[ti];
      const tnx = tr.nx, tny = tr.ny, tcc = tr.cc, thalf = tr.half, tamp = tr.amp;
      const tf = tr.front, tb = tr.back;
      const domainPx = size / rep;

      let node = tr.root;
      let bestQ = 1e9, bestAmp = 0, bestAlong = 0, bestNode = -1;
      let minPx = 1e9;
      while (node >= 0) {
        const d = tnx[node] * ru + tny[node] * rv - tcc[node];
        const ad = d < 0 ? -d : d;
        const q = ad / thalf[node];
        if (q < bestQ) {
          bestQ = q;
          bestAmp = tamp[node];
          bestAlong = (-tny[node] * ru + tnx[node] * rv) * domainPx;
          bestNode = node;
        }
        const px = ad * domainPx;
        if (px < minPx) minPx = px;
        node = d >= 0 ? tf[node] : tb[node];
      }
      const leaf = node < 0 ? -node - 1 : 0;

      // The plate-domain wrap is itself a structural joint, so the tile boundary
      // reads as a deliberate panel line instead of a smear.
      const bu = ru < 1 - ru ? ru : 1 - ru;
      const bv = rv < 1 - rv ? rv : 1 - rv;
      const bd = bu < bv ? bu : bv;
      const bq = bd / 0.0042;
      if (bq < bestQ) {
        bestQ = bq;
        bestAmp = 1;
        bestAlong = (bu < bv ? rv : ru) * domainPx;
        bestNode = -2;
      }
      const bdPx = bd * domainPx;
      if (bdPx < minPx) minPx = bdPx;

      // --- seam profile -------------------------------------------------------
      // A groove with soft shoulders: flat-bottomed near the centre, easing out
      // over the bevel so the normal map gets a real chamfer rather than a step.
      let seam = 0;
      if (bestQ < 1.45) {
        const t = bestQ < 0.45 ? 0 : (bestQ - 0.45) / 1.0;
        seam = 1 - t * t * (3 - 2 * t);
      }

      // Section seams are wider and deeper than plate seams and always win.
      if (macroEdgePx < macroSeamPx * 2.0) {
        const t = clamp(macroEdgePx / (macroSeamPx * 2.0));
        const ms = 1 - t * t * (3 - 2 * t);
        if (ms > seam) { seam = ms; bestAmp = 1; bestNode = -1; }
        if (macroEdgePx < minPx) minPx = macroEdgePx;
      }

      // --- fasteners ----------------------------------------------------------
      let riv = 0;
      if (bestAmp > 0.46 && bestNode !== -1) {
        const nodeKey = (bestCell * 131 + (bestNode + 3) * 7919) >>> 0;
        if (cellValue(nodeKey, seed + 211) < rivetChance) {
          const adPx = bestQ * (bestNode >= 0 ? thalf[bestNode] : 0.0042) * domainPx;
          const dPerp = adPx - inset;
          const s = bestAlong * invSpacing;
          const dAlong = (s - Math.floor(s) - 0.5) * spacing;
          const dist = Math.sqrt(dPerp * dPerp + dAlong * dAlong);
          if (dist < rr) {
            // Dome profile, not a cylinder: bolt heads are round.
            const k = 1 - dist / rr;
            riv = Math.sqrt(k);
          }
        }
      }

      const i = rowBase + x;
      macroOut[i] = bestCell;
      seamOut[i] = seam;
      seamAmpOut[i] = (bestAmp * 255) | 0;
      rivetOut[i] = riv;
      edgeOut[i] = minPx > 255 ? 255 : minPx | 0;
      // Arc length along the winning cut, wrapped to a byte. Weld beads ripple
      // along it and any future feature that must march down a seam can use it.
      alongOut[i] = ((bestAlong | 0) % 256 + 256) % 256;
      const tileKey = (tileU & 1) | ((tileV & 1) << 1);
      panel[i] = (bestCell * maxLeaves + leaf + tileKey * nCells * maxLeaves) & 0xffff;
    }
  }

  return {
    panel, macro: macroOut, seam: seamOut, seamAmp: seamAmpOut,
    rivet: rivetOut, edgePx: edgeOut, along: alongOut, rivetHeightScale: rivFade,
    panelCount: Math.min(65536, nCells * maxLeaves * 4),
    macroCount: nCells,
    macroCells, cellPx, maxLeaves,
  };
}
