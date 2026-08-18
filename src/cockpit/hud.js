/**
 * Head-up display.
 *
 * ## Why a canvas
 * The HUD is painted on a 2D canvas at the *drawing buffer's own resolution* and
 * mapped 1:1 onto a quad that exactly fills the cockpit camera's frustum. One
 * texel per pixel, no resampling, glyphs rasterised by the platform's font
 * engine with proper hinting. ARCHITECTURE §7 fails aliased HUD text
 * automatically, and every alternative — SDF atlases, geometry text, a
 * lower-resolution overlay stretched up — is measurably softer than this.
 *
 * The canvas is drawn in `#7fe4ff` and the quad's material multiplies it to ~1.6,
 * so the symbology sits above white in the HDR target and the bloom pass gives
 * it the phosphor halo without any blur being baked into the glyphs themselves.
 *
 * ## What is where
 *   centre        boresight reticle, ITTS lead pipper, velocity vector
 *   dynamic       target bracket + name/range/closure, target shield ring,
 *                 missile lock diamond, off-screen target caret
 *   left          speed tape with throttle bug, afterburner fuel, gun selector
 *   right         shield/armour quadrant gauge, missile selector, nav block
 *   top centre    threat and incoming-missile annunciators
 */

import { makeSurface, FONT_COND, FONT_MONO } from '../procgen/canvasKit.js';
import { HUD_COLOR, HUD_FLOOR } from './layout.js';

const CY = HUD_COLOR;
const RED = '#ff6a52';
const AMBER = '#ffc061';
const GREEN = '#8dffb0';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const R = Math.round;

function fmtRange(m) {
  if (m >= 100000) return `${(m / 1000).toFixed(0)}K`;
  if (m >= 1000) return `${(m / 1000).toFixed(1)}K`;
  return `${Math.round(m)}`;
}

export function createHudPainter() {
  let W = 2;
  let H = 2;
  let s = 1;                       // scale factor, 1.0 at 900 px tall
  const surf = makeSurface(2, 2, { alpha: true });
  let ctx = surf.ctx;

  const st = {
    canvas: surf.canvas,
    width: W,
    height: H,
  };

  function setSize(w, h) {
    W = Math.max(2, Math.round(w));
    H = Math.max(2, Math.round(h));
    surf.canvas.width = W;
    surf.canvas.height = H;
    ctx = surf.canvas.getContext('2d', { alpha: true, willReadFrequently: false });
    ctx.imageSmoothingEnabled = true;
    s = H / 900;
    st.width = W;
    st.height = H;
  }

  // ------------------------------------------------------------------ atoms
  function text(str, x, y, {
    size = 18, color = CY, align = 'left', track = 0.08, weight = 700,
    font = FONT_COND, alpha = 1, baseline = 'alphabetic',
  } = {}) {
    const px = Math.max(8, Math.round(size * s));
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `${weight} ${px}px ${font}`;
    ctx.textBaseline = baseline;
    ctx.fillStyle = color;
    const t = String(str);
    const gap = track * px;
    const widths = [];
    let total = 0;
    for (let i = 0; i < t.length; i++) {
      const wd = ctx.measureText(t[i]).width;
      widths.push(wd);
      total += wd + (i < t.length - 1 ? gap : 0);
    }
    let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
    cx = Math.round(cx);
    const yy = Math.round(y);
    for (let i = 0; i < t.length; i++) {
      if (t[i] !== ' ') ctx.fillText(t[i], cx, yy);
      cx += widths[i] + gap;
    }
    ctx.restore();
    return total;
  }

  /** Crisp 1-device-pixel stroke: snap to the half-pixel grid. */
  function line(x0, y0, x1, y1, { color = CY, width = 1.6, alpha = 1, dash = null } = {}) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, width * s);
    if (dash) ctx.setLineDash(dash.map((d) => d * s));
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.restore();
  }

  function poly(pts, { color = CY, width = 1.6, alpha = 1, close = false, fill = null } = {}) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, width * s);
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    if (close) ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    ctx.stroke();
    ctx.restore();
  }

  function arc(cx, cy, r, a0, a1, { color = CY, width = 2, alpha = 1 } = {}) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, width * s);
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a1);
    ctx.stroke();
    ctx.restore();
  }

  function box(x, y, w, h, { color = CY, width = 1.4, alpha = 1, fill = null } = {}) {
    ctx.save();
    ctx.globalAlpha = alpha;
    if (fill) { ctx.fillStyle = fill; ctx.fillRect(x, y, w, h); }
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, width * s);
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
    ctx.restore();
  }

  /** Ladder bar used by every quantity gauge on the HUD. */
  function ladder(x, y, w, h, frac, {
    color = CY, segments = 12, vertical = false, warn = 0.3, alpha = 1,
  } = {}) {
    const f = clamp01(frac);
    const lit = Math.round(f * segments);
    const c = f <= warn ? RED : color;
    const gap = Math.max(1, 2 * s);
    ctx.save();
    ctx.globalAlpha = alpha;
    for (let i = 0; i < segments; i++) {
      const on = i < lit;
      ctx.fillStyle = on ? c : color;
      ctx.globalAlpha = alpha * (on ? 1 : 0.20);
      if (vertical) {
        const sh = (h - gap * (segments - 1)) / segments;
        ctx.fillRect(R(x), R(y + h - (i + 1) * (sh + gap) + gap), R(w), Math.max(1, R(sh)));
      } else {
        const sw = (w - gap * (segments - 1)) / segments;
        ctx.fillRect(R(x + i * (sw + gap)), R(y), Math.max(1, R(sw)), Math.max(1, R(h)));
      }
    }
    ctx.restore();
  }

  // ------------------------------------------------------------- components

  /** Fixed boresight: where the guns point, before any lead. */
  function drawReticle(cx, cy, { status = 'ok', flash = 0 } = {}) {
    const r = 26 * s;
    const col = status === 'ok' ? CY : status === 'out-of-range' ? AMBER : CY;
    const a = status === 'ok' ? 1 : 0.72;
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2 + Math.PI / 4;
      arc(cx, cy, r, ang - 0.42, ang + 0.42, { color: col, width: 2, alpha: a });
    }
    // Cardinal ticks.
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      line(cx + dx * r * 1.02, cy + dy * r * 1.02, cx + dx * r * 1.42, cy + dy * r * 1.42,
        { color: col, width: 1.8, alpha: a });
    }
    // Centre pip.
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = col;
    ctx.fillRect(R(cx - 1.6 * s), R(cy - 1.6 * s), Math.max(2, R(3.2 * s)), Math.max(2, R(3.2 * s)));
    ctx.restore();
    if (flash > 0) arc(cx, cy, r * 1.75, 0, Math.PI * 2, { color: RED, width: 2, alpha: flash });
  }

  /** ITTS lead pipper — the thing the pilot actually aims with. */
  function drawPipper(px, py, cx, cy, { inRange = true, time = 0 } = {}) {
    const r = 13 * s;
    const col = inRange ? CY : AMBER;
    arc(px, py, r, 0, Math.PI * 2, { color: col, width: 2.2 });
    arc(px, py, r * 0.30, 0, Math.PI * 2, { color: col, width: 2.2 });
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2 + Math.PI / 4;
      line(px + Math.cos(ang) * r, py + Math.sin(ang) * r,
        px + Math.cos(ang) * r * 1.5, py + Math.sin(ang) * r * 1.5, { color: col, width: 1.6 });
    }
    // Tie the pipper back to the boresight so the required lead is legible.
    const dx = px - cx;
    const dy = py - cy;
    const d = Math.hypot(dx, dy);
    if (d > r * 2.4) {
      line(cx + (dx / d) * 40 * s, cy + (dy / d) * 40 * s, px - (dx / d) * r * 1.6, py - (dy / d) * r * 1.6,
        { color: col, width: 1.2, alpha: 0.45, dash: [6, 6] });
    }
    void time;
  }

  /** Corner bracket around the locked target, sized by its angular extent. */
  function drawTargetBracket(x, y, half, t, { time = 0 } = {}) {
    const col = t.hostile ? RED : GREEN;
    const h = Math.max(16 * s, Math.min(half, H * 0.34));
    const k = Math.max(7 * s, h * 0.34);
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      poly([x + sx * h - sx * k, y + sy * h, x + sx * h, y + sy * h, x + sx * h, y + sy * h - sy * k],
        { color: col, width: 2.2 });
    }

    // Target shield/armour ring: four arcs reading fore, right, aft, left.
    const rr = h + 20 * s;
    const banks = [
      [t.shields ? t.shields.fore.v / t.shields.fore.max : 0, -Math.PI * 0.75, -Math.PI * 0.25],
      [t.armor ? t.armor.right.v / t.armor.right.max : 0, -Math.PI * 0.25, Math.PI * 0.25],
      [t.shields ? t.shields.aft.v / t.shields.aft.max : 0, Math.PI * 0.25, Math.PI * 0.75],
      [t.armor ? t.armor.left.v / t.armor.left.max : 0, Math.PI * 0.75, Math.PI * 1.25],
    ];
    for (const [f, a0, a1] of banks) {
      arc(x, y, rr, a0 + 0.06, a1 - 0.06, { color: col, width: 3, alpha: 0.16 });
      const mid = (a0 + a1) / 2;
      const span = (a1 - a0 - 0.12) * clamp01(f) * 0.5;
      if (span > 0.01) arc(x, y, rr, mid - span, mid + span, { color: col, width: 3, alpha: 0.9 });
    }

    // Data block, offset so it never sits on the target itself.
    const bx = x + h + 30 * s;
    const by = y - h * 0.5;
    text(t.name, bx, by, { size: 20, color: col, track: 0.1 });
    text(`${fmtRange(t.distance)}m`, bx, by + 24 * s, { size: 19, color: col, track: 0.02, font: FONT_MONO });
    text(`${t.closure >= 0 ? '+' : ''}${Math.round(t.closure)}`, bx, by + 46 * s,
      { size: 17, color: t.closure >= 0 ? col : AMBER, track: 0.02, font: FONT_MONO });
    text(t.role, bx, by + 66 * s, { size: 14, color: col, track: 0.14, alpha: 0.7 });
    void time;
  }

  /** Missile lock: a diamond that converges onto the target as the seeker cools. */
  function drawLockDiamond(x, y, half, lock, locked, time) {
    const col = locked ? RED : AMBER;
    const spread = (1 - clamp01(lock)) * 90 * s;
    const r = Math.max(12 * s, half * 0.85) + spread;
    const blink = locked ? (Math.sin(time * 18) > -0.3 ? 1 : 0.25) : 1;
    poly([x, y - r, x + r, y, x, y + r, x - r, y], { color: col, width: 2.4, alpha: blink, close: true });
    if (locked) {
      text('LOCK', x, y - r - 10 * s, { size: 18, color: RED, align: 'center', track: 0.2, alpha: blink });
    } else if (lock > 0.02) {
      arc(x, y, r * 0.55, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp01(lock), { color: col, width: 3 });
    }
  }

  /** Caret at the frame edge pointing at a target outside the field of view. */
  function drawOffscreenCaret(x, y, cx, cy, col) {
    const m = 54 * s;
    const px = Math.min(W - m, Math.max(m, x));
    const py = Math.min(H * HUD_FLOOR - m, Math.max(m, y));
    const ang = Math.atan2(py - cy, px - cx);
    const r = 22 * s;
    poly([
      px + Math.cos(ang) * r, py + Math.sin(ang) * r,
      px + Math.cos(ang + 2.5) * r, py + Math.sin(ang + 2.5) * r,
      px + Math.cos(ang - 2.5) * r, py + Math.sin(ang - 2.5) * r,
    ], { color: col, width: 2.2, close: true });
  }

  // ------------------------------------------------------------- fixed panels

  function drawSpeedTape(state) {
    const x = R(W * 0.058);
    const top = R(H * 0.235);
    const h = R(H * 0.255);
    const w = R(28 * s);

    text('KPS', x, top - 12 * s, { size: 15, color: CY, track: 0.16, alpha: 0.8 });
    // Throttle commanded vs achieved: two adjacent columns is the clearest way
    // to show a fly-by-wire lag the pilot can actually feel.
    ladder(x, top, w, h, state.speed / Math.max(1, state.maxSpeed), { vertical: true, segments: 16, warn: -1 });
    const cf = clamp01(state.commanded / Math.max(1, state.maxSpeed));
    const cy2 = top + h - cf * h;
    poly([x - 12 * s, cy2, x - 3 * s, cy2 - 6 * s, x - 3 * s, cy2 + 6 * s],
      { color: AMBER, width: 1.6, close: true, fill: AMBER });

    box(x + w + 8 * s, top + h - 34 * s, 84 * s, 30 * s, { alpha: 0.55 });
    text(`${Math.round(state.speed)}`, x + w + 80 * s, top + h - 12 * s,
      { size: 25, align: 'right', track: 0.02, font: FONT_MONO });

    // Afterburner fuel.
    const fy = top + h + 26 * s;
    text('AB', x, fy + 11 * s, { size: 15, color: CY, track: 0.14, alpha: 0.8 });
    ladder(x + 30 * s, fy, 96 * s, 11 * s, state.abFuel, { segments: 10, warn: 0.25 });
    if (state.afterburner) {
      text('BURN', x + 136 * s, fy + 11 * s, { size: 15, color: AMBER, track: 0.16 });
    }

    // Gun capacitor.
    const gy = fy + 22 * s;
    text('GUN', x, gy + 11 * s, { size: 15, color: CY, track: 0.14, alpha: 0.8 });
    ladder(x + 30 * s, gy, 96 * s, 11 * s, state.energy, { segments: 10, warn: 0.2 });
  }

  /** Fore/aft shields and the four armour facings, as a plan-view gauge. */
  function drawDefenceGauge(state) {
    const cx = R(W - 118 * s);
    const cy = R(H * 0.325);
    const sh = state.shields;
    const ar = state.armor;
    const rr = 46 * s;

    text('SHIELDS', cx, cy - rr - 30 * s, { size: 15, color: CY, align: 'center', track: 0.18, alpha: 0.85 });

    const shieldArc = (frac, a0, a1) => {
      arc(cx, cy, rr, a0, a1, { color: CY, width: 6, alpha: 0.14 });
      const mid = (a0 + a1) / 2;
      const span = (a1 - a0) * clamp01(frac) * 0.5;
      if (span > 0.01) {
        arc(cx, cy, rr, mid - span, mid + span, { color: frac < 0.3 ? RED : CY, width: 6, alpha: 0.95 });
      }
    };
    shieldArc(sh ? sh.fore.v / sh.fore.max : 0, -Math.PI * 0.86, -Math.PI * 0.14);
    shieldArc(sh ? sh.aft.v / sh.aft.max : 0, Math.PI * 0.14, Math.PI * 0.86);

    // Hull plan with the four armour facings.
    const g = 22 * s;
    poly([cx, cy - g * 1.5, cx + g * 0.8, cy + g * 0.2, cx + g * 0.5, cy + g * 1.2,
      cx - g * 0.5, cy + g * 1.2, cx - g * 0.8, cy + g * 0.2],
    { color: CY, width: 1.6, close: true, alpha: 0.55 });

    const quads = [
      ['fore', cx, cy - g * 2.0, 0],
      ['aft', cx, cy + g * 2.0, 0],
      ['left', cx - g * 1.9, cy, 1],
      ['right', cx + g * 1.9, cy, 1],
    ];
    for (const [q, qx, qy, vertical] of quads) {
      const f = ar?.[q] ? ar[q].v / ar[q].max : 1;
      if (vertical) ladder(qx - 5 * s, qy - 20 * s, 9 * s, 40 * s, f, { vertical: true, segments: 6, warn: 0.34 });
      else ladder(qx - 20 * s, qy - 4 * s, 40 * s, 9 * s, f, { segments: 6, warn: 0.34 });
    }
    text('ARMOUR', cx, cy + rr + 42 * s, { size: 14, color: CY, align: 'center', track: 0.18, alpha: 0.7 });
  }

  function drawWeapons(state) {
    const y = R(H * HUD_FLOOR - 34 * s);
    const x = R(W * 0.058);
    box(x - 8 * s, y - 20 * s, 176 * s, 30 * s, { alpha: 0.5 });
    text(state.weapon.name, x, y, { size: 20, track: 0.12 });
    text(state.weapon.count > 1 ? `x${state.weapon.count}` : 'SEL', x + 160 * s, y,
      { size: 15, align: 'right', track: 0.1, alpha: 0.7 });

    const mx = R(W - 184 * s);
    box(mx - 8 * s, y - 20 * s, 176 * s, 30 * s, { alpha: 0.5, color: state.missile.locked ? RED : CY });
    text(state.missile.name, mx, y, { size: 20, track: 0.12, color: state.missile.locked ? RED : CY });
    text(`${state.missile.count}`, mx + 160 * s, y,
      { size: 22, align: 'right', track: 0.02, font: FONT_MONO, color: state.missile.count > 0 ? CY : RED });
  }

  function drawNav(state, time) {
    const x = R(W - 30 * s);
    text(state.nav.name, x, R(H * 0.085), { size: 17, align: 'right', track: 0.14, alpha: 0.9 });
    text(`${fmtRange(Math.max(0, state.nav.distance))}m`, x, R(H * 0.085 + 24 * s),
      { size: 17, align: 'right', track: 0.02, font: FONT_MONO, alpha: 0.85 });
    if (state.autopilotReady) {
      const blink = Math.sin(time * 4) > -0.2 ? 1 : 0.3;
      text('AUTOPILOT READY', x, R(H * 0.085 + 48 * s),
        { size: 15, align: 'right', track: 0.16, color: GREEN, alpha: blink });
    }
  }

  function drawAnnunciators(state, time) {
    const cx = R(W * 0.5);
    let y = R(H * 0.115);
    const blink = Math.sin(time * 11) > -0.15;

    if (state.incoming > 0 && blink) {
      box(cx - 132 * s, y - 26 * s, 264 * s, 34 * s, { color: RED, alpha: 0.9, fill: 'rgba(255,60,40,0.16)' });
      text('MISSILE  INCOMING', cx, y, { size: 24, color: RED, align: 'center', track: 0.18 });
    }
    if (state.incoming > 0) y += 42 * s;
    if (state.lockedBy > 0 && blink) {
      text('LOCK  WARNING', cx, y, { size: 20, color: AMBER, align: 'center', track: 0.2 });
      y += 30 * s;
    }
    const lowShield = state.shields && (state.shields.fore.v / state.shields.fore.max < 0.2
      || state.shields.aft.v / state.shields.aft.max < 0.2);
    if (lowShield && blink) {
      text('SHIELDS  LOW', cx, y, { size: 18, color: AMBER, align: 'center', track: 0.2 });
      y += 28 * s;
    }
    if (state.abFuel < 0.15 && blink) {
      text('FUEL', cx, y, { size: 18, color: AMBER, align: 'center', track: 0.24 });
    }
  }

  /** Roll/pitch reference. In space this is attitude relative to the ecliptic. */
  function drawAttitude(state, cx, cy) {
    const r = 92 * s;
    const roll = Math.atan2(state.right.y, state.up.y);
    const pitch = Math.asin(clamp01Signed(state.forward.y));
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-roll);
    const off = pitch * r * 1.1;
    ctx.globalAlpha = 0.42;
    ctx.strokeStyle = CY;
    ctx.lineWidth = Math.max(1, 1.6 * s);
    for (const k of [-1, 0, 1]) {
      const yy = off + k * 34 * s;
      const half = k === 0 ? r : r * 0.55;
      ctx.beginPath();
      ctx.moveTo(-half, yy); ctx.lineTo(-half * 0.42, yy);
      ctx.moveTo(half * 0.42, yy); ctx.lineTo(half, yy);
      if (k !== 0) {
        ctx.moveTo(-half, yy); ctx.lineTo(-half, yy - Math.sign(k) * 8 * s);
        ctx.moveTo(half, yy); ctx.lineTo(half, yy - Math.sign(k) * 8 * s);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
  const clamp01Signed = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);

  // ------------------------------------------------------------------ draw
  /**
   * @param {object} p
   * @param {object} p.state    resolved cockpit state
   * @param {Function} p.project (Vector3, out) => boolean inFront
   * @param {object|null} p.solution ITTS solution from combat/targeting.js
   * @param {number} p.time
   */
  function draw({ state, project, solution, time, boresight, velocityMark }) {
    ctx.clearRect(0, 0, W, H);
    if (W < 8 || H < 8) return;

    const out = { x: 0, y: 0 };
    const cx = boresight && project(boresight, out) ? out.x : W * 0.5;
    const cy = boresight && project(boresight, out) ? out.y : H * 0.5;

    // ---- velocity vector ---------------------------------------------------
    if (velocityMark && state.speed > 8 && project(velocityMark, out)) {
      const r = 9 * s;
      arc(out.x, out.y, r, 0, Math.PI * 2, { color: CY, width: 1.8, alpha: 0.7 });
      line(out.x - r * 2.2, out.y, out.x - r, out.y, { color: CY, width: 1.8, alpha: 0.7 });
      line(out.x + r, out.y, out.x + r * 2.2, out.y, { color: CY, width: 1.8, alpha: 0.7 });
      line(out.x, out.y - r, out.x, out.y - r * 2.0, { color: CY, width: 1.8, alpha: 0.7 });
    }

    drawAttitude(state, cx, cy);

    // ---- target -----------------------------------------------------------
    const t = state.target;
    if (t) {
      const inFront = project(t.position, out);
      const col = t.hostile ? RED : GREEN;
      if (inFront && out.x > -200 * s && out.x < W + 200 * s && out.y > -200 * s && out.y < H + 200 * s) {
        // Angular radius -> pixels through the vertical FOV.
        const half = Math.max(14 * s, t.angularRadius * state.pixelsPerRadian * 1.25);
        drawTargetBracket(out.x, out.y, half, t, { time });
        if (state.missile.lock > 0.02 || state.missile.locked) {
          drawLockDiamond(out.x, out.y, half, state.missile.lock, state.missile.locked, time);
        }
      } else {
        drawOffscreenCaret(out.x, out.y, cx, cy, col);
      }
    }

    // ---- reticle and pipper ------------------------------------------------
    drawReticle(cx, cy, {
      status: solution?.status ?? 'no-target',
      flash: state.incoming > 0 && Math.sin(time * 12) > 0 ? 0.6 : 0,
    });
    if (solution?.valid && project(solution.point, out)) {
      drawPipper(out.x, out.y, cx, cy, { inRange: solution.inRange, time });
    }

    // ---- fixed furniture ---------------------------------------------------
    drawSpeedTape(state);
    drawDefenceGauge(state);
    drawWeapons(state);
    drawNav(state, time);
    drawAnnunciators(state, time);

    // Callsign strip, bottom left of the combiner area.
    text(`${state.shipName}  ·  ${state.pilotName}`, R(W * 0.058), R(H * HUD_FLOOR - 6 * s),
      { size: 13, track: 0.18, alpha: 0.45 });
  }

  function dispose() { /* canvas is GC'd with the painter */ }

  st.setSize = setSize;
  st.draw = draw;
  st.dispose = dispose;
  return st;
}
