/**
 * Multi-function displays.
 *
 * Two 512² surfaces, both driven through the same CRT shader so they read as
 * glass tubes rather than web pages: barrel distortion, an aperture grille, a
 * phosphor tint with a nine-tap bleed, a rolling refresh bar, a corner sheen and
 * a vignette. Text is painted at 512² and then *undersampled* on screen (the
 * displays are ~250 px tall in a 900 px frame), which is what keeps it legible.
 *
 *   left   TARGET VDU   — a live 3D render of the locked target, plus class,
 *                         shields, armour, range and closure.
 *   right  DAMAGE VDU   — the player's own hull, per-quadrant armour and the
 *                         fore/aft shield arcs.
 *
 * The target VDU renders `engine.scene` with everything except the target and
 * the lights temporarily hidden. That is a two-line save/restore inside one
 * function, it never mutates another module's state across a frame boundary, and
 * it gives a correctly lit ship against black for the cost of one small pass.
 */

import * as THREE from 'three';
import { makeSurface, FONT_COND, FONT_MONO, roundRectPath } from '../procgen/canvasKit.js';

export const MFD_RES = 512;

const CYAN = '#8fe4ff';
const AMBER = '#ffb45a';
const RED = '#ff6a52';
const GREEN = '#7dffa8';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// ---------------------------------------------------------------------------
// CRT material
// ---------------------------------------------------------------------------

const CRT_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const CRT_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tContent;
uniform sampler2D tOverlay;
uniform vec3  uTint;
uniform float uBright;
uniform float uCurve;
uniform float uScanCount;
uniform float uScanAmt;
uniform float uTime;
uniform float uGlow;
uniform float uContentMix;
uniform float uOn;
varying vec2 vUv;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  // ---- barrel distortion -------------------------------------------------
  vec2 c = vUv * 2.0 - 1.0;
  float r2 = dot(c, c);
  c *= 1.0 + uCurve * r2;
  vec2 uv = c * 0.5 + 0.5;

  // Outside the tube face: the black surround inside the bezel.
  float edge = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);

  vec3 col = texture2D(tContent, uv).rgb * uContentMix;

  // ---- overlay + phosphor bleed -----------------------------------------
  vec4 ov = texture2D(tOverlay, uv);
  vec3 glow = vec3(0.0);
  float g = 1.0 / 512.0 * 2.2;
  for (int i = -1; i <= 1; i++) {
    for (int j = -1; j <= 1; j++) {
      if (i == 0 && j == 0) continue;
      vec4 s = texture2D(tOverlay, uv + vec2(float(i), float(j)) * g);
      glow += s.rgb * s.a;
    }
  }
  col += ov.rgb * ov.a;
  col += glow * (uGlow / 8.0);

  col *= uTint;

  // ---- aperture grille ---------------------------------------------------
  float sl = 0.5 + 0.5 * cos(uv.y * uScanCount * 6.28318);
  col *= mix(1.0, 1.0 - uScanAmt, sl);
  col *= 0.94 + 0.06 * cos(uv.x * uScanCount * 2.0 * 6.28318);

  // ---- refresh roll ------------------------------------------------------
  float roll = fract(uv.y * 0.5 - uTime * 0.11);
  col *= 1.0 + 0.10 * smoothstep(0.96, 1.0, roll);

  // ---- tube glass: vignette, corner sheen, grain -------------------------
  col *= 1.0 - 0.62 * pow(clamp(r2 * 0.62, 0.0, 1.0), 1.7);
  float sheen = smoothstep(0.55, 1.6, (0.72 - uv.x) + uv.y * 1.25);
  col += vec3(0.055, 0.070, 0.085) * sheen * 0.85;
  col += (hash21(uv * 512.0 + uTime) - 0.5) * 0.020;

  // Faint always-on raster wash so a dead display still reads as powered glass.
  col += uTint * 0.012;

  gl_FragColor = vec4(col * uBright * edge * uOn, 1.0);
}`;

export function createCrtMaterial(engine, {
  content, overlay, tint = CYAN, bright = 1.45, curve = 0.085, scanCount = 190,
  scanAmt = 0.34, glow = 1.0, contentMix = 1.0,
} = {}) {
  return new THREE.ShaderMaterial({
    name: 'cockpit-crt',
    uniforms: {
      tContent: { value: content },
      tOverlay: { value: overlay },
      uTint: { value: new THREE.Color(tint).convertSRGBToLinear() },
      uBright: { value: bright },
      uCurve: { value: curve },
      uScanCount: { value: scanCount },
      uScanAmt: { value: scanAmt },
      uTime: { value: 0 },
      uGlow: { value: glow },
      uContentMix: { value: contentMix },
      uOn: { value: 1 },
    },
    vertexShader: CRT_VERT,
    fragmentShader: CRT_FRAG,
    depthWrite: true,
    depthTest: true,
    toneMapped: false,
  });
}

// ---------------------------------------------------------------------------
// shared canvas helpers
// ---------------------------------------------------------------------------

function surface(size = MFD_RES) {
  const s = makeSurface(size, size, { alpha: true });
  const tex = new THREE.CanvasTexture(s.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.anisotropy = engineAniso(size);
  return { ...s, texture: tex, size };
}
function engineAniso() { return 1; }

/** Tracked stencil text — the only text style these displays use. */
function txt(ctx, s, x, y, { size = 18, color = CYAN, align = 'left', track = 0.06, weight = 700, font = FONT_COND, alpha = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color;
  const str = String(s);
  const gap = track * size;
  let total = 0;
  const w = [];
  for (let i = 0; i < str.length; i++) { const m = ctx.measureText(str[i]).width; w.push(m); total += m + (i < str.length - 1 ? gap : 0); }
  let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  for (let i = 0; i < str.length; i++) { if (str[i] !== ' ') ctx.fillText(str[i], cx, y); cx += w[i] + gap; }
  ctx.restore();
  return total;
}

/** Segmented bar — the display idiom for every quantity on these panels. */
function bar(ctx, x, y, w, h, frac, { color = CYAN, segments = 16, bg = 'rgba(255,255,255,0.09)', warn = 0.34 } = {}) {
  const f = clamp01(frac);
  const gap = 2;
  const sw = (w - gap * (segments - 1)) / segments;
  const lit = Math.round(f * segments);
  for (let i = 0; i < segments; i++) {
    ctx.fillStyle = i < lit ? (f < warn ? RED : color) : bg;
    ctx.fillRect(x + i * (sw + gap), y, sw, h);
  }
}

function grid(ctx, size, { color = 'rgba(140,220,255,0.10)', step = 32 } = {}) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = step; i < size; i += step) {
    ctx.moveTo(i + 0.5, 0); ctx.lineTo(i + 0.5, size);
    ctx.moveTo(0, i + 0.5); ctx.lineTo(size, i + 0.5);
  }
  ctx.stroke();
  ctx.restore();
}

/** Corner ticks + a title strip: the chrome every VDU page shares. */
function frameChrome(ctx, size, title, { color = CYAN, sub = '' } = {}) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = 2;
  const m = 12;
  const k = 26;
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const x = sx > 0 ? m : size - m;
    const y = sy > 0 ? m : size - m;
    ctx.beginPath();
    ctx.moveTo(x + sx * k, y); ctx.lineTo(x, y); ctx.lineTo(x, y + sy * k);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
  ctx.save();
  ctx.fillStyle = 'rgba(120,200,240,0.13)';
  ctx.fillRect(m, m, size - m * 2, 30);
  ctx.restore();
  txt(ctx, title, m + 10, m + 22, { size: 20, color, track: 0.14 });
  if (sub) txt(ctx, sub, size - m - 10, m + 22, { size: 16, color, align: 'right', track: 0.1, alpha: 0.8 });
}

const fmtRange = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)}K` : `${Math.round(m)}`);

// ---------------------------------------------------------------------------
// LEFT — target VDU
// ---------------------------------------------------------------------------

export function createTargetVdu(engine) {
  const rt = new THREE.WebGLRenderTarget(MFD_RES, MFD_RES, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: true,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    colorSpace: THREE.NoColorSpace,
  });
  const cam = new THREE.PerspectiveCamera(28, 1, 0.5, 40000);
  const ov = surface();
  const hidden = [];
  const _v = new THREE.Vector3();
  const _u = new THREE.Vector3();
  let sweepPhase = 0;

  /** Live 3D pass. Returns true when something was actually drawn. */
  function renderScene(eng, target) {
    const scene = eng.scene;
    const g = target?.ship?.group;
    if (!g) return false;
    const r = Math.max(2, num(target.radius, 10));

    // Look at the target from the player's own aspect, so the VDU answers
    // "which way is it pointing" — the question the pilot is actually asking.
    _u.copy(target.position).sub(eng.cockpitCamera.position);
    if (_u.lengthSq() < 1e-6) _u.set(0, 0, 1);
    _u.normalize();
    const dist = r * 3.1;
    _v.copy(target.position).addScaledVector(_u, -dist);
    _v.y += r * 0.28;
    cam.position.copy(_v);
    cam.up.set(0, 1, 0);
    cam.lookAt(target.position);
    cam.near = Math.max(0.4, dist - r * 4);
    cam.far = dist + r * 8;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    const bg = scene.background;
    const env = scene.environment;
    scene.background = null;
    // A little env light keeps the dark side of the hull from going to zero.
    hidden.length = 0;
    for (const c of scene.children) {
      if (c.isLight) continue;
      if (c === g) continue;
      if (c.visible) { c.visible = false; hidden.push(c); }
    }

    const renderer = eng.renderer;
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, false);
    renderer.render(scene, cam);
    renderer.setRenderTarget(prevTarget);

    for (const c of hidden) c.visible = true;
    hidden.length = 0;
    scene.background = bg;
    scene.environment = env;
    return true;
  }

  function paint(st, dt) {
    const ctx = ov.ctx;
    const S = ov.size;
    ctx.clearRect(0, 0, S, S);
    sweepPhase = (sweepPhase + dt * 0.35) % 1;

    const t = st?.target ?? null;
    grid(ctx, S, { color: 'rgba(120,210,255,0.075)', step: 42 });
    frameChrome(ctx, S, 'TARGET', { sub: t ? (t.hostile ? 'HOSTILE' : 'FRIEND') : 'STANDBY', color: CYAN });

    if (!t) {
      txt(ctx, 'NO TARGET', S / 2, S / 2 - 6, { size: 34, color: CYAN, align: 'center', track: 0.22, alpha: 0.55 });
      txt(ctx, 'PRESS  T  TO ACQUIRE', S / 2, S / 2 + 26, { size: 16, color: CYAN, align: 'center', track: 0.16, alpha: 0.35 });
      ov.texture.needsUpdate = true;
      return;
    }

    // Reticle framing the live render.
    ctx.save();
    ctx.strokeStyle = t.hostile ? RED : GREEN;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.8;
    const b = 96;
    const bx = S / 2;
    const by = 218;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.beginPath();
      ctx.moveTo(bx + sx * b - sx * 22, by + sy * b);
      ctx.lineTo(bx + sx * b, by + sy * b);
      ctx.lineTo(bx + sx * b, by + sy * b - sy * 22);
      ctx.stroke();
    }
    ctx.restore();

    // Scan line sweeping the target — the display is *doing* something.
    ctx.save();
    ctx.globalAlpha = 0.30;
    const sy2 = 122 + sweepPhase * 192;
    const grd = ctx.createLinearGradient(0, sy2 - 22, 0, sy2 + 4);
    grd.addColorStop(0, 'rgba(143,228,255,0)');
    grd.addColorStop(1, 'rgba(143,228,255,0.9)');
    ctx.fillStyle = grd;
    ctx.fillRect(bx - b, sy2 - 22, b * 2, 26);
    ctx.restore();

    // ---- identity block ----------------------------------------------------
    txt(ctx, t.name, 22, 356, { size: 26, color: t.hostile ? RED : CYAN, track: 0.1 });
    txt(ctx, t.role, 22, 378, { size: 15, color: CYAN, track: 0.14, alpha: 0.72 });

    // ---- shields / armour --------------------------------------------------
    const sh = t.shields ?? null;
    const ar = t.armor ?? null;
    const rowY = 402;
    txt(ctx, 'SHLD F', 22, rowY, { size: 14, color: CYAN, track: 0.1, alpha: 0.8 });
    bar(ctx, 96, rowY - 11, 150, 11, sh ? sh.fore.v / sh.fore.max : 0, { color: CYAN, segments: 12 });
    txt(ctx, 'A', 258, rowY, { size: 14, color: CYAN, track: 0.1, alpha: 0.8 });
    bar(ctx, 274, rowY - 11, 150, 11, sh ? sh.aft.v / sh.aft.max : 0, { color: CYAN, segments: 12 });

    const rowY2 = 428;
    txt(ctx, 'ARMR', 22, rowY2, { size: 14, color: AMBER, track: 0.1, alpha: 0.85 });
    const quads = ['fore', 'aft', 'left', 'right'];
    for (let i = 0; i < 4; i++) {
      const q = ar?.[quads[i]];
      bar(ctx, 96 + i * 84, rowY2 - 11, 74, 11, q ? q.v / q.max : 0, { color: AMBER, segments: 6 });
    }

    // ---- range / closure ---------------------------------------------------
    ctx.save();
    ctx.fillStyle = 'rgba(120,200,240,0.12)';
    ctx.fillRect(12, 444, S - 24, 46);
    ctx.restore();
    txt(ctx, 'RNG', 24, 464, { size: 14, color: CYAN, track: 0.12, alpha: 0.7 });
    txt(ctx, `${fmtRange(t.distance)}m`, 24, 486, { size: 24, color: CYAN, track: 0.02, font: FONT_MONO });
    txt(ctx, 'CLS', 190, 464, { size: 14, color: CYAN, track: 0.12, alpha: 0.7 });
    txt(ctx, `${t.closure >= 0 ? '+' : ''}${Math.round(t.closure)}`, 190, 486, {
      size: 24, color: t.closure >= 0 ? GREEN : AMBER, track: 0.02, font: FONT_MONO,
    });
    txt(ctx, 'ASP', 348, 464, { size: 14, color: CYAN, track: 0.12, alpha: 0.7 });
    txt(ctx, aspectLabel(t.aspect), 348, 486, { size: 24, color: CYAN, track: 0.02, font: FONT_MONO });

    if (t.estimated) txt(ctx, 'EST', S - 24, 356, { size: 13, color: AMBER, align: 'right', track: 0.2, alpha: 0.6 });
    ov.texture.needsUpdate = true;
  }

  function aspectLabel(a) {
    if (a > 0.62) return 'TAIL';
    if (a < -0.62) return 'HEAD';
    return 'BEAM';
  }

  return {
    renderTarget: rt,
    overlay: ov.texture,
    camera: cam,
    renderScene,
    paint,
    dispose() {
      rt.dispose();
      ov.texture.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// RIGHT — damage VDU
// ---------------------------------------------------------------------------

/**
 * Plan-view silhouette of a Confed twin-boom fighter, in a unit box centred on
 * the origin (+y forward). Drawn as a path so it can be clipped per quadrant.
 */
function shipSilhouette(ctx, cx, cy, s) {
  const P = (x, y) => ctx.lineTo(cx + x * s, cy - y * s);
  ctx.beginPath();
  ctx.moveTo(cx + 0, cy - 1.0 * s);
  P(0.09, 0.72); P(0.13, 0.34); P(0.30, 0.22); P(0.32, 0.46);
  P(0.40, 0.50); P(0.44, 0.10); P(0.40, -0.46); P(0.31, -0.52);
  P(0.30, -0.16); P(0.20, -0.12);
  P(0.62, -0.44); P(0.66, -0.62); P(0.24, -0.60); P(0.15, -0.74);
  P(0.10, -0.92); P(-0.10, -0.92); P(-0.15, -0.74); P(-0.24, -0.60);
  P(-0.66, -0.62); P(-0.62, -0.44); P(-0.20, -0.12); P(-0.30, -0.16);
  P(-0.31, -0.52); P(-0.40, -0.46); P(-0.44, 0.10); P(-0.40, 0.50);
  P(-0.32, 0.46); P(-0.30, 0.22); P(-0.13, 0.34); P(-0.09, 0.72);
  ctx.closePath();
}

const QUAD_CLIP = {
  fore: (ctx, cx, cy, s) => { ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx - 2 * s, cy - 2 * s); ctx.lineTo(cx + 2 * s, cy - 2 * s); ctx.closePath(); },
  aft: (ctx, cx, cy, s) => { ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx - 2 * s, cy + 2 * s); ctx.lineTo(cx + 2 * s, cy + 2 * s); ctx.closePath(); },
  left: (ctx, cx, cy, s) => { ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx - 2 * s, cy - 2 * s); ctx.lineTo(cx - 2 * s, cy + 2 * s); ctx.closePath(); },
  right: (ctx, cx, cy, s) => { ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + 2 * s, cy - 2 * s); ctx.lineTo(cx + 2 * s, cy + 2 * s); ctx.closePath(); },
};

/** Armour colour ramp: healthy amber -> hot red as the plate is stripped. */
function armourColor(f) {
  const t = clamp01(f);
  if (t > 0.66) return `rgba(120,220,150,${0.32 + t * 0.42})`;
  if (t > 0.33) return `rgba(255,180,90,${0.40 + t * 0.42})`;
  return `rgba(255,86,66,${0.55 + (1 - t) * 0.40})`;
}

export function createDamageVdu(engine) {
  const ov = surface();
  let blink = 0;

  function paint(st, dt) {
    const ctx = ov.ctx;
    const S = ov.size;
    ctx.clearRect(0, 0, S, S);
    blink = (blink + dt) % 1;

    grid(ctx, S, { color: 'rgba(255,190,120,0.07)', step: 42 });
    frameChrome(ctx, S, 'DAMAGE', { sub: st?.damageEstimated ? 'EST' : 'LINK', color: AMBER });

    const cx = S / 2 - 34;
    const cy = 258;
    const s = 148;

    const ar = st?.armor ?? null;
    const sh = st?.shields ?? null;

    // ---- shield arcs -------------------------------------------------------
    const arc = (from, to, frac, color) => {
      const f = clamp01(frac);
      ctx.save();
      ctx.lineWidth = 13;
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.beginPath(); ctx.arc(cx, cy, 176, from, to); ctx.stroke();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.35 + f * 0.65;
      const mid = (from + to) / 2;
      const half = (to - from) / 2 * f;
      ctx.beginPath(); ctx.arc(cx, cy, 176, mid - half, mid + half); ctx.stroke();
      ctx.restore();
    };
    arc(Math.PI * 1.18, Math.PI * 1.82, sh ? sh.fore.v / sh.fore.max : 0, CYAN);
    arc(Math.PI * 0.18, Math.PI * 0.82, sh ? sh.aft.v / sh.aft.max : 0, CYAN);

    // ---- hull, painted per quadrant ---------------------------------------
    for (const q of ['fore', 'aft', 'left', 'right']) {
      const f = ar?.[q] ? ar[q].v / ar[q].max : 1;
      ctx.save();
      QUAD_CLIP[q](ctx, cx, cy, s);
      ctx.clip();
      shipSilhouette(ctx, cx, cy, s);
      ctx.fillStyle = armourColor(f);
      ctx.fill();
      if (f < 0.28 && blink < 0.5) {
        ctx.fillStyle = 'rgba(255,90,70,0.45)';
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.save();
    shipSilhouette(ctx, cx, cy, s);
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = 2;
    ctx.stroke();
    // Quadrant dividers, so the four readings are unambiguous.
    ctx.strokeStyle = 'rgba(255,180,90,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - s, cy - s); ctx.lineTo(cx + s, cy + s);
    ctx.moveTo(cx + s, cy - s); ctx.lineTo(cx - s, cy + s);
    ctx.stroke();
    ctx.restore();

    // ---- numeric quadrant readouts ----------------------------------------
    const place = {
      fore: [cx, cy - s * 0.82], aft: [cx, cy + s * 0.90],
      left: [cx - s * 0.74, cy + 6], right: [cx + s * 0.74, cy + 6],
    };
    for (const q of ['fore', 'aft', 'left', 'right']) {
      const f = ar?.[q] ? ar[q].v / ar[q].max : 1;
      const [px, py] = place[q];
      txt(ctx, `${Math.round(f * 100)}`, px, py, {
        size: 21, color: f < 0.34 ? RED : AMBER, align: 'center', track: 0.02, font: FONT_MONO,
      });
    }

    // ---- side stack: shields, armour totals, systems -----------------------
    const sx = S - 118;
    txt(ctx, 'SHIELDS', sx, 118, { size: 15, color: CYAN, track: 0.13, alpha: 0.85 });
    txt(ctx, 'FWD', sx, 142, { size: 13, color: CYAN, track: 0.1, alpha: 0.65 });
    bar(ctx, sx + 40, 131, 64, 10, sh ? sh.fore.v / sh.fore.max : 0, { color: CYAN, segments: 8 });
    txt(ctx, 'AFT', sx, 164, { size: 13, color: CYAN, track: 0.1, alpha: 0.65 });
    bar(ctx, sx + 40, 153, 64, 10, sh ? sh.aft.v / sh.aft.max : 0, { color: CYAN, segments: 8 });

    txt(ctx, 'SYSTEMS', sx, 208, { size: 15, color: AMBER, track: 0.13, alpha: 0.85 });
    const sys = [
      ['ENG', clamp01(num(st?.abFuel, 1) * 0.4 + 0.6)],
      ['PWR', clamp01(num(st?.energy, 1))],
      ['GUN', clamp01(num(st?.energy, 1) * 0.9 + 0.1)],
      ['RDR', 1],
      ['ECM', 0.72],
      ['LFE', 1],
    ];
    for (let i = 0; i < sys.length; i++) {
      const y = 232 + i * 22;
      txt(ctx, sys[i][0], sx, y, { size: 13, color: AMBER, track: 0.1, alpha: 0.7 });
      bar(ctx, sx + 40, y - 10, 64, 9, sys[i][1], { color: AMBER, segments: 8 });
    }

    // ---- footer ------------------------------------------------------------
    ctx.save();
    ctx.fillStyle = 'rgba(255,190,120,0.12)';
    ctx.fillRect(12, S - 62, S - 24, 44);
    ctx.restore();
    const worst = ['fore', 'aft', 'left', 'right']
      .map((q) => [q, ar?.[q] ? ar[q].v / ar[q].max : 1])
      .sort((a, b) => a[1] - b[1])[0];
    const critical = worst[1] < 0.34;
    txt(ctx, critical ? `${worst[0].toUpperCase()} ARMOUR CRITICAL` : 'HULL INTEGRITY NOMINAL',
      S / 2, S - 33, {
        size: 19, align: 'center', track: 0.13,
        color: critical ? (blink < 0.5 ? RED : '#ffd0c0') : GREEN,
      });
    ov.texture.needsUpdate = true;
  }

  return {
    overlay: ov.texture,
    paint,
    dispose() { ov.texture.dispose(); },
  };
}

/** 1×1 black texture, used as the damage VDU's (absent) 3D content layer. */
export function blackTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

export { roundRectPath };
