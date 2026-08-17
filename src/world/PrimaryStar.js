import * as THREE from 'three';
import { NOISE_GLSL } from './glsl/noise.glsl.js';

/**
 * The system primary — hard key light and the anchor for god rays.
 *
 * The disc is an impostor, but a physically-shaped one: Eddington limb darkening
 * (I = 1 - u(1 - μ)) over a granulation field evaluated on the *sphere* rather
 * than on the flat billboard, so the cells compress toward the limb the way real
 * convection cells do. On top of that sit faculae along the granule lanes,
 * slow-drifting spot groups, a thin bright chromosphere at the limb, and a
 * corona with angular streamers.
 *
 * Everything is emitted well above 1.0 — this is the brightest thing in the game
 * and the post stack's bloom and radial occlusion pass both key off it.
 */

const STAR_DISTANCE = 3.0e6;

const STAR_VERT = /* glsl */ `
uniform float uSize;
varying vec2 vP;

void main() {
  // View-space billboard: the quad always faces the camera exactly.
  vec3 centre = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vP = position.xy;
  gl_Position = projectionMatrix * vec4(centre + vec3(position.xy * uSize, 0.0), 1.0);
}
`;

const STAR_FRAG = /* glsl */ `
precision highp float;
varying vec2 vP;

uniform float uTime;
uniform float uDisc;      // disc radius as a fraction of the quad half-size
uniform float uLimbU;     // limb-darkening coefficient
uniform vec3  uCore;      // photosphere HDR colour
uniform vec3  uChromo;    // chromosphere ring colour
uniform vec3  uGlow;      // corona colour

${NOISE_GLSL}

void main() {
  vec2 uv = vP;
  float r = length(uv);
  if (r > 1.0) discard;

  float inside = smoothstep(uDisc * 1.012, uDisc * 0.982, r);

  vec3 col = vec3(0.0);

  if (inside > 0.001) {
    float rr = min(r / uDisc, 1.0);
    float mu = sqrt(max(0.0, 1.0 - rr * rr));
    vec3 sp = normalize(vec3(uv / uDisc, mu));

    // Slow rotation of the photosphere.
    float a = uTime * 0.014;
    float ca = cos(a), sa = sin(a);
    vec3 spr = vec3(sp.x * ca + sp.z * sa, sp.y, -sp.x * sa + sp.z * ca);

    float gran = wcFbm(spr * 27.0 + uTime * 0.055, 4) * 0.5 + 0.5;
    float superg = wcFbm(spr * 7.5 - uTime * 0.018, 3) * 0.5 + 0.5;
    float faculae = wcRidged(spr * 16.0, 3, 1.0);
    float spots = smoothstep(0.71, 0.89, wcFbm(spr * 4.4 + 61.0, 3) * 0.5 + 0.5);

    float limb = 1.0 - uLimbU * (1.0 - mu);
    float surf = limb * (0.80 + 0.30 * gran + 0.18 * superg);
    surf *= 1.0 + 0.30 * faculae * (1.0 - mu);
    surf *= 1.0 - 0.55 * spots;

    // Chromosphere: a thin hot rim right at the limb.
    float chromo = pow(rr, 16.0);
    col += uCore * surf + uChromo * chromo * 1.2;
  }

  if (inside < 0.999) {
    float t = max(0.0, (r - uDisc) / max(1e-3, 1.0 - uDisc));
    float ang = atan(uv.y, uv.x);
    float streamer = 0.50 + 0.85 * (wcFbm(vec3(cos(ang) * 2.3, sin(ang) * 2.3, uTime * 0.012), 3) * 0.5 + 0.5);
    float corona = (exp(-t * 4.4) * 0.42 + exp(-t * 15.0) * 1.05) * streamer;
    col += uGlow * corona * (1.0 - inside);
  }

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

/**
 * @returns {{ object3D: THREE.Object3D, light: THREE.DirectionalLight, rimLight: THREE.DirectionalLight,
 *             screenPosition: THREE.Vector3, applyPreset: Function, update: Function, dispose: Function }}
 */
export function createPrimaryStar(engine) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSize: { value: 1 },
      uTime: { value: 0 },
      uDisc: { value: 0.14 },
      uLimbU: { value: 0.62 },
      uCore: { value: new THREE.Vector3(18, 16, 13) },
      uChromo: { value: new THREE.Vector3(9, 3.4, 2.0) },
      uGlow: { value: new THREE.Vector3(2.2, 1.9, 1.6) },
    },
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    transparent: true,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -6;
  mesh.name = 'primary-star';

  const light = new THREE.DirectionalLight(0xffffff, 4.5);
  light.name = 'key';
  const rimLight = new THREE.DirectionalLight(0xffffff, 0.6);
  rimLight.name = 'rim';

  const direction = new THREE.Vector3(0, 0, -1);
  // Camera basis + result for the rim kicker, reused every frame — see aimRim().
  const _rimFwd = new THREE.Vector3();
  const _rimSide = new THREE.Vector3();
  const _rimUp = new THREE.Vector3();
  const _rimDir = new THREE.Vector3();
  const worldPosition = new THREE.Vector3();
  const screenPosition = new THREE.Vector3(0.5, 0.5, -1);
  const screenNDC = new THREE.Vector3();
  const colorLinear = new THREE.Color(1, 1, 1);

  /**
   * Aim the rim light.
   *
   * A rim exists to draw a bright line along the edge where the hull meets the
   * background, and "the edge" is a property of *where the viewer is*, not of where
   * the star is. A world-fixed back light therefore only rims correctly from one
   * camera position and reads as a weak second key from every other — which is what
   * the previous fixed `-direction + (0.55, 0.42)` did: measured against the hero
   * framing it sat 74° off the view axis, on the camera's own side of the subject,
   * lighting surfaces the key was already lighting instead of grazing the silhouette.
   *
   * So it is rebuilt from the camera basis each frame: pushed to the far side of the
   * subject (~140° off the view axis, the classic kicker angle — far enough back that
   * broad surfaces get nothing and only the turning edge catches it, near enough that
   * Lambert still delivers ~0.67 of full irradiance right at the silhouette), lifted,
   * and thrown to whichever side the key is *not* on so the two never merge.
   *
   * It stays a rim, not a light source: intensity is pinned to 15 % of key in
   * applyPreset and never touched here.
   */
  function aimRim(camera) {
    if (camera) _rimFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    else if (_rimFwd.lengthSq() < 1e-6) _rimFwd.copy(direction).negate();

    _rimSide.crossVectors(_rimFwd, WORLD_UP);
    // Straight up or straight down the world axis leaves no side vector; any
    // perpendicular will do at that point.
    if (_rimSide.lengthSq() < 1e-8) _rimSide.set(1, 0, 0);
    _rimSide.normalize();
    _rimUp.crossVectors(_rimSide, _rimFwd).normalize();

    const awayFromKey = _rimSide.dot(direction) >= 0 ? -1 : 1;
    _rimDir.copy(_rimFwd).multiplyScalar(0.78)
      .addScaledVector(_rimUp, 0.42)
      .addScaledVector(_rimSide, 0.46 * awayFromKey)
      .normalize();
    rimLight.position.copy(_rimDir).multiplyScalar(1e5);
  }

  const api = {
    object3D: mesh,
    light,
    rimLight,
    /** Screen-space position of the star: x,y in [0,1] UV (y up), z>0 when in front. */
    screenPosition,
    /** Same point in NDC ([-1,1]) for passes that prefer clip space. */
    screenNDC,
    /** Unit world-space direction from the camera to the star. */
    direction,
    worldPosition,
    color: colorLinear,
    intensity: 4.5,
    /** True when the star is in front of the camera and inside the frustum. */
    onScreen: false,
    /** Angular radius of the disc, radians. */
    angularRadius: 0.01,

    applyPreset(preset) {
      const s = preset.star;
      direction.copy(s.dir).normalize();
      const c = new THREE.Color(s.color[0], s.color[1], s.color[2]);
      colorLinear.copy(c);
      light.color.copy(c);
      light.intensity = s.intensity;
      api.intensity = s.intensity;
      rimLight.color.setRGB(s.rim[0], s.rim[1], s.rim[2]);
      // Bible §7 wants the back light at 8–15 % of key. That ratio is of *radiance*,
      // so the rim colour counts: an intensity factor alone, multiplied by a rim
      // triple peaking at 0.6, quietly delivered 8 % in one channel and 2 % in the
      // others. Normalise the colour out of it and set the ratio directly.
      const rimPeak = Math.max(0.2, s.rim[0], s.rim[1], s.rim[2]);
      rimLight.intensity = (s.intensity * 0.15) / rimPeak;

      // Key from the star. The rim's *direction* is not set here — see update().
      light.position.copy(direction).multiplyScalar(1e5);
      light.target.position.set(0, 0, 0);
      rimLight.target.position.set(0, 0, 0);
      aimRim();

      api.angularRadius = s.angular;
      const coronaScale = 7.5;
      const discRadius = STAR_DISTANCE * Math.tan(s.angular);
      material.uniforms.uSize.value = discRadius * coronaScale;
      material.uniforms.uDisc.value = 1 / coronaScale;

      // Photosphere brightness scales inversely with apparent size so a red giant
      // that fills more of the frame does not blow the whole exposure out.
      const power = 20 * Math.pow(0.011 / s.angular, 0.75);
      material.uniforms.uCore.value.set(c.r * power, c.g * power, c.b * power);
      material.uniforms.uChromo.value.set(power * 0.55, power * 0.20, power * 0.13);
      material.uniforms.uGlow.value.set(c.r * power * 0.13, c.g * power * 0.12, c.b * power * 0.11);
      material.uniforms.uLimbU.value = s.temperature > 6500 ? 0.52 : 0.70;

      mesh.position.copy(direction).multiplyScalar(STAR_DISTANCE);
    },

    update(dt, camera, skyOrigin) {
      material.uniforms.uTime.value += dt;
      aimRim(camera);
      worldPosition.copy(skyOrigin).addScaledVector(direction, STAR_DISTANCE);

      screenNDC.copy(worldPosition).project(camera);
      const forward = _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
      const inFront = forward.dot(direction) > 0;
      screenPosition.set(screenNDC.x * 0.5 + 0.5, screenNDC.y * 0.5 + 0.5, inFront ? 1 : -1);
      api.onScreen = inFront
        && screenPosition.x > -0.35 && screenPosition.x < 1.35
        && screenPosition.y > -0.35 && screenPosition.y < 1.35;
    },

    dispose() {
      mesh.geometry.dispose();
      material.dispose();
    },
  };

  return api;
}

const _fwd = new THREE.Vector3();
const WORLD_UP = /* @__PURE__ */ new THREE.Vector3(0, 1, 0);
