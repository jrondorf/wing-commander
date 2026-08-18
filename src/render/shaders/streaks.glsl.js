/**
 * Anamorphic lens streaks.
 *
 * A wide-aperture anamorphic lens smears very bright points into a long
 * horizontal flare with a cyan-blue cast. It is a tiny effect in isolation and a
 * huge one in aggregate — it is most of why a modern space sim's engine glow and
 * star read as *photographed* rather than rendered. Kept deliberately subtle:
 * `intensity` above ~0.5 immediately looks like a JJ Abrams parody.
 *
 * Implementation is a ping-ponged horizontal Kawase blur at quarter resolution
 * with exponentially growing stride, so four passes of 9 taps reach ~600 px.
 * Per-tap tint drift gives the streak its chromatic falloff without a separate
 * dispersion pass.
 *
 * Defines: STREAK_TAPS.
 */

export const STREAK_PREFILTER_FRAG = /* glsl */ `
uniform sampler2D tSource;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uClamp;
varying vec2 vUv;

void main() {
  vec3 c = vec3(0.0);
  c += texture2D(tSource, vUv + uTexel * vec2(-0.5, -0.5)).rgb;
  c += texture2D(tSource, vUv + uTexel * vec2( 0.5, -0.5)).rgb;
  c += texture2D(tSource, vUv + uTexel * vec2(-0.5,  0.5)).rgb;
  c += texture2D(tSource, vUv + uTexel * vec2( 0.5,  0.5)).rgb;
  c = min(max(c * 0.25, vec3(0.0)), vec3(uClamp));

  // Streaks *do* want a real threshold — only genuine over-range highlights
  // (engine cores, the star, muzzle flashes) throw a lens flare. Everything else
  // would just be a horizontal smear.
  float br = maxc(c);
  float w = smoothstep(uThreshold, uThreshold * 2.0, br);
  gl_FragColor = vec4(c * w, 1.0);
}
`;

export const STREAK_BLUR_FRAG = /* glsl */ `
uniform sampler2D tSource;
uniform vec2 uTexel;
uniform float uStride;
uniform float uAttenuation;
uniform vec3 uTint;
uniform vec2 uDirection;
varying vec2 vUv;

void main() {
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  float half_ = float(STREAK_TAPS - 1) * 0.5;
  for (int i = 0; i < STREAK_TAPS; i++) {
    float fi = float(i) - half_;
    float a = abs(fi) / max(half_, 1.0);
    float w = pow(uAttenuation, abs(fi));
    vec3 tint = mix(vec3(1.0), uTint, a);
    sum += texture2D(tSource, vUv + uDirection * uTexel * (fi * uStride)).rgb * w * tint;
    wsum += w;
  }
  gl_FragColor = vec4(sum / max(wsum, 1e-4), 1.0);
}
`;
