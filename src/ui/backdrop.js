/**
 * src/ui/backdrop.js — the moving background behind every full-screen menu.
 *
 * A menu that is a still image reads as a web page. Wing Commander's shipboard
 * terminals always had something alive behind them, so this draws a hangar-bay
 * view: a nebula wall for colour separation (ARCHITECTURE §7 — space is not
 * empty black), a parallaxed starfield of *varied* stars, and the lit spine of
 * the carrier you are standing inside drifting slowly across the bottom.
 *
 * Everything is 2D canvas, seeded through `makeRng` so a given seed always
 * paints the same sky, and split into two costs:
 *   - `bake()` renders the nebula and the star plates once per resize into
 *     offscreen canvases;
 *   - `draw()` blits those with a slow parallax offset and paints only the
 *     genuinely time-varying parts (twinkle, running lights, scan drift).
 *
 * That keeps a 1600×900 animated backdrop at a few hundred microseconds a frame
 * instead of re-rasterising 600 stars.
 */
import { makeRng, hashSeed } from '../core/Rand.js';
import { fitCanvas } from './dom.js';

/** Star colours, weighted the way a real field looks: mostly dim and warm-white. */
const STAR_COLORS = [
  [0.62, '#cfd8e6'], [0.14, '#ffe9c8'], [0.10, '#bcd4ff'],
  [0.08, '#ffd0b0'], [0.06, '#9fe8ff'],
];

function pickColor(r) {
  let acc = 0;
  const v = r();
  for (const [w, c] of STAR_COLORS) { acc += w; if (v <= acc) return c; }
  return '#cfd8e6';
}

export function createBackdrop(canvas, { seed = 0x5eed, palette = 'teal' } = {}) {
  const layers = [];
  let nebula = null;
  let size = { w: 0, h: 0 };
  let t = 0;
  let hull = null;
  let planet = null;

  const rng = makeRng(hashSeed(`backdrop:${seed}:${palette}`));

  /**
   * Nebula families. These are deliberately *bright* for a background: the CRT
   * layer multiplies scanlines over the whole screen and the barrel vignette
   * eats the outer third, so a wall authored at "correct" space brightness
   * arrives as flat black. ARCHITECTURE §7 is explicit that space is not empty
   * black and every frame needs colour separation — that has to survive the
   * overlays, which means authoring above them.
   */
  const PALETTES = {
    teal: {
      clouds: [['#1d5f83', 0.95], ['#164a76', 0.85], ['#46236b', 0.6], ['#0d5a68', 0.75], ['#2b7f96', 0.5]],
      star: '#cfe0ff',
      planet: ['#26405e', '#16283d', '#4e6f96'],
    },
    amber: {
      clouds: [['#7a4517', 0.9], ['#5e2c4a', 0.7], ['#1c4a60', 0.7], ['#6b4712', 0.6], ['#8a5a22', 0.5]],
      star: '#ffd0a0',
      planet: ['#5c3a1c', '#33200f', '#8a6238'],
    },
    crimson: {
      clouds: [['#7a1f30', 0.9], ['#431a63', 0.75], ['#153c5a', 0.65], ['#5e2418', 0.6], ['#94304a', 0.45]],
      star: '#ff8a5c',
      planet: ['#5a2230', '#2c1018', '#8c4652'],
    },
  };

  const familyOf = () => PALETTES[palette] ?? PALETTES.teal;

  /** Bake the nebula wall: broad screen-blended radial blooms plus a dust band. */
  function bakeNebula(w, h) {
    const cv = document.createElement('canvas');
    cv.width = Math.max(2, Math.round(w / 3));
    cv.height = Math.max(2, Math.round(h / 3));
    const c = cv.getContext('2d');
    const r = makeRng(hashSeed(`neb:${seed}:${palette}`));
    const fam = familyOf();
    const stops = fam.clouds;

    c.fillStyle = '#050a10';
    c.fillRect(0, 0, cv.width, cv.height);

    // A broad diagonal wash first, so the wall has a direction rather than
    // being a field of unrelated blobs.
    const wash = c.createLinearGradient(0, cv.height, cv.width, 0);
    wash.addColorStop(0, hexA(stops[0][0], 0.55));
    wash.addColorStop(0.5, hexA(stops[2][0], 0.30));
    wash.addColorStop(1, hexA(stops[1][0], 0.16));
    c.globalCompositeOperation = 'screen';
    c.fillStyle = wash;
    c.fillRect(0, 0, cv.width, cv.height);

    for (let i = 0; i < 30; i++) {
      const [col, amp] = stops[i % stops.length];
      const x = r.range(-0.15, 1.15) * cv.width;
      const y = r.range(-0.1, 1.1) * cv.height;
      const rad = r.range(0.14, 0.58) * cv.width;
      const g = c.createRadialGradient(x, y, 0, x, y, rad);
      const a = amp * r.range(0.30, 0.85);
      g.addColorStop(0, hexA(col, a));
      g.addColorStop(0.42, hexA(col, a * 0.45));
      g.addColorStop(1, hexA(col, 0));
      c.fillStyle = g;
      c.beginPath();
      c.arc(x, y, rad, 0, Math.PI * 2);
      c.fill();
    }

    // Filaments. Broad radial blooms alone average out into a smooth blue
    // gradient — which is what a nebula is *not*. Stretched, rotated wisps at
    // a second scale are what makes it read as gas rather than a backdrop wash.
    for (let i = 0; i < 26; i++) {
      const [col] = stops[(i * 3) % stops.length];
      const x = r() * cv.width;
      const y = r() * cv.height;
      const len = r.range(0.10, 0.42) * cv.width;
      const thick = len * r.range(0.06, 0.20);
      c.save();
      c.translate(x, y);
      c.rotate(r.range(-1.2, 1.2));
      const g = c.createRadialGradient(0, 0, 0, 0, 0, len);
      const a = r.range(0.10, 0.34);
      g.addColorStop(0, hexA(col, a));
      g.addColorStop(0.5, hexA(col, a * 0.35));
      g.addColorStop(1, hexA(col, 0));
      c.fillStyle = g;
      c.beginPath();
      c.ellipse(0, 0, len, thick, 0, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }

    // Dust lanes carve the wall into structure. Multiplied, but kept shallow —
    // at full strength they eat the colour the blooms just paid for.
    c.globalCompositeOperation = 'multiply';
    for (let i = 0; i < 9; i++) {
      const y = r.range(-0.05, 1.05) * cv.height;
      const half = cv.height * r.range(0.06, 0.16);
      c.save();
      c.translate(cv.width / 2, y);
      c.rotate(r.range(-0.22, 0.22));
      const g = c.createLinearGradient(0, -half, 0, half);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.5, `rgba(${58 + r.int(0, 46)},${58 + r.int(0, 40)},${74 + r.int(0, 46)},1)`);
      g.addColorStop(1, 'rgba(255,255,255,1)');
      c.fillStyle = g;
      c.fillRect(-cv.width, -half, cv.width * 2, half * 2);
      c.restore();
    }
    c.globalCompositeOperation = 'source-over';
    return cv;
  }

  /**
   * A gas giant hanging off one edge. ARCHITECTURE §7 asks every frame for at
   * least one large-scale object to give depth; on a menu that has to come from
   * the backdrop, and a banded limb with a hard terminator does it in about
   * thirty draw calls, baked once.
   */
  function bakePlanet(w, h) {
    const r = makeRng(hashSeed(`planet:${seed}:${palette}`));
    const fam = familyOf();
    const R = Math.round(Math.min(w, h) * r.range(0.30, 0.42));
    const size = R * 2 + 40;
    const cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    const c = cv.getContext('2d');
    const cx = size / 2; const cy = size / 2;
    const [mid, dark, light] = fam.planet;

    c.save();
    c.beginPath();
    c.arc(cx, cy, R, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = mid;
    c.fillRect(0, 0, size, size);
    // Latitude banding.
    for (let i = 0; i < 22; i++) {
      const y = cy - R + (i / 22) * R * 2 + r.range(-4, 4);
      const bh = (R * 2 / 22) * r.range(0.5, 1.5);
      c.fillStyle = hexA(r.bool(0.5) ? light : dark, r.range(0.10, 0.34));
      c.fillRect(0, y, size, bh);
    }
    // A storm oval, because a perfectly banded planet reads as a gradient.
    c.fillStyle = hexA(light, 0.30);
    c.beginPath();
    c.ellipse(cx + r.range(-0.4, 0.4) * R, cy + r.range(-0.5, 0.5) * R,
      R * r.range(0.10, 0.20), R * r.range(0.05, 0.10), r.range(-0.3, 0.3), 0, Math.PI * 2);
    c.fill();
    // Terminator: the star is up and to the left of the frame.
    // Mostly night side. A fully lit planet behind a menu is a lamp, not a
    // depth cue — the crescent is what reads, and it keeps the type legible.
    const term = c.createLinearGradient(cx - R * 0.9, cy - R * 0.9, cx + R * 0.9, cy + R * 0.9);
    term.addColorStop(0, 'rgba(0,0,0,0.10)');
    term.addColorStop(0.22, 'rgba(0,0,0,0.45)');
    term.addColorStop(0.40, 'rgba(0,0,0,0.86)');
    term.addColorStop(1, 'rgba(0,0,0,0.985)');
    c.fillStyle = term;
    c.fillRect(0, 0, size, size);
    c.restore();

    // Atmospheric rim on the lit limb.
    c.save();
    c.globalCompositeOperation = 'lighter';
    const rim = c.createRadialGradient(cx, cy, R * 0.93, cx, cy, R * 1.06);
    rim.addColorStop(0, hexA(fam.star, 0));
    rim.addColorStop(0.55, hexA(fam.star, 0.30));
    rim.addColorStop(1, hexA(fam.star, 0));
    c.fillStyle = rim;
    c.beginPath();
    c.arc(cx, cy, R * 1.06, 0, Math.PI * 2);
    c.fill();
    c.restore();

    return { cv, R, size, x: r.range(-0.34, -0.10), y: r.range(0.58, 0.92), drift: r.range(0.4, 1.1) };
  }

  /**
   * Bake one parallax star plate. Plates are drawn twice side by side when they
   * scroll, so each is one viewport wide and wraps seamlessly.
   */
  function bakeStars(w, h, { count, sizeMin, sizeMax, alpha, salt }) {
    const cv = document.createElement('canvas');
    cv.width = Math.max(2, Math.round(w));
    cv.height = Math.max(2, Math.round(h));
    const c = cv.getContext('2d');
    const r = makeRng(hashSeed(`stars:${seed}:${salt}`));
    for (let i = 0; i < count; i++) {
      const x = r() * cv.width;
      const y = r() * cv.height;
      // Magnitude distribution: cube the roll so bright stars stay rare.
      const mag = Math.pow(r(), 3);
      const rad = sizeMin + mag * (sizeMax - sizeMin);
      const col = pickColor(r);
      const a = alpha * (0.25 + mag * 0.75);
      const g = c.createRadialGradient(x, y, 0, x, y, rad * 3.2);
      g.addColorStop(0, hexA(col, a));
      g.addColorStop(0.34, hexA(col, a * 0.35));
      g.addColorStop(1, hexA(col, 0));
      c.fillStyle = g;
      c.beginPath();
      c.arc(x, y, rad * 3.2, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = hexA(col, Math.min(1, a * 1.5));
      c.beginPath();
      c.arc(x, y, rad * 0.62, 0, Math.PI * 2);
      c.fill();
      // The brightest few get a diffraction cross, as an optic would give them.
      if (mag > 0.86) {
        c.strokeStyle = hexA(col, a * 0.5);
        c.lineWidth = 0.8;
        const L = rad * 7;
        c.beginPath();
        c.moveTo(x - L, y); c.lineTo(x + L, y);
        c.moveTo(x, y - L * 0.55); c.lineTo(x, y + L * 0.55);
        c.stroke();
      }
    }
    return cv;
  }

  /** The carrier hull you are standing on: a dark angular silhouette + lights. */
  function bakeHull(w, h) {
    const r = makeRng(hashSeed(`hull:${seed}`));
    const pts = [];
    const baseY = h * 0.965;
    const n = 9;
    for (let i = 0; i <= n; i++) {
      const x = (i / n) * w * 1.35 - w * 0.16;
      const y = baseY - Math.pow(Math.sin((i / n) * Math.PI), 0.7) * h * r.range(0.05, 0.10)
        - (i % 3 === 0 ? h * 0.018 : 0);
      pts.push([x, y]);
    }
    const lights = [];
    for (let i = 0; i < 26; i++) {
      const u = r();
      const idx = Math.min(n - 1, Math.floor(u * n));
      const f = u * n - idx;
      const x = pts[idx][0] + (pts[idx + 1][0] - pts[idx][0]) * f;
      const y = pts[idx][1] + (pts[idx + 1][1] - pts[idx][1]) * f + r.range(2, 26);
      lights.push({ x, y, phase: r() * Math.PI * 2, rate: r.range(0.25, 1.5), col: r.bool(0.7) ? '#7fe4ff' : '#ffb04a', r: r.range(0.7, 1.9) });
    }
    return { pts, lights, baseY };
  }

  function bake(w, h) {
    size = { w, h };
    nebula = bakeNebula(w, h);
    layers.length = 0;
    layers.push({ cv: bakeStars(w, h, { count: 260, sizeMin: 0.35, sizeMax: 0.9, alpha: 0.42, salt: 'far' }), speed: 2.4 });
    layers.push({ cv: bakeStars(w, h, { count: 130, sizeMin: 0.5, sizeMax: 1.4, alpha: 0.62, salt: 'mid' }), speed: 5.5 });
    layers.push({ cv: bakeStars(w, h, { count: 46, sizeMin: 0.8, sizeMax: 2.2, alpha: 0.9, salt: 'near' }), speed: 11 });
    hull = bakeHull(w, h);
    planet = bakePlanet(w, h);
  }

  /** Internal width cap. See the note on `draw`. */
  const MAX_W = 1100;

  function draw(dt) {
    // The backdrop is deliberately rendered below native resolution and scaled
    // up by CSS. It is nebula, stars and a planet limb — all low-frequency —
    // and at full resolution the per-frame repaint dominated the menu's frame
    // budget under software rasterisation, which slowed the typewriter (the
    // menu loop clamps dt, so a slow frame literally slows time).
    const rect = canvas.getBoundingClientRect();
    const cap = rect.width > 0 ? Math.min(1, MAX_W / rect.width) : 1;
    const fit = fitCanvas(canvas, { maxDpr: cap });
    if (!fit) return;
    const { ctx, w, h } = fit;
    if (!nebula || size.w !== w || size.h !== h) bake(w, h);
    t += dt;

    ctx.clearRect(0, 0, w, h);
    // Nebula wall, drifting a hair so the gradient never sits still.
    const nz = 1.06 + Math.sin(t * 0.035) * 0.012;
    const nx = Math.sin(t * 0.021) * w * 0.012;
    const ny = Math.cos(t * 0.017) * h * 0.010;
    ctx.globalAlpha = 1;
    ctx.drawImage(nebula, nx - w * (nz - 1) / 2, ny - h * (nz - 1) / 2, w * nz, h * nz);

    // The planet sits between the nebula wall and the starfield: stars in front
    // of a planet is the single most common tell of a faked space backdrop.
    if (planet) {
      const px = planet.x * w - ((t * planet.drift * 0.6) % (w * 1.6));
      const py = planet.y * h;
      ctx.drawImage(planet.cv, px + w * 1.6, py - planet.size / 2, planet.size, planet.size);
      ctx.drawImage(planet.cv, px, py - planet.size / 2, planet.size, planet.size);
    }

    // The system primary, off in the upper right, with a soft bloom and the
    // horizontal flare the post pipeline gives the real one in flight.
    {
      const fam = familyOf();
      const sx = w * 0.845;
      const sy = h * 0.155 + Math.sin(t * 0.07) * h * 0.004;
      const pulse = 1 + Math.sin(t * 0.9) * 0.03;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g2 = ctx.createRadialGradient(sx, sy, 0, sx, sy, h * 0.30 * pulse);
      g2.addColorStop(0, hexA(fam.star, 0.55));
      g2.addColorStop(0.10, hexA(fam.star, 0.22));
      g2.addColorStop(0.35, hexA(fam.star, 0.06));
      g2.addColorStop(1, hexA(fam.star, 0));
      ctx.fillStyle = g2;
      ctx.beginPath();
      ctx.arc(sx, sy, h * 0.30 * pulse, 0, Math.PI * 2);
      ctx.fill();
      const flare = ctx.createLinearGradient(sx - w * 0.22, sy, sx + w * 0.22, sy);
      flare.addColorStop(0, hexA(fam.star, 0));
      flare.addColorStop(0.5, hexA(fam.star, 0.16));
      flare.addColorStop(1, hexA(fam.star, 0));
      ctx.fillStyle = flare;
      ctx.fillRect(sx - w * 0.22, sy - h * 0.006, w * 0.44, h * 0.012);
      ctx.fillStyle = hexA('#ffffff', 0.9);
      ctx.beginPath();
      ctx.arc(sx, sy, h * 0.008 * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Parallax star plates. Each scrolls left; two blits cover the wrap seam.
    ctx.globalCompositeOperation = 'lighter';
    for (const L of layers) {
      const off = -((t * L.speed) % w);
      ctx.drawImage(L.cv, off, 0, w, h);
      ctx.drawImage(L.cv, off + w, 0, w, h);
    }

    // Twinkle: a handful of stars brightening on their own phase. Drawn live
    // because baking it would freeze the one thing that says "this is running".
    const tw = 26;
    for (let i = 0; i < tw; i++) {
      const px = ((i * 97.31) % 1000) / 1000;
      const py = ((i * 61.17) % 1000) / 1000;
      const x = (px * w + t * 3.2) % w;
      const y = py * h * 0.86;
      const a = Math.max(0, Math.sin(t * (0.7 + (i % 5) * 0.23) + i * 1.7)) ** 6;
      if (a < 0.02) continue;
      ctx.fillStyle = `rgba(220,240,255,${a * 0.75})`;
      ctx.beginPath();
      ctx.arc(x, y, 1.0 + a * 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    // Carrier spine along the bottom, drifting slower than the stars.
    if (hull) {
      const sx = -((t * 1.6) % (w * 0.35));
      ctx.save();
      ctx.translate(sx, 0);
      ctx.beginPath();
      ctx.moveTo(hull.pts[0][0], h + 10);
      for (const [x, y] of hull.pts) ctx.lineTo(x, y);
      ctx.lineTo(hull.pts.at(-1)[0], h + 10);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, hull.baseY - h * 0.13, 0, h);
      g.addColorStop(0, 'rgba(20,30,40,0.92)');
      g.addColorStop(1, 'rgba(4,7,11,1)');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = 'rgba(127,228,255,0.18)';
      ctx.lineWidth = 1;
      ctx.stroke();
      for (const L of hull.lights) {
        const a = 0.35 + 0.65 * Math.max(0, Math.sin(t * L.rate + L.phase)) ** 3;
        ctx.fillStyle = hexA(L.col, a * 0.9);
        ctx.beginPath();
        ctx.arc(L.x, L.y, L.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = hexA(L.col, a * 0.18);
        ctx.beginPath();
        ctx.arc(L.x, L.y, L.r * 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  return {
    draw,
    resize() { nebula = null; },
    dispose() { layers.length = 0; nebula = null; hull = null; planet = null; },
    /** Swap the nebula colour family — briefings use the mission's own mood. */
    setPalette(p) { if (p !== palette && PALETTES[p]) { palette = p; nebula = null; } },
  };
}

/** `#rrggbb` + alpha -> `rgba(...)`. Canvas has no other way to do this. */
export function hexA(hex, a) {
  const h = hex.replace('#', '');
  const v = h.length === 3
    ? [h[0] + h[0], h[1] + h[1], h[2] + h[2]]
    : [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)];
  const [r, g, b] = v.map((s) => parseInt(s, 16));
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}
