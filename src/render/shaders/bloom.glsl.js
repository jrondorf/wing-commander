/**
 * Progressive dual-filter (Kawase) bloom.
 *
 * Marius Bjørge's "Bandwidth-Efficient Rendering" down/up kernels, run as a
 * 6-level pyramid, with Jimenez-style progressive upsampling: every up step is a
 * *lerp* between the mip and the wider blur below it, never an add. That keeps
 * the pyramid a weighted average — total energy stays at 1.0 no matter how many
 * mips are enabled, so switching quality presets changes the glow *radius*
 * without changing the exposure of the frame.
 *
 * There is no hard threshold anywhere. The prefilter is a soft knee blended back
 * towards unity by `uKneeMix`, so a 0.9-luminance cockpit readout still
 * contributes a little haze and a 26.0 engine core contributes almost all of
 * itself. Hard thresholds are what make bloom pop on and off along an edge as a
 * ship rolls — the single most obvious "this is a demo" tell.
 */

export const BLOOM_PREFILTER_FRAG = /* glsl */ `
uniform sampler2D tSource;
uniform vec2 uTexel;      // texel size of the SOURCE (full-res scene)
uniform float uKnee;      // knee centre, in max-channel units
uniform float uKneeWidth; // knee half-width; larger = softer ramp
uniform float uKneeMix;   // 0 = no filtering at all, 1 = full knee. Never 1.0.
uniform float uClamp;     // firefly clamp, in linear HDR units
varying vec2 vUv;

vec3 fetch(vec2 uv) {
  vec3 c = texture2D(tSource, uv).rgb;
  // NaN/Inf guard: one bad pixel out of a broken material would otherwise
  // propagate through the entire pyramid and white the frame out.
  c = max(c, vec3(0.0));
  c = min(c, vec3(uClamp));
  return c;
}

void main() {
  // 5-tap Karis-weighted box. The centre gets double weight so the prefilter
  // does not soften detail before the pyramid has a chance to.
  vec3 a = fetch(vUv + uTexel * vec2(-1.0, -1.0));
  vec3 b = fetch(vUv + uTexel * vec2( 1.0, -1.0));
  vec3 c = fetch(vUv + uTexel * vec2(-1.0,  1.0));
  vec3 d = fetch(vUv + uTexel * vec2( 1.0,  1.0));
  vec3 e = fetch(vUv);

  float wa = karisWeight(a), wb = karisWeight(b), wc = karisWeight(c);
  float wd = karisWeight(d), we = karisWeight(e) * 2.0;
  vec3 col = (a * wa + b * wb + c * wc + d * wd + e * we) / (wa + wb + wc + wd + we);

  float br = maxc(col);
  float soft = clamp(br - uKnee + uKneeWidth, 0.0, 2.0 * uKneeWidth);
  soft = soft * soft / (4.0 * uKneeWidth + 1e-4);
  float w = max(soft, br - uKnee) / max(br, 1e-5);
  w = mix(1.0, w, uKneeMix);

  gl_FragColor = vec4(col * w, 1.0);
}
`;

/** Dual-filter downsample: 5 taps, box+diagonal, /8. */
export const BLOOM_DOWN_FRAG = /* glsl */ `
uniform sampler2D tSource;
uniform vec2 uHalfPixel; // half a texel of the SOURCE
varying vec2 vUv;

void main() {
  vec3 sum = texture2D(tSource, vUv).rgb * 4.0;
  sum += texture2D(tSource, vUv - uHalfPixel).rgb;
  sum += texture2D(tSource, vUv + uHalfPixel).rgb;
  sum += texture2D(tSource, vUv + vec2(uHalfPixel.x, -uHalfPixel.y)).rgb;
  sum += texture2D(tSource, vUv - vec2(uHalfPixel.x, -uHalfPixel.y)).rgb;
  gl_FragColor = vec4(sum / 8.0, 1.0);
}
`;

/**
 * Dual-filter upsample: 8 taps in a tent, /12, then lerped against this level's
 * own mip by `uScatter`. Scatter *is* the bloom radius control — 0.5 keeps the
 * glow tight around the source, 0.85 throws it across the frame.
 */
export const BLOOM_UP_FRAG = /* glsl */ `
uniform sampler2D tSource;  // the smaller level below
uniform sampler2D tMip;     // this level's own downsampled mip
uniform vec2 uHalfPixel;    // half a texel of the DESTINATION
uniform float uScatter;
varying vec2 vUv;

void main() {
  vec3 s = texture2D(tSource, vUv + vec2(-uHalfPixel.x * 2.0, 0.0)).rgb;
  s += texture2D(tSource, vUv + vec2(-uHalfPixel.x,  uHalfPixel.y)).rgb * 2.0;
  s += texture2D(tSource, vUv + vec2( 0.0, uHalfPixel.y * 2.0)).rgb;
  s += texture2D(tSource, vUv + vec2( uHalfPixel.x,  uHalfPixel.y)).rgb * 2.0;
  s += texture2D(tSource, vUv + vec2( uHalfPixel.x * 2.0, 0.0)).rgb;
  s += texture2D(tSource, vUv + vec2( uHalfPixel.x, -uHalfPixel.y)).rgb * 2.0;
  s += texture2D(tSource, vUv + vec2( 0.0, -uHalfPixel.y * 2.0)).rgb;
  s += texture2D(tSource, vUv + vec2(-uHalfPixel.x, -uHalfPixel.y)).rgb * 2.0;
  s /= 12.0;

  vec3 m = texture2D(tMip, vUv).rgb;
  gl_FragColor = vec4(mix(m, s, uScatter), 1.0);
}
`;
