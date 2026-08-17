/**
 * Canopy transparency.
 *
 * Three things have to be true at once or the canopy reads as a coloured film:
 *
 *  1. **It tints and it absorbs.** Premultiplied custom blending, so the shader
 *     controls absorption (alpha) and emission (rgb) independently. Gold-film
 *     coating gives a faint blue-green cast that deepens toward grazing angles.
 *  2. **The star smears on it.** A tight specular core plus a wide anisotropic
 *     smear stretched along the wipe direction and broken up by a streak field —
 *     canopies are polished plastic, not optical glass, and the star always
 *     leaves a dirty comet on them.
 *  3. **It reflects the dashboard.** The reflection vector is intersected with
 *     the real instrument-panel plane and used to sample the *actual* cockpit
 *     emissive atlas, so the backlit legends and the two MFDs appear upside-down
 *     in the glass exactly where geometry says they should. This is the single
 *     detail that sells the whole cockpit, so it is done properly rather than
 *     faked with a gradient.
 */

import * as THREE from 'three';
import { PANEL, MFD } from './layout.js';
import { uvRect } from './atlas.js';
import { panelPoint, panelNormal } from './geometry.js';

const VERT = /* glsl */`
varying vec3 vLocal;
varying vec3 vLocalN;
varying vec3 vWorld;
varying vec3 vWorldN;
void main() {
  vLocal  = position;
  vLocalN = normalize(normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld  = wp.xyz;
  vWorldN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FRAG = /* glsl */`
precision highp float;

uniform vec3  uLocalEye;
uniform vec3  uTint;
uniform float uBaseAlpha;
uniform vec3  uStarDir;      // world space, from the cockpit toward the star
uniform vec3  uStarColor;
uniform float uStarPower;
uniform float uSmear;
uniform vec3  uPanelOrigin;  // cockpit space
uniform vec3  uPanelN;
uniform vec3  uPanelU;
uniform vec3  uPanelV;
uniform vec2  uPanelSize;
uniform sampler2D uEmissive;
uniform vec4  uEmissiveRect; // u0,v0,u1,v1 of the 'main' atlas region
uniform vec3  uMfdLeft;
uniform vec3  uMfdRight;
uniform vec2  uMfdCentre;    // panel-space |x|, y
uniform float uMfdHalf;
uniform float uReflect;
uniform vec3  uEnvTint;
uniform float uTime;
uniform float uGrime;

varying vec3 vLocal;
varying vec3 vLocalN;
varying vec3 vWorld;
varying vec3 vWorldN;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
/** Arc-shaped wipe streaks: the polish marks a canopy actually carries. */
float streaks(vec2 p) {
  float r = length(p * vec2(1.0, 1.55)) * 7.0;
  float a = atan(p.y, p.x);
  float s = vnoise(vec2(a * 5.0, r * 1.4)) * 0.6 + vnoise(vec2(a * 13.0, r * 3.1)) * 0.4;
  return s;
}

void main() {
  vec3 V = normalize(vLocal - uLocalEye);          // eye -> fragment, cockpit space
  vec3 N = normalize(vLocalN);
  if (dot(N, V) > 0.0) N = -N;                     // always face the pilot
  vec3 Nw = normalize(vWorldN);
  vec3 Vw = normalize(vWorld - cameraPosition);
  if (dot(Nw, Vw) > 0.0) Nw = -Nw;

  float ndv = clamp(dot(N, -V), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 4.0);

  // ---- surface grime, in the plane of the canopy -------------------------
  vec2 sp = vec2(vLocal.x, vLocal.z + 1.3);
  float sm = streaks(sp);
  float dust = vnoise(sp * 46.0) * 0.5 + vnoise(sp * 130.0) * 0.5;
  float grime = mix(1.0, 0.45 + sm * 1.25, uGrime);

  // ---- star: tight core + long anisotropic smear -------------------------
  vec3 Rw = reflect(Vw, Nw);
  float sd = max(dot(Rw, uStarDir), 0.0);
  float core = pow(sd, uStarPower);
  // Stretch the lobe horizontally by measuring the angular offset with the
  // vertical component scaled up — a cheap anisotropic highlight.
  vec3 d = Rw - uStarDir * sd;
  float stretched = 1.0 - clamp(length(d * vec3(0.34, 2.3, 0.34)) * 2.2, 0.0, 1.0);
  float smear = pow(max(stretched, 0.0), 2.0) * uSmear;
  vec3 spec = uStarColor * (core * 1.6 + smear * (0.35 + sm * 0.9) * grime);
  // Dust catches the light in a broad haze around the reflection.
  spec += uStarColor * pow(sd, 3.0) * dust * 0.05 * uGrime;

  // ---- dashboard reflection ---------------------------------------------
  vec3 R = reflect(V, N);
  vec3 refl = vec3(0.0);
  float denom = dot(R, uPanelN);
  if (denom < -1e-4) {
    float t = dot(uPanelOrigin - vLocal, uPanelN) / denom;
    if (t > 0.0 && t < 4.0) {
      vec3 hit = vLocal + R * t;
      vec3 rel = hit - uPanelOrigin;
      float px = dot(rel, uPanelU);
      float py = dot(rel, uPanelV);
      vec2 pn = vec2(px / uPanelSize.x + 0.5, py / uPanelSize.y + 0.5);
      if (pn.x > 0.0 && pn.x < 1.0 && pn.y > 0.0 && pn.y < 1.0) {
        vec2 auv = mix(uEmissiveRect.xy, uEmissiveRect.zw, pn);
        refl += texture2D(uEmissive, auv).rgb * 2.6;
        // The two MFDs are separate meshes, so their light is added by hand
        // from the average colour the displays are actually showing.
        float dl = length((vec2(px, py) - vec2(-uMfdCentre.x, uMfdCentre.y)) / uMfdHalf);
        float dr = length((vec2(px, py) - vec2( uMfdCentre.x, uMfdCentre.y)) / uMfdHalf);
        refl += uMfdLeft  * smoothstep(1.35, 0.15, dl);
        refl += uMfdRight * smoothstep(1.35, 0.15, dr);
        // Falls off with reflection distance and hardens at grazing angles.
        refl *= (0.35 + fres * 1.5) / (1.0 + t * t * 0.55);
      }
    }
  }
  refl *= uReflect * grime;

  // ---- assemble ----------------------------------------------------------
  float alpha = clamp(uBaseAlpha + fres * 0.26 + dust * 0.012, 0.0, 0.85);
  vec3 body = uTint * alpha;
  vec3 env = uEnvTint * (0.25 + fres * 1.2) * 0.09;
  vec3 col = body + env + refl + spec;
  // Emission raises coverage a little so a blown highlight is not see-through.
  alpha = clamp(alpha + max(max(spec.r, spec.g), spec.b) * 0.25, 0.0, 1.0);

  gl_FragColor = vec4(col, alpha);
}`;

/**
 * @param {THREE.Texture} emissiveMap the cockpit atlas emissive channel
 */
export function createCanopyGlassMaterial(engine, { emissiveMap } = {}) {
  const r = uvRect('main');
  const origin = panelPoint(0, 0, 0);
  const n = panelNormal();
  const u = new THREE.Vector3(1, 0, 0);
  const v = new THREE.Vector3(0, 1, 0).applyMatrix4(new THREE.Matrix4().makeRotationX(PANEL.tilt)).normalize();

  const mat = new THREE.ShaderMaterial({
    name: 'cockpit-canopy',
    uniforms: {
      uLocalEye: { value: new THREE.Vector3(0, 0, 0) },
      uTint: { value: new THREE.Color(0.055, 0.085, 0.10) },
      uBaseAlpha: { value: 0.055 },
      uStarDir: { value: new THREE.Vector3(0.6, 0.4, -0.7).normalize() },
      uStarColor: { value: new THREE.Color(0.82, 0.88, 1.0) },
      uStarPower: { value: 260 },
      uSmear: { value: 0.55 },
      uPanelOrigin: { value: origin },
      uPanelN: { value: n },
      uPanelU: { value: u },
      uPanelV: { value: v },
      uPanelSize: { value: new THREE.Vector2(PANEL.w, PANEL.h) },
      uEmissive: { value: emissiveMap ?? null },
      uEmissiveRect: { value: new THREE.Vector4(r.u0, r.v0, r.u1, r.v1) },
      uMfdLeft: { value: new THREE.Color(0.10, 0.24, 0.34) },
      uMfdRight: { value: new THREE.Color(0.32, 0.19, 0.06) },
      uMfdCentre: { value: new THREE.Vector2(Math.abs(MFD.leftX), MFD.y) },
      uMfdHalf: { value: MFD.size * 0.5 },
      uReflect: { value: 1.0 },
      uEnvTint: { value: new THREE.Color(0.32, 0.42, 0.62) },
      uTime: { value: 0 },
      uGrime: { value: 0.85 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    toneMapped: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  void engine;
  return mat;
}
