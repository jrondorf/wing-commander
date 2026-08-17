/**
 * Velocity (motion vector) G-buffer.
 *
 * Layout, RGBA16F:
 *   .rg  screen-space motion for this frame, in UV units, jitter-free
 *   .b   linear view depth normalised by `camera.far`, so 0 = eye, 1 = far plane
 *   .a   motion-blur mask: 1 = world geometry, 0 = cockpit/HUD
 *
 * The mask is what keeps the HUD out of the blur. Cockpit geometry is rigidly
 * parented to the camera, so its true motion vector is ~0 anyway — but the
 * *reconstruction* filter gathers from neighbours, and without an explicit mask a
 * fast-moving starfield behind a HUD bracket would smear straight through it.
 *
 * `gl_Position` deliberately uses three's jittered `projectionMatrix` so this
 * buffer lines up pixel-for-pixel with the jittered colour buffer, while the
 * stored vector is computed from unjittered view-projection matrices so TAA gets
 * a clean geometric reprojection.
 */

export const VELOCITY_VERT = /* glsl */ `
uniform mat4 uPrevModelMatrix;
uniform mat4 uCurrViewProj;
uniform mat4 uPrevViewProj;

varying vec4 vCurClip;
varying vec4 vPrevClip;
varying float vViewDepth;

void main() {
  vec4 op = vec4(position, 1.0);

  #ifdef USE_INSTANCING
    // Instances are assumed rigid between frames — per-instance history would
    // cost a second instanceMatrix buffer for a difference nobody sees on a
    // tumbling asteroid at 3 km.
    op = instanceMatrix * op;
  #endif

  vec4 worldCur  = modelMatrix     * op;
  vec4 worldPrev = uPrevModelMatrix * op;

  vCurClip  = uCurrViewProj * worldCur;
  vPrevClip = uPrevViewProj * worldPrev;

  vec4 mv = modelViewMatrix * op;
  vViewDepth = -mv.z;

  gl_Position = projectionMatrix * mv;
}
`;

export const VELOCITY_FRAG = /* glsl */ `
uniform float uMaxVelocity; // clamp in UV units — stops a 1600 m/s pass-by from
                            // asking the reconstruction filter for a 900 px tap
uniform float uMask;
uniform float uInvFar;
uniform float uVelocityScale;

varying vec4 vCurClip;
varying vec4 vPrevClip;
varying float vViewDepth;

void main() {
  vec2 v = vec2(0.0);
  if (vCurClip.w > 0.0 && vPrevClip.w > 0.0) {
    vec2 c = vCurClip.xy / vCurClip.w;
    vec2 p = vPrevClip.xy / vPrevClip.w;
    v = (c - p) * 0.5 * uVelocityScale; // NDC delta -> UV delta
    float l = length(v);
    if (l > uMaxVelocity) v *= uMaxVelocity / l;
  }
  gl_FragColor = vec4(v, clamp(vViewDepth * uInvFar, 0.0, 1.0), uMask);
}
`;

/**
 * Background/sky velocity.
 *
 * Written full-screen before the geometry pass. Anything the depth test does not
 * overwrite — a `scene.background` cubemap, or plain empty space — still needs a
 * motion vector, otherwise a hard roll leaves the nebula razor sharp while every
 * ship in front of it streaks, which reads as a bug instantly.
 *
 * Rotation only: the view matrix has its translation column zeroed, so this is
 * the motion of a point at infinity.
 */
export const VELOCITY_BACKGROUND_FRAG = /* glsl */ `
uniform mat4 uInvViewProjRot;
uniform mat4 uPrevViewProjRot;
uniform float uMaxVelocity;
uniform float uVelocityScale;
varying vec2 vUv;

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 h = uInvViewProjRot * vec4(ndc, 1.0, 1.0);
  vec3 dir = h.xyz / h.w;

  vec2 v = vec2(0.0);
  vec4 pc = uPrevViewProjRot * vec4(dir, 0.0);
  if (pc.w > 0.0) {
    vec2 p = pc.xy / pc.w;
    v = (ndc - p) * 0.5 * uVelocityScale;
    float l = length(v);
    if (l > uMaxVelocity) v *= uMaxVelocity / l;
  }
  gl_FragColor = vec4(v, 1.0, 1.0);
}
`;
