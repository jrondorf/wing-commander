/**
 * src/ui/portrait.js — procedural speaker portraits.
 *
 * No image assets exist in this project and none may be added (ARCHITECTURE §1),
 * so every face on the comms channel is drawn from a seed derived from the
 * speaker's callsign. That is not a compromise: it means an AI-generated pilot
 * roster gets consistent faces for free, and the same callsign always looks the
 * same in the briefing pip and the in-flight plate.
 *
 * Two species paths:
 *   human   flight helmet, visor (up or down), oxygen mask on some pilots,
 *           squadron flash, rim light in the faction tint
 *   alien   chitin carapace, eye cluster, mandibles — the Nephilim silhouette
 *
 * The static bust is baked once per speaker into an offscreen canvas; only the
 * mouth/mandibles, the transmission interference and the scanline phase are
 * redrawn per frame. A talking head that never moves is worse than no portrait.
 */
import { makeRng, hashSeed } from '../core/Rand.js';
import { hexA } from './backdrop.js';
import { FACTION_TINT } from './theme.js';

const SKIN = ['#e0b391', '#c98f68', '#9c6440', '#6f4429', '#4a2e1c', '#f0c9a8', '#8a5b3a'];
const SUIT = ['#2b3640', '#333c44', '#26313a', '#3a3f3a'];
const HELMET = ['#c9ced4', '#8e979f', '#5d6970', '#b6a892', '#7a8288'];
const FLASH = ['#e07a2a', '#7fe4ff', '#ffb04a', '#6bffae', '#ff5a45', '#c8cdd2'];

const baseCache = new Map();

/** Derive a stable appearance from the speaker's callsign + faction. */
export function portraitSpec(key, faction = 'confed') {
  const r = makeRng(hashSeed(`portrait:${key}:${faction}`));
  const alien = faction && !['confed', 'militia', 'civilian', 'terran', 'player'].includes(faction);
  const tint = FACTION_TINT[faction] ?? (alien ? FACTION_TINT.alien : FACTION_TINT.confed);
  return {
    key: `${key}|${faction}`,
    alien,
    tint,
    skin: r.pick(SKIN),
    suit: r.pick(SUIT),
    helmet: r.pick(HELMET),
    flash: r.pick(FLASH),
    visorDown: r.bool(0.34),
    mask: r.bool(0.4),
    jaw: r.range(0.82, 1.06),
    headW: r.range(0.90, 1.08),
    brow: r.range(0.9, 1.12),
    eyeGap: r.range(0.92, 1.1),
    tilt: r.range(-0.06, 0.06),
    chitin: r.pick(['#6f6a3e', '#5a5230', '#4a5340', '#6b4f2e']),
    eyes: r.int(3, 6),
    ridges: r.int(3, 5),
    seed: r.int(1, 1e6),
  };
}

/** Bake the parts that never move. Cached per speaker + pixel size. */
function baseFor(spec, w, h) {
  const ck = `${spec.key}|${w}x${h}`;
  let cv = baseCache.get(ck);
  if (cv) return cv;
  cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d');
  if (spec.alien) drawAlienBust(c, w, h, spec);
  else drawHumanBust(c, w, h, spec);
  if (baseCache.size > 48) baseCache.delete(baseCache.keys().next().value);
  baseCache.set(ck, cv);
  return cv;
}

// --------------------------------------------------------------------- human

function drawHumanBust(c, W, H, s) {
  const cx = W * 0.5;
  c.save();
  c.translate(cx, 0);
  c.rotate(s.tilt);
  c.translate(-cx, 0);

  drawCabin(c, W, H, s.tint, s.seed);

  const headW = W * 0.30 * s.headW;
  const headH = H * 0.26;
  const headY = H * 0.40;

  // ---- shoulders + torso
  c.beginPath();
  c.moveTo(-W * 0.10, H + 4);
  c.bezierCurveTo(W * 0.02, H * 0.78, W * 0.24, H * 0.70, cx - W * 0.10, H * 0.665);
  c.lineTo(cx + W * 0.10, H * 0.665);
  c.bezierCurveTo(W * 0.76, H * 0.70, W * 0.98, H * 0.78, W * 1.10, H + 4);
  c.closePath();
  const sg = c.createLinearGradient(0, H * 0.62, W, H);
  sg.addColorStop(0, shade(s.suit, -0.45));
  sg.addColorStop(0.35, s.suit);
  sg.addColorStop(1, shade(s.suit, -0.55));
  c.fillStyle = sg;
  c.fill();
  // Collar + a shoulder seam so the suit is not one flat slab.
  c.strokeStyle = hexA('#ffffff', 0.10);
  c.lineWidth = Math.max(1, H * 0.006);
  c.stroke();
  c.beginPath();
  c.moveTo(cx - W * 0.20, H * 0.80);
  c.quadraticCurveTo(cx, H * 0.74, cx + W * 0.20, H * 0.80);
  c.strokeStyle = hexA('#000000', 0.45);
  c.stroke();
  // Rank tab on the shoulder.
  c.fillStyle = hexA(s.flash, 0.75);
  c.fillRect(cx + W * 0.24, H * 0.83, W * 0.10, H * 0.018);
  c.fillRect(cx + W * 0.24, H * 0.87, W * 0.07, H * 0.018);

  // ---- neck
  c.fillStyle = shade(s.skin, -0.32);
  c.beginPath();
  c.ellipse(cx, H * 0.655, headW * 0.42, headH * 0.34, 0, 0, Math.PI * 2);
  c.fill();

  // ---- head
  c.beginPath();
  c.moveTo(cx - headW, headY);
  c.bezierCurveTo(cx - headW, headY - headH * 0.95, cx + headW, headY - headH * 0.95, cx + headW, headY);
  c.bezierCurveTo(cx + headW * 0.98, headY + headH * 0.72 * s.jaw,
    cx + headW * 0.42, headY + headH * 1.16 * s.jaw, cx, headY + headH * 1.20 * s.jaw);
  c.bezierCurveTo(cx - headW * 0.42, headY + headH * 1.16 * s.jaw,
    cx - headW * 0.98, headY + headH * 0.72 * s.jaw, cx - headW, headY);
  c.closePath();
  const fg = c.createRadialGradient(cx - headW * 0.45, headY - headH * 0.4, headW * 0.1,
    cx, headY, headW * 1.9);
  fg.addColorStop(0, shade(s.skin, 0.18));
  fg.addColorStop(0.55, s.skin);
  fg.addColorStop(1, shade(s.skin, -0.55));
  c.fillStyle = fg;
  c.fill();

  // ---- features
  const eyeY = headY + headH * 0.10;
  const ex = headW * 0.42 * s.eyeGap;
  // Brow shadow gives the face structure a flat fill cannot.
  c.fillStyle = hexA('#000000', 0.22);
  c.beginPath();
  c.ellipse(cx, eyeY - headH * 0.16 * s.brow, headW * 0.82, headH * 0.16, 0, 0, Math.PI);
  c.fill();
  for (const sgn of [-1, 1]) {
    c.fillStyle = hexA('#1a1410', 0.85);
    c.beginPath();
    c.ellipse(cx + sgn * ex, eyeY, headW * 0.17, headH * 0.075, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = hexA('#ffffff', 0.55);
    c.beginPath();
    c.arc(cx + sgn * ex - headW * 0.05, eyeY - headH * 0.02, headW * 0.035, 0, Math.PI * 2);
    c.fill();
    // Eyebrow.
    c.strokeStyle = hexA(shade(s.skin, -0.7), 0.9);
    c.lineWidth = Math.max(1, headH * 0.055);
    c.beginPath();
    c.moveTo(cx + sgn * (ex - headW * 0.20), eyeY - headH * 0.20 * s.brow);
    c.quadraticCurveTo(cx + sgn * ex, eyeY - headH * 0.27 * s.brow,
      cx + sgn * (ex + headW * 0.20), eyeY - headH * 0.19 * s.brow);
    c.stroke();
  }
  // Nose: one shadow edge, one lit edge.
  c.strokeStyle = hexA('#000000', 0.30);
  c.lineWidth = Math.max(1, headH * 0.04);
  c.beginPath();
  c.moveTo(cx + headW * 0.06, eyeY + headH * 0.04);
  c.lineTo(cx + headW * 0.11, eyeY + headH * 0.42);
  c.quadraticCurveTo(cx + headW * 0.02, eyeY + headH * 0.50, cx - headW * 0.06, eyeY + headH * 0.45);
  c.stroke();

  // ---- helmet shell
  const hy = headY - headH * 0.10;
  c.beginPath();
  c.moveTo(cx - headW * 1.14, hy + headH * 0.30);
  c.bezierCurveTo(cx - headW * 1.16, headY - headH * 1.30,
    cx + headW * 1.16, headY - headH * 1.30, cx + headW * 1.14, hy + headH * 0.30);
  c.lineTo(cx + headW * 1.14, hy + headH * 0.10);
  c.bezierCurveTo(cx + headW * 0.6, hy - headH * 0.28, cx - headW * 0.6, hy - headH * 0.28,
    cx - headW * 1.14, hy + headH * 0.10);
  c.closePath();
  const hg = c.createLinearGradient(cx - headW, headY - headH, cx + headW, headY);
  hg.addColorStop(0, shade(s.helmet, 0.22));
  hg.addColorStop(0.42, s.helmet);
  hg.addColorStop(1, shade(s.helmet, -0.5));
  c.fillStyle = hg;
  c.fill();
  c.strokeStyle = hexA('#000000', 0.5);
  c.lineWidth = 1;
  c.stroke();
  // Squadron flash + a hull-numbered chevron.
  c.fillStyle = hexA(s.flash, 0.9);
  c.beginPath();
  c.moveTo(cx - headW * 0.12, headY - headH * 1.24);
  c.lineTo(cx + headW * 0.12, headY - headH * 1.24);
  c.lineTo(cx + headW * 0.16, hy + headH * 0.05);
  c.lineTo(cx - headW * 0.16, hy + headH * 0.05);
  c.closePath();
  c.fill();
  c.fillStyle = hexA(shade(s.flash, -0.35), 0.85);
  c.beginPath();
  c.moveTo(cx - headW * 0.72, hy - headH * 0.02);
  c.lineTo(cx - headW * 0.44, hy - headH * 0.16);
  c.lineTo(cx - headW * 0.44, hy + headH * 0.02);
  c.closePath();
  c.fill();
  // Ear cup.
  c.fillStyle = shade(s.helmet, -0.42);
  c.beginPath();
  c.ellipse(cx + headW * 0.92, headY + headH * 0.06, headW * 0.24, headH * 0.30, 0, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = hexA('#000', 0.4);
  c.stroke();

  if (s.visorDown) {
    c.beginPath();
    c.moveTo(cx - headW * 1.10, hy + headH * 0.16);
    c.bezierCurveTo(cx - headW * 0.9, headY + headH * 0.56,
      cx + headW * 0.9, headY + headH * 0.56, cx + headW * 1.10, hy + headH * 0.16);
    c.closePath();
    const vg = c.createLinearGradient(cx - headW, hy, cx + headW, headY + headH * 0.4);
    vg.addColorStop(0, hexA('#0a1a24', 0.92));
    vg.addColorStop(0.5, hexA('#123a4a', 0.88));
    vg.addColorStop(1, hexA('#04080c', 0.95));
    c.fillStyle = vg;
    c.fill();
    // Specular smear across the visor: the single detail that says "glass".
    c.save();
    c.clip();
    c.strokeStyle = hexA('#cfefff', 0.30);
    c.lineWidth = Math.max(1.4, headH * 0.09);
    c.beginPath();
    c.moveTo(cx - headW * 1.1, headY + headH * 0.30);
    c.lineTo(cx + headW * 0.2, hy - headH * 0.05);
    c.stroke();
    c.strokeStyle = hexA(s.tint, 0.18);
    c.lineWidth = Math.max(1, headH * 0.03);
    c.beginPath();
    c.moveTo(cx - headW * 1.1, headY + headH * 0.48);
    c.lineTo(cx + headW * 0.6, headY - headH * 0.05);
    c.stroke();
    c.restore();
  } else {
    // Visor parked on the brow.
    c.fillStyle = hexA('#0d222c', 0.9);
    c.beginPath();
    c.moveTo(cx - headW * 1.12, hy + headH * 0.06);
    c.quadraticCurveTo(cx, hy - headH * 0.30, cx + headW * 1.12, hy + headH * 0.06);
    c.quadraticCurveTo(cx, hy - headH * 0.06, cx - headW * 1.12, hy + headH * 0.06);
    c.closePath();
    c.fill();
  }

  if (s.mask) {
    // Oxygen mask + hose. Drawn after the face so it occludes the mouth region.
    c.fillStyle = shade(s.suit, 0.12);
    c.beginPath();
    c.moveTo(cx - headW * 0.72, headY + headH * 0.34);
    c.bezierCurveTo(cx - headW * 0.80, headY + headH * 1.10,
      cx + headW * 0.80, headY + headH * 1.10, cx + headW * 0.72, headY + headH * 0.34);
    c.bezierCurveTo(cx + headW * 0.3, headY + headH * 0.48, cx - headW * 0.3, headY + headH * 0.48,
      cx - headW * 0.72, headY + headH * 0.34);
    c.closePath();
    c.fill();
    c.strokeStyle = hexA('#000', 0.45);
    c.stroke();
    c.strokeStyle = shade(s.suit, -0.3);
    c.lineWidth = Math.max(2, headW * 0.14);
    c.beginPath();
    c.moveTo(cx + headW * 0.55, headY + headH * 0.82);
    c.quadraticCurveTo(cx + headW * 1.3, headY + headH * 1.35, cx + headW * 1.2, H);
    c.stroke();
  }

  drawRim(c, W, H, s.tint);
  c.restore();
}

// --------------------------------------------------------------------- alien

function drawAlienBust(c, W, H, s) {
  const cx = W * 0.5;
  const r = makeRng(s.seed);
  drawCabin(c, W, H, s.tint, s.seed);

  const headW = W * 0.30;
  const headH = H * 0.30;
  const headY = H * 0.42;

  // Carapace shoulders — bladed, not rounded.
  c.beginPath();
  c.moveTo(-W * 0.08, H + 4);
  c.lineTo(W * 0.14, H * 0.74);
  c.lineTo(cx - W * 0.09, H * 0.68);
  c.lineTo(cx + W * 0.09, H * 0.68);
  c.lineTo(W * 0.86, H * 0.74);
  c.lineTo(W * 1.08, H + 4);
  c.closePath();
  const sg = c.createLinearGradient(0, H * 0.66, W, H);
  sg.addColorStop(0, shade(s.chitin, -0.55));
  sg.addColorStop(0.4, s.chitin);
  sg.addColorStop(1, shade(s.chitin, -0.65));
  c.fillStyle = sg;
  c.fill();

  // Elongated skull.
  c.beginPath();
  c.moveTo(cx, headY - headH * 1.35);
  c.bezierCurveTo(cx + headW * 1.15, headY - headH * 0.9, cx + headW * 1.05, headY + headH * 0.5,
    cx + headW * 0.42, headY + headH * 1.05);
  c.bezierCurveTo(cx + headW * 0.18, headY + headH * 1.35, cx - headW * 0.18, headY + headH * 1.35,
    cx - headW * 0.42, headY + headH * 1.05);
  c.bezierCurveTo(cx - headW * 1.05, headY + headH * 0.5, cx - headW * 1.15, headY - headH * 0.9,
    cx, headY - headH * 1.35);
  c.closePath();
  const hg = c.createRadialGradient(cx - headW * 0.4, headY - headH * 0.6, headW * 0.1,
    cx, headY, headW * 2.0);
  hg.addColorStop(0, shade(s.chitin, 0.35));
  hg.addColorStop(0.5, s.chitin);
  hg.addColorStop(1, shade(s.chitin, -0.7));
  c.fillStyle = hg;
  c.fill();

  // Chitin ridges running back over the crown.
  c.strokeStyle = hexA('#000000', 0.35);
  for (let i = 0; i < s.ridges; i++) {
    const f = (i + 1) / (s.ridges + 1);
    c.lineWidth = Math.max(1, headH * 0.05 * (1 - f * 0.4));
    c.beginPath();
    c.moveTo(cx - headW * (0.9 - f * 0.3), headY - headH * (0.2 + f * 0.5));
    c.quadraticCurveTo(cx, headY - headH * (1.1 + f * 0.2),
      cx + headW * (0.9 - f * 0.3), headY - headH * (0.2 + f * 0.5));
    c.stroke();
  }
  // Wet sheen — organic hulls in this universe are always slick.
  c.strokeStyle = hexA('#e8ffd0', 0.22);
  c.lineWidth = Math.max(1, headH * 0.06);
  c.beginPath();
  c.moveTo(cx - headW * 0.7, headY - headH * 0.15);
  c.quadraticCurveTo(cx - headW * 0.35, headY - headH * 0.95, cx + headW * 0.15, headY - headH * 1.05);
  c.stroke();

  // Eye cluster: asymmetric, glowing.
  for (let i = 0; i < s.eyes; i++) {
    const a = -0.5 + (i / Math.max(1, s.eyes - 1)) * 1.0;
    const ex = cx + Math.sin(a * 2.2) * headW * 0.72;
    const ey = headY - headH * 0.05 + Math.cos(a * 1.4) * headH * 0.22 + r.range(-1, 1) * headH * 0.05;
    const rr = headW * r.range(0.07, 0.13);
    const g = c.createRadialGradient(ex, ey, 0, ex, ey, rr * 3.4);
    g.addColorStop(0, hexA('#e8ff9a', 0.95));
    g.addColorStop(0.3, hexA('#b8ff4a', 0.6));
    g.addColorStop(1, hexA('#b8ff4a', 0));
    c.fillStyle = g;
    c.beginPath(); c.arc(ex, ey, rr * 3.4, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#1a2208';
    c.beginPath(); c.arc(ex, ey, rr, 0, Math.PI * 2); c.fill();
    c.fillStyle = hexA('#ffffff', 0.6);
    c.beginPath(); c.arc(ex - rr * 0.3, ey - rr * 0.3, rr * 0.3, 0, Math.PI * 2); c.fill();
  }

  drawRim(c, W, H, s.tint);
}

// ------------------------------------------------------------------- shared

/** Dim cabin behind the speaker, so the bust is not floating on flat black. */
function drawCabin(c, W, H, tint, seed) {
  const r = makeRng(seed ^ 0x9e37);
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#0a1219');
  g.addColorStop(0.55, '#060c11');
  g.addColorStop(1, '#03060a');
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
  // Instrument glow from behind the pilot's shoulder.
  const gg = c.createRadialGradient(W * 0.86, H * 0.30, 0, W * 0.86, H * 0.30, W * 0.75);
  gg.addColorStop(0, hexA(tint, 0.22));
  gg.addColorStop(1, hexA(tint, 0));
  c.fillStyle = gg;
  c.fillRect(0, 0, W, H);
  // Structural ribs.
  c.strokeStyle = hexA('#6f8894', 0.13);
  c.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const x = r() * W;
    c.beginPath();
    c.moveTo(x, 0);
    c.lineTo(x + r.range(-0.1, 0.1) * W, H);
    c.stroke();
  }
}

/** Faction-tinted rim light down the right silhouette. */
function drawRim(c, W, H, tint) {
  const g = c.createLinearGradient(W * 0.62, 0, W, 0);
  g.addColorStop(0, hexA(tint, 0));
  g.addColorStop(1, hexA(tint, 0.16));
  c.globalCompositeOperation = 'screen';
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
  c.globalCompositeOperation = 'source-over';
}

function shade(hex, amt) {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((x) => x + x) : [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)];
  const rgb = n.map((s) => parseInt(s, 16)).map((v) => {
    const t = amt < 0 ? 0 : 255;
    return Math.round(v + (t - v) * Math.abs(amt));
  });
  return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Paint one portrait frame.
 *
 * @param {CanvasRenderingContext2D} ctx  target, already scaled to CSS pixels
 * @param {number} w,h                    CSS size
 * @param {object} spec                   from `portraitSpec`
 * @param {number} time                   seconds, for interference phase
 * @param {number} level                  0..1 speech envelope (drives the mouth)
 */
export function drawPortrait(ctx, w, h, spec, time, level) {
  const px = Math.max(2, Math.round(w));
  const py = Math.max(2, Math.round(h));
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(baseFor(spec, px, py), 0, 0, w, h);

  const cx = w * 0.5;
  const headW = w * 0.30 * (spec.alien ? 1 : spec.headW);
  const headH = h * (spec.alien ? 0.30 : 0.26);
  const headY = h * (spec.alien ? 0.42 : 0.40);
  const open = Math.max(0, level);

  ctx.save();
  if (!spec.alien) {
    ctx.translate(cx, 0); ctx.rotate(spec.tilt); ctx.translate(-cx, 0);
  }

  if (spec.alien) {
    // Mandibles hinge open on the envelope.
    const spread = 0.16 + open * 0.5;
    ctx.strokeStyle = hexA(shade(spec.chitin, -0.55), 0.95);
    ctx.lineWidth = Math.max(1.5, headH * 0.10);
    ctx.lineCap = 'round';
    for (const sgn of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx + sgn * headW * 0.30, headY + headH * 0.62);
      ctx.quadraticCurveTo(
        cx + sgn * headW * (0.55 + spread), headY + headH * (0.95 + spread * 0.4),
        cx + sgn * headW * (0.18 + spread * 0.5), headY + headH * (1.30 + spread * 0.5),
      );
      ctx.stroke();
    }
    ctx.fillStyle = hexA('#120d06', 0.85 * (0.3 + open));
    ctx.beginPath();
    ctx.ellipse(cx, headY + headH * 0.92, headW * 0.22, headH * (0.06 + open * 0.16), 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (spec.mask) {
    // Masked pilots show speech as a mic tally and mask flex.
    ctx.fillStyle = hexA('#ff5a45', 0.35 + open * 0.65);
    ctx.beginPath();
    ctx.arc(cx - headW * 0.62, headY + headH * 0.72, Math.max(1.2, headW * 0.07), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = hexA('#000000', 0.25 + open * 0.3);
    ctx.lineWidth = Math.max(1, headH * 0.05);
    ctx.beginPath();
    ctx.moveTo(cx - headW * 0.42, headY + headH * (0.86 + open * 0.05));
    ctx.quadraticCurveTo(cx, headY + headH * (0.98 + open * 0.12),
      cx + headW * 0.42, headY + headH * (0.86 + open * 0.05));
    ctx.stroke();
  } else {
    const my = headY + headH * 0.74;
    const mw = headW * (0.34 + open * 0.06);
    const mh = headH * (0.035 + open * 0.30);
    ctx.fillStyle = hexA('#2a0f0d', 0.9);
    ctx.beginPath();
    ctx.ellipse(cx, my, mw, mh, 0, 0, Math.PI * 2);
    ctx.fill();
    if (open > 0.25) {
      ctx.fillStyle = hexA('#f2e6df', 0.55);
      ctx.beginPath();
      ctx.ellipse(cx, my - mh * 0.55, mw * 0.82, mh * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // Lip line keeps a closed mouth from vanishing into the jaw shadow.
    ctx.strokeStyle = hexA('#000000', 0.35);
    ctx.lineWidth = Math.max(1, headH * 0.03);
    ctx.beginPath();
    ctx.moveTo(cx - mw * 1.15, my);
    ctx.quadraticCurveTo(cx, my + mh * 0.9, cx + mw * 1.15, my);
    ctx.stroke();
  }
  ctx.restore();

  // ---- transmission treatment
  // Rolling scanline pair.
  const roll = ((time * 42) % (h + 30)) - 15;
  const g = ctx.createLinearGradient(0, roll - 8, 0, roll + 8);
  g.addColorStop(0, hexA(spec.tint, 0));
  g.addColorStop(0.5, hexA(spec.tint, 0.10));
  g.addColorStop(1, hexA(spec.tint, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, roll - 8, w, 16);

  // Occasional dropout band — comms in a nebula are never clean.
  const glitch = Math.sin(time * 3.1) * Math.sin(time * 7.7 + 1.3);
  if (glitch > 0.86) {
    const by = ((time * 311) % 1) * h;
    const bh = h * 0.05;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = hexA(spec.tint, 0.14);
    ctx.fillRect(0, by, w, bh);
    ctx.restore();
    ctx.drawImage(baseFor(spec, px, py), 0, by, w, bh, w * 0.03, by, w, bh);
  }

  // Phosphor tint + slight bloom toward the faction colour.
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = hexA(spec.tint, 0.055 + open * 0.03);
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/** Convenience for static pips (briefing roster). One draw, no animation. */
export function paintPortraitTo(canvas, key, faction, { level = 0 } = {}) {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(8, Math.round(r.width || canvas.clientWidth || 32));
  const h = Math.max(8, Math.round(r.height || canvas.clientHeight || 40));
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawPortrait(ctx, w, h, portraitSpec(key, faction), 0, level);
}

export function clearPortraitCache() { baseCache.clear(); }
