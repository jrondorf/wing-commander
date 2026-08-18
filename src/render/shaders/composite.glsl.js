/**
 * Final composite: bloom + streaks + shafts + lens dirt -> chromatic aberration
 * -> exposure -> ACES -> grade -> vignette -> grain -> dither -> sRGB.
 *
 * This is the only pass in the entire renderer that leaves linear space. Order
 * matters and is not arbitrary:
 *   - lens artefacts (bloom/streaks/shafts/dirt) are added in *scene-referred*
 *     linear light, because that is where they physically happen — in the lens,
 *     before the sensor.
 *   - chromatic aberration is a lens property too, so it samples the composed
 *     linear image rather than the graded one.
 *   - exposure and ACES turn scene-referred into display-referred.
 *   - the grade, vignette and grain are display-referred: a colourist's pass and
 *     two artefacts of the print.
 * Putting grain before the tone map would make it vanish in the highlights;
 * putting the vignette before it would make the corners *tone map differently*
 * from the centre, which reads as a dirty lens rather than a framing device.
 */

/**
 * Debug blit for a single intermediate target. Not part of the shipping path —
 * it exists so `settings.debug.view` can prove a stage is producing what it
 * claims (velocity buffers are unreadable without it, and "bloom looks wrong"
 * is impossible to diagnose from the composite alone).
 */
export const DEBUG_VIEW_FRAG = /* glsl */ `
uniform sampler2D tSource;
uniform float uScale;
uniform int uMode; // 0 = tonemapped colour, 1 = velocity (rg), 2 = depth (b), 3 = raw
varying vec2 vUv;
void main() {
  vec4 s = texture2D(tSource, vUv);
  vec3 c;
  if (uMode == 1)      c = vec3(0.5 + s.rg * uScale, 0.5);
  else if (uMode == 2) c = vec3(pow(sat(s.b * uScale), 0.35));
  else if (uMode == 3) c = s.rgb;
  else                 c = acesHill(max(s.rgb, vec3(0.0)) * uScale);
  gl_FragColor = vec4(encodeSrgb(c), 1.0);
}
`;

export const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tStreaks;
uniform sampler2D tGodRays;
uniform sampler2D tDirt;

uniform vec2 uResolution;
uniform float uTime;
uniform float uAspect;

uniform float uBloomIntensity;
uniform float uStreakIntensity;
uniform vec3  uStreakTint;
uniform float uGodRayIntensity;
uniform vec3  uGodRayColor;
uniform float uDirtIntensity;

uniform float uCA;          // chromatic aberration, in UV at the frame corner
uniform float uCACenterBias;

uniform float uExposure;
uniform int   uToneMode;
uniform float uWhitePoint;

uniform vec3  uLift;
uniform vec3  uInvGamma;
uniform vec3  uGain;
uniform float uContrast;
uniform float uSaturation;
uniform vec3  uShadowTint;
uniform vec3  uHighlightTint;
uniform vec3  uGlobalTint;

uniform float uGrain;
uniform float uGrainShadowBias;
uniform float uGrainSize;

uniform float uVignette;
uniform float uVignetteSmooth;
uniform float uVignetteRound;

uniform float uDither;
uniform float uSrgb;

varying vec2 vUv;

vec3 sampleScene(vec2 uv) { return max(texture2D(tScene, sat(uv)).rgb, vec3(0.0)); }
vec3 sampleBloom(vec2 uv) { return max(texture2D(tBloom, sat(uv)).rgb, vec3(0.0)); }

void main() {
  vec2 uv = vUv;
  vec2 centered = uv - 0.5;
  float r2 = dot(centered, centered) * 4.0; // 1.0 at the mid-edge, ~2 at corners

  vec3 scene;
  vec3 bloom;

  if (uCA > 0.0) {
    // Radial, strongest at the edges: the shift grows with r^2 so the middle
    // third of the frame — where the dogfight is — stays clean.
    vec2 dir = centered * (uCACenterBias + (1.0 - uCACenterBias) * r2) * uCA;
    scene.r = sampleScene(uv + dir).r;
    scene.g = sampleScene(uv).g;
    scene.b = sampleScene(uv - dir).b;
    // Bloom disperses harder than the scene — that is where CA is visible.
    bloom.r = sampleBloom(uv + dir * 1.8).r;
    bloom.g = sampleBloom(uv).g;
    bloom.b = sampleBloom(uv - dir * 1.8).b;
  } else {
    scene = sampleScene(uv);
    bloom = sampleBloom(uv);
  }

  float dirt = texture2D(tDirt, uv).r;

  vec3 color = scene;

  // Lens dirt modulates bloom rather than being pasted over the frame: the
  // smudges only light up where there is something bright to catch them.
  color += bloom * uBloomIntensity * (1.0 + dirt * uDirtIntensity);

  vec3 streak = max(texture2D(tStreaks, uv).rgb, vec3(0.0)) * uStreakTint;
  color += streak * uStreakIntensity * (1.0 + dirt * uDirtIntensity * 0.6);

  vec3 rays = max(texture2D(tGodRays, uv).rgb, vec3(0.0));
  color += rays * uGodRayIntensity * uGodRayColor;

  // ---- scene-referred -> display-referred -----------------------------------
  color *= uExposure;
  color = applyToneMap(color, uToneMode, uWhitePoint);

  color = applyGrade(
    color, uLift, uInvGamma, uGain,
    uContrast, uSaturation,
    uShadowTint, uHighlightTint, uGlobalTint
  );

  // ---- vignette -------------------------------------------------------------
  if (uVignette > 0.0) {
    vec2 p = centered;
    p.x *= mix(1.0, uAspect, uVignetteRound);
    float d = length(p) * 1.4142;
    float v = 1.0 - smoothstep(1.0 - uVignetteSmooth, 1.0 + uVignetteSmooth * 0.35, d);
    color *= mix(1.0, v, uVignette);
  }

  // ---- grain ----------------------------------------------------------------
  if (uGrain > 0.0) {
    vec2 gp = gl_FragCoord.xy / max(uGrainSize, 0.25) + vec2(uTime * 71.3, uTime * 53.7);
    float g = triNoise(gp);
    // Film has more visible grain in the toe than in the shoulder. Weighting by
    // (1 - luma) puts the noise where it belongs and keeps the star clean.
    float l = sat(luma(color));
    float w = mix(1.0, 1.0 - uGrainShadowBias, l);
    color += g * uGrain * w;
    color = max(color, vec3(0.0));
  }

  // ---- output ---------------------------------------------------------------
  if (uSrgb > 0.5) color = encodeSrgb(color);

  // Ordered-ish dither after the transfer function: 8-bit output of a smooth
  // nebula gradient bands hideously without it.
  if (uDither > 0.0) {
    color += triNoise(gl_FragCoord.xy * 0.9137 + uTime) * (uDither / 255.0);
  }

  gl_FragColor = vec4(color, 1.0);
}
`;
