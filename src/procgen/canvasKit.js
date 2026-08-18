/**
 * canvasKit — shared 2D-canvas helpers for procedural decals, markings and grunge.
 *
 * Everything here is deterministic: pass an rng from `core/Rand.js`. Nothing calls
 * Math.random(), nothing loads an image, nothing touches the network.
 *
 * The 2D canvas is the right tool for anything with *shape intent* — glyphs,
 * insignia, hazard chevrons, stencil bridges. The typed-array field synthesis in
 * textures.js is the right tool for anything with *statistical* structure. This
 * module is the bridge: draw on a canvas, read it back as a Float32 mask, composite
 * it into the albedo/roughness fields with a wear multiplier so nothing ever looks
 * pasted on.
 */

// ------------------------------------------------------------------ font stacks
// Deliberately metric-stable stacks: Liberation Sans is Arial-metric compatible and
// ships with every Linux capture container, DejaVu is the universal fallback.
export const FONT_SANS = '"Liberation Sans","Arial","DejaVu Sans","Helvetica",sans-serif';
export const FONT_MONO = '"Liberation Mono","DejaVu Sans Mono","Courier New",monospace';
export const FONT_COND = '"Liberation Sans Narrow","Arial Narrow","Liberation Sans","DejaVu Sans",sans-serif';

// --------------------------------------------------------------------- canvases

/** Create a 2D drawing surface, preferring a DOM canvas so CanvasTexture accepts it. */
export function createCanvas(w, h) {
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  throw new Error('canvasKit: no canvas implementation available');
}

export function ctxOf(canvas, { alpha = true } = {}) {
  const ctx = canvas.getContext('2d', { alpha, willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

/** Canvas + context in one go. */
export function makeSurface(w, h, opts) {
  const canvas = createCanvas(w, h);
  return { canvas, ctx: ctxOf(canvas, opts) };
}

/** Full RGBA byte view of a canvas. */
export function canvasRGBA(canvas) {
  const ctx = ctxOf(canvas);
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

/** Alpha channel as a Float32Array in [0,1] — the standard decal mask format. */
export function canvasAlpha(canvas) {
  const d = canvasRGBA(canvas);
  const n = canvas.width * canvas.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = d[i * 4 + 3] / 255;
  return out;
}

/** Luminance as Float32 in [0,1] — for using a drawn canvas as a height/mask field. */
export function canvasLuma(canvas) {
  const d = canvasRGBA(canvas);
  const n = canvas.width * canvas.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[i] = (d[o] * 0.2126 + d[o + 1] * 0.7152 + d[o + 2] * 0.0722) / 255;
  }
  return out;
}

// ----------------------------------------------------------------------- colour

export function hexToRgb(hex) {
  if (Array.isArray(hex)) return hex;
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const v = parseInt(h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function rgbaCss(rgb, a = 1) {
  const [r, g, b] = hexToRgb(rgb);
  return `rgba(${r | 0},${g | 0},${b | 0},${a})`;
}

export function mixRgb(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t];
}

/** Multiply toward black (<1) or toward white (>1) keeping hue. */
export function shadeRgb(c, k) {
  const [r, g, b] = hexToRgb(c);
  if (k <= 1) return [r * k, g * k, b * k];
  const t = k - 1;
  return [r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t];
}

export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

export function hslToRgb(h, s, l) {
  h = ((h % 1) + 1) % 1;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255];
}

/** Shift a colour in HSL — the cheap way to give every panel its own paint batch. */
export function hslShift(c, dh = 0, ds = 0, dl = 0) {
  const [r, g, b] = hexToRgb(c);
  const [h, s, l] = rgbToHsl(r, g, b);
  return hslToRgb(h + dh, Math.max(0, Math.min(1, s + ds)), Math.max(0, Math.min(1, l + dl)));
}

// ------------------------------------------------------------------ text stamps

/**
 * Draw text with explicit letter-spacing and optional horizontal condensing —
 * military stencilling is always tracked-out and narrow, and canvas gives us
 * neither by default.
 *
 * @returns {number} advance width in pixels
 */
export function stampText(ctx, text, {
  x = 0, y = 0, size = 32, tracking = 0.12, font = FONT_SANS, weight = 700,
  align = 'left', fill = '#ffffff', stroke = null, strokeWidth = 0,
  condense = 1, slant = 0, alpha = 1, rotate = 0,
} = {}) {
  const chars = String(text).split('');
  ctx.save();
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const gap = tracking * size;
  let total = 0;
  for (let i = 0; i < chars.length; i++) total += widths[i] + (i < chars.length - 1 ? gap : 0);
  total *= condense;

  let ox = 0;
  if (align === 'center') ox = -total / 2;
  else if (align === 'right') ox = -total;

  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  if (rotate) ctx.rotate(rotate);
  ctx.transform(condense, 0, -slant, 1, ox, 0);
  ctx.fillStyle = typeof fill === 'string' ? fill : rgbaCss(fill);
  if (stroke) {
    ctx.strokeStyle = typeof stroke === 'string' ? stroke : rgbaCss(stroke);
    ctx.lineWidth = strokeWidth || size * 0.08;
    ctx.lineJoin = 'round';
  }

  let cx = 0;
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== ' ') {
      if (stroke) ctx.strokeText(chars[i], cx, 0);
      ctx.fillText(chars[i], cx, 0);
    }
    cx += widths[i] + gap;
  }
  ctx.restore();
  return total;
}

/**
 * Stencil text: real glyphs with knocked-out bridges, the way a spray stencil
 * leaves the counters of O/A/R connected. Sold entirely by those bridges.
 */
export function stampStencilText(ctx, text, opts = {}) {
  const { x = 0, y = 0, size = 32, bridges = 2 } = opts;
  const w = stampText(ctx, text, opts);
  if (bridges <= 0) return w;
  const align = opts.align ?? 'left';
  const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = '#000';
  const barH = Math.max(1, size * 0.055);
  for (let i = 0; i < bridges; i++) {
    const fy = y - size * (0.72 - i * 0.42);
    ctx.fillRect(left - size * 0.1, fy, w + size * 0.2, barH);
  }
  ctx.restore();
  return w;
}

// -------------------------------------------------------------------- gradients

export function gradientRamp(ctx, x0, y0, x1, y1, stops) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [t, c, a] of stops) g.addColorStop(t, a === undefined ? c : rgbaCss(c, a));
  return g;
}

export function radialRamp(ctx, x, y, r0, r1, stops) {
  const g = ctx.createRadialGradient(x, y, r0, x, y, r1);
  for (const [t, c, a] of stops) g.addColorStop(t, a === undefined ? c : rgbaCss(c, a));
  return g;
}

/** Fill the whole canvas with an angled multi-stop ramp. */
export function fillRamp(ctx, w, h, stops, angle = Math.PI / 2) {
  const cx = w / 2, cy = h / 2;
  const dx = Math.cos(angle) * w, dy = Math.sin(angle) * h;
  ctx.fillStyle = gradientRamp(ctx, cx - dx / 2, cy - dy / 2, cx + dx / 2, cy + dy / 2, stops);
  ctx.fillRect(0, 0, w, h);
}

// ------------------------------------------------------------------ grunge tools

/**
 * Seeded splatter — clustered soft dots. Clusters, not a uniform scatter: real
 * grime arrives in blobs, and a Poisson-uniform sprinkle instantly reads as noise.
 */
export function seededSplatter(ctx, {
  rng, count = 200, x = 0, y = 0, w = 512, h = 512,
  radius = [2, 14], alpha = [0.04, 0.2], color = '#000000',
  clusters = 12, clusterSpread = 0.12, soft = true,
} = {}) {
  const [r0, r1] = radius;
  const [a0, a1] = alpha;
  const centres = [];
  for (let i = 0; i < clusters; i++) centres.push([x + rng() * w, y + rng() * h]);
  ctx.save();
  for (let i = 0; i < count; i++) {
    const c = centres[(rng() * clusters) | 0] ?? [x + rng() * w, y + rng() * h];
    const px = c[0] + rng.gauss(0, clusterSpread * w);
    const py = c[1] + rng.gauss(0, clusterSpread * h);
    const r = r0 + rng() * (r1 - r0);
    const a = a0 + rng() * (a1 - a0);
    if (soft) {
      ctx.fillStyle = radialRamp(ctx, px, py, 0, r, [[0, color, a], [0.55, color, a * 0.55], [1, color, 0]]);
    } else {
      ctx.fillStyle = rgbaCss(color, a);
    }
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Brushed-metal / rain-streak strokes: long thin strokes that fade at both ends,
 * all sharing one direction with a small angular spread.
 */
export function brushedStreaks(ctx, {
  rng, count = 400, x = 0, y = 0, w = 512, h = 512,
  angle = Math.PI / 2, spread = 0.04, length = [0.15, 0.6], width = [0.5, 2.5],
  alpha = [0.02, 0.12], color = '#000000', originBias = null,
} = {}) {
  const [l0, l1] = length, [w0, w1] = width, [a0, a1] = alpha;
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const a = angle + rng.gauss(0, spread);
    const len = (l0 + rng() * (l1 - l0)) * h;
    const sx = originBias ? originBias[0] + rng.gauss(0, originBias[2] ?? w * 0.05) : x + rng() * w;
    const sy = originBias ? originBias[1] + rng.gauss(0, originBias[3] ?? h * 0.02) : y + rng() * h;
    const ex = sx + Math.cos(a) * len, ey = sy + Math.sin(a) * len;
    const al = a0 + rng() * (a1 - a0);
    const g = ctx.createLinearGradient(sx, sy, ex, ey);
    g.addColorStop(0, rgbaCss(color, 0));
    g.addColorStop(0.15, rgbaCss(color, al));
    g.addColorStop(0.6, rgbaCss(color, al * 0.6));
    g.addColorStop(1, rgbaCss(color, 0));
    ctx.strokeStyle = g;
    ctx.lineWidth = w0 + rng() * (w1 - w0);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    // A slight bow keeps streaks from looking like a comb.
    ctx.quadraticCurveTo(
      (sx + ex) / 2 + rng.gauss(0, len * 0.02),
      (sy + ey) / 2 + rng.gauss(0, len * 0.02),
      ex, ey,
    );
    ctx.stroke();
  }
  ctx.restore();
}

/** Fine scratches with a coherent anisotropic direction. */
export function scratchLines(ctx, {
  rng, count = 160, x = 0, y = 0, w = 512, h = 512,
  angle = 0.5, spread = 0.25, length = [0.03, 0.25], alpha = [0.05, 0.35],
  color = '#ffffff', width = [0.4, 1.1],
} = {}) {
  const [l0, l1] = length, [a0, a1] = alpha, [w0, w1] = width;
  ctx.save();
  ctx.lineCap = 'butt';
  for (let i = 0; i < count; i++) {
    const a = angle + rng.gauss(0, spread) + (rng() < 0.12 ? Math.PI / 2 : 0);
    const len = (l0 + rng() * (l1 - l0)) * w;
    const sx = x + rng() * w, sy = y + rng() * h;
    const al = a0 + rng() * (a1 - a0);
    ctx.strokeStyle = rgbaCss(color, al);
    ctx.lineWidth = w0 + rng() * (w1 - w0);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    const segs = 2 + ((rng() * 3) | 0);
    let px = sx, py = sy;
    for (let s = 0; s < segs; s++) {
      const sl = len / segs;
      px += Math.cos(a + rng.gauss(0, 0.05)) * sl;
      py += Math.sin(a + rng.gauss(0, 0.05)) * sl;
      ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** Diagonal hazard striping — the universal "do not stand here" marking. */
export function hazardStripes(ctx, {
  x = 0, y = 0, w = 256, h = 48, pitch = 24, angle = Math.PI / 4,
  colorA = '#e5a21c', colorB = '#1a1a1a', duty = 0.5, alpha = 1,
} = {}) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = colorA;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = colorB;
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate(angle);
  const span = (w + h) * 1.2;
  for (let s = -span; s < span; s += pitch) {
    ctx.fillRect(s, -span / 2, pitch * duty, span);
  }
  ctx.restore();
}

/** Rounded rectangle path (older canvas impls lack roundRect). */
export function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** Convex/star polygon path from a radius callback. */
export function polygonPath(ctx, cx, cy, points, radiusAt, rotation = 0) {
  ctx.beginPath();
  for (let i = 0; i < points; i++) {
    const a = rotation + (i / points) * Math.PI * 2;
    const r = typeof radiusAt === 'function' ? radiusAt(i) : radiusAt;
    const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** Per-pixel monochrome dither/noise overlay — kills banding in canvas gradients. */
export function noiseOverlay(ctx, w, h, { rng, amount = 0.05, mono = true } = {}) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const k = amount * 255;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * k;
    if (mono) { d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    else { d[i] += (rng() - 0.5) * k; d[i + 1] += (rng() - 0.5) * k; d[i + 2] += (rng() - 0.5) * k; }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Erode a drawn mask so a marking looks sprayed through a worn stencil rather than
 * printed: multiply alpha by a noisy threshold and nibble the edges.
 */
export function weatherMask(ctx, w, h, { rng, bite = 0.35, grain = 0.25, patches = 40 } = {}) {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < patches; i++) {
    const px = rng() * w, py = rng() * h;
    const r = (0.02 + rng() * 0.12) * Math.min(w, h);
    ctx.fillStyle = radialRamp(ctx, px, py, 0, r, [
      [0, '#000', bite * (0.4 + rng() * 0.6)], [0.6, '#000', bite * 0.3], [1, '#000', 0],
    ]);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  if (grain > 0) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] === 0) continue;
      d[i] *= 1 - rng() * grain;
    }
    ctx.putImageData(img, 0, 0);
  }
}

// ------------------------------------------------------------------- resampling

/**
 * Bilinear sample of a Float32 field with wrapping — the workhorse for upsampling
 * cheap low-res noise into a 2048² composite without paying full-res noise cost.
 */
export function sampleFieldWrapped(field, size, u, v) {
  const fx = u * size - 0.5, fy = v * size - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const xa = ((x0 % size) + size) % size, xb = (xa + 1) % size;
  const ya = ((y0 % size) + size) % size, yb = (ya + 1) % size;
  const r0 = ya * size, r1 = yb * size;
  const a = field[r0 + xa], b = field[r0 + xb], c = field[r1 + xa], d = field[r1 + xb];
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

/** Nearest-power upsample of a square Float32 field to a larger square, wrapped. */
export function upsampleField(src, srcSize, dstSize) {
  const out = new Float32Array(dstSize * dstSize);
  const inv = 1 / dstSize;
  for (let y = 0; y < dstSize; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < dstSize; x++) {
      out[y * dstSize + x] = sampleFieldWrapped(src, srcSize, (x + 0.5) * inv, v);
    }
  }
  return out;
}
