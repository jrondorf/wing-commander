/**
 * Cockpit system — priority 800.
 *
 * Owns everything the pilot sees from inside the ship: the physical tub, the two
 * MFDs, the tactical radar globe and the HUD. Runs after the camera rig (700) so
 * the HUD is always projected against the transform the frame will actually be
 * composited with, and before audio (900).
 *
 * ## How it is anchored
 * `engine.cockpitCamera` is placed by the camera rig at the pilot's eye with the
 * hull's orientation plus its own G-sway and handheld drift. This system locks a
 * root group to that camera exactly, then applies its *own* inertia and vibration
 * to the tub inside it. Deriving the lag here rather than inheriting the camera's
 * means the cockpit renders correctly with no camera rig, no player ship and no
 * flight model — which is the state half the capture scenarios boot in.
 *
 * ## Draw calls
 * One merged mesh for the whole static interior, one canopy, two MFDs, four
 * radar primitives, two animated controls, one HUD quad. Everything static shares
 * the 2048² atlas from atlas.js.
 */

import * as THREE from 'three';
import { ittsSolution, solutionStatus, makeSolution } from '../combat/targeting.js';
import { buildCockpitAtlas, createCockpitMaterial } from './atlas.js';
import { buildCockpitGeometry, panelMatrix, panelPoint } from './geometry.js';
import { createCanopyGlassMaterial } from './glass.js';
import { createCockpitState } from './state.js';
import { createCrtMaterial, createTargetVdu, createDamageVdu, blackTexture } from './mfd.js';
import { createRadarGlobe } from './radar.js';
import { createHudPainter } from './hud.js';
import { MFD, THROTTLE, STICK, HUD_INTENSITY, HUD_BACKING, HUD_BACKING_PX } from './layout.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));

/** Cheap deterministic 1D noise for the airframe buzz. */
function hash1(n) {
  let h = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}
function noise1(t, seed = 0) {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  const a = hash1((i + seed * 7919) | 0);
  const b = hash1((i + 1 + seed * 7919) | 0);
  return (a + (b - a) * u) * 2 - 1;
}

export function createCockpitSystem(engine, opts = {}) {
  const seed = opts.seed ?? 9137;

  // ------------------------------------------------------------------ assets
  const atlas = buildCockpitAtlas(engine, { seed });
  const tubMat = createCockpitMaterial(engine, atlas);
  const geo = buildCockpitGeometry(engine, { seed: seed ^ 0x51ed });

  const state = createCockpitState(engine, { seed: seed ^ 0x2b17 });

  // ------------------------------------------------------------------- scene
  const root = new THREE.Group();
  root.name = 'cockpit-root';
  root.matrixAutoUpdate = true;

  /** Everything rigidly bolted to the airframe. Carries the inertia offset. */
  const tub = new THREE.Group();
  tub.name = 'cockpit-tub';
  root.add(tub);

  const tubMesh = new THREE.Mesh(geo.tub, tubMat);
  tubMesh.name = 'cockpit-shell';
  tubMesh.frustumCulled = false;
  tub.add(tubMesh);

  // ---- MFDs ---------------------------------------------------------------
  const targetVdu = createTargetVdu(engine);
  const damageVdu = createDamageVdu(engine);
  const black = blackTexture();

  const screenGeo = new THREE.PlaneGeometry(MFD.size - 0.008, MFD.size - 0.008);
  const leftGeo = screenGeo.clone();
  leftGeo.applyMatrix4(panelMatrix().multiply(new THREE.Matrix4().makeTranslation(MFD.leftX, MFD.y, 0.006)));
  const rightGeo = screenGeo.clone();
  rightGeo.applyMatrix4(panelMatrix().multiply(new THREE.Matrix4().makeTranslation(MFD.rightX, MFD.y, 0.006)));
  screenGeo.dispose();

  const leftMat = createCrtMaterial(engine, {
    content: targetVdu.renderTarget.texture, overlay: targetVdu.overlay,
    tint: '#9fe8ff', bright: 1.5, contentMix: 1.35, glow: 1.15,
  });
  const rightMat = createCrtMaterial(engine, {
    content: black, overlay: damageVdu.overlay,
    tint: '#ffc888', bright: 1.35, contentMix: 0, glow: 1.35, scanCount: 168,
  });
  const leftScreen = new THREE.Mesh(leftGeo, leftMat);
  const rightScreen = new THREE.Mesh(rightGeo, rightMat);
  leftScreen.frustumCulled = false;
  rightScreen.frustumCulled = false;
  tub.add(leftScreen, rightScreen);

  // ---- radar --------------------------------------------------------------
  const radar = createRadarGlobe(engine);
  tub.add(radar.object3D);

  // ---- animated controls --------------------------------------------------
  const stick = new THREE.Mesh(geo.stick, tubMat);
  stick.position.set(STICK.pivot[0], STICK.pivot[1], STICK.pivot[2]);
  stick.frustumCulled = false;
  tub.add(stick);

  const throttle = new THREE.Mesh(geo.throttle, tubMat);
  throttle.position.set(THROTTLE.pivot[0], THROTTLE.pivot[1], THROTTLE.pivot[2]);
  throttle.frustumCulled = false;
  tub.add(throttle);

  // ---- canopy -------------------------------------------------------------
  const glassMat = createCanopyGlassMaterial(engine, { emissiveMap: atlas.emissiveMap });
  const glass = new THREE.Mesh(geo.glass, glassMat);
  glass.name = 'canopy-glass';
  glass.renderOrder = 20;
  glass.frustumCulled = false;
  tub.add(glass);

  // ---- HUD ----------------------------------------------------------------
  const hud = createHudPainter();
  const hudTex = new THREE.CanvasTexture(hud.canvas);
  hudTex.colorSpace = THREE.SRGBColorSpace;
  hudTex.minFilter = THREE.LinearFilter;
  hudTex.magFilter = THREE.LinearFilter;
  hudTex.generateMipmaps = false;
  const hudMat = new THREE.MeshBasicMaterial({
    map: hudTex,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    side: THREE.FrontSide,
  });
  hudMat.color.setRGB(HUD_INTENSITY, HUD_INTENSITY, HUD_INTENSITY);
  const hudMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), hudMat);
  hudMesh.name = 'hud';
  hudMesh.renderOrder = 100;
  hudMesh.frustumCulled = false;
  // The HUD quad covers the whole frame. Letting it into the velocity pass would
  // stamp zero motion over the entire screen and silently disable motion blur and
  // TAA reprojection for the world behind it.
  hudMesh.userData.noVelocity = true;

  /**
   * Backing pass for the symbology.
   *
   * A combiner glass is additive, and that is correct right up until the sky
   * behind it is already at 1.0. Flying toward the primary star through a nebula
   * core, 18 % of the upper frame measured fully clipped: adding cyan to white
   * produces white, and the entire HUD — reticle, contact boxes, speed tape —
   * simply was not there. This quad renders one layer under the additive one and
   * lays down a dilated dark wash wherever symbology is about to be drawn, so
   * there is always something for the glow to sit on.
   *
   * The dilation radius matters more than the opacity. A 1 px keyline round a
   * 2 px stroke is thinner than the bloom the blown sky spills sideways, so the
   * glare simply closed over it; `HUD_BACKING_PX` opens a gutter wide enough that
   * it cannot. Nine taps of the HUD texture's own alpha, nothing else sampled.
   */
  const hudShadowMat = new THREE.ShaderMaterial({
    name: 'hud-backing',
    uniforms: {
      tHud: { value: hudTex },
      uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
      uStrength: { value: HUD_BACKING },
      uSpread: { value: HUD_BACKING_PX },
    },
    vertexShader: /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
    fragmentShader: /* glsl */`
precision highp float;
uniform sampler2D tHud;
uniform vec2 uTexel;
uniform float uStrength;
uniform float uSpread;
varying vec2 vUv;

/* Max-filter dilate. Two rings: the inner one keeps the keyline solid against
   the stroke, the outer one is what actually holds bloom off. */
void main() {
  vec2 s1 = uTexel * uSpread;
  vec2 s2 = uTexel * uSpread * 2.0;
  float a = texture2D(tHud, vUv).a;
  a = max(a, texture2D(tHud, vUv + vec2( s1.x,  s1.y)).a);
  a = max(a, texture2D(tHud, vUv + vec2(-s1.x,  s1.y)).a);
  a = max(a, texture2D(tHud, vUv + vec2( s1.x, -s1.y)).a);
  a = max(a, texture2D(tHud, vUv + vec2(-s1.x, -s1.y)).a);
  a = max(a, texture2D(tHud, vUv + vec2( s2.x,   0.0)).a);
  a = max(a, texture2D(tHud, vUv + vec2(-s2.x,   0.0)).a);
  a = max(a, texture2D(tHud, vUv + vec2(  0.0,  s2.y)).a);
  a = max(a, texture2D(tHud, vUv + vec2(  0.0, -s2.y)).a);
  if (a <= 0.004) discard;
  gl_FragColor = vec4(0.0, 0.006, 0.011, a * uStrength);
}`,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    side: THREE.FrontSide,
  });
  const hudShadow = new THREE.Mesh(hudMesh.geometry, hudShadowMat);
  hudShadow.name = 'hud-backing';
  hudShadow.renderOrder = 99;
  hudShadow.frustumCulled = false;
  hudShadow.userData.noVelocity = true;
  root.add(hudShadow, hudMesh);

  // ---- lighting -----------------------------------------------------------
  // The cockpit scene is separate from the world scene and therefore has no
  // lights of its own. One key from the star (so bevels rake as the ship turns),
  // one instrument flood, and the nebula PMREM as fill — the same recipe §7 uses
  // for hulls, at the level an enclosed tub actually receives.
  const key = new THREE.DirectionalLight(0xcfe0ff, 3.2);
  key.name = 'cockpit-key';
  const keyTarget = new THREE.Object3D();
  root.add(key, keyTarget);
  key.target = keyTarget;

  const flood = new THREE.PointLight(0xffb060, 0.55, 3.2, 2);
  flood.position.set(0, -0.02, -0.60);
  root.add(flood);

  const bounce = new THREE.HemisphereLight(0x8fb4d8, 0x1a1410, 0.30);
  root.add(bounce);

  engine.cockpitScene.add(root);

  // -------------------------------------------------------------------- misc
  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _size = new THREE.Vector2();
  const _proj = new THREE.Vector3();
  const solution = makeSolution();
  const boresight = new THREE.Vector3();
  const velocityMark = new THREE.Vector3();

  const inertia = {
    rot: new THREE.Vector3(),
    pos: new THREE.Vector3(),
  };
  let time = 0;
  let hudW = 0;
  let hudH = 0;
  let visible = true;

  function shouldShow() {
    const game = engine.game;
    const rig = game?.cameraRig ?? engine.getSystem?.('camera') ?? null;
    if (rig && rig.enabled === false) return false;
    const mode = rig?.mode ?? game?.viewMode ?? 'cockpit';
    return mode === 'cockpit' || mode === 'padlock';
  }

  /** World point -> HUD canvas pixels. Returns false when it is behind us. */
  function project(vec, out) {
    const cam = engine.cockpitCamera;
    _proj.copy(vec).applyMatrix4(cam.matrixWorldInverse);
    const behind = _proj.z > -1e-4;
    _proj.applyMatrix4(cam.projectionMatrix);
    if (behind) {
      // Flip so an off-screen caret still points the right way.
      out.x = (0.5 - _proj.x * 0.5) * hudW;
      out.y = (0.5 + _proj.y * 0.5) * hudH;
      return false;
    }
    out.x = (_proj.x * 0.5 + 0.5) * hudW;
    out.y = (1 - (_proj.y * 0.5 + 0.5)) * hudH;
    return true;
  }

  function syncHudSize() {
    engine.renderer.getDrawingBufferSize(_size);
    const w = Math.max(2, Math.round(_size.x));
    const h = Math.max(2, Math.round(_size.y));
    if (w === hudW && h === hudH) return;
    hudW = w;
    hudH = h;
    hud.setSize(w, h);
    hudTex.dispose();
    // A new canvas backing store needs a new texture object, not just an update.
    hudMat.map = new THREE.CanvasTexture(hud.canvas);
    hudMat.map.colorSpace = THREE.SRGBColorSpace;
    hudMat.map.minFilter = THREE.LinearFilter;
    hudMat.map.magFilter = THREE.LinearFilter;
    hudMat.map.generateMipmaps = false;
    hudMat.needsUpdate = true;
    hudShadowMat.uniforms.tHud.value = hudMat.map;
    hudShadowMat.uniforms.uTexel.value.set(1 / w, 1 / h);
  }

  function placeHudQuad() {
    const cam = engine.cockpitCamera;
    const d = 0.42;
    const h = 2 * d * Math.tan((cam.fov * Math.PI) / 360);
    hudMesh.scale.set(h * cam.aspect, h, 1);
    hudMesh.position.set(0, 0, -d);
    hudShadow.scale.copy(hudMesh.scale);
    hudShadow.position.copy(hudMesh.position);
  }

  /** Star direction/colour drives both the key light and the canopy specular. */
  function syncLighting() {
    const star = engine.game?.world?.star ?? null;
    if (star?.direction?.isVector3) {
      _v.copy(star.direction).normalize();
      if (star.color?.isColor) key.color.copy(star.color);
      key.intensity = Math.max(1.2, (star.intensity ?? 4.2) * 0.7);
    } else {
      _v.copy(state.starDir);
    }
    // Into root-local space: root carries the camera's orientation.
    _q.copy(root.quaternion).invert();
    _v2.copy(_v).applyQuaternion(_q);
    key.position.copy(_v2).multiplyScalar(6);
    keyTarget.position.set(0, 0, 0);

    glassMat.uniforms.uStarDir.value.copy(_v);
    glassMat.uniforms.uStarColor.value.copy(key.color).multiplyScalar(0.55 + key.intensity * 0.10);

    const cockpitScene = engine.cockpitScene;
    if (cockpitScene.environment !== engine.scene.environment) {
      cockpitScene.environment = engine.scene.environment;
    }
    cockpitScene.environmentIntensity = (engine.scene.environmentIntensity ?? 1) * 0.7;
    if (engine.scene.environment) {
      glassMat.uniforms.uEnvTint.value.setRGB(0.30, 0.40, 0.62);
    }
  }

  /**
   * Cockpit inertia. The tub is bolted to the airframe and the pilot's head is
   * not, so a hard reversal swings the whole interior a couple of degrees before
   * it settles. Afterburner adds a buzz on top.
   */
  function updateInertia(dt) {
    const w = state.angularVelocity;
    const a = state.acceleration;
    _q.copy(state.quaternion).invert();

    _v.copy(w).applyQuaternion(_q).multiplyScalar(-0.055);
    _v.clampLength(0, 0.055);
    inertia.rot.x = damp(inertia.rot.x, _v.x, 7, dt);
    inertia.rot.y = damp(inertia.rot.y, _v.y, 7, dt);
    inertia.rot.z = damp(inertia.rot.z, _v.z, 7, dt);

    _v2.copy(a).applyQuaternion(_q).multiplyScalar(-0.000075);
    _v2.clampLength(0, 0.018);
    inertia.pos.x = damp(inertia.pos.x, _v2.x, 6, dt);
    inertia.pos.y = damp(inertia.pos.y, _v2.y, 6, dt);
    inertia.pos.z = damp(inertia.pos.z, _v2.z, 6, dt);

    // Airframe buzz: always a trace of it, a lot of it on the burner.
    const buzz = (state.afterburner ? 0.0022 : 0.00035) + Math.min(0.0016, state.speed / state.maxSpeed * 0.0006);
    const f = state.afterburner ? 41 : 23;
    const bx = noise1(time * f, 3) * buzz;
    const by = noise1(time * f * 1.13 + 4.7, 11) * buzz;
    const bz = noise1(time * f * 0.87 + 9.1, 17) * buzz * 0.5;

    tub.position.set(inertia.pos.x + bx, inertia.pos.y + by, inertia.pos.z + bz);
    tub.rotation.set(
      inertia.rot.x + by * 5.5,
      inertia.rot.y + bx * 5.5,
      inertia.rot.z + bz * 4.0,
    );
  }

  function updateControls(dt) {
    const body = state.body;
    const thr = clamp(state.throttle, 0, 1);
    const ang = THROTTLE.idle + (THROTTLE.full - THROTTLE.idle) * thr;
    throttle.rotation.x = damp(throttle.rotation.x, ang, 9, dt);

    const c = body?.controls ?? null;
    const pitch = clamp(c ? -c.pitch ?? 0 : 0, -1, 1) || 0;
    const roll = clamp(c ? c.roll ?? 0 : 0, -1, 1) || 0;
    const yaw = clamp(c ? c.yaw ?? 0 : 0, -1, 1) || 0;
    stick.rotation.x = damp(stick.rotation.x, pitch * STICK.travel, 11, dt);
    stick.rotation.z = damp(stick.rotation.z, -(roll * 0.7 + yaw * 0.3) * STICK.travel, 11, dt);
  }

  function updateGlass() {
    // Eye position in the tub's local space, for the reflection ray.
    tub.updateMatrixWorld(true);
    _v.copy(engine.cockpitCamera.position);
    tub.worldToLocal(_v);
    glassMat.uniforms.uLocalEye.value.copy(_v);
    glassMat.uniforms.uTime.value = time;

    // How bright the two displays currently are, so the canopy reflects what is
    // actually on them rather than a constant.
    const t = state.target;
    glassMat.uniforms.uMfdLeft.value.setRGB(0.05, 0.15, 0.22).multiplyScalar(t ? 1.35 : 0.7);
    const worst = state.armor
      ? Math.min(...['fore', 'aft', 'left', 'right'].map((q) => state.armor[q].v / state.armor[q].max))
      : 1;
    glassMat.uniforms.uMfdRight.value.setRGB(0.22, 0.12, 0.035).multiplyScalar(worst < 0.34 ? 1.6 : 1.0);
  }

  function updateSolution() {
    const t = state.target;
    if (!t?.ship) { solution.valid = false; solution.status = 'no-target'; return; }
    const shooter = state.player ?? { position: state.position, velocity: state.velocity };
    ittsSolution(shooter, t.ship, {
      speed: state.weapon.speed,
      range: state.weapon.range,
      forward: state.forward,
      out: solution,
    });
    solution.status = solutionStatus(solution, { cone: 0.10 });
  }

  // ------------------------------------------------------------------ update
  function update(dt, eng) {
    time += dt;
    visible = shouldShow();
    root.visible = visible;
    if (!visible) return;

    state.update(dt);

    const cam = eng.cockpitCamera;
    root.position.copy(cam.position);
    root.quaternion.copy(cam.quaternion);
    root.updateMatrixWorld(true);

    updateInertia(dt);
    updateControls(dt);
    syncLighting();
    updateSolution();
    radar.update(dt, state);
    updateGlass();
    placeHudQuad();

    // Warm-up frames in capture mode skip rasterization entirely; painting the
    // MFDs and the HUD then would cost 1200 canvas redraws for nothing.
    if (!eng.renderEnabled) return;

    syncHudSize();

    // ---- MFDs ------------------------------------------------------------
    const drew = state.target ? targetVdu.renderScene(eng, state.target) : false;
    leftMat.uniforms.uContentMix.value = drew ? 1.35 : 0;
    leftMat.uniforms.uTime.value = time;
    rightMat.uniforms.uTime.value = time;
    targetVdu.paint(state, dt);
    damageVdu.paint(state, dt);

    // ---- HUD -------------------------------------------------------------
    state.pixelsPerRadian = hudH / (2 * Math.tan((cam.fov * Math.PI) / 360));
    boresight.copy(state.forward).multiplyScalar(4000).add(cam.position);
    velocityMark.copy(state.velocity);
    if (velocityMark.lengthSq() > 1) velocityMark.setLength(4000).add(cam.position);
    else velocityMark.copy(boresight);

    hud.draw({ state, project, solution, time, boresight, velocityMark });
    if (hudMat.map) hudMat.map.needsUpdate = true;
  }

  function resize(w, h) {
    void w; void h;
    hudW = 0;   // force syncHudSize to rebuild on the next rendered frame
  }

  function dispose() {
    engine.cockpitScene.remove(root);
    root.traverse((o) => {
      if (o.isMesh || o.isLineSegments) {
        if (o.geometry && o.geometry !== geo.tub && o.geometry !== geo.glass) o.geometry.dispose?.();
      }
    });
    leftGeo.dispose();
    rightGeo.dispose();
    hudMesh.geometry.dispose();
    hudMat.map?.dispose();
    hudMat.dispose();
    hudShadowMat.dispose();
    leftMat.dispose();
    rightMat.dispose();
    glassMat.dispose();
    black.dispose();
    targetVdu.dispose();
    damageVdu.dispose();
    radar.dispose();
    hud.dispose();
    state.dispose();
  }

  return {
    name: 'cockpit',
    priority: 800,
    update,
    resize,
    dispose,
    /** Exposed for diagnostics and for the audio system's instrument cues. */
    state,
    solution,
    stats: geo.stats,
    setVisible(v) { visible = !!v; root.visible = visible; },
  };
}
