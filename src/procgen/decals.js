/**
 * Decals — squadron insignia, hull numbers, stencilled warning blocks, hazard
 * striping and stripe liveries, all drawn with real vector shapes and real glyphs
 * on a 2D canvas.
 *
 * Two ways to consume them:
 *
 *  - `generateDecalTexture(engine, opts)` for a standalone alpha-masked
 *    `THREE.CanvasTexture` (decal meshes, HUD, briefing screens).
 *  - `paintMarkingLayer(...)` for textures.js, which composites the layer into the
 *    hull albedo *underneath* the wear and grime passes. Markings that sit on top
 *    of the dirt read as stickers; markings that get worn through read as paint.
 */

import * as THREE from 'three';
import { makeRng, hashSeed } from '../core/Rand.js';
import {
  makeSurface, stampText, stampStencilText, hazardStripes, roundRectPath,
  polygonPath, radialRamp, rgbaCss, weatherMask, FONT_SANS, FONT_MONO, FONT_COND,
} from './canvasKit.js';

// ------------------------------------------------------------------- word banks

const WARN_BLOCKS = [
  ['DANGER', 'INTAKE', 'KEEP CLEAR'],
  ['NO STEP', 'COMPOSITE'],
  ['RESCUE', 'CUT HERE'],
  ['EJECTION SEAT', 'DO NOT TOW'],
  ['FUEL', 'H2-CRYO', 'GRD BEFORE'],
  ['AVIONICS BAY', 'ACCESS 4C'],
  ['CAUTION', 'HOT SURFACE'],
  ['ORDNANCE', 'ARMED'],
  ['GND PWR', '400 HZ'],
  ['COOLANT', 'PURGE VALVE'],
  ['SERVICE', 'PANEL 12'],
  ['LIFT POINT', 'MAX 4T'],
];

const KIL_BLOCKS = [
  ['KTITHRAK', 'MANG'],
  ['SIVAR', 'DUE'],
  ['HRAI', 'NAR CAXKI'],
  ['VAK RATHA'],
  ['UTUKH', 'ZU'],
];

const CIV_BLOCKS = [
  ['CARGO', 'BAY 2'],
  ['LIFE SUPPORT'],
  ['REGISTRY', 'TCN-4471'],
  ['NO SMOKING'],
  ['EMERGENCY', 'RELEASE'],
];

const SQUADRONS = [
  'BLACK LIONS', 'WILD EAGLES', 'DIAMONDBACKS', 'GOLDEN SUNS', 'IRON HAWKS',
  'STAR SLAYERS', 'RED DEVILS', 'BLUE LANCE', 'GREY GHOSTS', 'SABRE WING',
];

// ---------------------------------------------------------------- insignia art

/**
 * Squadron insignia. Built from primitive shapes rather than a font so it reads as
 * a badge: a shield/roundel/star ground, a device on top, a motto ring.
 */
export function drawInsignia(ctx, {
  x = 0, y = 0, size = 256, seed = 1, kind = null,
  primary = '#c8cdd2', secondary = '#1d232b', accent = '#e07a2a', text = null,
} = {}) {
  const rng = makeRng((seed >>> 0) || 1);
  const kinds = ['shield', 'roundel', 'star', 'chevron', 'fang'];
  const k = kind ?? kinds[(rng() * kinds.length) | 0];
  const r = size * 0.5;
  ctx.save();
  ctx.translate(x, y);

  const strokeAll = (w, c) => { ctx.lineWidth = w; ctx.strokeStyle = c; ctx.stroke(); };

  if (k === 'shield') {
    ctx.beginPath();
    ctx.moveTo(-r * 0.78, -r * 0.86);
    ctx.lineTo(r * 0.78, -r * 0.86);
    ctx.lineTo(r * 0.78, r * 0.18);
    ctx.quadraticCurveTo(r * 0.72, r * 0.72, 0, r * 0.95);
    ctx.quadraticCurveTo(-r * 0.72, r * 0.72, -r * 0.78, r * 0.18);
    ctx.closePath();
    ctx.fillStyle = secondary; ctx.fill();
    strokeAll(size * 0.045, primary);
    // Diagonal bend.
    ctx.save();
    ctx.clip();
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(-r, r * 0.1); ctx.lineTo(r * 0.1, -r); ctx.lineTo(r * 0.55, -r);
    ctx.lineTo(-r * 0.55, r * 0.55); ctx.closePath();
    ctx.fill();
    ctx.restore();
  } else if (k === 'roundel') {
    for (const [rr, c] of [[1, primary], [0.72, secondary], [0.42, accent]]) {
      ctx.beginPath();
      ctx.arc(0, 0, r * rr * 0.92, 0, Math.PI * 2);
      ctx.fillStyle = c; ctx.fill();
    }
  } else if (k === 'star') {
    polygonPath(ctx, 0, 0, 10, (i) => (i % 2 ? r * 0.42 : r * 0.95), -Math.PI / 2);
    ctx.fillStyle = accent; ctx.fill();
    strokeAll(size * 0.03, primary);
    ctx.beginPath(); ctx.arc(0, 0, r * 0.34, 0, Math.PI * 2);
    ctx.fillStyle = secondary; ctx.fill();
  } else if (k === 'chevron') {
    ctx.beginPath(); ctx.arc(0, 0, r * 0.94, 0, Math.PI * 2);
    ctx.fillStyle = secondary; ctx.fill();
    strokeAll(size * 0.05, primary);
    ctx.fillStyle = accent;
    for (let i = 0; i < 3; i++) {
      const o = -r * 0.5 + i * r * 0.42;
      ctx.beginPath();
      ctx.moveTo(-r * 0.62, o + r * 0.26);
      ctx.lineTo(0, o - r * 0.2);
      ctx.lineTo(r * 0.62, o + r * 0.26);
      ctx.lineTo(r * 0.62, o + r * 0.42);
      ctx.lineTo(0, o - r * 0.04);
      ctx.lineTo(-r * 0.62, o + r * 0.42);
      ctx.closePath(); ctx.fill();
    }
  } else {
    // 'fang' — Kilrathi-style: three claw slashes across a dark disc.
    ctx.beginPath(); ctx.arc(0, 0, r * 0.94, 0, Math.PI * 2);
    ctx.fillStyle = secondary; ctx.fill();
    strokeAll(size * 0.035, accent);
    ctx.strokeStyle = primary;
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const o = (i - 1) * r * 0.44;
      ctx.lineWidth = size * (0.075 - i * 0.012);
      ctx.beginPath();
      ctx.moveTo(o - r * 0.5, -r * 0.72);
      ctx.quadraticCurveTo(o + r * 0.1, 0, o + r * 0.32, r * 0.78);
      ctx.stroke();
    }
  }

  if (text) {
    stampText(ctx, text, {
      x: 0, y: r * 1.28, size: size * 0.13, tracking: 0.16, font: FONT_COND,
      align: 'center', fill: primary, condense: 0.9, weight: 700,
    });
  }
  ctx.restore();
  return k;
}

// -------------------------------------------------------------- marking layers

/**
 * Paint every squadron marking onto a transparent full-size layer.
 *
 * Placement is in normalised UV so callers can reason about it; the layer is drawn
 * once at texture resolution and read back as RGBA by textures.js.
 */
export function paintMarkingLayer(size, {
  seed = 1, style = 'confed', palette, insignia = null, wear = 0.5,
} = {}) {
  const rng = makeRng(hashSeed(`markings:${style}:${seed}`) >>> 0);
  const { canvas, ctx } = makeSurface(size, size);
  ctx.clearRect(0, 0, size, size);

  const paintLight = palette.markLight ?? '#d8dde2';
  const paintDark = palette.markDark ?? '#161a20';
  const accent = palette.accent ?? '#e07a2a';
  const S = size / 2048; // authoring scale — everything below is tuned at 2048²

  const blocks = style === 'kilrathi' || style === 'alien' ? KIL_BLOCKS
    : style === 'civilian' ? CIV_BLOCKS : WARN_BLOCKS;

  // ---- livery stripes ------------------------------------------------------
  // Bands that run the length of the hull. Slightly off-axis and tapered so they
  // read as sprayed onto a curved fuselage, not as a UV-space rectangle.
  const stripeCount = style === 'capital' ? 1 : rng.int(1, 2);
  for (let i = 0; i < stripeCount; i++) {
    const y0 = (0.12 + rng() * 0.7) * size;
    const h = (style === 'capital' ? 0.02 : 0.035 + rng() * 0.05) * size;
    const tilt = rng.gauss(0, 0.012);
    ctx.save();
    ctx.translate(0, y0);
    ctx.rotate(tilt);
    ctx.globalAlpha = 0.9;
    const col = rng() < 0.55 ? accent : paintLight;
    ctx.fillStyle = col;
    ctx.fillRect(-size * 0.1, 0, size * 1.2, h);
    // Thin outline stripes above and below sell it as a real livery.
    ctx.fillStyle = paintDark;
    ctx.fillRect(-size * 0.1, -h * 0.16, size * 1.2, h * 0.13);
    ctx.fillRect(-size * 0.1, h * 1.03, size * 1.2, h * 0.13);
    ctx.restore();
  }

  // ---- squadron insignia ---------------------------------------------------
  const insigniaSpec = typeof insignia === 'string' ? { kind: insignia } : (insignia ?? {});
  const badgeCount = style === 'capital' ? 1 : 2;
  const squadron = insigniaSpec.text ?? SQUADRONS[(rng() * SQUADRONS.length) | 0];
  for (let i = 0; i < badgeCount; i++) {
    const bs = (style === 'capital' ? 0.11 : 0.17) * size * (0.85 + rng() * 0.3);
    const bx = (0.16 + rng() * 0.68) * size;
    const by = (0.14 + rng() * 0.7) * size;
    ctx.save();
    ctx.rotate(0);
    drawInsignia(ctx, {
      x: bx, y: by, size: bs, seed: (seed * 31 + i * 7) >>> 0,
      kind: insigniaSpec.kind ?? null,
      primary: insigniaSpec.primary ?? paintLight,
      secondary: insigniaSpec.secondary ?? paintDark,
      accent: insigniaSpec.accent ?? accent,
      text: i === 0 ? squadron : null,
    });
    ctx.restore();
  }

  // ---- hull numbers --------------------------------------------------------
  const tail = insigniaSpec.hullNumber ?? `${rng.int(1, 9)}${rng.int(0, 9)}${rng.int(0, 9)}`;
  const prefix = style === 'kilrathi' ? 'KIS' : style === 'civilian' ? 'TCN' : 'TCS';
  for (let i = 0; i < 2; i++) {
    const ns = (0.075 + rng() * 0.03) * size;
    stampText(ctx, tail, {
      x: (0.1 + rng() * 0.75) * size, y: (0.16 + rng() * 0.72) * size,
      size: ns, tracking: 0.05, font: FONT_COND, weight: 700,
      fill: rng() < 0.5 ? paintLight : paintDark, condense: 0.82,
      align: 'left', alpha: 0.92,
    });
  }
  stampText(ctx, `${prefix}-${tail}${String.fromCharCode(65 + rng.int(0, 25))}`, {
    x: (0.08 + rng() * 0.5) * size, y: (0.2 + rng() * 0.68) * size,
    size: 0.03 * size, tracking: 0.14, font: FONT_MONO, weight: 700,
    fill: paintLight, alpha: 0.8,
  });

  // ---- stencilled warning blocks ------------------------------------------
  const blockCount = 10 + rng.int(0, 6);
  for (let i = 0; i < blockCount; i++) {
    const lines = blocks[(rng() * blocks.length) | 0];
    const ts = (0.013 + rng() * 0.011) * size;
    const bx = rng() * size;
    const by = rng() * size;
    const rot = rng() < 0.22 ? (rng() < 0.5 ? Math.PI / 2 : -Math.PI / 2) : 0;
    const dark = rng() < 0.62;
    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(rot);
    ctx.globalAlpha = 0.72 + rng() * 0.28;
    for (let l = 0; l < lines.length; l++) {
      stampStencilText(ctx, lines[l], {
        x: 0, y: l * ts * 1.32, size: ts, tracking: 0.16, font: FONT_COND,
        weight: 700, fill: dark ? paintDark : paintLight, condense: 0.86,
        bridges: ts > 22 * S ? 2 : 0,
      });
    }
    // Occasional boxed callout with a leader line to an access hatch.
    if (rng() < 0.3) {
      const bw = ts * 6.2, bh = ts * 1.5 * lines.length;
      ctx.strokeStyle = dark ? paintDark : paintLight;
      ctx.lineWidth = Math.max(1, ts * 0.09);
      ctx.strokeRect(-ts * 0.4, -ts * 0.95, bw, bh);
    }
    ctx.restore();
  }

  // ---- hazard striping around service points -------------------------------
  const hazardCount = 3 + rng.int(0, 3);
  for (let i = 0; i < hazardCount; i++) {
    const hw = (0.06 + rng() * 0.12) * size;
    const hh = (0.014 + rng() * 0.016) * size;
    ctx.save();
    ctx.translate(rng() * size, rng() * size);
    ctx.rotate(rng() < 0.35 ? Math.PI / 2 : 0);
    ctx.globalAlpha = 0.85;
    hazardStripes(ctx, {
      x: 0, y: 0, w: hw, h: hh, pitch: hh * 1.1, angle: Math.PI / 4,
      colorA: accent, colorB: paintDark, duty: 0.5,
    });
    ctx.restore();
  }

  // ---- walkway / no-step dashed borders ------------------------------------
  if (style !== 'alien') {
    ctx.save();
    ctx.setLineDash([size * 0.012, size * 0.008]);
    ctx.strokeStyle = rgbaCss(paintLight, 0.55);
    ctx.lineWidth = Math.max(1, size * 0.0022);
    for (let i = 0; i < 3; i++) {
      const wx = rng() * size, wy = rng() * size;
      const ww = (0.12 + rng() * 0.22) * size, wh = (0.05 + rng() * 0.1) * size;
      roundRectPath(ctx, wx, wy, ww, wh, size * 0.008);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---- rank/kill tallies ---------------------------------------------------
  if (style === 'confed' || style === 'kilrathi') {
    const kills = rng.int(2, 11);
    const kx = (0.1 + rng() * 0.7) * size, ky = (0.15 + rng() * 0.7) * size;
    const ks = size * 0.016;
    for (let i = 0; i < kills; i++) {
      const col = i % 5, row = (i / 5) | 0;
      ctx.save();
      ctx.translate(kx + col * ks * 1.5, ky + row * ks * 1.7);
      ctx.globalAlpha = 0.8;
      if (style === 'confed') {
        // Kilrathi silhouette tally.
        ctx.fillStyle = accent;
        polygonPath(ctx, 0, 0, 3, ks * 0.6, -Math.PI / 2);
        ctx.fill();
      } else {
        ctx.fillStyle = paintLight;
        ctx.fillRect(-ks * 0.12, -ks * 0.6, ks * 0.24, ks * 1.2);
      }
      ctx.restore();
    }
  }

  // Markings are sprayed through stencils that have been used a hundred times and
  // then flown through a war — nibble them before they ever reach the albedo.
  weatherMask(ctx, size, size, {
    rng, bite: 0.25 + wear * 0.5, grain: 0.12 + wear * 0.3, patches: 60,
  });

  return canvas;
}

// ------------------------------------------------------- standalone THREE decals

/**
 * A single alpha-masked decal as a `THREE.CanvasTexture`.
 * @param {'insignia'|'number'|'stencil'|'hazard'|'roundel'} kind
 */
export function generateDecalTexture(engine, {
  kind = 'insignia', size = 256, seed = 1, text = null, palette = null,
  colorSpace = THREE.SRGBColorSpace, wear = 0.35,
} = {}) {
  const pal = palette ?? { markLight: '#d8dde2', markDark: '#161a20', accent: '#e07a2a' };
  const key = `decal/${kind}/${size}/${seed}/${text ?? ''}/${pal.accent}/${wear}`;
  const make = () => {
    const rng = makeRng(hashSeed(key) >>> 0);
    const { canvas, ctx } = makeSurface(size, size);
    ctx.clearRect(0, 0, size, size);
    if (kind === 'insignia' || kind === 'roundel') {
      drawInsignia(ctx, {
        x: size / 2, y: size * 0.46, size: size * 0.72, seed,
        kind: kind === 'roundel' ? 'roundel' : null,
        primary: pal.markLight, secondary: pal.markDark, accent: pal.accent,
        text: text ?? null,
      });
    } else if (kind === 'number') {
      stampText(ctx, text ?? `${rng.int(100, 999)}`, {
        x: size / 2, y: size * 0.68, size: size * 0.6, tracking: 0.06,
        font: FONT_COND, weight: 700, align: 'center', fill: pal.markLight, condense: 0.8,
      });
    } else if (kind === 'stencil') {
      const lines = (text ? String(text).split('\n') : WARN_BLOCKS[rng.int(0, WARN_BLOCKS.length - 1)]);
      const ts = size / (Math.max(6, lines.reduce((m, l) => Math.max(m, l.length), 0)) * 0.62);
      for (let l = 0; l < lines.length; l++) {
        stampStencilText(ctx, lines[l], {
          x: size / 2, y: size * 0.35 + l * ts * 1.3, size: ts, tracking: 0.16,
          font: FONT_COND, weight: 700, align: 'center', fill: pal.markLight, condense: 0.86,
        });
      }
    } else if (kind === 'hazard') {
      hazardStripes(ctx, {
        x: 0, y: size * 0.34, w: size, h: size * 0.32, pitch: size * 0.14,
        angle: Math.PI / 4, colorA: pal.accent, colorB: pal.markDark,
      });
    }
    weatherMask(ctx, size, size, { rng, bite: wear, grain: wear * 0.6, patches: 30 });
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = colorSpace;
    tex.anisotropy = engine?.maxAnisotropy ?? 1;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.needsUpdate = true;
    return tex;
  };
  return engine?.registry ? engine.registry.get(key, make) : make();
}

/** Hazard striping as a tileable strip texture — handy for cargo bays and gantries. */
export function generateHazardTexture(engine, { width = 512, height = 128, pitch = 64, palette = null } = {}) {
  const pal = palette ?? { accent: '#e5a21c', markDark: '#1a1a1a' };
  const key = `decal/hazardstrip/${width}x${height}/${pitch}/${pal.accent}`;
  const make = () => {
    const { canvas, ctx } = makeSurface(width, height);
    hazardStripes(ctx, { x: 0, y: 0, w: width, h: height, pitch, colorA: pal.accent, colorB: pal.markDark });
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = engine?.maxAnisotropy ?? 1;
    tex.needsUpdate = true;
    return tex;
  };
  return engine?.registry ? engine.registry.get(key, make) : make();
}

export { SQUADRONS, WARN_BLOCKS };
