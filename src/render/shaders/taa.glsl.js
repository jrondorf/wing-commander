/**
 * Temporal anti-aliasing with velocity reprojection and neighbourhood clipping.
 *
 * The camera projection is jittered on a Halton(2,3) sequence, so each frame
 * samples a different sub-pixel position; this pass accumulates them. On top of
 * the 4x MSAA in the HDR target that gives clean geometric edges *and* stable
 * speculars — the thing MSAA alone cannot do, and the thing that makes a hull's
 * roughness variation stop crawling when the ship rolls.
 *
 * History rejection is variance clipping in YCoCg (Salvi/Karis): build the mean
 * and standard deviation of the 3x3 neighbourhood, clip the reprojected history
 * to that ellipsoid. Compared to a min/max AABB it keeps far more history on
 * still frames (less flicker) while still cutting ghosting behind a fast ship.
 *
 * Defines: TAA_CATMULL (bicubic history fetch), TAA_SHARPEN.
 */

export const TAA_FRAG = /* glsl */ `
uniform sampler2D tCurrent;   // this frame's jittered HDR scene
uniform sampler2D tHistory;   // last frame's resolved output
uniform sampler2D tVelocity;
uniform vec2 uTexel;          // 1 / resolution
uniform vec2 uResolution;
uniform vec2 uJitterDelta;    // (prevJitter - curJitter) * 0.5, in UV
uniform float uFeedbackMin;   // history weight when moving fast
uniform float uFeedbackMax;   // history weight when still
uniform float uVarianceGamma; // clip box width in standard deviations
uniform float uVelocityWeight;
uniform float uSharpen;
varying vec2 vUv;

// Dilate the motion vector towards the closest fragment in the 3x3 tap set.
// Without this, silhouette pixels reproject with the *background's* vector and
// leave a one-pixel ghost trail hanging off every wingtip.
vec3 closestVelocity(vec2 uv) {
  vec4 c0 = texture2D(tVelocity, uv);
  vec3 best = vec3(c0.xy, c0.z);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y)) * uTexel;
      vec4 s = texture2D(tVelocity, uv + o);
      if (s.z < best.z) best = vec3(s.xy, s.z);
    }
  }
  return best;
}

vec3 clipToAABB(vec3 history, vec3 minC, vec3 maxC) {
  vec3 center = 0.5 * (maxC + minC);
  vec3 extent = 0.5 * (maxC - minC) + 1e-5;
  vec3 offset = history - center;
  vec3 ratio = abs(offset / extent);
  float m = max(ratio.x, max(ratio.y, ratio.z));
  return m > 1.0 ? center + offset / m : history;
}

void main() {
  vec3 current = max(texture2D(tCurrent, vUv).rgb, vec3(0.0));

  vec3 vel = closestVelocity(vUv);
  vec2 prevUv = vUv - vel.xy + uJitterDelta;

  // Off-screen history is worthless — a newly revealed edge must take the
  // current sample whole rather than smear whatever used to be at the border.
  bool valid = prevUv.x > 0.0 && prevUv.x < 1.0 && prevUv.y > 0.0 && prevUv.y < 1.0;

  #ifdef TAA_CATMULL
    vec3 history = valid ? sampleCatmullRom(tHistory, prevUv, uResolution) : current;
  #else
    vec3 history = valid ? max(texture2D(tHistory, prevUv).rgb, vec3(0.0)) : current;
  #endif

  // --- neighbourhood statistics, YCoCg, tonemap-weighted ---------------------
  vec3 m1 = vec3(0.0);
  vec3 m2 = vec3(0.0);
  vec3 nmin = vec3(1e9);
  vec3 nmax = vec3(-1e9);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y)) * uTexel;
      vec3 c = rgb2ycocg(hdrWeightIn(max(texture2D(tCurrent, vUv + o).rgb, vec3(0.0))));
      m1 += c;
      m2 += c * c;
      nmin = min(nmin, c);
      nmax = max(nmax, c);
    }
  }
  vec3 mean = m1 / 9.0;
  vec3 sigma = sqrt(max(m2 / 9.0 - mean * mean, vec3(0.0)));
  vec3 lo = max(mean - uVarianceGamma * sigma, nmin);
  vec3 hi = min(mean + uVarianceGamma * sigma, nmax);

  vec3 histW = rgb2ycocg(hdrWeightIn(history));
  histW = clipToAABB(histW, lo, hi);
  history = hdrWeightOut(ycocg2rgb(histW));

  // --- blend ----------------------------------------------------------------
  float speed = length(vel.xy * uResolution);
  float feedback = mix(uFeedbackMax, uFeedbackMin, sat(speed * uVelocityWeight));
  if (!valid) feedback = 0.0;

  // Karis' weighted average: blend in tonemapped space so a 20.0 engine core
  // does not out-vote 8 neighbours and leave a comet behind it.
  vec3 cw = hdrWeightIn(current);
  vec3 hw = hdrWeightIn(history);
  vec3 result = hdrWeightOut(mix(cw, hw, feedback));

  #ifdef TAA_SHARPEN
    // Cheap unsharp against the cross neighbourhood; TAA always costs a touch of
    // acutance and this hands it back without ringing on HDR edges.
    vec3 blur =
      texture2D(tCurrent, vUv + vec2( uTexel.x, 0.0)).rgb +
      texture2D(tCurrent, vUv + vec2(-uTexel.x, 0.0)).rgb +
      texture2D(tCurrent, vUv + vec2(0.0,  uTexel.y)).rgb +
      texture2D(tCurrent, vUv + vec2(0.0, -uTexel.y)).rgb;
    result += (current - blur * 0.25) * uSharpen;
  #endif

  gl_FragColor = vec4(max(result, vec3(0.0)), 1.0);
}
`;
