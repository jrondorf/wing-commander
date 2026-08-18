/**
 * FXAA — the fallback anti-aliasing path when TAA is off (low preset, or when a
 * caller disables temporal accumulation for a still capture).
 *
 * Runs on the HDR buffer, so edge detection uses a tonemapped luma proxy rather
 * than raw luminance: an 18.0 engine core next to 0.02 space is a *huge* raw
 * delta and naive FXAA would smear the whole nozzle. `l / (1 + l)` compresses
 * that to the perceptual delta a display would actually show.
 */

export const FXAA_FRAG = /* glsl */ `
uniform sampler2D tSource;
uniform vec2 uTexel;
uniform float uEdgeThreshold;    // relative contrast to trigger on
uniform float uEdgeThresholdMin; // absolute floor, kills noise in the dark
uniform float uSubpixel;         // subpixel aliasing removal, 0..1
varying vec2 vUv;

float fxaaLuma(vec2 uv) {
  vec3 c = max(texture2D(tSource, uv).rgb, vec3(0.0));
  float l = luma(c);
  return l / (1.0 + l);
}

void main() {
  vec3 rgbM = texture2D(tSource, vUv).rgb;

  float lM  = fxaaLuma(vUv);
  float lNW = fxaaLuma(vUv + vec2(-uTexel.x, -uTexel.y));
  float lNE = fxaaLuma(vUv + vec2( uTexel.x, -uTexel.y));
  float lSW = fxaaLuma(vUv + vec2(-uTexel.x,  uTexel.y));
  float lSE = fxaaLuma(vUv + vec2( uTexel.x,  uTexel.y));

  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  float range = lMax - lMin;

  if (range < max(uEdgeThresholdMin, lMax * uEdgeThreshold)) {
    gl_FragColor = vec4(rgbM, 1.0);
    return;
  }

  vec2 dir = vec2(
    -((lNW + lNE) - (lSW + lSE)),
     ((lNW + lSW) - (lNE + lSE))
  );

  float dirReduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpDirMin, vec2(-8.0), vec2(8.0)) * uTexel;

  vec3 rgbA = 0.5 * (
    texture2D(tSource, vUv + dir * (1.0 / 3.0 - 0.5)).rgb +
    texture2D(tSource, vUv + dir * (2.0 / 3.0 - 0.5)).rgb
  );
  vec3 rgbB = rgbA * 0.5 + 0.25 * (
    texture2D(tSource, vUv + dir * -0.5).rgb +
    texture2D(tSource, vUv + dir *  0.5).rgb
  );

  float lB = luma(rgbB);
  lB = lB / (1.0 + lB);

  vec3 edge = (lB < lMin || lB > lMax) ? rgbA : rgbB;

  // Subpixel term: blend a little of the plain 3x3 average back in so isolated
  // single-pixel speculars stop strobing between frames.
  vec3 avg = 0.25 * (
    texture2D(tSource, vUv + vec2(-uTexel.x, -uTexel.y)).rgb +
    texture2D(tSource, vUv + vec2( uTexel.x, -uTexel.y)).rgb +
    texture2D(tSource, vUv + vec2(-uTexel.x,  uTexel.y)).rgb +
    texture2D(tSource, vUv + vec2( uTexel.x,  uTexel.y)).rgb
  );
  float subpix = sat(abs((lNW + lNE + lSW + lSE) * 0.25 - lM) / max(range, 1e-5));
  subpix = subpix * subpix * uSubpixel;

  gl_FragColor = vec4(max(mix(edge, avg, subpix), vec3(0.0)), 1.0);
}
`;
