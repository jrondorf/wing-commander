import * as THREE from 'three';
import { NOISE_GLSL } from './glsl/noise.glsl.js';
import { CubePass, makeCubeTarget } from './GpuGen.js';
import { makeRng } from '../core/Rand.js';
import { fbm2, worley2, cellValue, clamp, smoothstep } from '../procgen/noise.js';

/**
 * Procedural planets.
 *
 * Surfaces are baked into a **cube map** rather than an equirectangular texture:
 * the generator is a function of the object-space direction, so there is no polar
 * pinch, no seam, and no wasted texels — exactly the artefacts that give away a
 * cheap CG planet. Two cube maps per planet:
 *
 *   surface : rgb = albedo, a = height (drives per-pixel normals)
 *   extra   : r = water/ice specular mask, g = night-side city lights, b = cloud
 *
 * On top of the shaded sphere sit three optional shells — an atmosphere with a
 * Rayleigh-weighted limb glow that brightens toward the terminator, a rotating
 * cloud layer, and a ring system that casts a real shadow on the planet and
 * receives one from it.
 */

const TYPE_INDEX = { 'gas-giant': 0, rocky: 1, ice: 2, terrestrial: 3 };

// ---------------------------------------------------------------- bake shader

const BAKE_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;

uniform int   uType;
uniform float uChannel;
uniform float uSeed;
uniform vec3  uC0;
uniform vec3  uC1;
uniform vec3  uC2;
uniform vec3  uC3;
uniform vec3  uStormCol;
uniform float uBandFreq;
uniform float uSea;
uniform vec4  uStorms[3];

${NOISE_GLSL}

// --------------------------------------------------------------- gas giant
void gasGiant(vec3 n, out vec3 albedo, out float height) {
  // Zonal flow: heavy shear along longitude, tight banding in latitude.
  vec3 pz = vec3(n.x * 2.2, n.y * 9.0, n.z * 2.2) + uSeed;
  float flow = wcFbm(pz, 5);
  float lat = n.y;
  float bands = sin(lat * uBandFreq + flow * 0.62) * 0.5 + 0.5;
  float fine = wcFbm(vec3(n.x * 5.0, n.y * 27.0, n.z * 5.0) + flow * 1.5 + uSeed, 5) * 0.5 + 0.5;
  float t = wcSat(bands * 0.62 + fine * 0.52);

  vec3 col = mix(uC0, uC1, smoothstep(0.12, 0.86, t));
  col = mix(col, uC2, smoothstep(0.56, 0.96, fine * (0.45 + 0.55 * bands)));

  // ---- storm ovals: real vortices, swirled about their own centres --------
  for (int i = 0; i < 3; i++) {
    vec4 st = uStorms[i];
    if (st.w <= 0.0) continue;
    vec3 c = normalize(st.xyz);
    vec3 t1 = normalize(cross(c, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));
    vec3 t2 = cross(c, t1);
    vec2 q = vec2(dot(n, t1), dot(n, t2) * 2.4);
    float d = length(q) / st.w;
    if (d < 1.25) {
      float swirl = (1.0 - wcSat(d)) * 3.6;
      float cs = cos(swirl), ss = sin(swirl);
      vec2 rq = vec2(q.x * cs - q.y * ss, q.x * ss + q.y * cs);
      float sn = wcFbm(vec3(rq * 22.0, uSeed + float(i) * 7.0), 4) * 0.5 + 0.5;
      float k = smoothstep(1.0, 0.45, d);
      col = mix(col, mix(uStormCol * 0.72, uStormCol * 1.30, sn), k * 0.92);
      col += uStormCol * 0.30 * smoothstep(0.78, 0.99, d) * smoothstep(1.16, 1.0, d);
      t = mix(t, 0.35 + 0.5 * sn, k * 0.7);
    }
  }

  // Polar hoods.
  col = mix(col, uC3, smoothstep(0.58, 0.98, abs(lat)));
  albedo = col;
  height = t;
}

// ------------------------------------------------------------------- rocky
void rocky(vec3 n, out vec3 albedo, out float height, out float spec) {
  float base = wcFbm(n * 2.2 + uSeed, 6) * 0.5 + 0.5;
  float erode = wcRidged(n * 5.5 + uSeed, 5, 0.9);
  float h = base * 0.72 + erode * 0.40;

  float ejecta = 0.0;
  // Three crater generations, largest first — the classic saturated regolith.
  for (int i = 0; i < 3; i++) {
    float scale = i == 0 ? 3.4 : (i == 1 ? 8.5 : 20.0);
    float depth = i == 0 ? 0.34 : (i == 1 ? 0.19 : 0.10);
    float R = i == 0 ? 0.36 : (i == 1 ? 0.32 : 0.28);
    vec3 cw = wcWorley(n * scale + uSeed * 0.7);
    float exists = step(0.40, cw.z);
    float d = cw.x;
    float bowl = -smoothstep(R, 0.02, d);
    float rim = smoothstep(R * 1.35, R, d) * smoothstep(R * 0.70, R, d);
    h += exists * depth * (bowl * 0.85 + rim * 1.05);
    ejecta += exists * rim * (0.5 - float(i) * 0.15);
  }
  h = wcSat(h * 0.55 + 0.4);

  float mare = smoothstep(0.42, 0.20, base);          // dark basaltic plains
  vec3 col = mix(uC0, uC1, wcSat(h * 1.3 - 0.1));
  col = mix(col, uC2, mare * 0.75);
  col = mix(col, uC3, wcSat(ejecta * 0.9));
  // Fine regolith mottling so the albedo is never flat.
  col *= 0.86 + 0.28 * (wcFbm(n * 22.0 + uSeed, 3) * 0.5 + 0.5);

  albedo = col;
  height = h;
  spec = 0.04;
}

// --------------------------------------------------------------------- ice
void iceWorld(vec3 n, out vec3 albedo, out float height, out float spec) {
  float h = wcFbm(n * 2.6 + uSeed, 6) * 0.5 + 0.5;
  float cracks = wcRidged(n * 6.5 + uSeed, 5, 2.4);
  float lineal = smoothstep(0.70, 0.94, cracks);
  float chaos = smoothstep(0.55, 0.86, wcFbm(n * 3.4 + 77.0 + uSeed, 4) * 0.5 + 0.5);

  vec3 col = mix(uC0, uC1, h);
  col = mix(col, uC2, lineal * 0.85);
  col = mix(col, uC3, chaos * 0.42);
  col *= 0.90 + 0.20 * (wcFbm(n * 18.0, 3) * 0.5 + 0.5);

  albedo = col;
  height = h * 0.62 + lineal * 0.38;
  spec = 0.45 + 0.35 * (1.0 - lineal);
}

// ------------------------------------------------------------- terrestrial
void terrestrial(vec3 n, out vec3 albedo, out float height, out float spec, out float night, out float cloud) {
  float cont = wcFbm(n * 1.55 + uSeed, 6);
  float ridge = wcRidged(n * 3.4 + uSeed, 5, 1.1);
  float elev = cont + 0.42 * ridge - 0.21;

  float land = smoothstep(uSea - 0.012, uSea + 0.030, elev);
  float lat = abs(n.y);
  float icy = smoothstep(0.70, 0.90, lat + 0.14 * wcFbm(n * 5.0 + 21.0, 3));

  float moist = wcFbm(n * 2.3 + 55.0 + uSeed, 4) * 0.5 + 0.5;
  float mountain = smoothstep(uSea + 0.16, uSea + 0.34, elev);

  vec3 landCol = mix(uC1, uC2, smoothstep(0.34, 0.72, moist));   // desert -> forest
  landCol = mix(landCol, uC3, smoothstep(0.44, 0.80, lat));      // -> tundra
  landCol = mix(landCol, vec3(0.42, 0.40, 0.38), mountain * 0.55);

  // Ocean deepens away from the shelf.
  float depth = smoothstep(uSea, uSea - 0.22, elev);
  vec3 seaCol = mix(uC0 * 1.5, uC0 * 0.45, depth);

  vec3 col = mix(seaCol, landCol, land);
  col = mix(col, vec3(0.90, 0.94, 1.0), icy);
  col *= 0.90 + 0.20 * (wcFbm(n * 16.0, 3) * 0.5 + 0.5);

  // City lights: on land, hugging the coast, temperate latitudes, clustered.
  float coast = 1.0 - smoothstep(0.0, 0.075, abs(elev - uSea));
  float pop = smoothstep(0.52, 0.90, wcFbm(n * 8.5 + 120.0 + uSeed, 4) * 0.5 + 0.5);
  night = land * (0.30 + 0.70 * coast) * pop * (1.0 - icy) * (1.0 - smoothstep(0.55, 0.86, lat));

  // Cloud deck: banded by latitude (Hadley cells) and sheared by the rotation.
  vec3 cw = vec3(n.x * 2.3, n.y * 4.6, n.z * 2.3) + 210.0 + uSeed;
  float cband = 0.5 + 0.5 * sin(n.y * 9.0 + wcFbm(cw * 0.7, 3) * 2.4);
  float cn = wcFbm(cw + wcFbm(cw * 1.7, 3) * 1.5, 5) * 0.5 + 0.5;
  cloud = wcSat(smoothstep(0.44, 0.78, cn) * (0.45 + 0.75 * cband));

  albedo = col;
  height = wcSat(elev * 0.7 + 0.45);
  spec = (1.0 - land) * (1.0 - icy);
}

void main() {
  vec3 n = normalize(vDir);
  vec3 albedo = vec3(0.5);
  float height = 0.5, spec = 0.0, night = 0.0, cloud = 0.0;

  if (uType == 0) gasGiant(n, albedo, height);
  else if (uType == 1) rocky(n, albedo, height, spec);
  else if (uType == 2) iceWorld(n, albedo, height, spec);
  else terrestrial(n, albedo, height, spec, night, cloud);

  if (uChannel < 0.5) gl_FragColor = vec4(albedo, height);
  else gl_FragColor = vec4(spec, night, cloud, 1.0);
}
`;

// ------------------------------------------------------------ surface shader

const SURFACE_VERT = /* glsl */ `
varying vec3 vObj;
varying vec3 vWPos;
void main() {
  vObj = normalize(position);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SURFACE_FRAG = /* glsl */ `
precision highp float;
varying vec3 vObj;
varying vec3 vWPos;

uniform samplerCube uSurf;
uniform samplerCube uExtra;
uniform vec3  uLightDir;
uniform vec3  uLightColor;
uniform vec3  uAmbient;
uniform vec3  uCamPos;
uniform vec3  uCentre;
uniform mat3  uObjToWorld;
uniform float uBump;
uniform float uBumpEps;
uniform vec3  uAtmoColor;
uniform float uAtmoStrength;
uniform vec3  uNightColor;
uniform float uNightAmount;
uniform float uSpecPower;
uniform float uHasRing;
uniform float uRingInner;
uniform float uRingOuter;
uniform float uPlanetR;
uniform vec3  uRingAxis;
uniform sampler2D uRingTex;

void main() {
  vec3 n0 = normalize(vObj);
  vec4 s = textureCube(uSurf, n0);
  vec3 albedo = s.rgb;
  float h = s.a;

  // Per-pixel normals derived from the baked height channel.
  vec3 ref = abs(n0.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t1 = normalize(cross(n0, ref));
  vec3 t2 = cross(n0, t1);
  float h1 = textureCube(uSurf, normalize(n0 + t1 * uBumpEps)).a;
  float h2 = textureCube(uSurf, normalize(n0 + t2 * uBumpEps)).a;
  vec3 nObj = normalize(n0 - (h1 - h) * uBump * t1 - (h2 - h) * uBump * t2);
  vec3 N = normalize(uObjToWorld * nObj);

  vec4 ex = textureCube(uExtra, n0);
  float water = ex.r;
  float lights = ex.g;

  vec3 V = normalize(uCamPos - vWPos);
  vec3 L = uLightDir;
  float ndl = dot(N, L);
  float day = smoothstep(-0.09, 0.18, ndl);

  float shadow = 1.0;
  if (uHasRing > 0.5) {
    // Trace toward the star; if the ray crosses the ring plane inside the
    // annulus, the ring casts a banded shadow on the planet.
    vec3 rel = vWPos - uCentre;
    float dn = dot(uRingAxis, L);
    if (abs(dn) > 1e-4) {
      float t = -dot(rel, uRingAxis) / dn;
      if (t > 0.0) {
        vec3 q = rel + L * t;
        float rad = length(q);
        if (rad > uRingInner && rad < uRingOuter) {
          float u = (rad - uRingInner) / (uRingOuter - uRingInner);
          shadow = 1.0 - texture2D(uRingTex, vec2(u, 0.5)).a * 0.80;
        }
      }
    }
  }

  vec3 col = albedo * uLightColor * max(ndl, 0.0) * shadow;

  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), uSpecPower) * water;
  col += uLightColor * spec * 1.5 * day * shadow;

  col += albedo * uAmbient;

  // Night side: city lights, plus a faint airglow so it never goes pure black.
  col += uNightColor * lights * (1.0 - day) * uNightAmount;

  // Atmospheric in-scatter across the disc — haze thickens toward the limb and
  // peaks just inside the terminator.
  float rim = 1.0 - max(dot(N, V), 0.0);
  float twilight = smoothstep(-0.22, 0.30, ndl) * (0.55 + 0.9 * exp(-ndl * ndl * 26.0));
  col += uAtmoColor * uLightColor * uAtmoStrength * pow(rim, 2.4) * twilight;

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

// --------------------------------------------------------- atmosphere shell

const SHELL_VERT = /* glsl */ `
varying vec3 vWNormal;
varying vec3 vWPos;
void main() {
  vWNormal = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const ATMO_FRAG = /* glsl */ `
precision highp float;
varying vec3 vWNormal;
varying vec3 vWPos;

uniform vec3  uCamPos;
uniform vec3  uLightDir;
uniform vec3  uLightColor;
uniform vec3  uAtmoColor;
uniform float uStrength;

void main() {
  vec3 N = normalize(vWNormal);
  vec3 V = normalize(uCamPos - vWPos);
  float mu = max(dot(N, V), 0.0);

  // Optical depth through the shell grows sharply at grazing angles.
  float depth = pow(1.0 - mu, 3.2);

  float ndl = dot(N, uLightDir);
  // The limb stays lit a little past the geometric terminator — twilight.
  float sun = smoothstep(-0.38, 0.26, ndl);
  // Rayleigh is forward-biased, which is why a crescent world has a hot rim.
  float phase = 0.70 + 1.05 * pow(max(dot(V, -uLightDir), 0.0), 2.0);

  vec3 col = uAtmoColor * uLightColor * depth * sun * phase * uStrength;
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

const CLOUD_FRAG = /* glsl */ `
precision highp float;
varying vec3 vWNormal;
varying vec3 vWPos;
varying vec3 vObjC;

uniform samplerCube uExtra;
uniform vec3  uLightDir;
uniform vec3  uLightColor;
uniform vec3  uAmbient;
uniform float uOpacity;

void main() {
  vec3 n0 = normalize(vObjC);
  float c = textureCube(uExtra, n0).b;
  if (c < 0.01) discard;
  vec3 N = normalize(vWNormal);
  float ndl = dot(N, uLightDir);
  float lit = max(ndl, 0.0);
  vec3 col = uLightColor * (0.15 + 0.95 * lit) + uAmbient * 1.4;
  gl_FragColor = vec4(col, c * uOpacity * smoothstep(-0.28, 0.10, ndl + 0.28));
}
`;

const CLOUD_VERT = /* glsl */ `
varying vec3 vWNormal;
varying vec3 vWPos;
varying vec3 vObjC;
void main() {
  vObjC = normalize(position);
  vWNormal = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

// ------------------------------------------------------------------- rings

const RING_VERT = /* glsl */ `
varying vec3 vWPos;
varying vec3 vLocal;
varying vec3 vWNormal;
void main() {
  vLocal = position;
  vWNormal = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const RING_FRAG = /* glsl */ `
precision highp float;
varying vec3 vWPos;
varying vec3 vLocal;
varying vec3 vWNormal;

uniform sampler2D uRingTex;
uniform vec3  uCentre;
uniform vec3  uLightDir;
uniform vec3  uLightColor;
uniform vec3  uAmbient;
uniform vec3  uCamPos;
uniform float uInner;
uniform float uOuter;
uniform float uPlanetR;

void main() {
  float rad = length(vLocal.xy);
  float u = (rad - uInner) / (uOuter - uInner);
  if (u < 0.0 || u > 1.0) discard;
  vec4 t = texture2D(uRingTex, vec2(u, 0.5));
  if (t.a < 0.004) discard;

  // Planet shadow on the ring.
  vec3 rel = vWPos - uCentre;
  float dl = dot(rel, uLightDir);
  float perp = sqrt(max(dot(rel, rel) - dl * dl, 0.0));
  float shadow = dl < 0.0 ? smoothstep(uPlanetR * 1.05, uPlanetR * 0.92, perp) : 0.0;

  vec3 N = normalize(vWNormal);
  vec3 V = normalize(uCamPos - vWPos);
  float lit = 0.30 + 0.70 * abs(dot(N, uLightDir));
  // Fine ice viewed against the star scatters forward and glows.
  float forward = pow(max(dot(V, -uLightDir), 0.0), 3.0) * 0.9;

  vec3 col = t.rgb * (uLightColor * lit * (1.0 - shadow * 0.94) * (1.0 + forward) + uAmbient * 1.2);
  gl_FragColor = vec4(col, t.a * mix(1.0, 0.65, forward));
}
`;

// ------------------------------------------------------------------ palettes

function palette(type, rng) {
  switch (type) {
    case 'gas-giant': {
      const hueShift = rng.range(-0.06, 0.06);
      const warm = rng.bool(0.6);
      return warm
        ? {
          c0: [0.30, 0.20, 0.13], c1: [0.76, 0.62, 0.44],
          c2: [0.92, 0.80, 0.62], c3: [0.24, 0.22, 0.26],
          storm: [0.86, 0.36, 0.22], bandFreq: rng.range(16, 26) + hueShift,
        }
        : {
          c0: [0.16, 0.22, 0.30], c1: [0.52, 0.64, 0.74],
          c2: [0.80, 0.86, 0.92], c3: [0.18, 0.20, 0.28],
          storm: [0.90, 0.72, 0.42], bandFreq: rng.range(14, 22),
        };
    }
    case 'rocky':
      return {
        c0: [0.13, 0.115, 0.10], c1: [0.42, 0.37, 0.32],
        c2: [0.085, 0.080, 0.082], c3: [0.55, 0.51, 0.46],
        storm: [0, 0, 0], bandFreq: 0,
      };
    case 'ice':
      return {
        c0: [0.62, 0.70, 0.80], c1: [0.90, 0.94, 1.0],
        c2: [0.16, 0.26, 0.36], c3: [0.52, 0.40, 0.30],
        storm: [0, 0, 0], bandFreq: 0,
      };
    default: // terrestrial
      return {
        c0: [0.020, 0.055, 0.115], c1: [0.46, 0.38, 0.24],
        c2: [0.10, 0.20, 0.09], c3: [0.34, 0.36, 0.33],
        storm: [0, 0, 0], bandFreq: 0,
      };
  }
}

/** Radial ring density/colour profile — bands, gaps, a Cassini-style division. */
function makeRingTexture(seed) {
  const W = 1024;
  const data = new Uint8Array(W * 4);
  const rng = makeRng(seed ^ 0x71ce);
  const gapCentres = [];
  for (let i = 0; i < 5; i++) gapCentres.push({ at: rng.range(0.08, 0.94), w: rng.range(0.006, 0.030) });
  const cassini = rng.range(0.42, 0.62);

  for (let i = 0; i < W; i++) {
    const u = i / (W - 1);
    let d = 0.55 + 0.45 * fbm2(u * 26, 3.1, { octaves: 5, seed: 771 });
    d *= 0.6 + 0.5 * (worley2(u * 40, 1.7, { seed: 913 }).f2 - 0.15);
    // Sharp edges at the inner and outer boundary.
    d *= smoothstep(0.0, 0.05, u) * (1 - smoothstep(0.88, 1.0, u));
    for (const g of gapCentres) {
      d *= 1 - 0.92 * Math.exp(-((u - g.at) ** 2) / (2 * g.w * g.w));
    }
    d *= 1 - 0.96 * Math.exp(-((u - cassini) ** 2) / (2 * 0.018 * 0.018));
    d = clamp(d, 0, 1);

    const tint = 0.5 + 0.5 * fbm2(u * 9, 11.3, { octaves: 3, seed: 55 });
    const grit = cellValue(Math.floor(u * 260), 3) * 0.16;
    const r = clamp(0.72 + 0.24 * tint + grit, 0, 1);
    const g = clamp(0.66 + 0.22 * tint + grit, 0, 1);
    const b = clamp(0.56 + 0.18 * tint + grit * 0.6, 0, 1);
    data[i * 4] = r * 255;
    data[i * 4 + 1] = g * 255;
    data[i * 4 + 2] = b * 255;
    data[i * 4 + 3] = clamp(Math.pow(d, 0.85), 0, 1) * 255;
  }

  const tex = new THREE.DataTexture(data, W, 1, THREE.RGBAFormat);
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Build one planet.
 *
 * @param {Engine} engine
 * @param {object} opts { position, radius, type, seed, rings, tilt }
 */
export function createPlanet(engine, {
  position = new THREE.Vector3(),
  radius = 5000,
  type = 'rocky',
  seed = 1,
  rings = null,
  size = 512,
} = {}) {
  const t0 = performance.now();
  const renderer = engine.renderer;
  const rng = makeRng((seed ^ 0x9e37) >>> 0);
  const pal = palette(type, rng);
  const typeIdx = TYPE_INDEX[type] ?? 1;

  const storms = [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()];
  if (typeIdx === 0) {
    const n = rng.int(1, 3);
    for (let i = 0; i < n; i++) {
      const lat = rng.range(-0.45, 0.45);
      const lon = rng.range(0, Math.PI * 2);
      const cb = Math.cos(lat);
      storms[i].set(cb * Math.cos(lon), Math.sin(lat), cb * Math.sin(lon), rng.range(0.10, 0.26));
    }
  }

  const uniformsBake = {
    uType: { value: typeIdx },
    uChannel: { value: 0 },
    uSeed: { value: rng.range(0, 400) },
    uC0: { value: new THREE.Vector3(...pal.c0) },
    uC1: { value: new THREE.Vector3(...pal.c1) },
    uC2: { value: new THREE.Vector3(...pal.c2) },
    uC3: { value: new THREE.Vector3(...pal.c3) },
    uStormCol: { value: new THREE.Vector3(...pal.storm) },
    uBandFreq: { value: pal.bandFreq },
    uSea: { value: rng.range(-0.03, 0.06) },
    uStorms: { value: storms },
  };

  const bake = new CubePass(BAKE_FRAG, uniformsBake);
  const surfRT = makeCubeTarget(size, { mipmaps: true, half: false });
  const extraRT = makeCubeTarget(size, { mipmaps: true, half: false });
  bake.render(renderer, surfRT);
  uniformsBake.uChannel.value = 1;
  bake.render(renderer, extraRT);
  renderer.getContext().finish();
  bake.dispose();

  const group = new THREE.Group();
  group.name = `planet-${type}`;
  group.position.copy(position);

  const hasAtmo = typeIdx === 3 || typeIdx === 0 || typeIdx === 2;
  const atmoColor = typeIdx === 3
    ? new THREE.Vector3(0.24, 0.48, 1.0)
    : typeIdx === 0
      ? new THREE.Vector3(0.55, 0.62, 0.90)
      : new THREE.Vector3(0.42, 0.60, 0.92);

  const surfaceUniforms = {
    uSurf: { value: surfRT.texture },
    uExtra: { value: extraRT.texture },
    uLightDir: { value: new THREE.Vector3(0, 0, 1) },
    uLightColor: { value: new THREE.Vector3(1, 1, 1) },
    uAmbient: { value: new THREE.Vector3(0.02, 0.03, 0.05) },
    uCamPos: { value: new THREE.Vector3() },
    uCentre: { value: position.clone() },
    uObjToWorld: { value: new THREE.Matrix3() },
    uBump: { value: typeIdx === 0 ? 0.35 : 1.6 },
    uBumpEps: { value: 1.1 / size },
    uAtmoColor: { value: atmoColor.clone() },
    uAtmoStrength: { value: hasAtmo ? (typeIdx === 3 ? 0.55 : 0.30) : 0.05 },
    uNightColor: { value: new THREE.Vector3(1.0, 0.72, 0.36) },
    uNightAmount: { value: typeIdx === 3 ? 2.6 : 0.0 },
    uSpecPower: { value: typeIdx === 2 ? 40 : 110 },
    uHasRing: { value: 0 },
    uRingInner: { value: 0 },
    uRingOuter: { value: 0 },
    uPlanetR: { value: radius },
    uRingAxis: { value: new THREE.Vector3(0, 1, 0) },
    uRingTex: { value: null },
  };

  const surfaceMat = new THREE.ShaderMaterial({
    uniforms: surfaceUniforms,
    vertexShader: SURFACE_VERT,
    fragmentShader: SURFACE_FRAG,
    toneMapped: false,
  });

  const segments = radius > 3000 ? 128 : 96;
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(radius, segments, Math.floor(segments * 0.62)), surfaceMat);
  sphere.name = 'planet-surface';
  group.add(sphere);

  // Axial tilt gives the terminator and the ring plane something to read against.
  const tilt = rng.range(-0.45, 0.45);
  sphere.rotation.z = tilt;

  let cloudMesh = null;
  let cloudMat = null;
  if (typeIdx === 3) {
    cloudMat = new THREE.ShaderMaterial({
      uniforms: {
        uExtra: { value: extraRT.texture },
        uLightDir: surfaceUniforms.uLightDir,
        uLightColor: surfaceUniforms.uLightColor,
        uAmbient: surfaceUniforms.uAmbient,
        uOpacity: { value: 0.92 },
      },
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    cloudMesh = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.012, 96, 60), cloudMat);
    cloudMesh.rotation.z = tilt;
    cloudMesh.name = 'planet-clouds';
    group.add(cloudMesh);
  }

  let atmoMesh = null;
  let atmoMat = null;
  if (hasAtmo) {
    atmoMat = new THREE.ShaderMaterial({
      uniforms: {
        uCamPos: surfaceUniforms.uCamPos,
        uLightDir: surfaceUniforms.uLightDir,
        uLightColor: surfaceUniforms.uLightColor,
        uAtmoColor: { value: atmoColor.clone() },
        uStrength: { value: typeIdx === 3 ? 1.5 : 0.95 },
      },
      vertexShader: SHELL_VERT,
      fragmentShader: ATMO_FRAG,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      toneMapped: false,
    });
    atmoMesh = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.035, 96, 60), atmoMat);
    atmoMesh.name = 'planet-atmosphere';
    atmoMesh.renderOrder = 2;
    group.add(atmoMesh);
  }

  // ------------------------------------------------------------------ rings
  let ringMesh = null;
  let ringMat = null;
  let ringTex = null;
  const wantRings = rings ?? (typeIdx === 0 && rng.bool(0.75));
  if (wantRings) {
    const inner = radius * rng.range(1.35, 1.6);
    const outer = inner * rng.range(1.6, 2.1);
    ringTex = makeRingTexture(seed);
    ringMat = new THREE.ShaderMaterial({
      uniforms: {
        uRingTex: { value: ringTex },
        uCentre: { value: position.clone() },
        uLightDir: surfaceUniforms.uLightDir,
        uLightColor: surfaceUniforms.uLightColor,
        uAmbient: surfaceUniforms.uAmbient,
        uCamPos: surfaceUniforms.uCamPos,
        uInner: { value: inner },
        uOuter: { value: outer },
        uPlanetR: { value: radius },
      },
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const ringGeo = new THREE.RingGeometry(inner, outer, 192, 4);
    ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.rotation.x = -Math.PI / 2;
    ringMesh.renderOrder = 1;
    ringMesh.name = 'planet-rings';

    const ringHolder = new THREE.Group();
    ringHolder.rotation.z = tilt;
    ringHolder.add(ringMesh);
    group.add(ringHolder);

    surfaceUniforms.uHasRing.value = 1;
    surfaceUniforms.uRingInner.value = inner;
    surfaceUniforms.uRingOuter.value = outer;
    surfaceUniforms.uRingTex.value = ringTex;
    // Ring plane normal in world space, accounting for the axial tilt.
    surfaceUniforms.uRingAxis.value.set(0, 1, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), tilt);
  }

  const spin = rng.range(0.004, 0.02) * (typeIdx === 0 ? 2.2 : 1);
  const ms = +(performance.now() - t0).toFixed(1);

  return {
    object3D: group,
    type,
    radius,
    position: group.position,
    ms,

    applyPreset(preset, ambient) {
      const s = preset.star;
      surfaceUniforms.uLightDir.value.copy(s.dir).normalize();
      surfaceUniforms.uLightColor.value.set(
        s.color[0] * s.intensity * 0.30,
        s.color[1] * s.intensity * 0.30,
        s.color[2] * s.intensity * 0.30,
      );
      surfaceUniforms.uAmbient.value.copy(ambient);
    },

    update(dt, camera) {
      surfaceUniforms.uCamPos.value.copy(camera.position);
      sphere.rotateY(spin * dt);
      if (cloudMesh) cloudMesh.rotateY(spin * 1.35 * dt);
      sphere.updateMatrixWorld();
      surfaceUniforms.uObjToWorld.value.setFromMatrix4(sphere.matrixWorld);
    },

    dispose() {
      surfRT.dispose();
      extraRT.dispose();
      sphere.geometry.dispose();
      surfaceMat.dispose();
      cloudMesh?.geometry.dispose();
      cloudMat?.dispose();
      atmoMesh?.geometry.dispose();
      atmoMat?.dispose();
      ringMesh?.geometry.dispose();
      ringMat?.dispose();
      ringTex?.dispose();
    },
  };
}
