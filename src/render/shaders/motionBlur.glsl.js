/**
 * Per-object motion blur — McGuire et al. "A Reconstruction Filter for Plausible
 * Motion Blur" (2012), tile-max / neighbour-max variant.
 *
 * Three stages:
 *   1. tile max      — the largest motion vector in each KxK tile, done as two
 *                      separable passes (horizontal then vertical).
 *   2. neighbour max — the largest tile vector in the 3x3 tile neighbourhood, so
 *                      a fast object bleeds blur into the still pixels it is
 *                      about to cover. Without this, a Vampire crossing the frame
 *                      has a hard-edged blur that ends exactly at its silhouette.
 *   3. reconstruct   — gather along the neighbour-max direction, weighting each
 *                      tap by depth ordering (foreground blurs over background,
 *                      never the reverse) and by whether that tap's own velocity
 *                      could plausibly have reached this pixel.
 *
 * Tuning intent: an afterburner run at 1400 m/s should streak the asteroid field
 * past the canopy convincingly, while a 250 m/s cruise leaves the frame readable.
 * That is `settings.motionBlur.intensity` (shutter fraction) — 0.6 is roughly a
 * 180-degree shutter at 60 fps.
 *
 * Defines: MB_TILE_STEPS, MB_SAMPLES.
 */

/** Separable tile max. `uDirection` is (1,0) then (0,1). */
export const TILE_MAX_FRAG = /* glsl */ `
uniform sampler2D tVelocity;
uniform vec2 uTexel;      // texel size of the SOURCE
uniform vec2 uDirection;  // (1,0) or (0,1)
varying vec2 vUv;

void main() {
  vec2 best = vec2(0.0);
  float bestLen = -1.0;
  for (int i = 0; i < MB_TILE_STEPS; i++) {
    vec2 uv = vUv + uDirection * uTexel * (float(i) - float(MB_TILE_STEPS) * 0.5 + 0.5);
    vec4 s = texture2D(tVelocity, uv);
    // Cockpit/HUD pixels (mask 0) must not contribute a tile vector, or the
    // dashboard would dictate the blur length of the space behind it.
    vec2 v = s.xy * s.a;
    float l = dot(v, v);
    if (l > bestLen) { bestLen = l; best = v; }
  }
  gl_FragColor = vec4(best, 0.0, 1.0);
}
`;

export const NEIGHBOR_MAX_FRAG = /* glsl */ `
uniform sampler2D tTiles;
uniform vec2 uTexel;
varying vec2 vUv;

void main() {
  vec2 best = vec2(0.0);
  float bestLen = -1.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 v = texture2D(tTiles, vUv + vec2(float(x), float(y)) * uTexel).xy;
      float l = dot(v, v);
      if (l > bestLen) { bestLen = l; best = v; }
    }
  }
  gl_FragColor = vec4(best, 0.0, 1.0);
}
`;

export const MOTION_BLUR_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tVelocity;
uniform sampler2D tNeighborMax;
uniform vec2 uResolution;
uniform float uIntensity;   // shutter fraction
uniform float uTime;
uniform float uDepthExtent; // relative soft-z extent, fraction of depth
varying vec2 vUv;

float softDepthCompare(float za, float zb) {
  // Relative comparison: absolute epsilons are useless when the far plane is
  // 8000 km and the subject is 400 m away.
  float extent = max(uDepthExtent * max(za, zb), 1e-7);
  return sat(1.0 - (za - zb) / extent);
}

float cone(float dist, float vlen)     { return sat(1.0 - dist / max(vlen, 1e-4)); }
float cylinder(float dist, float vlen) { return 1.0 - smoothstep(0.95 * vlen, 1.05 * vlen, dist); }

void main() {
  vec4 vc = texture2D(tVelocity, vUv);
  vec3 colorC = texture2D(tColor, vUv).rgb;

  // Cockpit and HUD: never blurred. Returning early also saves the whole gather
  // over the lower 40% of a cockpit frame, which is most of its cost.
  if (vc.a < 0.5) { gl_FragColor = vec4(colorC, 1.0); return; }

  vec2 vN = texture2D(tNeighborMax, vUv).xy * uIntensity;
  vec2 vNpx = vN * uResolution;
  float lN = length(vNpx);
  if (lN < 1.0) { gl_FragColor = vec4(colorC, 1.0); return; }

  vec2 vCenter = vc.xy * uIntensity;
  float lC = max(length(vCenter * uResolution), 0.5);
  float zC = vc.b;

  // Per-pixel jitter breaks the gather into noise instead of banding; the grain
  // pass downstream hides what is left.
  float jitter = hash12(vUv * uResolution + uTime * 37.13) - 0.5;

  float wC = 1.0 / lC;
  vec3 sum = colorC * wC;
  float wSum = wC;

  for (int i = 0; i < MB_SAMPLES; i++) {
    float t = mix(-1.0, 1.0, (float(i) + jitter + 1.0) / (float(MB_SAMPLES) + 1.0));
    vec2 offset = vN * t;
    vec2 suv = vUv + offset;

    vec4 sv = texture2D(tVelocity, suv);
    float zS = sv.b;
    float dist = length(offset * uResolution);
    float lS = max(length(sv.xy * uIntensity * uResolution), 0.5);

    float f = softDepthCompare(zC, zS); // sample is in front of us
    float b = softDepthCompare(zS, zC); // sample is behind us

    float w = f * cone(dist, lS)          // blurry foreground bleeding onto us
            + b * cone(dist, lC)          // our own blur reaching that sample
            + cylinder(dist, lS) * cylinder(dist, lC) * 2.0; // both moving alike

    w *= sv.a; // never drag a HUD pixel into the world's blur

    sum += texture2D(tColor, suv).rgb * w;
    wSum += w;
  }

  gl_FragColor = vec4(sum / max(wSum, 1e-4), 1.0);
}
`;
