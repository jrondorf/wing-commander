/**
 * Shared GLSL for the VFX stack.
 *
 * Everything here renders into the linear HDR target with no tone mapping
 * (ARCHITECTURE §1.7) — emissive magnitudes of 4–30 are deliberate, the post
 * stack's progressive bloom is what turns them into light.
 *
 * ## Soft particles
 * The single biggest tell of cheap particle work is the hard line where a sprite
 * intersects geometry. We kill it by fading against scene depth. The depth we read
 * is the `.b` channel of the post pipeline's velocity G-buffer (`post.targets.vel`,
 * a documented public intermediate — see render/shaders/velocity.glsl.js), which
 * stores linear view depth normalised by `camera.far`.
 *
 * Two consequences worth knowing:
 *   - It is one frame stale. At combat closing speeds that is a sub-metre error on
 *     a fade that spans several metres; invisible.
 *   - Every VFX object sets `userData.noVelocity = true`, so particles are excluded
 *     from that buffer. That is exactly what we want: we need the depth of the
 *     *opaque* world behind the smoke, not of the smoke itself.
 * A cleared/unwritten buffer reads 0, which we treat as "infinitely far" so a shot
 * whose warm-up never rasterised does not make every particle vanish.
 */

// ---------------------------------------------------------------------------
export const GLSL_COMMON = /* glsl */ `
#ifndef VFX_COMMON
#define VFX_COMMON
float vfxSat(float x) { return clamp(x, 0.0, 1.0); }
vec3  vfxSat(vec3 x)  { return clamp(x, 0.0, 1.0); }
float vfxHash(float n) { return fract(sin(n) * 43758.5453123); }
float vfxHash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
#endif
`;

/** Scene-depth sampling + the soft-particle fade every VFX surface uses. */
export const GLSL_SOFT_DEPTH = /* glsl */ `
uniform sampler2D tSceneDepth;
uniform vec2  uInvRes;
uniform float uCameraFar;
uniform float uHasDepth;
uniform float uCameraNear;

float vfxSceneDepth(vec2 uv) {
  if (uHasDepth < 0.5) return 1.0e9;
  float d = texture2D(tSceneDepth, uv).b;
  // 0 means "never written this frame" (cleared buffer, or a warm-up frame that
  // skipped rasterisation) — treat as the far plane rather than as the eye.
  if (d <= 0.0) return 1.0e9;
  return d * uCameraFar;
}

/** 1 = fully visible, 0 = coincident with the geometry behind it. */
float vfxSoftFade(float viewDepth, float soft) {
  float sd = vfxSceneDepth(gl_FragCoord.xy * uInvRes);
  float f = vfxSat((sd - viewDepth) / max(soft, 0.001));
  // Also fade out as a sprite swallows the near plane — a particle clipped by
  // camera.near shows a razor edge across the frame.
  f *= smoothstep(uCameraNear * 1.5, uCameraNear * 7.0, viewDepth);
  return f;
}
`;

/**
 * Up to three "fire lights" — the dying fireball lighting its own smoke from the
 * inside. Positions arrive already in view space so the fragment shader never
 * touches a matrix. This is the difference between a grey cloud and a cloud with
 * an orange furnace buried in it.
 */
export const GLSL_FIRE_LIGHTS = /* glsl */ `
#define VFX_FIRE_LIGHTS 3
uniform vec4 uFireLightPos[VFX_FIRE_LIGHTS]; // xyz view-space position, w = 1/radius^2
uniform vec3 uFireLightCol[VFX_FIRE_LIGHTS]; // HDR radiance

vec3 vfxFireLighting(vec3 nView, vec3 posView, vec3 albedo) {
  vec3 acc = vec3(0.0);
  for (int i = 0; i < VFX_FIRE_LIGHTS; i++) {
    vec3 col = uFireLightCol[i];
    if (col.r + col.g + col.b < 0.0005) continue;
    vec3 d = uFireLightPos[i].xyz - posView;
    float dd = dot(d, d);
    float att = 1.0 / (1.0 + dd * uFireLightPos[i].w);
    // Wrapped diffuse: smoke forward-scatters, so the terminator is soft and the
    // "unlit" side still picks up a glow.
    float w = max((dot(nView, d * inversesqrt(max(dd, 1e-6))) + 0.7) / 1.7, 0.0);
    acc += col * att * w;
  }
  return acc * albedo;
}
`;

// ---------------------------------------------------------------------------
// Particle sprite
// ---------------------------------------------------------------------------

export const PARTICLE_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec4 iA;   // x: diameter  y: roll  z: temperature  w: alpha
attribute vec4 iB;   // x: seed      y: atlas variant  z: erosion  w: stretch/m
attribute vec3 iTint;

uniform float uSoftScale;

varying vec2  vQuad;
varying vec2  vLocalUv;
varying vec2  vTile;
varying float vTemp;
varying float vAlpha;
varying float vSeed;
varying float vErode;
varying float vViewDepth;
varying float vSoft;
varying vec3  vViewPos;
varying vec3  vTint;

void main() {
  vec2 c = position.xy * 2.0;      // base quad spans -0.5..0.5
  float rad = iA.x * 0.5;
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  vViewPos = mv.xyz;

#ifdef VFX_STRETCH
  // Velocity-aligned billboard. A spark is a streak, not a dot — and a streak
  // that follows its own motion vector is the cheapest way to stop a particle
  // system reading as a field of identical discs.
  vec3 vv = (modelViewMatrix * vec4(iVel, 0.0)).xyz;
  float vl = length(vv.xy);
  vec2 dir = vl > 1e-4 ? vv.xy / vl : vec2(0.0, 1.0);
  vec2 per = vec2(-dir.y, dir.x);
  float st = 1.0 + iB.w * vl;
  mv.xy += per * (c.x * rad) + dir * (c.y * rad * st);
#else
  float sr = sin(iA.y);
  float cr = cos(iA.y);
  mv.xy += vec2(c.x * cr - c.y * sr, c.x * sr + c.y * cr) * rad;
#endif

  vQuad = c;
  vLocalUv = uv;
  float vi = floor(iB.y + 0.5);
  vTile = vec2(mod(vi, 2.0), floor(vi * 0.5));
  vTemp = iA.z;
  vAlpha = iA.w;
  vSeed = iB.x;
  vErode = iB.z;
  vTint = iTint;
  vViewDepth = -mv.z;
  vSoft = iA.x * uSoftScale;

  gl_Position = projectionMatrix * mv;
}
`;

export const PARTICLE_FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform sampler2D uRamp;
uniform sampler2D uNoise;
uniform float uTime;
uniform float uEmissive;
uniform float uWarp;
uniform float uRim;
uniform float uDetail;
uniform vec3  uKeyDirView;
uniform vec3  uKeyColor;
uniform vec3  uAmbient;
uniform vec3  uAlbedo;

varying vec2  vQuad;
varying vec2  vLocalUv;
varying vec2  vTile;
varying float vTemp;
varying float vAlpha;
varying float vSeed;
varying float vErode;
varying float vViewDepth;
varying float vSoft;
varying vec3  vViewPos;
varying vec3  vTint;

vec2 atlasUv(vec2 luv) { return (clamp(luv, 0.012, 0.988) + vTile) * 0.5; }

void main() {
  float r2 = dot(vQuad, vQuad);
  if (r2 > 1.0) discard;

  // Two octaves of scrolling warp. The sprite's silhouette boils and folds
  // instead of sitting frozen — this plus the atlas erosion is what stops the
  // "obvious camera-facing disc" read.
  vec2 s2 = vec2(vSeed, vSeed * 1.71);
  vec3 nz1 = texture2D(uNoise, vLocalUv * 0.85 + s2 + uTime * 0.021).rgb;
  vec3 nz2 = texture2D(uNoise, vLocalUv * 2.4 - s2 * 1.9 - uTime * 0.047).rgb;
  vec2 warp = ((nz1.rg - 0.5) + (nz2.rg - 0.5) * 0.5) * uWarp;

  vec2 luv = vLocalUv + warp;
  vec4 tex = texture2D(uAtlas, atlasUv(luv));

  float grain = mix(1.0, tex.g * 1.6, uDetail);
  float a = smoothstep(vErode, vErode + 0.40, tex.r * grain);
  a *= smoothstep(1.0, 0.58, sqrt(r2));
  a *= vAlpha;
  if (a < 0.004) discard;

  // ---- fake volumetric normal ------------------------------------------------
  // The quad faces the camera, so a hemispherical normal is already in view
  // space; perturbing it by the thickness gradient gives each puff lobes that
  // catch the key light. Sprites shaded this way read as lit gas, not as decals.
  vec3 n;
  n.xy = vQuad * 0.94;
  n.z = sqrt(max(0.0, 1.0 - dot(n.xy, n.xy)));
  float hx = texture2D(uAtlas, atlasUv(luv + vec2(0.035, 0.0))).b - tex.b;
  float hy = texture2D(uAtlas, atlasUv(luv + vec2(0.0, 0.035))).b - tex.b;
  n = normalize(n + vec3(-hx, -hy, 0.0) * 2.6);

  // ---- emission --------------------------------------------------------------
  vec3 chroma = texture2D(uRamp, vec2(vTemp, 0.5)).rgb * vTint;
  float e = pow(vTemp, 2.55) * uEmissive;
  // Optically thin at the edges: you look through more glowing gas near the rim.
  float rim = pow(1.0 - n.z, 2.4);
  // Hot gas is not uniformly bright across a puff: the same detail octave that
  // erodes the silhouette also modulates the emission, so the fireball has
  // burning filaments inside it rather than a flat glowing card.
  float fil = mix(1.0, 0.35 + 1.45 * tex.g, uDetail * 0.85);
  vec3 col = chroma * e * (1.0 + rim * uRim) * fil;

#ifdef VFX_LIT
  vec3 lit = uAmbient + uKeyColor * max((dot(n, uKeyDirView) + 0.42) / 1.42, 0.0);
  // Self-shadowing approximation: the denser the puff, the less light reaches
  // the far side of it. Without this smoke is a flat grey wash.
  lit *= mix(1.0, 0.42, vfxSat(tex.b));
  col += uAlbedo * vTint * lit;
  col += vfxFireLighting(n, vViewPos, uAlbedo * vTint);
#endif

  a *= vfxSoftFade(vViewDepth, vSoft);
  if (a < 0.003) discard;

#ifdef VFX_PREMULT
  gl_FragColor = vec4(col * a, a);
#else
  gl_FragColor = vec4(col, a);
#endif
}
`;

// ---------------------------------------------------------------------------
// Screen-space distortion: heat haze and shockwave refraction
// ---------------------------------------------------------------------------

export const DISTORT_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iQuat;    // orientation (rings); identity for billboards
attribute vec4 iA;       // x size  y strength  z alpha  w seed
attribute vec4 iB;       // x inner radius frac  y rim power  z variant  w scroll

uniform float uSoftScale;

varying vec2  vLocalUv;
varying vec2  vQuad;
varying float vStrength;
varying float vAlpha;
varying float vSeed;
varying float vInner;
varying float vRimPow;
varying float vScroll;
varying float vViewDepth;
varying float vSoft;
varying vec3  vViewPos;
varying vec3  vWorldDir;

// Camera world-space basis. Lets the vertex shader turn a view-space position
// back into a world direction without an inverse matrix — needed because the
// billboard branch expands the quad *after* the modelView transform.
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamZ;

vec3 qrot(vec4 q, vec3 v) {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

void main() {
  vec4 mv;
#ifdef VFX_ORIENTED
  // A ring lives in a real plane in the world: the blast front is a physical
  // surface, and billboarding it would betray that instantly.
  vec3 local = qrot(iQuat, position * iA.x);
  mv = modelViewMatrix * vec4(iPos + local, 1.0);
  vQuad = position.xy * 2.0;
#else
  mv = modelViewMatrix * vec4(iPos, 1.0);
  float sr = sin(iA.w * 6.283);
  float cr = cos(iA.w * 6.283);
  vec2 c = position.xy * 2.0;
  mv.xy += vec2(c.x * cr - c.y * sr, c.x * sr + c.y * cr) * iA.x * 0.5;
  vQuad = c;
#endif

  vViewPos = mv.xyz;
  vWorldDir = normalize(uCamRight * mv.x + uCamUp * mv.y + uCamZ * mv.z);
  vLocalUv = uv;
  vStrength = iA.y;
  vAlpha = iA.z;
  vSeed = iA.w;
  vInner = iB.x;
  vRimPow = iB.y;
  vScroll = iB.w;
  vViewDepth = -mv.z;
  vSoft = iA.x * uSoftScale;
  gl_Position = projectionMatrix * mv;
}
`;

/**
 * Refraction source note.
 *
 * The honest way to refract is to sample a copy of the framebuffer, and there is
 * no way to obtain one here: the scene renders into an MSAA HDR target that
 * cannot be read while it is bound, and the post stack's resolved intermediates
 * ping-pong under a private index. So the shock front refracts the **nebula
 * cubemap** — `scene.background`, sampled twice, once along the straight view ray
 * and once along the bent one, and the *difference* is added.
 *
 * That is not a compromise in this game, it is closer to right: in space
 * essentially everything behind an explosion is at infinity, and adding
 * (skyBent − skyStraight) to a pixel that already contains skyStraight leaves
 * exactly skyBent. Where a hull *is* behind the front the difference lands as a
 * mild coloured smear instead of punching a hole through the ship, which is what
 * a framebuffer-replacing refraction would do with stale depth.
 */
export const DISTORT_FRAG = /* glsl */ `
uniform samplerCube uSky;
uniform sampler2D uNoise;
uniform sampler2D uRamp;
uniform float uTime;
uniform float uHasSky;
uniform float uSkyFlip;
uniform float uRefract;
uniform vec3  uRimColor;
uniform float uRimIntensity;
uniform vec3  uCamRight;
uniform vec3  uCamUp;

varying vec3  vWorldDir;
varying vec2  vLocalUv;
varying vec2  vQuad;
varying float vStrength;
varying float vAlpha;
varying float vSeed;
varying float vInner;
varying float vRimPow;
varying float vScroll;
varying float vViewDepth;
varying float vSoft;
varying vec3  vViewPos;

void main() {
  float mask;
  vec2 refractDir;

#ifdef VFX_RING
  // Annulus: uv.x runs 0..1 across the ring's thickness, uv.y around it.
  float t = vLocalUv.x;
  // Sharp leading edge, long trailing wake — a shock front, not a soap bubble.
  float prof = pow(vfxSat(t), 3.0) * pow(vfxSat(1.0 - t), 0.55);
  prof *= 3.1;
  float ripple = texture2D(uNoise, vec2(vLocalUv.y * 3.0 + vSeed, t * 0.5 + vScroll)).r;
  prof *= 0.72 + 0.56 * ripple;
  mask = vfxSat(prof) * vAlpha;
  refractDir = vec2(0.0, 1.0);
  float rim = pow(vfxSat(t), vRimPow) * pow(vfxSat(1.0 - t), 1.2);
#else
  float r = length(vQuad);
  mask = smoothstep(1.0, vInner, r) * vAlpha;
  refractDir = vQuad;
  float rim = 0.0;
#endif

  if (mask < 0.004) discard;

  vec2 p = vLocalUv * 1.6 + vec2(vSeed * 3.1, vSeed * 1.3) + vec2(uTime * 0.05, -uTime * 0.13 - vScroll);
  vec3 n1 = texture2D(uNoise, p).rgb;
  vec3 n2 = texture2D(uNoise, p * 2.9 + vec2(-uTime * 0.09, uTime * 0.06)).rgb;
  vec2 turb = (n1.rg - 0.5) + (n2.rg - 0.5) * 0.55;

  vec2 off = (turb + refractDir * 0.35) * vStrength * mask;

  float fade = vfxSoftFade(vViewDepth, vSoft);
  mask *= fade;

  vec3 delta = vec3(0.0);
  if (uHasSky > 0.5 && mask > 0.002) {
    vec3 base = normalize(vWorldDir);
    vec3 bent = normalize(base + (uCamRight * off.x + uCamUp * off.y) * uRefract);
    vec3 fb = vec3(uSkyFlip * base.x, base.yz);
    // Dispersion: bend the red end fractionally harder than the blue so a strong
    // front fringes like a lens instead of smearing like a blur.
    vec3 fr = vec3(uSkyFlip, 1.0, 1.0) * normalize(mix(base, bent, 1.12));
    vec3 fg = vec3(uSkyFlip * bent.x, bent.yz);
    vec3 fbb = vec3(uSkyFlip, 1.0, 1.0) * normalize(mix(base, bent, 0.90));
    vec3 s0 = textureCube(uSky, fb).rgb;
    vec3 s1 = vec3(textureCube(uSky, fr).r, textureCube(uSky, fg).g, textureCube(uSky, fbb).b);
    delta = clamp(s1 - s0, vec3(-1.5), vec3(6.0)) * mask;
  }

  vec3 add = vec3(0.0);
#ifdef VFX_RING
  add = uRimColor * (rim * uRimIntensity * vAlpha * fade);
#endif

  // Pure additive (the material uses src=ONE): the sky delta rewrites the
  // background in place, the rim adds on top. Alpha is unused.
  gl_FragColor = vec4(delta + add, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Engine exhaust plume
// ---------------------------------------------------------------------------

export const PLUME_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iQuat;
attribute vec4 iA;   // x radius  y length  z power(0..3)  w seed
attribute vec4 iB;   // x afterburner 0..1  y flicker  z coreTemp  w unused
attribute vec3 iCol;

varying vec2  vUvp;      // x: 0 at nozzle -> 1 at tip, y: around
varying float vPower;
varying float vBurn;
varying float vSeed;
varying float vFlick;
varying float vTemp;
varying vec3  vCol;
varying float vViewDepth;
varying float vSoft;
varying vec3  vNormalView;
varying vec3  vViewDir;

vec3 qrot(vec4 q, vec3 v) {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

void main() {
  // The lathe profile arrives as a unit bell: xy in [-1,1], z in [0,1].
  vec3 p = position;
  vec3 scaled = vec3(p.xy * iA.x, p.z * iA.y);
  vec3 world = iPos + qrot(iQuat, scaled);
  vec3 nrm = normalize(qrot(iQuat, vec3(normal.xy, normal.z * (iA.x / max(iA.y, 1e-3)))));

  vec4 mv = modelViewMatrix * vec4(world, 1.0);
  vNormalView = normalize((modelViewMatrix * vec4(nrm, 0.0)).xyz);
  vViewDir = normalize(-mv.xyz);
  vUvp = uv;
  vPower = iA.z;
  vBurn = iB.x;
  vSeed = iA.w;
  vFlick = iB.y;
  vTemp = iB.z;
  vCol = iCol;
  vViewDepth = -mv.z;
  vSoft = iA.x * 1.4;
  gl_Position = projectionMatrix * mv;
}
`;

export const PLUME_FRAG = /* glsl */ `
uniform sampler2D uNoise;
uniform sampler2D uRamp;
uniform float uTime;
uniform float uIntensity;
uniform float uShock;

varying vec2  vUvp;
varying float vPower;
varying float vBurn;
varying float vSeed;
varying float vFlick;
varying float vTemp;
varying vec3  vCol;
varying float vViewDepth;
varying float vSoft;
varying vec3  vNormalView;
varying vec3  vViewDir;

void main() {
  float z = vfxSat(vUvp.x);          // 0 at the throat, 1 at the tip

  // Turbulent mixing layer: the plume shears against vacuum and breaks up
  // downstream, so the noise amplitude grows with z.
  vec2 np = vec2(vUvp.y * 2.0 + vSeed, z * 1.4 - uTime * (1.1 + vPower * 0.5));
  float turb = texture2D(uNoise, np).g;
  float turb2 = texture2D(uNoise, np * vec2(2.3, 3.1) - vec2(0.0, uTime * 2.2)).b;
  float mix1 = (turb * 0.65 + turb2 * 0.35);

  // Longitudinal profile: dense at the throat, torn apart at the tip.
  float body = pow(1.0 - z, 1.25);
  body *= mix(1.0, 0.35 + 1.3 * mix1, z * 0.92);

  // Shock diamonds. Under-expanded flow reflects off the shear layer and forms
  // a periodic train of bright cells — the visual signature of afterburner.
  float diamonds = 0.0;
  if (vBurn > 0.01) {
    float k = 9.0 + vSeed * 3.0;
    float d = sin(z * k * 3.14159 - 0.6);
    d = pow(max(d, 0.0), 5.0);
    // They fade downstream as the flow loses energy.
    diamonds = d * pow(1.0 - z, 1.6) * vBurn;
  }

  // Edge-on paths are optically longer: brighten the silhouette so the plume
  // reads as a volume of gas instead of a shaded cone.
  float fres = pow(1.0 - abs(dot(normalize(vNormalView), vViewDir)), 1.7);

  float flicker = 0.86 + 0.14 * sin(uTime * 47.0 + vSeed * 31.0) * vFlick;

  float dens = body * (0.55 + 0.85 * fres) * flicker;
  dens += diamonds * uShock * (0.4 + 0.8 * fres);
  dens *= vfxSat(vPower * 0.85);

  // Temperature falls along the plume: white-hot throat -> engine colour -> dark.
  float temp = vfxSat(vTemp * (1.0 - z * 0.78) + diamonds * 0.5);
  vec3 chroma = texture2D(uRamp, vec2(temp, 0.5)).rgb;
  // Blend the physical blackbody toward the ship's drive colour, which is what
  // makes a Confed engine cyan and a Kilrathi one sickly green.
  vec3 col = mix(vCol, chroma, vfxSat(temp * 1.25 - 0.15));

  float a = vfxSat(dens) * vfxSoftFade(vViewDepth, vSoft);
  if (a < 0.003) discard;

  gl_FragColor = vec4(col * uIntensity * (0.35 + 1.3 * temp), a);
}
`;

// ---------------------------------------------------------------------------
// Tracer bolts
// ---------------------------------------------------------------------------

export const BOLT_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iDir;     // unit travel direction
attribute vec4 iA;       // x length  y radius  z intensity  w alpha
attribute vec3 iCol;

varying vec2  vUvb;
varying float vInt;
varying float vAlpha;
varying vec3  vCol;
varying float vViewDepth;
varying float vSoft;

void main() {
  // Cylindrical billboard: the quad rotates about the bolt's own axis to face
  // the camera, so a tracer is never seen edge-on and never reads as a card.
  vec4 mvC = modelViewMatrix * vec4(iPos, 1.0);
  vec3 axis = normalize((modelViewMatrix * vec4(iDir, 0.0)).xyz);
  vec3 toEye = normalize(-mvC.xyz);
  vec3 side = cross(axis, toEye);
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : normalize(cross(axis, vec3(0.0, 0.0, 1.0)));

  vec3 mv = mvC.xyz + axis * (position.y * iA.x) + side * (position.x * 2.0 * iA.y);

  vUvb = uv;
  vInt = iA.z;
  vAlpha = iA.w;
  vCol = iCol;
  vViewDepth = -mv.z;
  vSoft = iA.y * 3.0;
  gl_Position = projectionMatrix * vec4(mv, 1.0);
}
`;

export const BOLT_FRAG = /* glsl */ `
uniform float uCoreBoost;

varying vec2  vUvb;
varying float vInt;
varying float vAlpha;
varying vec3  vCol;
varying float vViewDepth;
varying float vSoft;

void main() {
  float x = vUvb.x * 2.0 - 1.0;   // across the bolt
  float y = vUvb.y;               // 0 = tail, 1 = head

  // Two nested gaussians: a needle-thin white core inside a wide coloured halo.
  // A single falloff gives the flat capsule look we are explicitly avoiding.
  float core = exp(-x * x * 46.0);
  float halo = exp(-x * x * 5.0);

  // The head is compressed and hot, the tail stretches and cools.
  float head = pow(vfxSat(y), 1.6);
  float tail = pow(vfxSat(y), 0.35);
  float caps = smoothstep(0.0, 0.12, y) * smoothstep(1.0, 0.86, y);

  vec3 col = vCol * halo * tail * 1.5;
  col += vec3(1.0, 0.97, 0.92) * core * (0.55 + head) * uCoreBoost;

  float a = vfxSat(core * 1.2 + halo * 0.55) * caps * vAlpha;
  a *= vfxSoftFade(vViewDepth, vSoft);
  if (a < 0.004) discard;

  gl_FragColor = vec4(col * vInt, a);
}
`;

// ---------------------------------------------------------------------------
// Beam weapons
// ---------------------------------------------------------------------------

export const BEAM_FRAG = /* glsl */ `
uniform sampler2D uBeam;
uniform float uTime;
uniform float uCoreBoost;

varying vec2  vUvb;
varying float vInt;
varying float vAlpha;
varying vec3  vCol;
varying float vViewDepth;
varying float vSoft;

void main() {
  float x = vUvb.x;
  // Two counter-scrolling copies of the energy texture beat against each other,
  // which reads as plasma travelling down the channel rather than a lit tube.
  vec4 e1 = texture2D(uBeam, vec2(x, vUvb.y * 3.0 - uTime * 1.9));
  vec4 e2 = texture2D(uBeam, vec2(1.0 - x, vUvb.y * 1.7 - uTime * 3.4 + 0.37));
  float energy = e1.a * 0.65 + e2.a * 0.55;

  float xc = x * 2.0 - 1.0;
  float core = exp(-xc * xc * 60.0);
  float halo = exp(-xc * xc * 4.0);

  float caps = smoothstep(0.0, 0.03, vUvb.y) * smoothstep(1.0, 0.97, vUvb.y);

  vec3 col = vCol * halo * (0.5 + 1.4 * energy);
  col += vec3(1.0, 0.98, 0.95) * core * uCoreBoost * (0.8 + 0.5 * e1.r);

  float a = vfxSat(core + halo * 0.7 * (0.35 + energy)) * caps * vAlpha;
  a *= vfxSoftFade(vViewDepth, vSoft);
  if (a < 0.004) discard;

  gl_FragColor = vec4(col * vInt, a);
}
`;

// ---------------------------------------------------------------------------
// Shield ripple
// ---------------------------------------------------------------------------

export const SHIELD_VERT = /* glsl */ `
varying vec3 vLocal;
varying vec3 vNrmView;
varying vec3 vViewDirV;
varying float vViewDepthS;

void main() {
  vLocal = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vNrmView = normalize(normalMatrix * normal);
  vViewDirV = normalize(-mv.xyz);
  vViewDepthS = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

export const SHIELD_FRAG = /* glsl */ `
#define SHIELD_HITS 4
uniform vec4  uHitDir[SHIELD_HITS];  // xyz: unit impact direction (object space), w: age
uniform vec4  uHitParam[SHIELD_HITS]; // x: strength  y: speed  z: falloff  w: life
uniform vec3  uColor;
uniform vec3  uHotColor;
uniform float uIntensity;
uniform float uAmbientGlow;
uniform float uCell;
uniform float uTime;
uniform float uSoft;

varying vec3 vLocal;
varying vec3 vNrmView;
varying vec3 vViewDirV;
varying float vViewDepthS;

/** Hex grid on a plane. Returns xy = position in cell, z = distance to edge. */
vec3 vfxHex(vec2 p) {
  const vec2 s = vec2(1.0, 1.7320508);
  vec2 a = mod(p, s) - s * 0.5;
  vec2 b = mod(p - s * 0.5, s) - s * 0.5;
  vec2 gv = dot(a, a) < dot(b, b) ? a : b;
  vec2 ap = abs(gv);
  float ed = max(dot(ap, normalize(vec2(1.0, 1.7320508))), ap.x);
  return vec3(p - gv, 0.5 - ed);
}

void main() {
  vec3 n = normalize(vLocal);
  vec3 an = abs(n);
  // Triplanar hex so the cells stay the same size everywhere on the ellipsoid —
  // a spherical-uv hex grid pinches to nothing at the poles and looks wrong.
  vec3 w = an / max(an.x + an.y + an.z, 1e-4);
  vec3 hx = vfxHex(n.yz * uCell);
  vec3 hy = vfxHex(n.zx * uCell);
  vec3 hz = vfxHex(n.xy * uCell);
  float edge = hx.z * w.x + hy.z * w.y + hz.z * w.z;
  vec2 cellId = hx.xy * w.x + hy.xy * w.y + hz.xy * w.z;
  float cellRnd = vfxHash2(floor(cellId * 3.0));

  // Cell wireframe: bright borders, dim interior.
  float border = smoothstep(0.16, 0.015, edge);
  float interior = smoothstep(0.5, 0.16, edge) * 0.16;

  float ripple = 0.0;
  float heat = 0.0;
  for (int i = 0; i < SHIELD_HITS; i++) {
    float life = uHitParam[i].w;
    if (life <= 0.0) continue;
    float age = uHitDir[i].w;
    float tt = age / life;
    if (tt >= 1.0) continue;
    // Great-circle angle from the impact point — the wave travels across the
    // surface of the bubble, which is what the payload's "point" really means.
    float ang = acos(clamp(dot(n, normalize(uHitDir[i].xyz)), -1.0, 1.0));
    float front = age * uHitParam[i].y;
    float d = ang - front;
    // A travelling packet, not a global pulse.
    float wave = exp(-d * d * uHitParam[i].z) * cos(d * 14.0);
    float dist = exp(-ang * 1.35);          // fades with distance from impact
    float decay = pow(1.0 - tt, 1.7);
    float amp = uHitParam[i].x * dist * decay;
    ripple += wave * amp;
    heat += exp(-ang * ang * 22.0) * decay * uHitParam[i].x;
  }
  ripple = abs(ripple);

  float fres = pow(1.0 - abs(dot(normalize(vNrmView), vViewDirV)), 2.6);

  // Cells flicker individually where the wave is passing — the shield reads as
  // a discrete lattice absorbing energy, not a painted sphere.
  float cellPulse = ripple * (0.45 + 0.9 * cellRnd);
  float glow = uAmbientGlow * (fres * 1.4 + border * 0.35 + interior);
  glow += cellPulse * (border * 2.6 + interior * 6.0 + 0.55);
  glow += heat * 2.2 * (border * 1.5 + 0.7);

  vec3 col = mix(uColor, uHotColor, vfxSat(cellPulse * 1.6 + heat * 2.0));
  float a = vfxSat(glow);
  a *= vfxSoftFade(vViewDepthS, uSoft);
  if (a < 0.004) discard;

  gl_FragColor = vec4(col * uIntensity * (0.4 + glow), a);
}
`;

// ---------------------------------------------------------------------------
// Ribbon trails
// ---------------------------------------------------------------------------

export const RIBBON_VERT = /* glsl */ `
attribute vec3 aTangent;
attribute vec4 aParam;   // x: side(-1/1)  y: width  z: alpha  w: u along ribbon
attribute vec3 aColor;
attribute float aTemp;

uniform float uSoftScale;

varying float vU;
varying float vSide;
varying float vAlphaR;
varying vec3  vColR;
varying float vTempR;
varying float vViewDepth;
varying float vSoft;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 t = normalize((modelViewMatrix * vec4(aTangent, 0.0)).xyz);
  vec3 toEye = normalize(-mv.xyz);
  vec3 side = cross(t, toEye);
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);
  mv.xyz += side * (aParam.x * aParam.y);

  vU = aParam.w;
  vSide = aParam.x;
  vAlphaR = aParam.z;
  vColR = aColor;
  vTempR = aTemp;
  vViewDepth = -mv.z;
  vSoft = max(aParam.y, 0.05) * uSoftScale;
  gl_Position = projectionMatrix * mv;
}
`;

export const RIBBON_FRAG = /* glsl */ `
uniform sampler2D uNoise;
uniform sampler2D uRamp;
uniform float uTime;
uniform float uEmissive;
uniform vec3  uAmbient;
uniform vec3  uKeyColor;

varying float vU;
varying float vSide;
varying float vAlphaR;
varying vec3  vColR;
varying float vTempR;
varying float vViewDepth;
varying float vSoft;

void main() {
  float x = abs(vSide);
  float prof = 1.0 - x * x;
  // Break the ribbon's edge with noise so smoke disperses into wisps rather
  // than tapering as a clean geometric strip.
  float n = texture2D(uNoise, vec2(vU * 3.0, vSide * 0.5 + 0.5 + uTime * 0.03)).r;
  float n2 = texture2D(uNoise, vec2(vU * 8.0 - uTime * 0.07, vSide * 0.5 + 0.5)).b;
  float erode = mix(0.06, 0.62, vU);        // older sections are more torn up
  float a = smoothstep(erode, erode + 0.5, prof * (0.55 + 0.9 * n * n2 * 2.0));
  a *= vAlphaR;
  if (a < 0.004) discard;

  vec3 chroma = texture2D(uRamp, vec2(vTempR, 0.5)).rgb;
  vec3 col = vColR * (uAmbient + uKeyColor * 0.55);
  col += chroma * pow(vTempR, 2.4) * uEmissive;

  a *= vfxSoftFade(vViewDepth, vSoft);
  gl_FragColor = vec4(col * a, a);
}
`;
