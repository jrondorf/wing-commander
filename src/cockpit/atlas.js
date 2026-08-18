/**
 * Cockpit texture atlas.
 *
 * The whole interior — dashboard, coaming, consoles, canopy frame, switch bodies,
 * grips — shares one 2048² material set so the entire static tub merges into a
 * single draw call. Every geometry builder in `geometry.js` maps its planar UVs
 * into one of the named regions below.
 *
 * Four maps come out:
 *   map          albedo, sRGB — paint, placards, wear, soot
 *   normalMap    from a height canvas: scribe lines, screw heads, bevels, texture
 *   ormMap       R = AO, G = roughness, B = metalness (glTF packing)
 *   emissiveMap  backlit legends, indicator lamps, edge-lit panel graphics
 *
 * Nothing here is loaded; nothing calls Math.random(). One `engine.registry` entry
 * keyed by seed and size, so a second cockpit (or a hot reload) is free.
 */

import * as THREE from 'three';
import { makeRng } from '../core/Rand.js';
import { heightToNormal } from '../procgen/noise.js';
import { PANEL, MFD, RADAR, STACK, SWITCHES, KNOBS } from './layout.js';
import {
  makeSurface, canvasLuma, rgbaCss, radialRamp, gradientRamp,
  seededSplatter, brushedStreaks, scratchLines, hazardStripes, roundRectPath,
  FONT_COND, FONT_MONO,
} from '../procgen/canvasKit.js';

export const ATLAS_SIZE = 2048;

/**
 * Named pixel rects inside the atlas. Region names are the contract between this
 * file and `geometry.js`; nothing else should know these numbers.
 */
export const REGIONS = {
  /** Main instrument panel face — the densest, most-seen surface. */
  main: [0, 0, 1280, 896],
  /** Glareshield top + the sloped brow under it. */
  coaming: [0, 896, 1280, 320],
  /** Side consoles, knee panel, throttle quadrant deck. */
  console: [0, 1216, 1280, 512],
  /** Generic dark painted metal for sides, backs and structure. */
  grey: [0, 1728, 1024, 320],
  /** Canopy frame, ribs, sill rails. */
  frame: [1280, 0, 768, 512],
  /** Bright worn metal: bezels, trim strips, guard wire. */
  trim: [1280, 512, 768, 384],
  /** Switch bodies, knobs, stick grip, throttle grip. */
  detail: [1280, 896, 768, 512],
  /**
   * The MFD bezel face — square, because both bezels planar-map their whole
   * front face into it. This is where the soft-key legends live: painting them
   * on the panel behind would put them underneath the bezel geometry.
   */
  plate: [1280, 1408, 640, 640],
};

/** UV rect (u0,v0,u1,v1) for a region, with the canvas y-flip already applied. */
export function uvRect(name) {
  const [x, y, w, h] = REGIONS[name] ?? REGIONS.grey;
  const s = ATLAS_SIZE;
  return { u0: x / s, v0: 1 - (y + h) / s, u1: (x + w) / s, v1: 1 - y / s };
}

// --------------------------------------------------------------------- palette
const C = {
  paintDark: '#23282b',
  paint: '#2e3438',
  paintLit: '#3a4247',
  green: '#2d3a34',       // the classic instrument-panel grey-green
  bezel: '#454d52',
  trimMetal: '#6d757a',
  trimBright: '#9aa3a8',
  legend: '#c3cbd0',
  legendDim: '#8d969b',
  orange: '#e07a2a',
  red: '#c9392b',
  amber: '#ffab3d',
  cyan: '#7fe4ff',
  lamp_green: '#66e08a',
  soot: '#14181a',
};

// ---------------------------------------------------------------- draw helpers

/** Layer bundle: one context per output channel, all the same size. */
function makeLayers(size) {
  const alb = makeSurface(size, size, { alpha: false });
  const hgt = makeSurface(size, size, { alpha: false });
  const orm = makeSurface(size, size, { alpha: false });
  const ems = makeSurface(size, size, { alpha: false });
  // Height mid-grey = flush; ORM defaults to lit/rough/dielectric; emissive black.
  hgt.ctx.fillStyle = '#808080'; hgt.ctx.fillRect(0, 0, size, size);
  orm.ctx.fillStyle = 'rgb(255,150,12)'; orm.ctx.fillRect(0, 0, size, size);
  ems.ctx.fillStyle = '#000000'; ems.ctx.fillRect(0, 0, size, size);
  alb.ctx.fillStyle = C.paint; alb.ctx.fillRect(0, 0, size, size);
  return { alb: alb.ctx, hgt: hgt.ctx, orm: orm.ctx, ems: ems.ctx, canvases: { alb, hgt, orm, ems }, size };
}

/** Set roughness/metalness on a rect without disturbing the AO channel. */
function orm(L, x, y, w, h, { rough = 0.55, metal = 0.05, ao = 1 } = {}) {
  L.orm.fillStyle = `rgb(${Math.round(ao * 255)},${Math.round(rough * 255)},${Math.round(metal * 255)})`;
  L.orm.fillRect(x, y, w, h);
}

/** A tracked, condensed military legend. Returns the drawn width. */
function legend(ctx, text, x, y, {
  size = 15, color = C.legend, align = 'left', track = 0.1, weight = 600,
  font = FONT_COND, alpha = 1,
} = {}) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color;
  const s = String(text);
  const gap = track * size;
  let total = 0;
  const widths = [];
  for (let i = 0; i < s.length; i++) {
    const wd = ctx.measureText(s[i]).width;
    widths.push(wd);
    total += wd + (i < s.length - 1 ? gap : 0);
  }
  let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ' ') ctx.fillText(s[i], cx, y);
    cx += widths[i] + gap;
  }
  ctx.restore();
  return total;
}

/** Brushed/anodised base coat with mottling — never a flat fill. */
function basePaint(L, rect, rng, {
  color = C.paint, wear = 0.5, brushAngle = 0, rough = 0.58, metal = 0.05,
} = {}) {
  const [x, y, w, h] = rect;
  const { alb, hgt, orm: o } = L;

  alb.save();
  alb.beginPath(); alb.rect(x, y, w, h); alb.clip();
  alb.fillStyle = color;
  alb.fillRect(x, y, w, h);
  // Broad tonal drift so the panel is never one value.
  alb.fillStyle = gradientRamp(alb, x, y, x + w * 0.3, y + h, [
    [0, color, 0], [0.45, '#000000', 0.14], [1, '#000000', 0.30],
  ]);
  alb.fillRect(x, y, w, h);
  seededSplatter(alb, { rng, count: 260, x, y, w, h, radius: [6, 46], alpha: [0.015, 0.055], color: '#000000', clusters: 14, clusterSpread: 0.1 });
  seededSplatter(alb, { rng, count: 120, x, y, w, h, radius: [4, 24], alpha: [0.01, 0.035], color: '#8b949a', clusters: 9, clusterSpread: 0.12 });
  brushedStreaks(alb, { rng, count: 260, x, y, w, h, angle: brushAngle, spread: 0.02, length: [0.05, 0.3], width: [0.4, 1.6], alpha: [0.008, 0.035], color: '#aeb7bc' });
  scratchLines(alb, { rng, count: Math.round(120 * wear), x, y, w, h, angle: brushAngle + 0.2, spread: 0.5, length: [0.01, 0.09], alpha: [0.03, 0.16], color: '#b9c2c7', width: [0.4, 0.9] });
  alb.restore();

  // Fine cast-texture on the height channel: real panels are lightly pebbled.
  hgt.save();
  hgt.beginPath(); hgt.rect(x, y, w, h); hgt.clip();
  hgt.fillStyle = '#808080'; hgt.fillRect(x, y, w, h);
  seededSplatter(hgt, { rng, count: 900, x, y, w, h, radius: [1.5, 5], alpha: [0.05, 0.16], color: '#ffffff', clusters: 26, clusterSpread: 0.18 });
  seededSplatter(hgt, { rng, count: 900, x, y, w, h, radius: [1.5, 5], alpha: [0.05, 0.16], color: '#000000', clusters: 26, clusterSpread: 0.18 });
  hgt.restore();

  // Roughness varies with the same mottling — constant roughness is the tell.
  o.save();
  o.beginPath(); o.rect(x, y, w, h); o.clip();
  o.fillStyle = `rgb(255,${Math.round(rough * 255)},${Math.round(metal * 255)})`;
  o.fillRect(x, y, w, h);
  seededSplatter(o, { rng, count: 200, x, y, w, h, radius: [10, 60], alpha: [0.08, 0.3], color: '#00ff00', clusters: 12, clusterSpread: 0.13 });
  seededSplatter(o, { rng, count: 200, x, y, w, h, radius: [8, 40], alpha: [0.08, 0.26], color: '#004400', clusters: 12, clusterSpread: 0.13 });
  o.restore();
}

/** Recessed scribe line — a groove in the height field with a dark AO core. */
function scribe(L, x0, y0, x1, y1, { width = 3, depth = 0.42 } = {}) {
  const { alb, hgt, orm: o } = L;
  hgt.save();
  hgt.strokeStyle = rgbaCss('#000000', depth);
  hgt.lineWidth = width;
  hgt.lineCap = 'round';
  hgt.beginPath(); hgt.moveTo(x0, y0); hgt.lineTo(x1, y1); hgt.stroke();
  hgt.restore();

  alb.save();
  alb.strokeStyle = rgbaCss('#000000', 0.34);
  alb.lineWidth = width;
  alb.beginPath(); alb.moveTo(x0, y0); alb.lineTo(x1, y1); alb.stroke();
  alb.restore();

  o.save();
  o.globalCompositeOperation = 'multiply';
  o.strokeStyle = 'rgba(120,255,255,1)';   // darken AO, leave rough/metal alone
  o.lineWidth = width + 3;
  o.beginPath(); o.moveTo(x0, y0); o.lineTo(x1, y1); o.stroke();
  o.restore();
}

/** A raised bevelled sub-panel: the edge is what catches the key light. */
function subPanel(L, x, y, w, h, { r = 6, rise = 0.16, tint = 0.0 } = {}) {
  const { alb, hgt } = L;
  hgt.save();
  roundRectPath(hgt, x, y, w, h, r);
  hgt.fillStyle = rgbaCss('#ffffff', rise);
  hgt.fill();
  // A darker halo just outside the plate reads as the shadowed step down.
  hgt.strokeStyle = rgbaCss('#000000', rise * 1.3);
  hgt.lineWidth = 3;
  roundRectPath(hgt, x - 2, y - 2, w + 4, h + 4, r + 2);
  hgt.stroke();
  hgt.restore();

  if (tint !== 0) {
    alb.save();
    roundRectPath(alb, x, y, w, h, r);
    alb.fillStyle = rgbaCss(tint > 0 ? '#ffffff' : '#000000', Math.abs(tint));
    alb.fill();
    alb.restore();
  }
}

/** Countersunk screw heads around a plate. */
function screws(L, x, y, w, h, rng, { inset = 11, radius = 4.2, every = 96 } = {}) {
  const pts = [];
  const push = (px, py) => pts.push([px, py]);
  const nx = Math.max(1, Math.round(w / every));
  const ny = Math.max(1, Math.round(h / every));
  for (let i = 0; i <= nx; i++) {
    push(x + inset + (i * (w - inset * 2)) / nx, y + inset);
    push(x + inset + (i * (w - inset * 2)) / nx, y + h - inset);
  }
  for (let j = 1; j < ny; j++) {
    push(x + inset, y + inset + (j * (h - inset * 2)) / ny);
    push(x + w - inset, y + inset + (j * (h - inset * 2)) / ny);
  }
  const { alb, hgt } = L;
  for (const [px, py] of pts) {
    const a = rng.range(0, Math.PI);
    hgt.save();
    hgt.fillStyle = radialRamp(hgt, px, py, 0, radius, [[0, '#000000', 0.55], [0.65, '#000000', 0.3], [1, '#ffffff', 0.22]]);
    hgt.beginPath(); hgt.arc(px, py, radius, 0, Math.PI * 2); hgt.fill();
    // Cross slot.
    hgt.strokeStyle = rgbaCss('#000000', 0.8);
    hgt.lineWidth = 1.4;
    hgt.beginPath();
    hgt.moveTo(px - Math.cos(a) * radius * 0.8, py - Math.sin(a) * radius * 0.8);
    hgt.lineTo(px + Math.cos(a) * radius * 0.8, py + Math.sin(a) * radius * 0.8);
    hgt.stroke();
    hgt.restore();

    alb.save();
    alb.fillStyle = radialRamp(alb, px - radius * 0.3, py - radius * 0.3, 0, radius * 1.4, [
      [0, '#b6bec3', 0.5], [0.6, '#4a5257', 0.42], [1, '#000000', 0.3],
    ]);
    alb.beginPath(); alb.arc(px, py, radius * 1.25, 0, Math.PI * 2); alb.fill();
    alb.restore();
  }
}

/** Backlit legend: paint on albedo, glow on emissive. */
function litLegend(L, text, x, y, opts = {}) {
  const color = opts.color ?? C.legend;
  const glow = opts.glow ?? C.cyan;
  const w = legend(L.alb, text, x, y, { ...opts, color });
  L.ems.save();
  L.ems.shadowColor = glow;
  L.ems.shadowBlur = (opts.size ?? 15) * 0.55;
  legend(L.ems, text, x, y, { ...opts, color: glow });
  L.ems.restore();
  return w;
}

/** Indicator lamp: a lens with a coloured filament and a real emissive core. */
function lamp(L, x, y, r, color, { on = true, label = null } = {}) {
  const { alb, hgt, ems, orm: o } = L;
  hgt.save();
  hgt.fillStyle = radialRamp(hgt, x, y, 0, r * 1.35, [[0, '#ffffff', 0.3], [0.72, '#c8c8c8', 0.12], [0.82, '#000000', 0.5], [1, '#000000', 0]]);
  hgt.beginPath(); hgt.arc(x, y, r * 1.35, 0, Math.PI * 2); hgt.fill();
  hgt.restore();

  alb.save();
  alb.fillStyle = '#101315';
  alb.beginPath(); alb.arc(x, y, r * 1.28, 0, Math.PI * 2); alb.fill();
  alb.fillStyle = rgbaCss(color, on ? 0.9 : 0.34);
  alb.beginPath(); alb.arc(x, y, r, 0, Math.PI * 2); alb.fill();
  alb.fillStyle = radialRamp(alb, x - r * 0.35, y - r * 0.4, 0, r, [[0, '#ffffff', 0.5], [1, '#ffffff', 0]]);
  alb.beginPath(); alb.arc(x, y, r, 0, Math.PI * 2); alb.fill();
  alb.restore();

  if (on) {
    ems.save();
    ems.fillStyle = radialRamp(ems, x, y, 0, r * 2.1, [[0, color, 1], [0.42, color, 0.85], [0.62, color, 0.3], [1, color, 0]]);
    ems.beginPath(); ems.arc(x, y, r * 2.1, 0, Math.PI * 2); ems.fill();
    ems.restore();
  }

  o.save();
  o.fillStyle = 'rgb(210,40,10)';   // lens: smooth, dielectric
  o.beginPath(); o.arc(x, y, r, 0, Math.PI * 2); o.fill();
  o.restore();

  if (label) legend(alb, label, x, y + r * 2.6, { size: 10, align: 'center', color: C.legendDim, track: 0.14 });
}

/** Warning / data placard with a border and stencilled text. */
function placard(L, x, y, w, h, lines, { accent = C.orange, fill = '#1b1f22' } = {}) {
  const { alb, hgt } = L;
  hgt.save();
  roundRectPath(hgt, x, y, w, h, 3);
  hgt.fillStyle = rgbaCss('#ffffff', 0.12);
  hgt.fill();
  hgt.restore();

  alb.save();
  roundRectPath(alb, x, y, w, h, 3);
  alb.fillStyle = fill;
  alb.fill();
  alb.strokeStyle = accent;
  alb.lineWidth = 2;
  alb.stroke();
  alb.restore();

  const lh = (h - 10) / lines.length;
  for (let i = 0; i < lines.length; i++) {
    legend(alb, lines[i], x + w / 2, y + 8 + lh * (i + 0.78), {
      size: Math.min(lh * 0.78, 14), align: 'center', color: i === 0 ? accent : C.legend, track: 0.13,
    });
  }
}

/** Soot / hand-oil grime concentrated where a pilot actually touches things. */
function grime(L, x, y, w, h, rng, amount = 1) {
  L.alb.save();
  L.alb.beginPath(); L.alb.rect(x, y, w, h); L.alb.clip();
  seededSplatter(L.alb, { rng, count: Math.round(90 * amount), x, y, w, h, radius: [12, 70], alpha: [0.02, 0.09], color: C.soot, clusters: 6, clusterSpread: 0.16 });
  L.alb.restore();
  L.orm.save();
  L.orm.beginPath(); L.orm.rect(x, y, w, h); L.orm.clip();
  // Handled surfaces polish up: lower roughness where the grime is.
  seededSplatter(L.orm, { rng, count: Math.round(70 * amount), x, y, w, h, radius: [14, 64], alpha: [0.1, 0.32], color: '#005500', clusters: 6, clusterSpread: 0.16 });
  L.orm.restore();
}

// ------------------------------------------------------------------- painters

function paintMainPanel(L, rng) {
  const [x, y, w, h] = REGIONS.main;
  basePaint(L, REGIONS.main, rng, { color: C.green, wear: 0.55, brushAngle: 0, rough: 0.62, metal: 0.06 });

  // Panel space (metres, origin at the panel centre, +Y up) -> atlas pixels.
  // Everything below is positioned from layout.js so the geometry lines up.
  const sx = w / PANEL.w;
  const sy = h / PANEL.h;
  const PX = (mx) => x + (mx + PANEL.w / 2) * sx;
  const PY = (my) => y + (PANEL.h / 2 - my) * sy;

  // Bevelled outer frame of the whole panel + top/bottom joint scribes.
  subPanel(L, x + 10, y + 10, w - 20, h - 20, { r: 10, rise: 0.1 });
  scribe(L, x + 18, PY(PANEL.h / 2 - 0.018), x + w - 18, PY(PANEL.h / 2 - 0.018), { width: 4, depth: 0.5 });
  scribe(L, x + 18, PY(-PANEL.h / 2 + 0.016), x + w - 18, PY(-PANEL.h / 2 + 0.016), { width: 4, depth: 0.5 });
  // Vertical joints splitting the panel into bolted sections.
  for (const jx of [-0.62, -0.20, 0.20, 0.62]) {
    scribe(L, PX(jx), y + 16, PX(jx), y + h - 16, { width: 3, depth: 0.38 });
  }

  // ---- MFD wells ------------------------------------------------------------
  // A deep, bevelled recess; the bezel and the screen are real geometry on top,
  // so all the texture has to sell is the surround, the screws and the hood shadow.
  const halfM = MFD.size / 2;
  for (const cxm of [MFD.leftX, MFD.rightX]) {
    const rx = PX(cxm - halfM), ry = PY(MFD.y + halfM);
    const rw = MFD.size * sx, rh = MFD.size * sy;
    const bz = MFD.bezel * sx;
    subPanel(L, rx - bz, ry - bz, rw + bz * 2, rh + bz * 2, { r: 12, rise: 0.22, tint: 0.05 });
    L.hgt.save();
    roundRectPath(L.hgt, rx, ry, rw, rh, 8);
    L.hgt.fillStyle = rgbaCss('#000000', 0.8);
    L.hgt.fill();
    L.hgt.restore();
    L.alb.save();
    roundRectPath(L.alb, rx, ry, rw, rh, 8);
    L.alb.fillStyle = '#080b0d';
    L.alb.fill();
    L.alb.restore();
    orm(L, rx, ry, rw, rh, { rough: 0.2, metal: 0.02, ao: 0.4 });
    screws(L, rx - bz, ry - bz, rw + bz * 2, rh + bz * 2, rng, { inset: 9, radius: 4.4, every: 110 });
  }

  // ---- centre stack ---------------------------------------------------------
  const stackX0 = PX(-STACK.halfWidth), stackW = STACK.halfWidth * 2 * sx;
  subPanel(L, stackX0, PY(PANEL.h / 2 - 0.026), stackW, (PANEL.h - 0.052) * sy, { r: 8, rise: 0.14, tint: -0.05 });
  screws(L, stackX0, PY(PANEL.h / 2 - 0.026), stackW, (PANEL.h - 0.052) * sy, rng, { inset: 10, radius: 4, every: 140 });

  // Radar well: a circular recess with a machined lip.
  const rcx = PX(RADAR.x), rcy = PY(RADAR.y), rr = RADAR.r * sx;
  L.hgt.save();
  L.hgt.fillStyle = radialRamp(L.hgt, rcx, rcy, rr * 0.9, rr * 1.2, [[0, '#000000', 0.75], [0.55, '#000000', 0.4], [1, '#ffffff', 0.24]]);
  L.hgt.beginPath(); L.hgt.arc(rcx, rcy, rr * 1.22, 0, Math.PI * 2); L.hgt.fill();
  L.hgt.restore();
  L.alb.save();
  L.alb.fillStyle = '#05080a';
  L.alb.beginPath(); L.alb.arc(rcx, rcy, rr, 0, Math.PI * 2); L.alb.fill();
  L.alb.restore();
  orm(L, rcx - rr, rcy - rr, rr * 2, rr * 2, { rough: 0.30, metal: 0.02, ao: 0.35 });

  // Annunciator lamps flank the globe: the strip either side of the radar bezel
  // is the only real estate in the centre stack the glareshield does not eat.
  const lampNames = [['MSTR', 'SHLD', 'PWR'], ['ARMR', 'FUEL', 'ITTS']];
  const lampCols = [[C.amber, C.lamp_green, C.lamp_green], [C.red, C.lamp_green, C.cyan]];
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < 3; i++) {
      const lx = PX((c === 0 ? -1 : 1) * 0.150);
      const ly = PY(0.058 - i * 0.060);
      lamp(L, lx, ly, 8.5, lampCols[c][i], { on: !(c === 1 && i === 0), label: lampNames[c][i] });
    }
  }

  // ---- switch banks ---------------------------------------------------------
  // Two columns of toggles in the gaps between the stack and the MFD bezels.
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < SWITCHES.rows; i++) {
      switchPocket(L,
        PX((c === 0 ? -1 : 1) * SWITCHES.colX),
        PY(SWITCHES.topY - i * SWITCHES.pitch),
        SWITCH_LEGENDS[(c * SWITCHES.rows + i) % SWITCH_LEGENDS.length]);
    }
  }

  // ---- rotaries and outboard strips -----------------------------------------
  const knobLabels = [['CONTRAST', 'BRT'], ['GAIN', 'VOL']];
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < KNOBS.ys.length; i++) {
      const kx = PX((c === 0 ? -1 : 1) * KNOBS.x);
      const ky = PY(KNOBS.ys[i]);
      L.hgt.save();
      L.hgt.fillStyle = radialRamp(L.hgt, kx, ky, 0, KNOBS.r * sx * 1.35, [[0, '#000000', 0.5], [0.75, '#000000', 0.32], [1, '#ffffff', 0.18]]);
      L.hgt.beginPath(); L.hgt.arc(kx, ky, KNOBS.r * sx * 1.35, 0, Math.PI * 2); L.hgt.fill();
      L.hgt.restore();
      L.alb.save();
      L.alb.fillStyle = '#0e1214';
      L.alb.beginPath(); L.alb.arc(kx, ky, KNOBS.r * sx * 1.2, 0, Math.PI * 2); L.alb.fill();
      L.alb.restore();
      // Detent ticks around the rotary.
      L.alb.save();
      L.alb.strokeStyle = rgbaCss(C.legendDim, 0.75);
      L.alb.lineWidth = 2;
      for (let t = 0; t <= 8; t++) {
        const a = -Math.PI * 1.25 + (t / 8) * Math.PI * 1.5;
        const r0 = KNOBS.r * sx * 1.45, r1 = r0 + 7;
        L.alb.beginPath();
        L.alb.moveTo(kx + Math.cos(a) * r0, ky + Math.sin(a) * r0);
        L.alb.lineTo(kx + Math.cos(a) * r1, ky + Math.sin(a) * r1);
        L.alb.stroke();
      }
      L.alb.restore();
      legend(L.alb, knobLabels[c][i], kx, ky + KNOBS.r * sx * 2.1, { size: 12, align: 'center', color: C.legendDim, track: 0.12 });
    }
  }

  // ---- placards and markings ------------------------------------------------
  // Above the visibility band — decorative, and the reflection in the canopy is
  // the only place a pilot ever really sees them.
  placard(L, PX(-0.585), PY(PANEL.h / 2 - 0.012), 0.19 * sx, 0.036 * sy, ['CAUTION', 'EJECT SEAT ARMED'], { accent: C.orange });
  placard(L, PX(0.395), PY(PANEL.h / 2 - 0.012), 0.19 * sx, 0.036 * sy, ['F-109A  BLK IV', 'TCS MIDWAY  VF-32'], { accent: C.legendDim, fill: '#191d20' });
  litLegend(L, 'MASTER CAUTION', PX(0), PY(0.140), { size: 20, align: 'center', color: C.amber, glow: C.amber, track: 0.16 });
  hazardStripes(L.alb, { x: PX(-0.085), y: PY(-PANEL.h / 2 + 0.020), w: 0.17 * sx, h: 15, pitch: 15, angle: Math.PI / 4, colorA: C.orange, colorB: '#16191b', alpha: 0.85 });

  // ---- wear where hands actually go -----------------------------------------
  grime(L, PX(-0.19), PY(0.10), 0.38 * sx, 0.22 * sy, rng, 1.4);
  grime(L, PX(-0.60), PY(-0.10), 0.30 * sx, 0.16 * sy, rng, 0.9);
  grime(L, PX(0.30), PY(-0.10), 0.30 * sx, 0.16 * sy, rng, 0.9);
}

const MFD_KEYS = ['TGT', 'ZM+', 'ZM-', 'IFF', 'DMG', 'SYS', 'CAM', 'RST'];

/** Recessed pocket a physical toggle sits in, with its stencilled legend. */
function switchPocket(L, x, y, label) {
  L.hgt.save();
  L.hgt.fillStyle = radialRamp(L.hgt, x, y, 0, 15, [[0, '#000000', 0.6], [0.72, '#000000', 0.4], [1, '#ffffff', 0.16]]);
  L.hgt.beginPath(); L.hgt.arc(x, y, 15, 0, Math.PI * 2); L.hgt.fill();
  L.hgt.restore();
  L.alb.save();
  L.alb.fillStyle = '#121618';
  L.alb.beginPath(); L.alb.arc(x, y, 12, 0, Math.PI * 2); L.alb.fill();
  L.alb.restore();
  if (label) legend(L.alb, label, x, y + 27, { size: 11, align: 'center', color: C.legendDim, track: 0.12 });
}

const SWITCH_LEGENDS = ['MSTR', 'GUN', 'MSL', 'SHLD', 'ECM', 'DCOY', 'NAV', 'AUTO', 'ITTS', 'IFF', 'LDG', 'EXT', 'PWR', 'RCS'];

/**
 * Glareshield.
 *
 * The loft in geometry.js maps the *deck* — the only face the pilot can see —
 * into v ∈ [0, 0.70], i.e. the bottom 70 % of this region, with the near lip at
 * the bottom edge. Everything worth painting therefore goes below `deckTop`.
 */
function paintCoaming(L, rng) {
  const [x, y, w, h] = REGIONS.coaming;
  basePaint(L, REGIONS.coaming, rng, { color: C.paintDark, wear: 0.7, brushAngle: 0, rough: 0.86, metal: 0.02 });
  const deckTop = y + h * 0.30;
  const deckH = h * 0.70;

  // Anti-glare surface: matte, dark, with the far edge falling into the hood's
  // own shadow and the near lip catching the light.
  L.alb.save();
  L.alb.fillStyle = gradientRamp(L.alb, x, deckTop, x, y + h, [
    [0, '#000000', 0.45], [0.55, '#000000', 0.12], [0.92, '#000000', 0.0], [1, '#aab3b8', 0.10],
  ]);
  L.alb.fillRect(x, deckTop, w, deckH);
  L.alb.restore();

  // Chordwise stiffener scribes across the deck.
  for (let i = 0; i < 13; i++) {
    const sx = x + w * (0.04 + i * 0.0767);
    scribe(L, sx, deckTop + 8, sx, y + h - 6, { width: 3, depth: 0.34 });
  }
  scribe(L, x, deckTop + deckH * 0.30, x + w, deckTop + deckH * 0.30, { width: 4, depth: 0.42 });
  screws(L, x + 10, deckTop + 8, w - 20, deckH - 16, rng, { inset: 13, radius: 4, every: 118 });

  // Markings, sized against the deck rather than the whole region.
  legend(L.alb, 'DO NOT STEP', x + w * 0.30, deckTop + deckH * 0.52, {
    size: 26, align: 'center', color: 'rgba(224,122,42,0.55)', track: 0.32,
  });
  legend(L.alb, 'DO NOT STEP', x + w * 0.70, deckTop + deckH * 0.52, {
    size: 26, align: 'center', color: 'rgba(224,122,42,0.55)', track: 0.32,
  });
  placard(L, x + w * 0.44, deckTop + deckH * 0.18, w * 0.12, deckH * 0.24, ['VF-32', 'BLACK ACES'], { accent: C.legendDim, fill: '#15181a' });
  hazardStripes(L.alb, { x: x + w * 0.02, y: y + h - 16, w: w * 0.14, h: 12, pitch: 13, angle: Math.PI / 4, colorA: C.orange, colorB: '#16191b', alpha: 0.55 });
  hazardStripes(L.alb, { x: x + w * 0.84, y: y + h - 16, w: w * 0.14, h: 12, pitch: 13, angle: Math.PI / 4, colorA: C.orange, colorB: '#16191b', alpha: 0.55 });

  // Scuff along the near lip, where a boot and a helmet actually land.
  grime(L, x, y + h - 40, w, 40, rng, 1.8);
  grime(L, x, deckTop, w, deckH, rng, 1.0);
}

function paintConsoles(L, rng) {
  const [x, y, w, h] = REGIONS.console;
  basePaint(L, REGIONS.console, rng, { color: C.paint, wear: 0.6, brushAngle: 0.1, rough: 0.6, metal: 0.08 });

  // Two console decks side by side inside the region: left (throttle) / right (stick).
  for (let deck = 0; deck < 2; deck++) {
    const dx = x + deck * (w / 2);
    const dw = w / 2;
    subPanel(L, dx + 12, y + 12, dw - 24, h - 24, { r: 8, rise: 0.12 });
    screws(L, dx + 12, y + 12, dw - 24, h - 24, rng, { inset: 11, radius: 4, every: 110 });

    // Rows of guarded rockers and circuit breakers.
    for (let r = 0; r < 3; r++) {
      const ry = y + h * (0.26 + r * 0.22);
      for (let cIdx = 0; cIdx < 6; cIdx++) {
        const cx = dx + dw * (0.13 + cIdx * 0.148);
        L.hgt.save();
        roundRectPath(L.hgt, cx - 16, ry - 12, 32, 24, 4);
        L.hgt.fillStyle = rgbaCss('#000000', 0.5);
        L.hgt.fill();
        L.hgt.restore();
        L.alb.save();
        roundRectPath(L.alb, cx - 16, ry - 12, 32, 24, 4);
        L.alb.fillStyle = '#14181a';
        L.alb.fill();
        L.alb.restore();
        legend(L.alb, CONSOLE_LEGENDS[(deck * 18 + r * 6 + cIdx) % CONSOLE_LEGENDS.length], cx, ry + 27, {
          size: 10, align: 'center', color: C.legendDim, track: 0.1,
        });
      }
    }
    // Power / systems strip, backlit.
    litLegend(L, deck === 0 ? 'THROTTLE  ·  ENGINE  ·  FUEL' : 'WEAPONS  ·  COMMS  ·  ECM',
      dx + dw / 2, y + h * 0.14, { size: 15, align: 'center', glow: C.cyan, track: 0.2 });
    hazardStripes(L.alb, { x: dx + dw * 0.06, y: y + h * 0.86, w: dw * 0.28, h: 14, pitch: 14, angle: Math.PI / 4, colorA: C.red, colorB: '#16191b', alpha: 0.7 });
    legend(L.alb, deck === 0 ? 'FUEL DUMP' : 'JETTISON', dx + dw * 0.44, y + h * 0.895, { size: 12, color: C.red, track: 0.14 });
    grime(L, dx, y + h * 0.2, dw, h * 0.7, rng, 1.1);
  }
}

const CONSOLE_LEGENDS = [
  'AB', 'FUEL', 'X-FD', 'PUMP', 'IGN', 'PURGE',
  'AVI', 'RDR', 'IFF', 'TCN', 'ILS', 'DTA',
  'ANTI', 'ICE', 'PITOT', 'DEFOG', 'VENT', 'O2',
  'GUN', 'MSL', 'ARM', 'SAFE', 'CHAF', 'FLARE',
  'RWR', 'JAM', 'TOW', 'DISP', 'MODE', 'TEST',
  'LT', 'FORM', 'NAV', 'ANTI', 'STRB', 'PNL',
];

function paintGrey(L, rng) {
  const [x, y, w, h] = REGIONS.grey;
  basePaint(L, REGIONS.grey, rng, { color: C.paintDark, wear: 0.4, rough: 0.72, metal: 0.05 });
  for (let i = 0; i < 6; i++) {
    const sy = y + h * (0.1 + i * 0.16);
    scribe(L, x, sy, x + w, sy, { width: 3, depth: 0.32 });
  }
  screws(L, x + 6, y + 6, w - 12, h - 12, rng, { inset: 14, radius: 3.6, every: 140 });
}

function paintFrame(L, rng) {
  const [x, y, w, h] = REGIONS.frame;
  basePaint(L, REGIONS.frame, rng, { color: '#3c4348', wear: 0.85, brushAngle: Math.PI / 2, rough: 0.44, metal: 0.55 });
  // Longitudinal rib flanges plus a dense fastener run — canopy frames are the
  // most fastener-heavy thing in a cockpit and it is what makes them read.
  for (let i = 0; i < 5; i++) {
    const sx = x + w * (0.12 + i * 0.19);
    scribe(L, sx, y, sx, y + h, { width: 5, depth: 0.5 });
  }
  const rng2 = rng;
  for (let i = 0; i < 46; i++) {
    const fx = x + w * (0.04 + (i % 2) * 0.9 + rng2.range(-0.02, 0.02));
    const fy = y + h * (0.03 + (i / 46) * 0.94);
    L.hgt.save();
    L.hgt.fillStyle = radialRamp(L.hgt, fx, fy, 0, 7, [[0, '#ffffff', 0.5], [0.72, '#dddddd', 0.25], [0.85, '#000000', 0.45], [1, '#000000', 0]]);
    L.hgt.beginPath(); L.hgt.arc(fx, fy, 7, 0, Math.PI * 2); L.hgt.fill();
    L.hgt.restore();
    L.alb.save();
    L.alb.fillStyle = radialRamp(L.alb, fx - 2, fy - 2, 0, 8, [[0, '#c9d1d6', 0.55], [0.7, '#5b6469', 0.4], [1, '#000000', 0.35]]);
    L.alb.beginPath(); L.alb.arc(fx, fy, 8, 0, Math.PI * 2); L.alb.fill();
    L.alb.restore();
  }
  // Paint chipped back to bare alloy along the edges the pilot's helmet hits.
  L.alb.save();
  L.alb.beginPath(); L.alb.rect(x, y, w, h); L.alb.clip();
  seededSplatter(L.alb, { rng, count: 220, x, y, w, h, radius: [1.5, 7], alpha: [0.18, 0.55], color: '#aab3b8', clusters: 16, clusterSpread: 0.08 });
  L.alb.restore();
  L.orm.save();
  L.orm.beginPath(); L.orm.rect(x, y, w, h); L.orm.clip();
  seededSplatter(L.orm, { rng, count: 220, x, y, w, h, radius: [1.5, 7], alpha: [0.3, 0.8], color: '#0000ff', clusters: 16, clusterSpread: 0.08 });
  L.orm.restore();
}

function paintTrim(L, rng) {
  const [x, y, w, h] = REGIONS.trim;
  basePaint(L, REGIONS.trim, rng, { color: C.trimMetal, wear: 1.0, brushAngle: 0, rough: 0.3, metal: 0.85 });
  L.alb.save();
  L.alb.beginPath(); L.alb.rect(x, y, w, h); L.alb.clip();
  brushedStreaks(L.alb, { rng, count: 700, x, y, w, h, angle: 0, spread: 0.012, length: [0.2, 0.8], width: [0.4, 1.8], alpha: [0.03, 0.14], color: '#e6edf1' });
  brushedStreaks(L.alb, { rng, count: 500, x, y, w, h, angle: 0, spread: 0.012, length: [0.2, 0.8], width: [0.4, 1.6], alpha: [0.03, 0.14], color: '#1d2225' });
  seededSplatter(L.alb, { rng, count: 90, x, y, w, h, radius: [8, 40], alpha: [0.03, 0.12], color: '#2b3033', clusters: 8, clusterSpread: 0.14 });
  L.alb.restore();
  L.orm.save();
  L.orm.beginPath(); L.orm.rect(x, y, w, h); L.orm.clip();
  seededSplatter(L.orm, { rng, count: 160, x, y, w, h, radius: [6, 34], alpha: [0.1, 0.35], color: '#00cc00', clusters: 10, clusterSpread: 0.12 });
  L.orm.restore();
}

function paintDetail(L, rng) {
  const [x, y, w, h] = REGIONS.detail;
  basePaint(L, REGIONS.detail, rng, { color: '#1a1e20', wear: 0.9, rough: 0.68, metal: 0.06 });
  // Moulded grip texture: a diamond knurl, which is what a stick grip actually is.
  L.hgt.save();
  L.hgt.beginPath(); L.hgt.rect(x, y, w, h); L.hgt.clip();
  L.hgt.strokeStyle = rgbaCss('#ffffff', 0.28);
  L.hgt.lineWidth = 2;
  for (let i = -h; i < w; i += 13) {
    L.hgt.beginPath(); L.hgt.moveTo(x + i, y); L.hgt.lineTo(x + i + h, y + h); L.hgt.stroke();
    L.hgt.beginPath(); L.hgt.moveTo(x + i + h, y); L.hgt.lineTo(x + i, y + h); L.hgt.stroke();
  }
  L.hgt.restore();
  L.alb.save();
  L.alb.beginPath(); L.alb.rect(x, y, w, h); L.alb.clip();
  seededSplatter(L.alb, { rng, count: 260, x, y, w, h, radius: [4, 26], alpha: [0.03, 0.12], color: '#000000', clusters: 12, clusterSpread: 0.13 });
  seededSplatter(L.alb, { rng, count: 160, x, y, w, h, radius: [2, 9], alpha: [0.06, 0.22], color: '#77807f', clusters: 10, clusterSpread: 0.1 });
  L.alb.restore();
}

/**
 * MFD bezel face.
 *
 * The bezel geometry planar-maps its entire square front face into this region,
 * so pixel (u, v) here lands exactly on the corresponding point of the frame.
 * The centre is the screen aperture — nothing painted there is ever seen — and
 * the four margins carry the soft keys, which is the only place they can go:
 * painted on the panel they would sit *behind* the bezel.
 */
function paintPlate(L, rng) {
  const [x, y, w, h] = REGIONS.plate;
  basePaint(L, REGIONS.plate, rng, { color: '#343c41', wear: 0.95, brushAngle: 0, rough: 0.34, metal: 0.72 });

  // Anodised frame with a machined inner lip.
  const inset = w * (MFD.bezel / (MFD.size + MFD.bezel * 2));
  L.hgt.save();
  roundRectPath(L.hgt, x + 6, y + 6, w - 12, h - 12, 22);
  L.hgt.fillStyle = rgbaCss('#ffffff', 0.18);
  L.hgt.fill();
  roundRectPath(L.hgt, x + inset * 0.72, y + inset * 0.72, w - inset * 1.44, h - inset * 1.44, 14);
  L.hgt.strokeStyle = rgbaCss('#000000', 0.6);
  L.hgt.lineWidth = 6;
  L.hgt.stroke();
  L.hgt.restore();

  L.alb.save();
  L.alb.fillStyle = gradientRamp(L.alb, x, y, x, y + h, [[0, '#ffffff', 0.10], [0.5, '#000000', 0.06], [1, '#000000', 0.26]]);
  L.alb.fillRect(x, y, w, h);
  L.alb.restore();

  // Soft keys: four a side, aligned with the display's row pitch.
  for (let i = 0; i < 4; i++) {
    const ky = y + inset + (h - inset * 2) * (0.155 + i * 0.23);
    for (const side of [0, 1]) {
      const kx = side === 0 ? x + inset * 0.5 : x + w - inset * 0.5;
      L.hgt.save();
      roundRectPath(L.hgt, kx - inset * 0.32, ky - 11, inset * 0.64, 22, 4);
      L.hgt.fillStyle = rgbaCss('#000000', 0.45);
      L.hgt.fill();
      L.hgt.restore();
      L.alb.save();
      roundRectPath(L.alb, kx - inset * 0.32, ky - 11, inset * 0.64, 22, 4);
      L.alb.fillStyle = '#14181a';
      L.alb.fill();
      L.alb.restore();
      litLegend(L, MFD_KEYS[side * 4 + i], kx, ky + 5, {
        size: 15, align: 'center', color: C.legend, glow: C.cyan, track: 0.06,
      });
    }
  }

  // Data plate along the bottom rail, and a dark surround inside the aperture.
  litLegend(L, 'MULTI FUNCTION DISPLAY', x + w / 2, y + h - inset * 0.30, {
    size: 15, align: 'center', color: C.legendDim, glow: C.cyan, track: 0.2,
  });
  legend(L.alb, 'PWR  BRT  CON  MODE', x + w / 2, y + inset * 0.62, {
    size: 14, align: 'center', color: C.legendDim, track: 0.18, font: FONT_MONO,
  });
  L.alb.save();
  roundRectPath(L.alb, x + inset, y + inset, w - inset * 2, h - inset * 2, 10);
  L.alb.fillStyle = '#050708';
  L.alb.fill();
  L.alb.restore();
  orm(L, x + inset, y + inset, w - inset * 2, h - inset * 2, { rough: 0.22, metal: 0.0, ao: 0.35 });

  screws(L, x + 10, y + 10, w - 20, h - 20, rng, { inset: 16, radius: 4.6, every: 150 });
}

// ---------------------------------------------------------------------- build

/**
 * @param {import('../core/Engine.js').Engine} engine
 * @returns {{map:THREE.Texture, normalMap:THREE.Texture, ormMap:THREE.Texture, emissiveMap:THREE.Texture}}
 */
export function buildCockpitAtlas(engine, { seed = 9137, size = ATLAS_SIZE } = {}) {
  const key = `cockpit/atlas/${size}/${seed}`;
  const make = () => {
    const rng = makeRng(seed);
    const L = makeLayers(size);

    paintGrey(L, rng);
    paintMainPanel(L, rng);
    paintCoaming(L, rng);
    paintConsoles(L, rng);
    paintFrame(L, rng);
    paintTrim(L, rng);
    paintDetail(L, rng);
    paintPlate(L, rng);

    const map = new THREE.CanvasTexture(L.canvases.alb.canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = engine?.maxAnisotropy ?? 4;
    map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
    map.needsUpdate = true;

    const height = canvasLuma(L.canvases.hgt.canvas);
    const nrm = heightToNormal(height, size, 2.6);
    const normalMap = new THREE.DataTexture(nrm, size, size, THREE.RGBAFormat);
    normalMap.colorSpace = THREE.NoColorSpace;
    normalMap.wrapS = normalMap.wrapT = THREE.ClampToEdgeWrapping;
    normalMap.minFilter = THREE.LinearMipmapLinearFilter;
    normalMap.magFilter = THREE.LinearFilter;
    normalMap.generateMipmaps = true;
    normalMap.anisotropy = engine?.maxAnisotropy ?? 4;
    normalMap.needsUpdate = true;

    const ormMap = new THREE.CanvasTexture(L.canvases.orm.canvas);
    ormMap.colorSpace = THREE.NoColorSpace;
    ormMap.anisotropy = 4;
    ormMap.wrapS = ormMap.wrapT = THREE.ClampToEdgeWrapping;
    ormMap.needsUpdate = true;

    const emissiveMap = new THREE.CanvasTexture(L.canvases.ems.canvas);
    emissiveMap.colorSpace = THREE.SRGBColorSpace;
    emissiveMap.anisotropy = 4;
    emissiveMap.wrapS = emissiveMap.wrapT = THREE.ClampToEdgeWrapping;
    emissiveMap.needsUpdate = true;

    return { map, normalMap, ormMap, emissiveMap, size };
  };
  return engine?.registry ? engine.registry.get(key, make) : make();
}

/** The one material the merged cockpit tub wears. */
export function createCockpitMaterial(engine, atlas) {
  return engine.registry.get('cockpit/mat/tub', () => new THREE.MeshPhysicalMaterial({
    name: 'cockpit-tub',
    map: atlas.map,
    normalMap: atlas.normalMap,
    normalScale: new THREE.Vector2(1.15, 1.15),
    // glTF ORM packing: one texture, three channels.
    aoMap: atlas.ormMap,
    roughnessMap: atlas.ormMap,
    metalnessMap: atlas.ormMap,
    emissiveMap: atlas.emissiveMap,
    emissive: new THREE.Color(0xffffff),
    // Backlit legends are allowed over 1.0 — they should catch the bloom pass.
    emissiveIntensity: 2.0,
    roughness: 1,
    metalness: 1,
    aoMapIntensity: 0.85,
    clearcoat: 0.18,
    clearcoatRoughness: 0.42,
    envMapIntensity: 1.0,
    dithering: true,
  }));
}
