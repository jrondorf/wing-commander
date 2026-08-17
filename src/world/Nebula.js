import * as THREE from 'three';
import { NOISE_GLSL } from './glsl/noise.glsl.js';
import { CubePass, makeCubeTarget } from './GpuGen.js';

/**
 * Procedural nebula skybox — the single most important thing in the frame.
 *
 * Generated in two GPU passes, which is both cheaper and better art than one:
 *
 *   Pass A (structure, 384²/face) runs the expensive part — two levels of domain
 *   warping over fbm, the kind of turbulence that makes gas look like it is
 *   *moving*. It writes four scalar fields: gas density, dust density, an
 *   ionisation/hue field, and embedded-cluster glow.
 *
 *   Pass B (detail, 1024²/face) magnifies those fields and erodes them with
 *   high-frequency ridged noise. This is the same shape-then-erode structure real
 *   volumetric cloud renderers use, and it is what produces hard-edged dust
 *   pillars silhouetted against glowing gas — the Eagle/Carina signature —
 *   instead of a soft airbrushed blob.
 *
 * Colour is three emission bands (cool outer → mid → hot core) mixed by density
 * and by the ionisation field, plus an explicit ionisation-front term that
 * brightens gas exactly where it meets dust. Dust then *absorbs*
 * (exp(-density·k)) rather than merely darkening, so lanes read as opaque
 * foreground material with real depth behind them.
 *
 * Output is HDR: cluster cores land well above 1.0 so the post stack's bloom has
 * something true to work with. Alpha carries dust opacity — the starfield reads
 * it back to hide background stars behind the lanes.
 */

const STRUCTURE_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;

uniform float uSeed;
uniform float uScale;
uniform float uWarp;
uniform float uCoverage;
uniform float uDust;
uniform float uWallSoft;
uniform vec3  uWall;

${NOISE_GLSL}

void main() {
  vec3 d = normalize(vDir);
  vec3 p = d * uScale + uSeed;

  // ---- two-level domain warp: gas that curls instead of blobs ---------------
  vec3 q = vec3(
    wcFbm(p, 4),
    wcFbm(p + vec3(31.4, 12.7, 5.3), 4),
    wcFbm(p + vec3(7.1, 23.9, 41.2), 4));
  vec3 w1 = p + uWarp * q;
  vec3 r = vec3(
    wcFbm(w1, 4),
    wcFbm(w1 + vec3(17.3, 9.4, 28.1), 4),
    wcFbm(w1 + vec3(3.7, 44.2, 11.8), 4));
  float base = wcFbm(p + uWarp * r, 5);

  // ---- composition: a nebula *wall*, not a uniform fog ----------------------
  // The boundary between lit sky and empty sky is broken up by low-frequency
  // noise, so the frame keeps a genuinely dark quadrant for contrast.
  float wallN = wcFbm(p * 0.40 + 91.0, 3);
  float wall = smoothstep(-uWallSoft, uWallSoft, dot(d, uWall) + 0.62 * wallN);

  float gas = wcSat(base * 0.5 + 0.5);
  gas = smoothstep(uCoverage, 0.96, gas) * wall;

  // ---- dust: its own field, warped by the same flow so it hugs the gas ------
  vec3 pd = p * 1.28 + vec3(101.0, 57.0, 13.0);
  float dbase = wcFbm(pd + uWarp * 0.72 * r, 5);
  float dust = wcSat(smoothstep(-0.14, 0.40, dbase) * uDust * mix(0.40, 1.20, wall));

  // ---- which parts of the cloud are ionised to the hot colour --------------
  float hue = wcSat(wcFbm(p * 0.52 + 143.0, 3) * 0.85 + 0.5);

  // ---- embedded star-cluster cores: rare, small, very bright ---------------
  float glow = pow(wcSat(wcFbm(p * 0.92 - 33.0, 3) * 0.5 + 0.5), 8.0);

  gl_FragColor = vec4(gas, dust, hue, glow);
}
`;

const DETAIL_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;

uniform samplerCube uLo;
uniform float uSeed;
uniform float uScale;
uniform float uAbsorb;
uniform float uExposure;
uniform vec3  uGasHot;
uniform vec3  uGasMid;
uniform vec3  uGasCool;
uniform vec3  uDustCol;
uniform vec3  uDeep;
uniform vec3  uBand;
uniform vec3  uGalNormal;

${NOISE_GLSL}

void main() {
  vec3 d = normalize(vDir);
  vec4 lo = textureCube(uLo, d);
  float gas = lo.r, dust = lo.g, hue = lo.b, glow = lo.a;

  vec3 p = d * uScale + uSeed;

  // High-frequency detail. "fil" is a ridged multifractal: its creases become
  // both the wisps in the gas and the fingers eaten out of the dust edge.
  // Detail frequency is deliberately low. Real nebulae are dominated by huge soft
  // masses with filament structure riding on top; running the ridged multifractal
  // at high frequency and full modulation depth turns the whole sky into uniform
  // lacework that reads as lichen and competes with the ships for attention.
  float det = wcFbm(p * 1.35 + 71.0, 4);
  float fil = wcRidged(p * 2.15 + det * 0.45, 4, 1.35);
  float dn = det * 0.5 + 0.5;

  // Coverage is the thing that decides whether a sky reads as a nebula or as a
  // noise texture. Gas that fills every direction leaves the eye nowhere to rest
  // and nothing for a ship silhouette to read against, so the field is thresholded
  // to carve out genuinely empty sky and concentrate the gas into fewer, denser
  // masses. Everything below the low edge becomes clean dark space.
  gas = smoothstep(0.34, 0.92, gas);

  // Large-scale gas carries the image (0.72); filaments modulate it (0.48) rather
  // than defining it.
  float g = clamp(gas * (0.72 + 0.48 * fil) + 0.16 * gas * dn, 0.0, 1.9);

  float du = dust * 1.05 - 0.20 * fil - 0.10 * dn + 0.06;
  // A narrow threshold turns the dust field into hard-edged blobs scattered over
  // the whole sky. Real absorption is a soft gradient with a few dense cores, so
  // the ramp is wide and the field is biased down to keep coverage sparse.
  du = smoothstep(0.02, 0.72, clamp(du, 0.0, 1.0));

  // ---- three colour bands mixing across the sky ----------------------------
  vec3 emis = mix(uGasCool, uGasMid, smoothstep(0.03, 0.40, g));
  emis = mix(emis, uGasHot, smoothstep(0.36, 1.05, g) * (0.28 + 0.72 * hue));
  // Gentler than 1.30: a steep gamma crushes the mid-tones and leaves only bright
  // cores and black, which is what makes procedural gas look like a noise field.
  emis *= pow(g, 1.05);

  // Ionisation front — gas glows hardest where the dust wall shadows it.
  float rim = du * (1.0 - du) * 4.0;
  emis += uGasHot * rim * g * 0.80;

  // Embedded clusters, deliberately over-range.
  emis += uGasHot * glow * (0.25 + g) * 3.4;

  // ---- absorption: dust occludes, it does not merely darken ----------------
  vec3 col = emis * exp(-du * uAbsorb);
  col += uDustCol * du * (0.12 + 0.32 * g);

  // ---- galactic band, broken by its own dust rifts -------------------------
  float b = dot(d, uGalNormal);
  float band = exp(-b * b * 130.0);
  float rift = smoothstep(-0.40, 0.45, det);
  col += uBand * band * (0.22 + 0.78 * rift) * 0.55 * (1.0 - 0.8 * du);

  // ---- deep-space floor: space is never #000 -------------------------------
  col += uDeep * (0.55 + 0.55 * dn);

  gl_FragColor = vec4(max(col, 0.0) * uExposure, du);
}
`;

/**
 * Bake a nebula skybox + its PMREM environment map.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {object} sky preset `sky` block
 * @param {object} [opts]
 * @returns {{ texture: THREE.CubeTexture, envMap: THREE.Texture, timings: object, dispose: Function }}
 */
export function generateNebula(renderer, sky, { size = 1024, structureSize = 384 } = {}) {
  const timings = {};
  let t0 = performance.now();

  const loTarget = makeCubeTarget(structureSize, { mipmaps: false });
  const structurePass = new CubePass(STRUCTURE_FRAG, {
    uSeed: { value: sky.seed },
    uScale: { value: sky.scale },
    uWarp: { value: sky.warp },
    uCoverage: { value: sky.coverage },
    uDust: { value: sky.dust },
    uWallSoft: { value: sky.wallSoft },
    uWall: { value: sky.wall.clone() },
  });
  structurePass.render(renderer, loTarget);
  renderer.getContext().finish();
  structurePass.dispose();
  timings.structure = +(performance.now() - t0).toFixed(1);

  t0 = performance.now();
  const target = makeCubeTarget(size, { mipmaps: true });
  const detailPass = new CubePass(DETAIL_FRAG, {
    uLo: { value: loTarget.texture },
    uSeed: { value: sky.seed },
    uScale: { value: sky.scale },
    uAbsorb: { value: sky.absorb },
    uExposure: { value: sky.exposure },
    uGasHot: { value: new THREE.Vector3(...sky.gasHot) },
    uGasMid: { value: new THREE.Vector3(...sky.gasMid) },
    uGasCool: { value: new THREE.Vector3(...sky.gasCool) },
    uDustCol: { value: new THREE.Vector3(...sky.dustCol) },
    uDeep: { value: new THREE.Vector3(...sky.deep) },
    uBand: { value: new THREE.Vector3(...sky.band) },
    uGalNormal: { value: sky.galNormal.clone() },
  });
  detailPass.render(renderer, target);
  renderer.getContext().finish();
  detailPass.dispose();
  loTarget.dispose();
  timings.detail = +(performance.now() - t0).toFixed(1);

  // ---- PMREM: the game's only fill light ------------------------------------
  t0 = performance.now();
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileCubemapShader();
  const envRT = pmrem.fromCubemap(target.texture);
  renderer.getContext().finish();
  pmrem.dispose();
  timings.pmrem = +(performance.now() - t0).toFixed(1);

  return {
    texture: target.texture,
    envMap: envRT.texture,
    timings,
    dispose() {
      target.dispose();
      envRT.dispose();
    },
  };
}
