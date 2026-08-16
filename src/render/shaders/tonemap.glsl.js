/**
 * Tone mapping and colour grading.
 *
 * The world renders linear with no clamping — engine cores sit at 4–30, the star
 * far above that. Exactly one place in the frame converts that to display range,
 * and this is it.
 *
 * Two ACES fits are provided:
 *   `acesHill`      — Stephen Hill's full RRT+ODT fit with the AP0/AP1 matrices.
 *                     Correct hue rotation on over-range colours: an orange
 *                     fireball at 12.0 goes to white *through* yellow, which is
 *                     what makes explosions read as hot rather than as clipped
 *                     orange. This is the default.
 *   `acesNarkowicz` — Krzysztof Narkowicz's cheap curve fit. Slightly punchier
 *                     shadows, half the ALU, no matrix transforms. Low preset.
 */

export const GLSL_TONEMAP = /* glsl */ `
#ifndef WC_TONEMAP_INCLUDED
#define WC_TONEMAP_INCLUDED

// sRGB/Rec.709 primaries -> ACEScg (AP1). Column-major, so these read
// transposed relative to the HLSL originals.
const mat3 WC_ACES_INPUT = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777
);

const mat3 WC_ACES_OUTPUT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602
);

vec3 wcRRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 acesHill(vec3 color) {
  color = WC_ACES_INPUT * max(color, vec3(0.0));
  color = wcRRTAndODTFit(color);
  color = WC_ACES_OUTPUT * color;
  return clamp(color, 0.0, 1.0);
}

vec3 acesNarkowicz(vec3 x) {
  x = max(x, vec3(0.0));
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// Reinhard with a white point — kept only as an escape hatch for debugging an
// over-bright pass, never shipped as the default look.
vec3 reinhardWhite(vec3 x, float w) {
  x = max(x, vec3(0.0));
  return sat((x * (1.0 + x / (w * w))) / (1.0 + x));
}

vec3 applyToneMap(vec3 c, int mode, float whitePoint) {
  if (mode == 0) return sat(c);
  if (mode == 1) return acesNarkowicz(c);
  if (mode == 3) return reinhardWhite(c, whitePoint);
  return acesHill(c);
}
#endif
`;

/**
 * Lift / gamma / gain grade plus split toning.
 *
 * Runs *after* the tone map, in display-referred space, which is where a
 * colourist actually works. `uGradeShadow`/`uGradeHighlight` are the per-mission
 * "LUT-ish" tint — a K-class amber system pushes highlights warm and shadows
 * into blue-green, a nebula mission pushes both towards magenta. Cheaper than a
 * 3D LUT and it costs no texture bandwidth.
 */
export const GLSL_GRADE = /* glsl */ `
#ifndef WC_GRADE_INCLUDED
#define WC_GRADE_INCLUDED
vec3 applyGrade(
  vec3 c,
  vec3 lift, vec3 invGamma, vec3 gain,
  float contrast, float saturation,
  vec3 shadowTint, vec3 highlightTint, vec3 globalTint
) {
  c = max(c, vec3(0.0));

  // Contrast around the 18% grey pivot — pivoting on 0.5 crushes mid-shadows.
  c = (c - 0.18) * contrast + 0.18;
  c = max(c, vec3(0.0));

  // ASC-CDL ordering: slope (gain), offset (lift), power (gamma).
  c = c * gain + lift;
  c = pow(max(c, vec3(0.0)), invGamma);

  // Split tone before saturation so the tint survives a desaturating grade.
  float l = sat(luma(c));
  c *= mix(shadowTint, highlightTint, smoothstep(0.06, 0.72, l));

  float lg = luma(c);
  c = mix(vec3(lg), c, saturation);

  return max(c * globalTint, vec3(0.0));
}
#endif
`;
