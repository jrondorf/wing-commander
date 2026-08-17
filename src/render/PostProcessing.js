/**
 * The post-processing stack.
 *
 * Hand-rolled against raw WebGLRenderTargets rather than EffectComposer, because
 * every stage here needs to share intermediate buffers with the next one (the
 * velocity buffer feeds TAA *and* motion blur *and* the god-ray occlusion test;
 * the TAA history is recycled as the motion-blur scratch target) and because the
 * ordering below is load-bearing rather than a list of independent effects.
 *
 * Frame graph
 * ───────────
 *   scene      ──▶ hdr (RGBA16F, MSAA 4x)  ──┐  cockpitScene renders into the same
 *   cockpit    ──▶ hdr (after depth clear) ──┘  target so it takes identical grading
 *   scene+cpt  ──▶ vel (RGBA16F: motion.rg, depth.b, blurMask.a)
 *   hdr + vel  ──▶ TAA resolve  ──▶ history ping-pong        (or FXAA fallback)
 *   colour     ──▶ tile max ──▶ neighbour max ──▶ motion blur
 *   colour     ──▶ bloom prefilter ──▶ 6 down ──▶ 5 up (progressive dual filter)
 *   bloom mip1 ──▶ anamorphic streak chain
 *   colour+vel ──▶ god-ray mask ──▶ 2x radial blur
 *   everything ──▶ composite: dirt, CA, exposure, ACES, grade, vignette, grain, sRGB
 *
 * Linear/HDR discipline: nothing between the scene render and the composite ever
 * leaves linear space, nothing is clamped to 1.0, and `renderer.toneMapping` is
 * never touched. See ARCHITECTURE.md §1.7.
 *
 * @see ./shaders/ for the GLSL, each file documents its own algorithm.
 */

import * as THREE from 'three';

import {
  FULLSCREEN_VERT,
  GLSL_COMMON,
  GLSL_CATMULL_ROM,
  GLSL_TONEMAP,
  GLSL_GRADE,
  BLOOM_PREFILTER_FRAG,
  BLOOM_DOWN_FRAG,
  BLOOM_UP_FRAG,
  TAA_FRAG,
  FXAA_FRAG,
  TILE_MAX_FRAG,
  NEIGHBOR_MAX_FRAG,
  MOTION_BLUR_FRAG,
  VELOCITY_VERT,
  VELOCITY_FRAG,
  VELOCITY_BACKGROUND_FRAG,
  GODRAY_MASK_FRAG,
  GODRAY_BLUR_FRAG,
  STREAK_PREFILTER_FRAG,
  STREAK_BLUR_FRAG,
  COMPOSITE_FRAG,
  DEBUG_VIEW_FRAG,
  generateLensDirtTexture,
} from './shaders/index.js';

// ---------------------------------------------------------------------------
// Colour grades. The "per-mission LUT-ish tinting" of §5.3 — split toning plus a
// contrast/saturation pair, keyed to the star class and nebula presets in world/.
// Cheaper than a 3D LUT, and it costs no texture bandwidth or asset pipeline.
// ---------------------------------------------------------------------------
export const MISSION_GRADES = {
  neutral: {
    contrast: 1.05, saturation: 1.04,
    shadowTint: [0.97, 0.99, 1.04], highlightTint: [1.02, 1.0, 0.98], tint: [1, 1, 1],
  },
  /** F-class white-blue primary — clean, cold, high separation. */
  'f-class': {
    contrast: 1.09, saturation: 1.02,
    shadowTint: [0.86, 0.94, 1.14], highlightTint: [1.0, 1.02, 1.07], tint: [1, 1, 1],
  },
  /** K-class amber — warm key, cold shadows. The classic Prophecy hangar look. */
  'k-class': {
    contrast: 1.06, saturation: 1.08,
    shadowTint: [0.82, 0.9, 1.16], highlightTint: [1.13, 1.02, 0.89], tint: [1, 1, 1],
  },
  /** Red giant — heavy, dirty, oppressive. */
  'red-giant': {
    contrast: 1.03, saturation: 1.1,
    shadowTint: [0.8, 0.85, 1.06], highlightTint: [1.2, 0.94, 0.82], tint: [1.02, 0.99, 0.97],
  },
  'nebula-teal': {
    contrast: 1.07, saturation: 1.1,
    shadowTint: [0.84, 1.0, 1.08], highlightTint: [1.06, 1.02, 0.95], tint: [1, 1, 1],
  },
  'nebula-magenta': {
    contrast: 1.06, saturation: 1.12,
    shadowTint: [1.02, 0.9, 1.12], highlightTint: [1.08, 0.98, 1.0], tint: [1, 1, 1],
  },
  'nebula-ember': {
    contrast: 1.04, saturation: 1.12,
    shadowTint: [0.9, 0.88, 1.04], highlightTint: [1.16, 0.99, 0.86], tint: [1, 1, 1],
  },
  'deep-blue': {
    contrast: 1.08, saturation: 1.06,
    shadowTint: [0.86, 0.93, 1.18], highlightTint: [1.0, 1.02, 1.08], tint: [1, 1, 1],
  },
};

// ---------------------------------------------------------------------------
// Quality presets. Every one of these is a *structural* override — anything that
// changes a define, a target count or a resolution lives here; anything that is
// a pure uniform can be tweaked live in `settings` without a rebuild.
// ---------------------------------------------------------------------------
const QUALITY_PRESETS = {
  low: {
    renderScale: 0.85,
    msaa: 0,
    taa: { enabled: false },
    fxaa: { enabled: true },
    velocity: { enabled: false },
    motionBlur: { enabled: false },
    bloom: { mips: 4, scatter: 0.66 },
    streaks: { enabled: false },
    godRays: { samples: 8, downscale: 4 },
    lensDirt: { enabled: false },
    chromatic: { enabled: false },
    grain: { intensity: 0.02 },
  },
  medium: {
    renderScale: 1,
    msaa: 2,
    taa: { enabled: true, catmullRom: false, sharpen: 0.12 },
    fxaa: { enabled: false },
    velocity: { enabled: true, halfRes: true },
    motionBlur: { enabled: true, samples: 7, tileSize: 16 },
    bloom: { mips: 5, scatter: 0.7 },
    streaks: { enabled: true, iterations: 3, taps: 7 },
    godRays: { samples: 10, downscale: 4 },
    lensDirt: { enabled: true, size: 512 },
    chromatic: { enabled: true },
  },
  high: {
    renderScale: 1,
    msaa: 4,
    taa: { enabled: true, catmullRom: true, sharpen: 0.18 },
    fxaa: { enabled: false },
    velocity: { enabled: true, halfRes: false },
    motionBlur: { enabled: true, samples: 11, tileSize: 20 },
    bloom: { mips: 6, scatter: 0.72 },
    streaks: { enabled: true, iterations: 4, taps: 9 },
    godRays: { samples: 12, downscale: 4 },
    lensDirt: { enabled: true, size: 1024 },
    chromatic: { enabled: true },
  },
  ultra: {
    renderScale: 1,
    msaa: 4,
    taa: { enabled: true, catmullRom: true, sharpen: 0.2, sampleCount: 16 },
    fxaa: { enabled: false },
    velocity: { enabled: true, halfRes: false },
    motionBlur: { enabled: true, samples: 15, tileSize: 24 },
    bloom: { mips: 6, scatter: 0.74 },
    streaks: { enabled: true, iterations: 5, taps: 11 },
    godRays: { samples: 16, downscale: 2 },
    lensDirt: { enabled: true, size: 2048 },
    chromatic: { enabled: true },
  },
};

/** Halton(2,3), the standard TAA jitter sequence — low discrepancy, no clumping. */
const HALTON = (() => {
  const radical = (i, base) => {
    let f = 1;
    let r = 0;
    let n = i;
    while (n > 0) {
      f /= base;
      r += f * (n % base);
      n = Math.floor(n / base);
    }
    return r;
  };
  const out = [];
  for (let i = 1; i <= 16; i++) out.push([radical(i, 2) - 0.5, radical(i, 3) - 0.5]);
  return out;
})();

function defaultSettings() {
  return {
    enabled: true,
    quality: 'high',
    /** Internal render resolution multiplier. The composite always writes full-res. */
    renderScale: 1,
    msaa: 4,

    taa: {
      enabled: true,
      sampleCount: 8,
      jitterScale: 1,
      /** History weight when the pixel is moving fast — lower = less ghosting. */
      feedbackMin: 0.7,
      /** History weight when still — higher = more temporal AA, more stability. */
      feedbackMax: 0.955,
      /** Clip box half-width in standard deviations. <1 flickers, >2 ghosts. */
      varianceGamma: 1.25,
      velocityWeight: 0.055,
      catmullRom: true,
      sharpen: 0.18,
    },

    fxaa: { enabled: false, edgeThreshold: 0.125, edgeThresholdMin: 0.0312, subpixel: 0.6 },

    velocity: {
      enabled: true,
      halfRes: false,
      /** Clamp in UV units. 0.09 ≈ 170 px at 1080p — beyond that blur is soup. */
      maxVelocity: 0.09,
      scale: 1,
    },

    motionBlur: {
      enabled: true,
      /** Shutter fraction. 0.6 ≈ a 216° shutter at 60 fps. */
      intensity: 0.6,
      samples: 11,
      tileSize: 20,
      depthExtent: 0.05,
    },

    bloom: {
      enabled: true,
      intensity: 0.58,
      /** Soft-knee centre in max-channel linear units. No hard threshold anywhere. */
      knee: 0.8,
      kneeWidth: 0.65,
      /** How much of the knee to apply. <1 means even mid-tones haze slightly. */
      kneeMix: 0.8,
      /** Radius control: lerp weight of the wider mip at each up step. */
      scatter: 0.72,
      mips: 6,
      /** Firefly clamp on the prefilter, in linear units. */
      clamp: 120,
    },

    streaks: {
      enabled: true,
      // At 0.17 a single blown-out hull threw a hard horizontal band right across
      // the frame. Anamorphic streaks should be a hint of lens character, not a
      // structural element of the image.
      intensity: 0.10,
      threshold: 2.0,
      taps: 9,
      iterations: 4,
      attenuation: 0.87,
      stride: 1,
      tint: [0.52, 0.76, 1.0],
      clamp: 90,
    },

    godRays: {
      enabled: true,
      // 0.55 threw a starburst across the entire vista and flattened everything
      // behind it. Shafts should suggest depth, not become the subject.
      intensity: 0.30,
      density: 0.9,
      decay: 0.94,
      weight: 0.85,
      exposure: 1.8,
      samples: 12,
      downscale: 4,
      /** Gaussian reach around the star, in aspect-corrected UV. */
      radius: 0.8,
      threshold: 0.9,
      color: [1.0, 0.94, 0.85],
      /** Vector3 | Object3D | null. Null auto-resolves from the scene. */
      sun: null,
      /** How far off-screen the star may drift before the shafts fade out. */
      offscreenMargin: 0.45,
    },

    lensDirt: { enabled: true, intensity: 1.5, size: 1024, seed: 20791, density: 1 },

    chromatic: { enabled: true, amount: 0.0024, centerBias: 0.12 },

    // Exposure was calibrated against the hero-fighter capture: at 1.0 a hull with
    // correctly-authored albedo (~0.17 linear) sat so far down the ACES curve that
    // ships read as black silhouettes against the nebula. 3.2 puts the hull in the
    // middle of the curve while leaving the star and engine cores headroom to bloom.
    tonemap: { mode: 'hill', exposure: 3.2, whitePoint: 4 },

    grade: {
      lift: [0, 0, 0],
      gamma: [1, 1, 1],
      gain: [1, 1, 1],
      contrast: 1.05,
      saturation: 1.05,
      shadowTint: [0.97, 0.99, 1.04],
      highlightTint: [1.02, 1.0, 0.98],
      tint: [1, 1, 1],
    },

    // Grain is shadow-weighted, so in a frame that is mostly dark space the old
    // 0.026 read as visible noise over the whole image rather than film texture.
    grain: { enabled: true, intensity: 0.010, shadowBias: 0.75, size: 1.4, speed: 1 },

    vignette: { enabled: true, intensity: 0.4, smoothness: 0.6, roundness: 0.55 },

    output: { srgb: true, dither: 0.85 },

    /** 'final' | 'scene' | 'velocity' | 'depth' | 'bloom' | 'streaks' | 'godrays' | 'dirt' */
    debug: { view: 'final', scale: 1 },
  };
}

function deepMerge(target, patch) {
  if (!patch) return target;
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && !v.isVector3 && !v.isObject3D) {
      if (!target[k] || typeof target[k] !== 'object') target[k] = {};
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * @param {import('../core/Engine.js').Engine} engine
 * @param {object} [opts] `{ quality, ...settingsOverrides }`
 */
export function createPostPipeline(engine, opts = {}) {
  const renderer = engine.renderer;
  const { quality = 'high', ...overrides } = opts;

  const settings = defaultSettings();
  settings.quality = quality;
  deepMerge(settings, QUALITY_PRESETS[quality] ?? QUALITY_PRESETS.high);
  deepMerge(settings, overrides);

  // Half-float MSAA needs EXT_color_buffer_float on WebGL2; without it the FBO
  // comes back incomplete and three quietly renders nothing. Degrade instead.
  const canFloatMSAA =
    renderer.extensions.has('EXT_color_buffer_float') ||
    renderer.extensions.has('EXT_color_buffer_half_float');
  const maxSamples = canFloatMSAA ? (renderer.capabilities.maxSamples ?? 4) : 0;

  // -------------------------------------------------------------- scratch state
  const _v2 = new THREE.Vector2();
  const _v3 = new THREE.Vector3();
  const _v3b = new THREE.Vector3();
  const _sunWorld = new THREE.Vector3();
  const _mat4 = new THREE.Matrix4();

  const state = {
    time: 0,
    frame: 0,
    size: { w: 2, h: 2 },
    outSize: { w: 2, h: 2 },
    historyIndex: 0,
    historyValid: false,
    jitter: new THREE.Vector2(),
    prevJitter: new THREE.Vector2(),
    signature: '',
    sunLight: null,
    sunScanFrame: -1e9,
  };

  const prev = {
    viewProj: new THREE.Matrix4(),
    viewProjCockpit: new THREE.Matrix4(),
    viewProjRot: new THREE.Matrix4(),
    valid: false,
  };
  const cur = {
    viewProj: new THREE.Matrix4(),
    viewProjCockpit: new THREE.Matrix4(),
    viewProjRot: new THREE.Matrix4(),
    invViewProjRot: new THREE.Matrix4(),
    proj: new THREE.Matrix4(),
    projCockpit: new THREE.Matrix4(),
  };

  // ------------------------------------------------------------- full-screen rig
  // One oversized triangle rather than a quad: no diagonal seam, ~10% fewer
  // helper-lane invocations, and the UVs run 0..2 so the 0..1 window is exact.
  const quadGeo = new THREE.BufferGeometry();
  quadGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  quadGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadScene = new THREE.Scene();
  const quadMesh = new THREE.Mesh(quadGeo, null);
  quadMesh.frustumCulled = false;
  quadMesh.matrixAutoUpdate = false;
  quadScene.add(quadMesh);
  quadScene.matrixAutoUpdate = false;

  const HEADER = GLSL_COMMON + GLSL_CATMULL_ROM;
  const HEADER_TONE = HEADER + GLSL_TONEMAP + GLSL_GRADE;

  const materials = [];
  function makeMaterial(fragment, uniforms, defines = {}, header = HEADER) {
    const m = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: header + fragment,
      uniforms,
      defines,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    materials.push(m);
    return m;
  }

  function blit(material, target) {
    quadMesh.material = material;
    renderer.setRenderTarget(target ?? null);
    renderer.render(quadScene, quadCam);
  }

  // 1x1 black stand-in so a disabled stage never leaves the composite sampling a
  // stale target (or worse, an undefined sampler on some drivers).
  const blackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  blackTex.needsUpdate = true;

  // ---------------------------------------------------------------- render targets
  const targets = {
    hdr: null,
    vel: null,
    taa: [null, null],
    bloomDown: [],
    bloomUp: [],
    streak: [null, null],
    godray: [null, null],
    tileA: null,
    tileB: null,
    neighbor: null,
  };

  function makeRT(w, h, { samples = 0, depth = false, type = THREE.HalfFloatType, filter = THREE.LinearFilter } = {}) {
    const rt = new THREE.WebGLRenderTarget(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), {
      type,
      format: THREE.RGBAFormat,
      minFilter: filter,
      magFilter: filter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: depth,
      stencilBuffer: false,
      generateMipmaps: false,
      samples,
      colorSpace: THREE.NoColorSpace,
    });
    rt.texture.colorSpace = THREE.NoColorSpace;
    return rt;
  }

  function disposeTargets() {
    const all = [
      targets.hdr, targets.vel, targets.taa[0], targets.taa[1],
      ...targets.bloomDown, ...targets.bloomUp,
      targets.streak[0], targets.streak[1],
      targets.godray[0], targets.godray[1],
      targets.tileA, targets.tileB, targets.neighbor,
    ];
    for (const t of all) t?.dispose();
    targets.bloomDown = [];
    targets.bloomUp = [];
  }

  function allocateTargets(w, h) {
    disposeTargets();

    const samples = clamp(Math.round(settings.msaa), 0, maxSamples);
    targets.hdr = makeRT(w, h, { samples, depth: true });
    targets.hdr.texture.name = 'post/hdr';

    const velDiv = settings.velocity.halfRes ? 2 : 1;
    targets.vel = makeRT(w / velDiv, h / velDiv, { depth: true, filter: THREE.NearestFilter });
    targets.vel.texture.name = 'post/velocity';

    targets.taa[0] = makeRT(w, h);
    targets.taa[1] = makeRT(w, h);
    targets.taa[0].texture.name = 'post/taa0';
    targets.taa[1].texture.name = 'post/taa1';
    state.historyValid = false;

    // Bloom pyramid: mip0 is half-res, each subsequent level halves again.
    const mips = clamp(Math.round(settings.bloom.mips), 2, 8);
    let bw = Math.max(1, Math.floor(w / 2));
    let bh = Math.max(1, Math.floor(h / 2));
    for (let i = 0; i < mips; i++) {
      targets.bloomDown.push(makeRT(bw, bh));
      targets.bloomDown[i].texture.name = `post/bloomDown${i}`;
      if (i < mips - 1) {
        targets.bloomUp.push(makeRT(bw, bh));
        targets.bloomUp[i].texture.name = `post/bloomUp${i}`;
      }
      bw = Math.max(1, Math.floor(bw / 2));
      bh = Math.max(1, Math.floor(bh / 2));
    }

    const sw = Math.max(1, Math.floor(w / 4));
    const sh = Math.max(1, Math.floor(h / 4));
    targets.streak[0] = makeRT(sw, sh);
    targets.streak[1] = makeRT(sw, sh);

    const gd = clamp(Math.round(settings.godRays.downscale), 1, 8);
    const gw = Math.max(1, Math.floor(w / gd));
    const gh = Math.max(1, Math.floor(h / gd));
    targets.godray[0] = makeRT(gw, gh);
    targets.godray[1] = makeRT(gw, gh);

    const K = clamp(Math.round(settings.motionBlur.tileSize), 4, 40);
    const tw = Math.max(1, Math.ceil(w / velDiv / K));
    const th = Math.max(1, Math.ceil(h / velDiv / K));
    targets.tileA = makeRT(tw, Math.max(1, Math.floor(h / velDiv)), { filter: THREE.NearestFilter });
    targets.tileB = makeRT(tw, th, { filter: THREE.NearestFilter });
    targets.neighbor = makeRT(tw, th, { filter: THREE.NearestFilter });
  }

  // ------------------------------------------------------------------- materials
  const velUniformsBase = () => ({
    uPrevModelMatrix: { value: new THREE.Matrix4() },
    uCurrViewProj: { value: new THREE.Matrix4() },
    uPrevViewProj: { value: new THREE.Matrix4() },
    uMaxVelocity: { value: 0.09 },
    uMask: { value: 1 },
    uInvFar: { value: 1 / 8e6 },
    uVelocityScale: { value: 1 },
  });

  function makeVelocityMaterial(mask) {
    const m = new THREE.ShaderMaterial({
      vertexShader: VELOCITY_VERT,
      fragmentShader: VELOCITY_FRAG,
      uniforms: velUniformsBase(),
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: true,
      blending: THREE.NoBlending,
      toneMapped: false,
      fog: false,
    });
    m.uniforms.uMask.value = mask;
    // Per-object previous world matrix. `onBeforeRender` fires immediately before
    // `setProgram` uploads uniforms, so writing here is the supported way to get
    // per-object data into a scene overrideMaterial.
    m.onBeforeRender = (_r, _s, _c, _g, object) => {
      const p = object.userData.__wcPrevMatrix;
      m.uniforms.uPrevModelMatrix.value.copy(p ?? object.matrixWorld);
      m.uniformsNeedUpdate = true;
    };
    materials.push(m);
    return m;
  }

  const velMatWorld = makeVelocityMaterial(1);
  const velMatCockpit = makeVelocityMaterial(0);

  const velBgMat = makeMaterial(VELOCITY_BACKGROUND_FRAG, {
    uInvViewProjRot: { value: new THREE.Matrix4() },
    uPrevViewProjRot: { value: new THREE.Matrix4() },
    uMaxVelocity: { value: 0.09 },
    uVelocityScale: { value: 1 },
  });

  const taaMat = makeMaterial(TAA_FRAG, {
    tCurrent: { value: null },
    tHistory: { value: null },
    tVelocity: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uResolution: { value: new THREE.Vector2() },
    uJitterDelta: { value: new THREE.Vector2() },
    uFeedbackMin: { value: 0.7 },
    uFeedbackMax: { value: 0.955 },
    uVarianceGamma: { value: 1.25 },
    uVelocityWeight: { value: 0.055 },
    uSharpen: { value: 0.18 },
  });

  const fxaaMat = makeMaterial(FXAA_FRAG, {
    tSource: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uEdgeThreshold: { value: 0.125 },
    uEdgeThresholdMin: { value: 0.0312 },
    uSubpixel: { value: 0.6 },
  });

  const tileMat = makeMaterial(TILE_MAX_FRAG, {
    tVelocity: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uDirection: { value: new THREE.Vector2(1, 0) },
  }, { MB_TILE_STEPS: 20 });

  const neighborMat = makeMaterial(NEIGHBOR_MAX_FRAG, {
    tTiles: { value: null },
    uTexel: { value: new THREE.Vector2() },
  });

  const motionMat = makeMaterial(MOTION_BLUR_FRAG, {
    tColor: { value: null },
    tVelocity: { value: null },
    tNeighborMax: { value: null },
    uResolution: { value: new THREE.Vector2() },
    uIntensity: { value: 0.6 },
    uTime: { value: 0 },
    uDepthExtent: { value: 0.05 },
  }, { MB_SAMPLES: 11 });

  const bloomPreMat = makeMaterial(BLOOM_PREFILTER_FRAG, {
    tSource: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uKnee: { value: 0.8 },
    uKneeWidth: { value: 0.65 },
    uKneeMix: { value: 0.8 },
    uClamp: { value: 120 },
  });

  const bloomDownMat = makeMaterial(BLOOM_DOWN_FRAG, {
    tSource: { value: null },
    uHalfPixel: { value: new THREE.Vector2() },
  });

  const bloomUpMat = makeMaterial(BLOOM_UP_FRAG, {
    tSource: { value: null },
    tMip: { value: null },
    uHalfPixel: { value: new THREE.Vector2() },
    uScatter: { value: 0.72 },
  });

  const streakPreMat = makeMaterial(STREAK_PREFILTER_FRAG, {
    tSource: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uThreshold: { value: 2.0 },
    uClamp: { value: 90 },
  });

  const streakBlurMat = makeMaterial(STREAK_BLUR_FRAG, {
    tSource: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uStride: { value: 1 },
    uAttenuation: { value: 0.87 },
    uTint: { value: new THREE.Vector3(0.52, 0.76, 1.0) },
    uDirection: { value: new THREE.Vector2(1, 0) },
  }, { STREAK_TAPS: 9 });

  const godMaskMat = makeMaterial(GODRAY_MASK_FRAG, {
    tScene: { value: null },
    tVelocity: { value: null },
    uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
    uSunDepth: { value: 1 },
    uRadius: { value: 0.8 },
    uThreshold: { value: 0.9 },
    uAspect: { value: 1.777 },
    uHasDepth: { value: 1 },
    uSourceTexel: { value: new THREE.Vector2() },
  });

  const godBlurMat = makeMaterial(GODRAY_BLUR_FRAG, {
    tSource: { value: null },
    uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
    uDensity: { value: 0.9 },
    uDecay: { value: 0.94 },
    uWeight: { value: 0.85 },
    uExposure: { value: 1.8 },
    uTexel: { value: new THREE.Vector2() },
  }, { GR_SAMPLES: 12 });

  const compositeMat = makeMaterial(COMPOSITE_FRAG, {
    tScene: { value: null },
    tBloom: { value: blackTex },
    tStreaks: { value: blackTex },
    tGodRays: { value: blackTex },
    tDirt: { value: blackTex },
    uResolution: { value: new THREE.Vector2() },
    uTime: { value: 0 },
    uAspect: { value: 1.777 },
    uBloomIntensity: { value: 0.58 },
    uStreakIntensity: { value: 0.17 },
    uStreakTint: { value: new THREE.Vector3(0.52, 0.76, 1.0) },
    uGodRayIntensity: { value: 0.55 },
    uGodRayColor: { value: new THREE.Vector3(1, 0.94, 0.85) },
    uDirtIntensity: { value: 1.5 },
    uCA: { value: 0.0024 },
    uCACenterBias: { value: 0.12 },
    uExposure: { value: 1 },
    uToneMode: { value: 2 },
    uWhitePoint: { value: 4 },
    uLift: { value: new THREE.Vector3() },
    uInvGamma: { value: new THREE.Vector3(1, 1, 1) },
    uGain: { value: new THREE.Vector3(1, 1, 1) },
    uContrast: { value: 1.05 },
    uSaturation: { value: 1.05 },
    uShadowTint: { value: new THREE.Vector3(1, 1, 1) },
    uHighlightTint: { value: new THREE.Vector3(1, 1, 1) },
    uGlobalTint: { value: new THREE.Vector3(1, 1, 1) },
    uGrain: { value: 0.026 },
    uGrainShadowBias: { value: 0.75 },
    uGrainSize: { value: 1.4 },
    uVignette: { value: 0.4 },
    uVignetteSmooth: { value: 0.6 },
    uVignetteRound: { value: 0.55 },
    uDither: { value: 0.85 },
    uSrgb: { value: 1 },
  }, {}, HEADER_TONE);

  const debugMat = makeMaterial(DEBUG_VIEW_FRAG, {
    tSource: { value: null },
    uScale: { value: 1 },
    uMode: { value: 0 },
  }, {}, HEADER_TONE);

  // ------------------------------------------------------------------ lens dirt
  let dirtTexture = null;
  function ensureDirt() {
    if (!settings.lensDirt.enabled) return null;
    const { size, seed, density } = settings.lensDirt;
    const key = `render/lensdirt/${size}/${seed}/${density}`;
    if (dirtTexture?.name === `lensDirt/${size}/${seed}`) return dirtTexture;
    dirtTexture = engine.registry.get(key, () => generateLensDirtTexture({ size, seed, density }));
    return dirtTexture;
  }

  // --------------------------------------------------------------- sizing/rebuild
  function structuralSignature() {
    const s = settings;
    return [
      s.renderScale, s.msaa,
      s.taa.enabled, s.taa.catmullRom, s.taa.sharpen > 0,
      s.fxaa.enabled,
      s.velocity.enabled, s.velocity.halfRes,
      s.motionBlur.enabled, s.motionBlur.samples, s.motionBlur.tileSize,
      s.bloom.mips,
      s.streaks.enabled, s.streaks.taps, s.streaks.iterations,
      s.godRays.enabled, s.godRays.samples, s.godRays.downscale,
      s.lensDirt.enabled, s.lensDirt.size, s.lensDirt.seed,
      state.outSize.w, state.outSize.h,
    ].join('|');
  }

  function applyDefines() {
    const K = clamp(Math.round(settings.motionBlur.tileSize), 4, 40);
    tileMat.defines.MB_TILE_STEPS = K;
    tileMat.needsUpdate = true;

    motionMat.defines.MB_SAMPLES = clamp(Math.round(settings.motionBlur.samples), 3, 32);
    motionMat.needsUpdate = true;

    streakBlurMat.defines.STREAK_TAPS = clamp(Math.round(settings.streaks.taps) | 1, 3, 17);
    streakBlurMat.needsUpdate = true;

    godBlurMat.defines.GR_SAMPLES = clamp(Math.round(settings.godRays.samples), 4, 32);
    godBlurMat.needsUpdate = true;

    if (settings.taa.catmullRom) taaMat.defines.TAA_CATMULL = 1;
    else delete taaMat.defines.TAA_CATMULL;
    if (settings.taa.sharpen > 0) taaMat.defines.TAA_SHARPEN = 1;
    else delete taaMat.defines.TAA_SHARPEN;
    taaMat.needsUpdate = true;
  }

  function rebuild() {
    const s = clamp(settings.renderScale, 0.4, 2);
    const w = Math.max(2, Math.round(state.outSize.w * s));
    const h = Math.max(2, Math.round(state.outSize.h * s));
    state.size.w = w;
    state.size.h = h;
    allocateTargets(w, h);
    applyDefines();
    ensureDirt();
    state.signature = structuralSignature();
  }

  function setSize(w, h) {
    // Engine hands us CSS pixels; the pipeline works in drawing-buffer pixels.
    renderer.getDrawingBufferSize(_v2);
    state.outSize.w = Math.max(2, Math.round(_v2.x));
    state.outSize.h = Math.max(2, Math.round(_v2.y));
    rebuild();
  }

  // ------------------------------------------------------------------ jitter
  const savedProj = new THREE.Matrix4();
  const savedProjCockpit = new THREE.Matrix4();
  let jittered = false;

  function applyJitter() {
    state.prevJitter.copy(state.jitter);
    if (!settings.taa.enabled) {
      state.jitter.set(0, 0);
      jittered = false;
      return;
    }
    const n = clamp(Math.round(settings.taa.sampleCount), 2, 16);
    const j = HALTON[state.frame % n];
    const scale = settings.taa.jitterScale;
    state.jitter.set(
      (j[0] * 2 * scale) / state.size.w,
      (j[1] * 2 * scale) / state.size.h,
    );

    savedProj.copy(engine.camera.projectionMatrix);
    savedProjCockpit.copy(engine.cockpitCamera.projectionMatrix);
    for (const cam of [engine.camera, engine.cockpitCamera]) {
      cam.projectionMatrix.elements[8] += state.jitter.x;
      cam.projectionMatrix.elements[9] += state.jitter.y;
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    }
    jittered = true;
  }

  function removeJitter() {
    if (!jittered) return;
    engine.camera.projectionMatrix.copy(savedProj);
    engine.camera.projectionMatrixInverse.copy(savedProj).invert();
    engine.cockpitCamera.projectionMatrix.copy(savedProjCockpit);
    engine.cockpitCamera.projectionMatrixInverse.copy(savedProjCockpit).invert();
    jittered = false;
  }

  // -------------------------------------------------------------- velocity pass
  const hidden = [];

  function hideNoVelocity(root) {
    root.traverse((o) => {
      if (!o.visible) return;
      // Sprites and Points carry their own vertex transform (billboard expansion,
      // gl_PointSize) that a scene overrideMaterial cannot reproduce — they would
      // scribble garbage vectors. Both live effectively at infinity anyway, so the
      // background pass already covers them.
      const skip = o.userData.noVelocity === true || o.isSprite === true || o.isPoints === true;
      if (skip) {
        o.visible = false;
        hidden.push(o);
      }
    });
  }

  function storePrevMatrices(root) {
    root.traverse((o) => {
      if (!(o.isMesh || o.isInstancedMesh || o.isPoints || o.isLine || o.isSprite)) return;
      let m = o.userData.__wcPrevMatrix;
      if (!m) m = o.userData.__wcPrevMatrix = new THREE.Matrix4();
      m.copy(o.matrixWorld);
    });
  }

  function hasCockpit() {
    const cs = engine.cockpitScene;
    return !!cs && cs.visible !== false && cs.children.length > 0;
  }

  function renderVelocity() {
    const vel = targets.vel;
    const cam = engine.camera;

    // Shadow maps are already up to date from the colour pass; re-running them
    // for a pass that never samples a shadow is pure waste.
    const smAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;

    hidden.length = 0;
    hideNoVelocity(engine.scene);
    if (hasCockpit()) hideNoVelocity(engine.cockpitScene);

    // three's background box/plane is built with `allowOverride: false`, so a
    // scene.background texture would paint sky *colour* straight into the
    // velocity buffer and blow away the reprojection pass below. Detach it.
    const bg = engine.scene.background;
    const bgCockpit = engine.cockpitScene.background;
    engine.scene.background = null;
    engine.cockpitScene.background = null;

    renderer.setRenderTarget(vel);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);

    // Sky/background first — depth stays at 1 so geometry overwrites it.
    velBgMat.uniforms.uInvViewProjRot.value.copy(cur.invViewProjRot);
    velBgMat.uniforms.uPrevViewProjRot.value.copy(prev.valid ? prev.viewProjRot : cur.viewProjRot);
    velBgMat.uniforms.uMaxVelocity.value = settings.velocity.maxVelocity;
    velBgMat.uniforms.uVelocityScale.value = settings.velocity.scale;
    blit(velBgMat, vel);

    const maxV = settings.velocity.maxVelocity;
    const invFar = 1 / Math.max(1, cam.far);

    velMatWorld.uniforms.uCurrViewProj.value.copy(cur.viewProj);
    velMatWorld.uniforms.uPrevViewProj.value.copy(prev.valid ? prev.viewProj : cur.viewProj);
    velMatWorld.uniforms.uMaxVelocity.value = maxV;
    velMatWorld.uniforms.uInvFar.value = invFar;
    velMatWorld.uniforms.uVelocityScale.value = settings.velocity.scale;

    engine.scene.overrideMaterial = velMatWorld;
    renderer.render(engine.scene, cam);
    engine.scene.overrideMaterial = null;

    if (hasCockpit()) {
      velMatCockpit.uniforms.uCurrViewProj.value.copy(cur.viewProjCockpit);
      velMatCockpit.uniforms.uPrevViewProj.value.copy(prev.valid ? prev.viewProjCockpit : cur.viewProjCockpit);
      velMatCockpit.uniforms.uMaxVelocity.value = maxV;
      // Cockpit depths are normalised by the *world* far plane so they land near
      // zero — i.e. always in front of everything, which is exactly true.
      velMatCockpit.uniforms.uInvFar.value = invFar;
      velMatCockpit.uniforms.uVelocityScale.value = settings.velocity.scale;

      renderer.setRenderTarget(vel);
      renderer.clearDepth();
      engine.cockpitScene.overrideMaterial = velMatCockpit;
      renderer.render(engine.cockpitScene, engine.cockpitCamera);
      engine.cockpitScene.overrideMaterial = null;
    }

    engine.scene.background = bg;
    engine.cockpitScene.background = bgCockpit;

    for (const o of hidden) o.visible = true;
    hidden.length = 0;

    storePrevMatrices(engine.scene);
    if (hasCockpit()) storePrevMatrices(engine.cockpitScene);

    renderer.shadowMap.autoUpdate = smAuto;
  }

  // ------------------------------------------------------------------- god rays
  function findSunLight() {
    if (state.frame - state.sunScanFrame < 60 && state.sunLight?.parent) return state.sunLight;
    state.sunScanFrame = state.frame;
    let best = null;
    let bestI = -1;
    engine.scene.traverse((o) => {
      if (o.isDirectionalLight && o.visible && o.intensity > bestI) {
        bestI = o.intensity;
        best = o;
      }
    });
    state.sunLight = best;
    return best;
  }

  /** @returns {boolean} whether a star could be resolved at all. */
  function resolveSun(out) {
    const s = settings.godRays.sun;
    if (s) {
      if (s.isVector3) { out.copy(s); return true; }
      if (s.isObject3D) { s.getWorldPosition(out); return true; }
    }
    const ud = engine.scene.userData;
    if (ud.sunPosition?.isVector3) { out.copy(ud.sunPosition); return true; }
    if (ud.sun?.isObject3D) { ud.sun.getWorldPosition(out); return true; }
    if (ud.star?.isObject3D) { ud.star.getWorldPosition(out); return true; }

    const light = findSunLight();
    if (light) {
      // A directional light has no position in the physical sense — only a
      // direction. Put the virtual star a megametre out along it so it projects
      // like a body at infinity rather than one inside the combat volume.
      _v3.copy(light.position);
      if (light.target) _v3.sub(light.target.getWorldPosition(_v3b));
      if (_v3.lengthSq() < 1e-6) _v3.set(0, 0, -1);
      _v3.normalize().multiplyScalar(1e6);
      out.copy(engine.camera.position).add(_v3);
      return true;
    }
    return false;
  }

  const edgeFade = (v, m) => {
    if (v >= 0 && v <= 1) return 1;
    const d = v < 0 ? -v : v - 1;
    return Math.max(0, 1 - d / Math.max(m, 1e-3));
  };

  function computeSunScreen() {
    if (!resolveSun(_sunWorld)) return { visible: 0, u: 0.5, v: 0.5, depth: 1 };

    const cam = engine.camera;
    _v3.copy(_sunWorld).applyMatrix4(cam.matrixWorldInverse);
    const viewZ = -_v3.z;
    if (viewZ <= cam.near) return { visible: 0, u: 0.5, v: 0.5, depth: 1 };

    _v3b.copy(_sunWorld).project(cam);
    const u = _v3b.x * 0.5 + 0.5;
    const v = _v3b.y * 0.5 + 0.5;

    const m = settings.godRays.offscreenMargin;
    const vis = edgeFade(u, m) * edgeFade(v, m);

    return { visible: vis, u, v, depth: clamp(viewZ / Math.max(1, cam.far), 0, 1) };
  }

  // -------------------------------------------------------------------- render
  const _sceneClear = new THREE.Color(0, 0, 0);

  function fallbackRender() {
    // `settings.enabled = false` must still put a frame on screen.
    renderer.setRenderTarget(null);
    renderer.setClearColor(_sceneClear, 1);
    renderer.clear(true, true, false);
    renderer.render(engine.scene, engine.camera);
    if (hasCockpit()) {
      renderer.clearDepth();
      renderer.render(engine.cockpitScene, engine.cockpitCamera);
    }
  }

  function captureMatrices() {
    const cam = engine.camera;
    const cpt = engine.cockpitCamera;

    // The camera rig writes the transform during update(); `renderer.render` would
    // refresh these for us, but we need them one step earlier to build the
    // unjittered view-projection pair the velocity pass reprojects against.
    cam.updateMatrixWorld();
    cpt.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    cpt.matrixWorldInverse.copy(cpt.matrixWorld).invert();

    prev.valid = state.frame > 0;
    prev.viewProj.copy(cur.viewProj);
    prev.viewProjCockpit.copy(cur.viewProjCockpit);
    prev.viewProjRot.copy(cur.viewProjRot);

    cur.proj.copy(cam.projectionMatrix);
    cur.projCockpit.copy(cpt.projectionMatrix);
    cur.viewProj.multiplyMatrices(cur.proj, cam.matrixWorldInverse);
    cur.viewProjCockpit.multiplyMatrices(cur.projCockpit, cpt.matrixWorldInverse);

    // Rotation-only view: zero the translation column of the inverse world
    // matrix, which leaves exactly R^T.
    _mat4.copy(cam.matrixWorldInverse);
    _mat4.elements[12] = 0;
    _mat4.elements[13] = 0;
    _mat4.elements[14] = 0;
    cur.viewProjRot.multiplyMatrices(cur.proj, _mat4);
    cur.invViewProjRot.copy(cur.viewProjRot).invert();
  }

  const TONE_MODES = { none: 0, narkowicz: 1, hill: 2, reinhard: 3 };

  function render(dt) {
    if (!settings.enabled) { fallbackRender(); return; }

    renderer.getDrawingBufferSize(_v2);
    if (Math.round(_v2.x) !== state.outSize.w || Math.round(_v2.y) !== state.outSize.h) {
      state.outSize.w = Math.max(2, Math.round(_v2.x));
      state.outSize.h = Math.max(2, Math.round(_v2.y));
      rebuild();
    } else if (structuralSignature() !== state.signature) {
      rebuild();
    }

    state.time += Math.max(0, dt);
    const { w, h } = state.size;
    const aspect = w / h;

    // Matrices must be captured *before* jitter so velocity stays geometric.
    captureMatrices();
    applyJitter();

    // ---- 1. HDR scene + cockpit ---------------------------------------------
    renderer.setRenderTarget(targets.hdr);
    renderer.setClearColor(_sceneClear, 1);
    renderer.clear(true, true, false);
    renderer.render(engine.scene, engine.camera);
    if (hasCockpit()) {
      renderer.clearDepth();
      renderer.render(engine.cockpitScene, engine.cockpitCamera);
    }

    // ---- 2. velocity ---------------------------------------------------------
    const wantVelocity =
      settings.velocity.enabled && (settings.taa.enabled || settings.motionBlur.enabled || settings.godRays.enabled);
    if (wantVelocity) renderVelocity();

    removeJitter();

    let colorTex = targets.hdr.texture;

    // ---- 3. TAA / FXAA -------------------------------------------------------
    if (settings.taa.enabled && wantVelocity) {
      const histIdx = state.historyIndex;
      const dstIdx = 1 - histIdx;
      const u = taaMat.uniforms;
      u.tCurrent.value = targets.hdr.texture;
      u.tHistory.value = state.historyValid ? targets.taa[histIdx].texture : targets.hdr.texture;
      u.tVelocity.value = targets.vel.texture;
      u.uTexel.value.set(1 / w, 1 / h);
      u.uResolution.value.set(w, h);
      // Jitter is applied in NDC; UV is half of that.
      u.uJitterDelta.value.set(
        (state.prevJitter.x - state.jitter.x) * 0.5,
        (state.prevJitter.y - state.jitter.y) * 0.5,
      );
      u.uFeedbackMin.value = state.historyValid ? settings.taa.feedbackMin : 0;
      u.uFeedbackMax.value = state.historyValid ? settings.taa.feedbackMax : 0;
      u.uVarianceGamma.value = settings.taa.varianceGamma;
      u.uVelocityWeight.value = settings.taa.velocityWeight;
      u.uSharpen.value = settings.taa.sharpen;
      blit(taaMat, targets.taa[dstIdx]);
      colorTex = targets.taa[dstIdx].texture;
      state.historyIndex = dstIdx;
      state.historyValid = true;
    } else if (settings.fxaa.enabled) {
      const u = fxaaMat.uniforms;
      u.tSource.value = targets.hdr.texture;
      u.uTexel.value.set(1 / w, 1 / h);
      u.uEdgeThreshold.value = settings.fxaa.edgeThreshold;
      u.uEdgeThresholdMin.value = settings.fxaa.edgeThresholdMin;
      u.uSubpixel.value = settings.fxaa.subpixel;
      blit(fxaaMat, targets.taa[0]);
      colorTex = targets.taa[0].texture;
      state.historyValid = false;
    } else {
      state.historyValid = false;
    }

    // ---- 4. motion blur ------------------------------------------------------
    if (settings.motionBlur.enabled && wantVelocity && settings.motionBlur.intensity > 0) {
      const velDiv = settings.velocity.halfRes ? 2 : 1;
      const vw = w / velDiv;
      const vh = h / velDiv;

      tileMat.uniforms.tVelocity.value = targets.vel.texture;
      tileMat.uniforms.uTexel.value.set(1 / vw, 1 / vh);
      tileMat.uniforms.uDirection.value.set(1, 0);
      blit(tileMat, targets.tileA);

      tileMat.uniforms.tVelocity.value = targets.tileA.texture;
      tileMat.uniforms.uTexel.value.set(1 / targets.tileA.width, 1 / targets.tileA.height);
      tileMat.uniforms.uDirection.value.set(0, 1);
      blit(tileMat, targets.tileB);

      neighborMat.uniforms.tTiles.value = targets.tileB.texture;
      neighborMat.uniforms.uTexel.value.set(1 / targets.tileB.width, 1 / targets.tileB.height);
      blit(neighborMat, targets.neighbor);

      // Recycle the stale TAA history slot: its contents were consumed above and
      // it is not read again until it becomes the write target next frame.
      const scratch = settings.taa.enabled ? targets.taa[1 - state.historyIndex] : targets.taa[1];
      const u = motionMat.uniforms;
      u.tColor.value = colorTex;
      u.tVelocity.value = targets.vel.texture;
      u.tNeighborMax.value = targets.neighbor.texture;
      u.uResolution.value.set(w, h);
      u.uIntensity.value = settings.motionBlur.intensity;
      u.uTime.value = state.time;
      u.uDepthExtent.value = settings.motionBlur.depthExtent;
      blit(motionMat, scratch);
      colorTex = scratch.texture;
    }

    // ---- 5. bloom ------------------------------------------------------------
    let bloomTex = blackTex;
    if (settings.bloom.enabled && settings.bloom.intensity > 0) {
      const down = targets.bloomDown;
      const up = targets.bloomUp;

      const pu = bloomPreMat.uniforms;
      pu.tSource.value = colorTex;
      pu.uTexel.value.set(1 / w, 1 / h);
      pu.uKnee.value = settings.bloom.knee;
      pu.uKneeWidth.value = Math.max(1e-3, settings.bloom.kneeWidth);
      pu.uKneeMix.value = clamp(settings.bloom.kneeMix, 0, 1);
      pu.uClamp.value = settings.bloom.clamp;
      blit(bloomPreMat, down[0]);

      for (let i = 1; i < down.length; i++) {
        bloomDownMat.uniforms.tSource.value = down[i - 1].texture;
        bloomDownMat.uniforms.uHalfPixel.value.set(0.5 / down[i - 1].width, 0.5 / down[i - 1].height);
        blit(bloomDownMat, down[i]);
      }

      let srcTex = down[down.length - 1].texture;
      for (let i = up.length - 1; i >= 0; i--) {
        bloomUpMat.uniforms.tSource.value = srcTex;
        bloomUpMat.uniforms.tMip.value = down[i].texture;
        bloomUpMat.uniforms.uHalfPixel.value.set(0.5 / up[i].width, 0.5 / up[i].height);
        bloomUpMat.uniforms.uScatter.value = clamp(settings.bloom.scatter, 0, 1);
        blit(bloomUpMat, up[i]);
        srcTex = up[i].texture;
      }
      bloomTex = srcTex;
    }

    // ---- 6. anamorphic streaks ----------------------------------------------
    let streakTex = blackTex;
    if (settings.streaks.enabled && settings.streaks.intensity > 0) {
      // Source from bloom mip1 when available: already bright-biased and cheap.
      const src = settings.bloom.enabled && targets.bloomDown.length > 1
        ? targets.bloomDown[1]
        : { texture: colorTex, width: w, height: h };

      const su = streakPreMat.uniforms;
      su.tSource.value = src.texture;
      su.uTexel.value.set(1 / src.width, 1 / src.height);
      su.uThreshold.value = settings.streaks.threshold;
      su.uClamp.value = settings.streaks.clamp;
      blit(streakPreMat, targets.streak[0]);

      const iterations = clamp(Math.round(settings.streaks.iterations), 1, 6);
      const taps = clamp(Math.round(settings.streaks.taps) | 1, 3, 17);
      const halfTaps = (taps - 1) / 2;
      // Reach must stay inside the buffer: ClampToEdge means an over-long stride
      // smears the border pixel into a horizontal bar across the whole frame.
      const maxStride = (targets.streak[0].width * 0.62) / Math.max(1, halfTaps);

      let a = 0;
      const bu = streakBlurMat.uniforms;
      bu.uTexel.value.set(1 / targets.streak[0].width, 1 / targets.streak[0].height);
      bu.uAttenuation.value = settings.streaks.attenuation;
      bu.uDirection.value.set(1, 0);
      bu.uTint.value.set(...settings.streaks.tint);
      for (let i = 0; i < iterations; i++) {
        bu.tSource.value = targets.streak[a].texture;
        // Kawase growth: stride multiplies by the tap count each iteration, so 4
        // passes of 9 taps reach ~2900 texels of coverage for 36 fetches.
        bu.uStride.value = Math.min(maxStride, settings.streaks.stride * Math.pow(taps, i));
        blit(streakBlurMat, targets.streak[1 - a]);
        a = 1 - a;
      }
      streakTex = targets.streak[a].texture;
    }

    // ---- 7. god rays ---------------------------------------------------------
    let godTex = blackTex;
    let godIntensity = 0;
    if (settings.godRays.enabled && settings.godRays.intensity > 0) {
      const sun = computeSunScreen();
      if (sun.visible > 0.001) {
        const mu = godMaskMat.uniforms;
        mu.tScene.value = colorTex;
        mu.tVelocity.value = wantVelocity ? targets.vel.texture : blackTex;
        mu.uSunUv.value.set(sun.u, sun.v);
        mu.uSunDepth.value = sun.depth;
        mu.uRadius.value = settings.godRays.radius;
        mu.uThreshold.value = settings.godRays.threshold;
        mu.uAspect.value = aspect;
        mu.uHasDepth.value = wantVelocity ? 1 : 0;
        mu.uSourceTexel.value.set(1 / w, 1 / h);
        blit(godMaskMat, targets.godray[0]);

        const gu = godBlurMat.uniforms;
        gu.uSunUv.value.set(sun.u, sun.v);
        gu.uDecay.value = settings.godRays.decay;
        gu.uWeight.value = settings.godRays.weight;
        gu.uTexel.value.set(1 / targets.godray[0].width, 1 / targets.godray[0].height);

        gu.tSource.value = targets.godray[0].texture;
        gu.uDensity.value = settings.godRays.density;
        gu.uExposure.value = settings.godRays.exposure;
        blit(godBlurMat, targets.godray[1]);

        // Second, shorter pass compounds the reach: 12 taps twice covers what
        // would otherwise need ~40 taps in one go.
        gu.tSource.value = targets.godray[1].texture;
        gu.uDensity.value = settings.godRays.density * 0.34;
        gu.uExposure.value = 1.0;
        blit(godBlurMat, targets.godray[0]);

        godTex = targets.godray[0].texture;
        godIntensity = settings.godRays.intensity * sun.visible;
      }
    }

    // ---- 8. composite --------------------------------------------------------
    const dirt = ensureDirt();
    const c = compositeMat.uniforms;
    const g = settings.grade;
    c.tScene.value = colorTex;
    c.tBloom.value = bloomTex;
    c.tStreaks.value = streakTex;
    c.tGodRays.value = godTex;
    c.tDirt.value = dirt ?? blackTex;
    c.uResolution.value.set(state.outSize.w, state.outSize.h);
    c.uTime.value = state.time * (settings.grain.speed ?? 1);
    c.uAspect.value = aspect;
    c.uBloomIntensity.value = settings.bloom.enabled ? settings.bloom.intensity : 0;
    c.uStreakIntensity.value = settings.streaks.enabled ? settings.streaks.intensity : 0;
    c.uStreakTint.value.set(...settings.streaks.tint);
    c.uGodRayIntensity.value = godIntensity;
    c.uGodRayColor.value.set(...settings.godRays.color);
    c.uDirtIntensity.value = dirt ? settings.lensDirt.intensity : 0;
    c.uCA.value = settings.chromatic.enabled ? settings.chromatic.amount : 0;
    c.uCACenterBias.value = settings.chromatic.centerBias;
    c.uExposure.value = settings.tonemap.exposure;
    c.uToneMode.value = TONE_MODES[settings.tonemap.mode] ?? 2;
    c.uWhitePoint.value = settings.tonemap.whitePoint;
    c.uLift.value.set(...g.lift);
    c.uInvGamma.value.set(1 / Math.max(1e-3, g.gamma[0]), 1 / Math.max(1e-3, g.gamma[1]), 1 / Math.max(1e-3, g.gamma[2]));
    c.uGain.value.set(...g.gain);
    c.uContrast.value = g.contrast;
    c.uSaturation.value = g.saturation;
    c.uShadowTint.value.set(...g.shadowTint);
    c.uHighlightTint.value.set(...g.highlightTint);
    c.uGlobalTint.value.set(...g.tint);
    c.uGrain.value = settings.grain.enabled ? settings.grain.intensity : 0;
    c.uGrainShadowBias.value = settings.grain.shadowBias;
    c.uGrainSize.value = settings.grain.size;
    c.uVignette.value = settings.vignette.enabled ? settings.vignette.intensity : 0;
    c.uVignetteSmooth.value = settings.vignette.smoothness;
    c.uVignetteRound.value = settings.vignette.roundness;
    c.uDither.value = settings.output.dither;
    c.uSrgb.value = settings.output.srgb ? 1 : 0;

    const view = settings.debug.view;
    if (view && view !== 'final') {
      const map = {
        scene: [colorTex, 0],
        hdr: [targets.hdr.texture, 0],
        velocity: [targets.vel.texture, 1],
        depth: [targets.vel.texture, 2],
        bloom: [bloomTex, 0],
        streaks: [streakTex, 0],
        godrays: [godTex, 0],
        dirt: [dirt ?? blackTex, 3],
      };
      const entry = map[view];
      if (entry) {
        debugMat.uniforms.tSource.value = entry[0];
        debugMat.uniforms.uMode.value = entry[1];
        debugMat.uniforms.uScale.value = settings.debug.scale ?? 1;
        blit(debugMat, null);
        state.frame++;
        return;
      }
    }

    blit(compositeMat, null);
    state.frame++;
  }

  // ---------------------------------------------------------------------- API
  function setQuality(q) {
    if (!QUALITY_PRESETS[q]) return;
    settings.quality = q;
    deepMerge(settings, QUALITY_PRESETS[q]);
    rebuild();
  }

  /**
   * Apply a per-mission colour grade.
   * @param {string|object} nameOrGrade key of MISSION_GRADES, or a partial grade
   */
  function setMissionGrade(nameOrGrade) {
    const g = typeof nameOrGrade === 'string' ? MISSION_GRADES[nameOrGrade] : nameOrGrade;
    if (!g) return false;
    deepMerge(settings.grade, g);
    return true;
  }

  function dispose() {
    disposeTargets();
    for (const m of materials) m.dispose();
    materials.length = 0;
    quadGeo.dispose();
    blackTex.dispose();
    // dirtTexture belongs to engine.registry — the registry disposes it.
    dirtTexture = null;
  }

  setSize(state.outSize.w, state.outSize.h);

  return {
    name: 'post',
    settings,
    render,
    setSize,
    dispose,
    setQuality,
    setMissionGrade,
    /** Live intermediates, for debugging and for other systems that want them. */
    targets,
    /** Resolve the star the shafts are keyed to (world space) or null. */
    getSunWorldPosition() {
      return resolveSun(_sunWorld) ? _sunWorld.clone() : null;
    },
    get internalSize() { return { ...state.size }; },
    get passCount() { return countPasses(); },
  };

  function countPasses() {
    let n = 1; // composite
    if (settings.velocity.enabled) n += 1;
    if (settings.taa.enabled) n += 1;
    else if (settings.fxaa.enabled) n += 1;
    if (settings.motionBlur.enabled) n += 4;
    if (settings.bloom.enabled) n += targets.bloomDown.length + targets.bloomUp.length;
    if (settings.streaks.enabled) n += 1 + settings.streaks.iterations;
    if (settings.godRays.enabled) n += 3;
    return n;
  }
}
