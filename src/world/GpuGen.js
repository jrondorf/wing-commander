import * as THREE from 'three';

/**
 * Offscreen procedural generation helpers.
 *
 * Everything in `world/` that needs a texture bakes it here, once, at load time:
 * a shader is rasterised into a render target and the result is a plain
 * `THREE.Texture` from then on. Nothing is loaded from disk and nothing is
 * re-evaluated per frame.
 *
 * `CubePass` renders through a real `THREE.CubeCamera`. That matters: three's
 * cube render targets use a mirrored projection (`fov = -90`) so that sampling a
 * render-target cube with a world direction round-trips exactly. Hand-rolling six
 * face matrices gets the handedness wrong and produces mirrored seams, so we let
 * three own that convention on both the write and the read side.
 */

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const CUBE_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** Full-screen shader pass into a 2D render target. */
export class QuadPass {
  constructor(fragmentShader, uniforms = {}) {
    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: QUAD_VERT,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  render(renderer, target) {
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * Shader pass into all six faces of a cube render target. The fragment shader
 * receives `varying vec3 vDir` — the unit world direction of the texel — so the
 * generator is written once as a function of direction with no face seams and no
 * equirectangular pole pinch.
 */
export class CubePass {
  constructor(fragmentShader, uniforms = {}) {
    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: CUBE_VERT,
      fragmentShader,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), this.material);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.camera = new THREE.CubeCamera(0.05, 8, null);
  }

  render(renderer, target) {
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;
    this.camera.renderTarget = target;
    this.camera.update(renderer, this.scene);
    renderer.autoClear = prevAutoClear;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/** HDR cube target sized for sky/environment work. */
export function makeCubeTarget(size, { mipmaps = true, half = true } = {}) {
  const rt = new THREE.WebGLCubeRenderTarget(size, {
    type: half ? THREE.HalfFloatType : THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    magFilter: THREE.LinearFilter,
    minFilter: mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
    generateMipmaps: mipmaps,
    depthBuffer: false,
    colorSpace: THREE.LinearSRGBColorSpace,
  });
  rt.texture.name = 'world.cube';
  return rt;
}

/** LDR 2D target for surface detail maps. */
export function makeTarget(w, h, { half = false, wrap = THREE.RepeatWrapping, colorSpace = THREE.LinearSRGBColorSpace } = {}) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: half ? THREE.HalfFloatType : THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    magFilter: THREE.LinearFilter,
    minFilter: THREE.LinearMipmapLinearFilter,
    generateMipmaps: true,
    depthBuffer: false,
    wrapS: wrap,
    wrapT: wrap,
    colorSpace,
  });
  return rt;
}

/** Wall-clock helper so generation cost shows up in the boot log. */
export function timed(label, fn, sink) {
  const t0 = performance.now();
  const out = fn();
  const ms = performance.now() - t0;
  if (sink) sink[label] = +ms.toFixed(1);
  return out;
}
