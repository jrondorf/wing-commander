import * as THREE from 'three';
import { makeRng } from '../core/Rand.js';
import { fbm2, clamp, smoothstep } from '../procgen/noise.js';

/**
 * Starfield.
 *
 * "A starfield of identical white dots" is on the instant-fail list in the art
 * bible, so this one is built from the actual astrophysics rather than from a
 * random size jitter:
 *
 *   • Mass is drawn from a Salpeter initial mass function (dN/dm ∝ m^-2.35), so
 *     M dwarfs vastly outnumber O/B stars exactly as they do in reality.
 *   • Luminosity follows the mass-luminosity relation (L ∝ M^3.5) and effective
 *     temperature follows from mass, so colour and brightness are *correlated* —
 *     the bright stars come out blue-white and the faint ones red, which is the
 *     single detail that makes a synthetic sky read as real.
 *   • Distance is uniform in volume, so apparent flux (L/d²) lands on a proper
 *     power law with no tuning.
 *   • A few per cent are evolved giants: cool temperature, huge luminosity. That
 *     is where the bright orange stars come from.
 *   • Colour is a Planckian blackbody curve, not a hand-picked palette.
 *
 * A galactic band carries ~45 % of the population, concentrated in latitude with
 * an exponential scale height and broken by dust rifts sampled from `fbm2`.
 *
 * Stars sit on a shell that the world system re-centres on the camera every
 * frame, so they have exactly zero parallax — they are at infinity.
 */

const SHELL = 900_000;
const GEN_POLE = new THREE.Vector3(0, 1, 0);

/** Planckian locus → linear RGB. Tanner Helland's approximation, sRGB-decoded. */
function blackbodyLinear(kelvin) {
  const t = clamp(kelvin, 1000, 40000) / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const srgb = [r, g, b].map((c) => clamp(c / 255, 0, 1));
  // sRGB transfer → linear
  const lin = srgb.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  const peak = Math.max(lin[0], lin[1], lin[2], 1e-4);
  return [lin[0] / peak, lin[1] / peak, lin[2] / peak];
}

/** Inverse-CDF sample of a Salpeter IMF over [m0, m1]. */
function salpeterMass(u, m0 = 0.12, m1 = 26) {
  const a = 1 - 2.35;
  const p0 = Math.pow(m0, a);
  const p1 = Math.pow(m1, a);
  return Math.pow(p0 + u * (p1 - p0), 1 / a);
}

const STAR_VERT = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
uniform float uPixelScale;
uniform samplerCube uSky;
uniform float uSkyDim;
varying vec3 vColor;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;

  // Dust lanes in the nebula occlude the stars behind them; alpha of the sky
  // cube is the baked dust opacity for that direction.
  vec3 dir = normalize(position);
  float dustA = textureLod(uSky, dir, 3.0).a;
  float atten = exp(-dustA * uSkyDim);

  vColor = aColor * atten;
  gl_PointSize = max(1.0, aSize * uPixelScale * (0.55 + 0.45 * atten));
}
`;

const STAR_FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot(c, c) * 4.0;
  float core = exp(-d2 * 7.0);
  float halo = exp(-sqrt(d2) * 2.9) * 0.22;
  float a = core + halo;
  if (a < 0.005) discard;
  gl_FragColor = vec4(vColor * a, 1.0);
}
`;

const SPIKE_VERT = /* glsl */ `
attribute vec3 aOffset;
attribute float aScale;
attribute vec3 aColor;
uniform vec2 uResolution;
uniform samplerCube uSky;
uniform float uSkyDim;
varying vec2 vP;
varying vec3 vColor;

void main() {
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(aOffset, 1.0);
  if (clip.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vP = vec2(0.0); vColor = vec3(0.0); return; }
  vec3 ndc = clip.xyz / clip.w;
  vP = position.xy;
  vec3 dir = normalize(aOffset);
  float dustA = textureLod(uSky, dir, 3.0).a;
  vColor = aColor * exp(-dustA * uSkyDim);
  gl_Position = vec4(ndc.xy + (position.xy * aScale) / uResolution * 2.0, ndc.z, 1.0);
}
`;

const SPIKE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vP;
varying vec3 vColor;

void main() {
  vec2 q = vP;
  float r = length(q);
  float core = exp(-r * r * 60.0);
  float ax = exp(-abs(q.y) * 120.0) * exp(-abs(q.x) * 3.2);
  float ay = exp(-abs(q.x) * 120.0) * exp(-abs(q.y) * 3.2);
  vec2 dg = vec2(q.x + q.y, q.x - q.y) * 0.70710678;
  float d1 = exp(-abs(dg.x) * 170.0) * exp(-r * 5.5);
  float d2 = exp(-abs(dg.y) * 170.0) * exp(-r * 5.5);
  float glow = exp(-r * 3.4) * 0.14;
  float a = core * 1.5 + (ax + ay) * 0.50 + (d1 + d2) * 0.20 + glow;
  if (a < 0.003) discard;
  // Slight chromatic spread along the spikes, as a real reflector produces.
  vec3 tint = vec3(1.0 - 0.10 * r, 1.0, 1.0 + 0.16 * r);
  gl_FragColor = vec4(vColor * a * tint, 1.0);
}
`;

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {object} opts
 * @returns {{ object3D: THREE.Group, setSky: Function, setPole: Function, resize: Function, dispose: Function, stats: object }}
 */
export function createStarfield(engine, { seed = 1337, count = 24000, spikes = 40 } = {}) {
  const rng = makeRng(seed ^ 0x5ad0);
  const t0 = performance.now();

  // Galactic frame for the generation pole; the whole object is rotated later to
  // match whichever pole the active preset's nebula band uses.
  const u = new THREE.Vector3(1, 0, 0);
  const w = new THREE.Vector3(0, 0, 1);

  const candidates = [];
  const want = Math.floor(count * 1.25);
  let guard = 0;
  while (candidates.length < want && guard++ < want * 6) {
    const inBand = rng() < 0.46;
    let dir;
    if (inBand) {
      // Exponential scale height in galactic latitude + dust-rift rejection.
      const lat = -0.105 * Math.log(1 - rng() * 0.999) * rng.sign();
      const lon = rng() * Math.PI * 2;
      const rift = fbm2(Math.cos(lon) * 2.4, Math.sin(lon) * 2.4 + lat * 9, { seed: 4021, octaves: 4 });
      if (rift < -0.22) continue; // this direction is behind a dust lane
      const cb = Math.cos(lat), sb = Math.sin(lat);
      dir = new THREE.Vector3()
        .addScaledVector(u, cb * Math.cos(lon))
        .addScaledVector(w, cb * Math.sin(lon))
        .addScaledVector(GEN_POLE, sb);
    } else {
      const z = rng() * 2 - 1;
      const a = rng() * Math.PI * 2;
      const s = Math.sqrt(Math.max(0, 1 - z * z));
      dir = new THREE.Vector3(s * Math.cos(a), z, s * Math.sin(a));
    }

    let mass = salpeterMass(rng());
    let temp = clamp(5772 * Math.pow(mass, 0.54), 2600, 33000);
    let lum = Math.pow(mass, 3.5);
    if (rng() < 0.028) {
      // Evolved giant: cool and enormous. Source of the bright orange stars.
      temp = rng.range(3100, 4600);
      lum *= rng.range(60, 900);
    }
    const dist = 1 + 60 * Math.cbrt(rng());
    const flux = lum / (dist * dist);
    candidates.push({ dir, temp, flux });
  }

  candidates.sort((a, b) => b.flux - a.flux);
  const stars = candidates.slice(0, count);
  const faint = Math.max(stars[stars.length - 1].flux, 1e-9);

  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const s = stars[i];
    positions[i * 3] = s.dir.x * SHELL;
    positions[i * 3 + 1] = s.dir.y * SHELL;
    positions[i * 3 + 2] = s.dir.z * SHELL;

    // Apparent brightness: physical flux, compressed the way an exposure curve
    // compresses it, then floored so nothing vanishes entirely.
    const bright = clamp(Math.pow(s.flux / faint, 0.22) * 0.052, 0.030, 1.55);
    const rgb = blackbodyLinear(s.temp);
    // Dim stars desaturate — the same reason faint stars look white to the eye.
    const sat = 0.32 + 0.68 * smoothstep(0.04, 0.9, bright);
    for (let c = 0; c < 3; c++) {
      colors[i * 3 + c] = (rgb[c] * sat + (1 - sat)) * bright;
    }
    sizes[i] = clamp(1.05 + 5.2 * Math.pow(bright, 1.55), 1.0, 7.5);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SHELL * 1.01);

  const skyUniform = { value: null };
  const dimUniform = { value: 3.4 };

  const pointsMat = new THREE.ShaderMaterial({
    uniforms: {
      uPixelScale: { value: 1 },
      uSky: skyUniform,
      uSkyDim: dimUniform,
    },
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    transparent: true,
  });

  const points = new THREE.Points(geo, pointsMat);
  points.frustumCulled = false;
  points.renderOrder = -8;
  points.name = 'starfield';

  // ---- diffraction spikes on the brightest handful --------------------------
  const nSpike = Math.min(spikes, count);
  const spikeOffsets = new Float32Array(nSpike * 3);
  const spikeColors = new Float32Array(nSpike * 3);
  const spikeScales = new Float32Array(nSpike);
  for (let i = 0; i < nSpike; i++) {
    const s = stars[i];
    spikeOffsets[i * 3] = s.dir.x * SHELL;
    spikeOffsets[i * 3 + 1] = s.dir.y * SHELL;
    spikeOffsets[i * 3 + 2] = s.dir.z * SHELL;
    const rgb = blackbodyLinear(s.temp);
    const b = clamp(Math.pow(s.flux / faint, 0.22) * 0.052, 0.2, 1.6);
    spikeColors[i * 3] = rgb[0] * b * 0.85;
    spikeColors[i * 3 + 1] = rgb[1] * b * 0.85;
    spikeColors[i * 3 + 2] = rgb[2] * b * 0.85;
    spikeScales[i] = 11 + 26 * Math.pow(b, 1.2);
  }

  const spikeGeo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(2, 2);
  spikeGeo.index = quad.index;
  spikeGeo.setAttribute('position', quad.getAttribute('position'));
  spikeGeo.setAttribute('uv', quad.getAttribute('uv'));
  spikeGeo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(spikeOffsets, 3));
  spikeGeo.setAttribute('aColor', new THREE.InstancedBufferAttribute(spikeColors, 3));
  spikeGeo.setAttribute('aScale', new THREE.InstancedBufferAttribute(spikeScales, 1));
  spikeGeo.instanceCount = nSpike;
  spikeGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SHELL * 1.01);

  const spikeMat = new THREE.ShaderMaterial({
    uniforms: {
      uResolution: { value: new THREE.Vector2(1600, 900) },
      uSky: skyUniform,
      uSkyDim: dimUniform,
    },
    vertexShader: SPIKE_VERT,
    fragmentShader: SPIKE_FRAG,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    transparent: true,
  });

  const spikeMesh = new THREE.Mesh(spikeGeo, spikeMat);
  spikeMesh.frustumCulled = false;
  spikeMesh.renderOrder = -7;
  spikeMesh.name = 'star-spikes';

  const group = new THREE.Group();
  group.name = 'starfield-group';
  group.add(points, spikeMesh);

  const size = new THREE.Vector2();
  engine.renderer.getSize(size);
  spikeMat.uniforms.uResolution.value.set(size.x, size.y);
  pointsMat.uniforms.uPixelScale.value = Math.max(0.75, size.y / 900);

  return {
    object3D: group,
    stats: { count, spikes: nSpike, ms: +(performance.now() - t0).toFixed(1) },

    /** Point the generated band at the preset's galactic pole. */
    setPole(pole) {
      group.quaternion.setFromUnitVectors(GEN_POLE, pole.clone().normalize());
    },

    setSky(cubeTexture) {
      skyUniform.value = cubeTexture;
    },

    resize(w, h) {
      spikeMat.uniforms.uResolution.value.set(w, h);
      pointsMat.uniforms.uPixelScale.value = Math.max(0.75, h / 900);
    },

    dispose() {
      geo.dispose();
      pointsMat.dispose();
      spikeGeo.dispose();
      quad.dispose();
      spikeMat.dispose();
    },
  };
}
