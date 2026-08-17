/**
 * Procedural lens dirt.
 *
 * No external assets, ever — this paints the smudge/dust/scratch mask on a 2D
 * canvas from a seeded RNG. Four layers, in the order a real lens accumulates
 * them:
 *   1. broad grease smudges (fingerprints, wiped cloth) — big, very soft, biased
 *      towards the edges where a hand actually touches the glass
 *   2. dust motes — hundreds of tiny points, radially biased outwards
 *   3. hair/scratch strokes — long low-alpha curves
 *   4. a couple of drying-fluid rings
 *
 * The result is a single-channel mask consumed by the composite pass to modulate
 * bloom. It is never added on its own: dirt you can see on a dark frame is a bug.
 */

import * as THREE from 'three';
import { makeRng } from '../../core/Rand.js';

/**
 * @param {object} opts
 * @param {number} [opts.size=1024]
 * @param {number} [opts.seed=20791]
 * @param {number} [opts.density=1] scales every layer's element count
 * @returns {THREE.CanvasTexture}
 */
export function generateLensDirtTexture({ size = 1024, seed = 20791, density = 1 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { alpha: false });
  const rng = makeRng(seed);

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'lighter';

  const S = size / 1024;

  // Bias a sample towards the frame edges — dirt collects where fingers and
  // cloth touch, and a perfectly uniform distribution reads as noise, not grime.
  const edgeBiased = () => {
    const a = rng() * Math.PI * 2;
    const r = 0.12 + Math.pow(rng(), 0.55) * 0.62;
    return [0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r];
  };

  // ---- 1. grease smudges ---------------------------------------------------
  const smudges = Math.round(52 * density);
  for (let i = 0; i < smudges; i++) {
    const [ux, uy] = edgeBiased();
    const x = ux * size;
    const y = uy * size;
    const rx = (18 + rng() * 130) * S;
    const ry = rx * rng.range(0.28, 1.0);
    const rot = rng() * Math.PI;
    const alpha = rng.range(0.05, 0.30);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(1, ry / rx);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0.0, `rgba(255,255,255,${alpha.toFixed(4)})`);
    g.addColorStop(0.45, `rgba(255,255,255,${(alpha * 0.35).toFixed(4)})`);
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ---- 2. dust motes -------------------------------------------------------
  const motes = Math.round(1400 * density);
  for (let i = 0; i < motes; i++) {
    const [ux, uy] = edgeBiased();
    const x = ux * size;
    const y = uy * size;
    const r = (0.6 + Math.pow(rng(), 3) * 9) * S;
    const alpha = rng.range(0.10, 0.85) * (r < 2 * S ? 0.6 : 1.0);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0.0, `rgba(255,255,255,${alpha.toFixed(4)})`);
    g.addColorStop(0.6, `rgba(255,255,255,${(alpha * 0.28).toFixed(4)})`);
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // ---- 3. scratches / hairs -------------------------------------------------
  const scratches = Math.round(30 * density);
  ctx.lineCap = 'round';
  for (let i = 0; i < scratches; i++) {
    const [ux, uy] = edgeBiased();
    const x0 = ux * size;
    const y0 = uy * size;
    const a = rng() * Math.PI * 2;
    const len = (60 + rng() * 420) * S;
    const bow = rng.range(-0.45, 0.45) * len;
    const x1 = x0 + Math.cos(a) * len;
    const y1 = y0 + Math.sin(a) * len;
    const cx = (x0 + x1) * 0.5 + Math.cos(a + Math.PI / 2) * bow;
    const cy = (y0 + y1) * 0.5 + Math.sin(a + Math.PI / 2) * bow;

    ctx.strokeStyle = `rgba(255,255,255,${rng.range(0.04, 0.17).toFixed(4)})`;
    ctx.lineWidth = rng.range(0.7, 3.2) * S;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(cx, cy, x1, y1);
    ctx.stroke();
  }

  // ---- 4. dried droplet rings ----------------------------------------------
  const rings = Math.round(9 * density);
  for (let i = 0; i < rings; i++) {
    const [ux, uy] = edgeBiased();
    const x = ux * size;
    const y = uy * size;
    const r = (24 + rng() * 120) * S;
    const alpha = rng.range(0.05, 0.20);
    const g = ctx.createRadialGradient(x, y, r * 0.62, x, y, r);
    g.addColorStop(0.0, 'rgba(255,255,255,0)');
    g.addColorStop(0.75, `rgba(255,255,255,${alpha.toFixed(4)})`);
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // ---- 5. faint overall haze so the mask never has dead-zero regions --------
  ctx.globalCompositeOperation = 'lighter';
  const haze = ctx.createRadialGradient(size * 0.5, size * 0.5, size * 0.18, size * 0.5, size * 0.5, size * 0.72);
  haze.addColorStop(0, 'rgba(255,255,255,0.010)');
  haze.addColorStop(1, 'rgba(255,255,255,0.075)');
  ctx.fillStyle = haze;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace; // this is a mask, not albedo
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  tex.name = `lensDirt/${size}/${seed}`;
  return tex;
}
