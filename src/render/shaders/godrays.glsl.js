/**
 * Screen-space volumetric shafts from the system star.
 *
 * Two stages:
 *   1. mask   — quarter-res occlusion mask. Bright pixels near the star survive;
 *               anything with geometry in front of the star is forced to zero
 *               using the velocity buffer's linear depth, so a Kilrathi fighter
 *               crossing the star cuts the shafts cleanly instead of glowing
 *               through them. That depth test is the difference between "god
 *               rays" and "a radial blur someone left on".
 *   2. blur   — Kenny Mitchell's radial accumulation, run twice with different
 *               densities so the shafts reach across the frame at 2 x 12 taps
 *               instead of 1 x 48.
 *
 * `uSunVisible` is computed on the CPU and folds in: star behind the camera, star
 * off-screen (with a margin, so shafts still rake in from just outside the
 * frame), and the angle between the view direction and the star.
 *
 * Defines: GR_SAMPLES.
 */

export const GODRAY_MASK_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tVelocity;
uniform vec2 uSunUv;
uniform float uSunDepth;   // normalised linear depth of the star
uniform float uRadius;     // gaussian reach around the star, aspect-corrected UV
uniform float uThreshold;
uniform float uAspect;
uniform float uHasDepth;
uniform vec2 uSourceTexel; // texel size of tScene, which is 2-4x this target
varying vec2 vUv;

void main() {
  // The mask runs at quarter resolution against a full-res source, so a single
  // tap would miss three quarters of the star and make the shafts flicker as it
  // drifts across the pixel grid. Four taps is enough to catch it.
  vec2 o = uSourceTexel;
  vec3 c = max(texture2D(tScene, vUv + o * vec2(-1.0, -1.0)).rgb, vec3(0.0));
  c += max(texture2D(tScene, vUv + o * vec2( 1.0, -1.0)).rgb, vec3(0.0));
  c += max(texture2D(tScene, vUv + o * vec2(-1.0,  1.0)).rgb, vec3(0.0));
  c += max(texture2D(tScene, vUv + o * vec2( 1.0,  1.0)).rgb, vec3(0.0));
  c *= 0.25;

  // Soft brightness gate. Deliberately not a hard cut — the corona around the
  // star and the bright edge of a nebula both need to feed the shafts.
  float br = maxc(c);
  float m = smoothstep(uThreshold, uThreshold * 4.0 + 1e-3, br);

  // Occlusion: anything closer than the star blocks it.
  vec4 v = texture2D(tVelocity, vUv);
  float occluder = step(0.5, v.a) * step(v.b, uSunDepth * 0.92) * uHasDepth;
  m *= 1.0 - occluder;

  vec2 d = (vUv - uSunUv) * vec2(uAspect, 1.0);
  float fall = exp(-dot(d, d) / max(uRadius * uRadius, 1e-4));

  gl_FragColor = vec4(c * m * fall, 1.0);
}
`;

export const GODRAY_BLUR_FRAG = /* glsl */ `
uniform sampler2D tSource;
uniform vec2 uSunUv;
uniform float uDensity;
uniform float uDecay;
uniform float uWeight;
uniform float uExposure;
uniform vec2 uTexel;
varying vec2 vUv;

void main() {
  vec2 delta = (vUv - uSunUv) * (uDensity / float(GR_SAMPLES));

  // Dither the ray start so 12 taps do not read as 12 concentric rings.
  float jitter = hash12(vUv / max(uTexel.x, 1e-6) * vec2(1.0, 1.37));
  vec2 uv = vUv - delta * jitter;

  vec3 acc = vec3(0.0);
  float illum = uWeight;
  for (int i = 0; i < GR_SAMPLES; i++) {
    uv -= delta;
    acc += texture2D(tSource, uv).rgb * illum;
    illum *= uDecay;
  }

  gl_FragColor = vec4(acc * (uExposure / float(GR_SAMPLES)), 1.0);
}
`;
