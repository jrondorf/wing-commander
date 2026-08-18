/**
 * src/ui/insignia.js — decorations, drawn not downloaded.
 *
 * The debrief's promotion/medal beat is the payoff for a mission, so it needs a
 * thing to look at. These are small canvas drawings: a ribbon bar, a struck
 * metal device and rank chevrons, all seeded off the award's name so a given
 * medal always looks the same.
 */
import { makeRng, hashSeed } from '../core/Rand.js';
import { hexA } from './backdrop.js';

const RIBBONS = {
  gold: ['#ffcf6a', '#b8781f', '#ffe6ad'],
  silver: ['#dfe8ee', '#7e8b95', '#ffffff'],
  bronze: ['#d79a5c', '#7d4d22', '#f0c191'],
  crimson: ['#e2483a', '#7d1f16', '#ff8b7d'],
  blue: ['#5fa8e8', '#1d4a7a', '#a8d6ff'],
};

/**
 * @param {string} name  medal name; picks the ribbon family and the device
 * @param {number} points 4..8 device points
 */
export function drawMedal(ctx, w, h, name = 'Service Star') {
  const r = makeRng(hashSeed(`medal:${name}`));
  const fam = Object.keys(RIBBONS)[r.int(0, Object.keys(RIBBONS).length - 1)];
  const [mid, dark, light] = RIBBONS[fam];
  const cx = w / 2;
  ctx.clearRect(0, 0, w, h);

  // Ribbon bar with vertical stripes.
  const rw = w * 0.62;
  const rh = h * 0.26;
  const rx = cx - rw / 2;
  const ry = h * 0.03;
  const stripes = r.int(3, 6);
  for (let i = 0; i < stripes; i++) {
    const sw = rw / stripes;
    ctx.fillStyle = i % 2 === 0 ? mid : dark;
    ctx.fillRect(rx + i * sw, ry, sw, rh);
  }
  const rg = ctx.createLinearGradient(0, ry, 0, ry + rh);
  rg.addColorStop(0, hexA('#ffffff', 0.30));
  rg.addColorStop(0.5, hexA('#ffffff', 0.02));
  rg.addColorStop(1, hexA('#000000', 0.35));
  ctx.fillStyle = rg;
  ctx.fillRect(rx, ry, rw, rh);
  ctx.strokeStyle = hexA('#000000', 0.55);
  ctx.lineWidth = 1;
  ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);

  // Suspension ring.
  ctx.strokeStyle = light;
  ctx.lineWidth = Math.max(1.4, h * 0.022);
  ctx.beginPath();
  ctx.arc(cx, ry + rh + h * 0.055, h * 0.05, 0, Math.PI * 2);
  ctx.stroke();

  // Struck device: a star or cross with a facetted metal gradient.
  const dy = h * 0.62;
  const R = Math.min(w, h) * 0.30;
  const points = r.int(4, 8);
  ctx.save();
  ctx.translate(cx, dy);
  ctx.rotate(r.range(-0.1, 0.1));
  for (let pass = 0; pass < 2; pass++) {
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
      const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
      const rad = (i % 2 === 0 ? R : R * 0.42) * (pass === 0 ? 1 : 0.62);
      ctx[i === 0 ? 'moveTo' : 'lineTo'](Math.cos(a) * rad, Math.sin(a) * rad);
    }
    ctx.closePath();
    const g = ctx.createLinearGradient(-R, -R, R, R);
    g.addColorStop(0, light);
    g.addColorStop(0.42, mid);
    g.addColorStop(0.62, dark);
    g.addColorStop(1, mid);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = hexA('#000000', 0.45);
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  // Centre boss.
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.24, 0, Math.PI * 2);
  const bg = ctx.createRadialGradient(-R * 0.08, -R * 0.08, 0, 0, 0, R * 0.24);
  bg.addColorStop(0, light);
  bg.addColorStop(1, dark);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.restore();

  // Specular glint.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const sg = ctx.createLinearGradient(cx - R, dy - R, cx + R * 0.2, dy + R * 0.2);
  sg.addColorStop(0, hexA('#ffffff', 0.22));
  sg.addColorStop(1, hexA('#ffffff', 0));
  ctx.fillStyle = sg;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/** Rank chevrons for a promotion line. */
export function drawChevrons(ctx, w, h, count = 2, color = '#ffb04a') {
  ctx.clearRect(0, 0, w, h);
  const n = Math.max(1, Math.min(5, count));
  const gap = h / (n + 1);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.6, h * 0.06);
  ctx.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const y = gap * (i + 0.75);
    ctx.beginPath();
    ctx.moveTo(w * 0.14, y + h * 0.1);
    ctx.lineTo(w * 0.5, y - h * 0.08);
    ctx.lineTo(w * 0.86, y + h * 0.1);
    ctx.stroke();
  }
}
