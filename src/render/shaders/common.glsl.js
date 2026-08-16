/**
 * Shared GLSL for the post-processing stack.
 *
 * Everything here is a plain exported template string so passes can compose the
 * pieces they need. All chunks are guarded with `#ifndef` so a shader can include
 * the same chunk twice without a redefinition error.
 *
 * Naming discipline: three.js injects `luminance()`, `linearToOutputTexel()`,
 * `sRGBTransferOETF/EOTF()` and `LinearTransferOETF()` into every non-raw
 * ShaderMaterial fragment prefix. Nothing in here may reuse those names — hence
 * `luma()`, `encodeSrgb()` and friends.
 */

/**
 * Full-screen triangle vertex shader.
 *
 * Paired with the 3-vertex geometry built in PostProcessing.js: one oversized
 * triangle instead of two triangles, so the diagonal seam never splits a
 * derivative-using quad and we shade ~10% fewer helper lanes.
 */
export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Scalar/vector helpers, colour space conversions, hashing. */
export const GLSL_COMMON = /* glsl */ `
#ifndef WC_COMMON_INCLUDED
#define WC_COMMON_INCLUDED

float sat(float x) { return clamp(x, 0.0, 1.0); }
vec2  sat(vec2  x) { return clamp(x, 0.0, 1.0); }
vec3  sat(vec3  x) { return clamp(x, 0.0, 1.0); }

// Rec.709 luma. Named `luma` because three.js already injects `luminance`.
float luma(vec3 c) { return dot(c, vec3(0.2126729, 0.7151522, 0.0721750)); }
float maxc(vec3 c) { return max(c.r, max(c.g, c.b)); }

// Karis' tonemapped weight — stops one 30x emissive pixel from owning a whole
// downsample tap and boiling into a firefly.
float karisWeight(vec3 c) { return 1.0 / (1.0 + luma(c)); }

// YCoCg is the right space for TAA neighbourhood clipping: the chroma axes are
// decorrelated, so a clip box in YCoCg keeps hue stable where an RGB box shifts it.
vec3 rgb2ycocg(vec3 c) {
  return vec3(
     0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
     0.50 * c.r             - 0.50 * c.b,
    -0.25 * c.r + 0.5 * c.g - 0.25 * c.b
  );
}
vec3 ycocg2rgb(vec3 c) {
  float t = c.x - c.z;
  return vec3(t + c.y, c.x + c.z, t - c.y);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

// Triangular PDF noise in [-1,1]. Film grain and dither both want a triangular
// distribution rather than a uniform one — uniform noise reads as digital hash,
// triangular reads as emulsion.
float triNoise(vec2 p) { return hash12(p) + hash12(p + 17.317) - 1.0; }

vec3 encodeSrgb(vec3 c) {
  c = max(c, vec3(0.0));
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

vec3 decodeSrgb(vec3 c) {
  c = max(c, vec3(0.0));
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}

// Perceptual weight used when blending HDR samples: without it a single bright
// tap drags the average and produces the classic TAA/blur "comet" artefact.
vec3 hdrWeightIn(vec3 c)  { return c / (1.0 + luma(c)); }
vec3 hdrWeightOut(vec3 c) { return c / max(1e-5, 1.0 - luma(c)); }

#endif
`;

/**
 * Bicubic (Catmull-Rom) texture fetch, 9 taps via 5 bilinear samples.
 *
 * TAA history resampling with plain bilinear loses a little energy every frame
 * and the image creeps towards mush; Catmull-Rom keeps it crisp. Gated behind a
 * define so the medium preset can drop back to bilinear.
 */
export const GLSL_CATMULL_ROM = /* glsl */ `
#ifndef WC_CATMULL_INCLUDED
#define WC_CATMULL_INCLUDED
vec3 sampleCatmullRom(sampler2D tex, vec2 uv, vec2 texSize) {
  vec2 samplePos = uv * texSize;
  vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - texPos1;

  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);

  vec2 w12 = w1 + w2;
  vec2 offset12 = w2 / max(w12, vec2(1e-5));

  vec2 texPos0 = (texPos1 - 1.0) / texSize;
  vec2 texPos3 = (texPos1 + 2.0) / texSize;
  vec2 texPos12 = (texPos1 + offset12) / texSize;

  vec3 result = vec3(0.0);
  result += texture2D(tex, vec2(texPos0.x,  texPos0.y)).rgb  * w0.x  * w0.y;
  result += texture2D(tex, vec2(texPos12.x, texPos0.y)).rgb  * w12.x * w0.y;
  result += texture2D(tex, vec2(texPos3.x,  texPos0.y)).rgb  * w3.x  * w0.y;

  result += texture2D(tex, vec2(texPos0.x,  texPos12.y)).rgb * w0.x  * w12.y;
  result += texture2D(tex, vec2(texPos12.x, texPos12.y)).rgb * w12.x * w12.y;
  result += texture2D(tex, vec2(texPos3.x,  texPos12.y)).rgb * w3.x  * w12.y;

  result += texture2D(tex, vec2(texPos0.x,  texPos3.y)).rgb  * w0.x  * w3.y;
  result += texture2D(tex, vec2(texPos12.x, texPos3.y)).rgb  * w12.x * w3.y;
  result += texture2D(tex, vec2(texPos3.x,  texPos3.y)).rgb  * w3.x  * w3.y;

  return max(result, vec3(0.0));
}
#endif
`;
