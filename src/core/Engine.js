import * as THREE from 'three';
import { Input } from './Input.js';
import { Registry } from './Registry.js';

/**
 * Engine — owns the renderer, the frame loop, and the system list.
 *
 * Systems are plain objects: { name, priority, update(dt, engine), dispose?() }
 * Lower priority numbers update earlier. See ARCHITECTURE.md for the ordering
 * table that keeps flight -> combat -> ai -> vfx -> camera -> hud deterministic.
 */
export class Engine {
  constructor({ canvas, pixelRatio = null } = {}) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // MSAA is handled by the post-processing pipeline's HDR target
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
    });
    this.renderer.setPixelRatio(pixelRatio ?? Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Tone mapping is applied inside the post stack, not here — the scene renders
    // to a linear HDR target so bloom sees true over-range values.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false;

    this.maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();

    // Two scenes: the deep-space world, and a near-field cockpit rendered with a
    // separate camera/clip range so a 2m dashboard never z-fights a 40km capship.
    this.scene = new THREE.Scene();
    this.cockpitScene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 1, 8_000_000);
    this.cockpitCamera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.01, 50);

    this.clock = new THREE.Clock();
    this.elapsed = 0;
    this.frame = 0;
    this.dt = 0;

    this.input = new Input(canvas);
    this.registry = new Registry();

    /** @type {Array<{name:string, priority:number, update:Function, dispose?:Function}>} */
    this.systems = [];
    this._systemsDirty = false;

    this.post = null; // set by render/PostProcessing.js
    this.paused = false;
    this.timeScale = 1;

    // Deterministic capture mode: fixed dt, no wall-clock coupling. Driven by
    // tools/shoot.mjs so the critic compares like for like every run.
    this.deterministic = false;
    this.fixedDt = 1 / 60;
    // Warm-up frames in capture mode skip rasterization entirely — simulating 20s
    // of dogfight costs physics time, not 1200 SwiftShader frames.
    this.renderEnabled = true;

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);
    this._raf = null;

    this.stats = { drawCalls: 0, triangles: 0, programs: 0, fps: 0 };
    this._fpsAccum = 0;
    this._fpsFrames = 0;
  }

  registerSystem(system) {
    if (typeof system.priority !== 'number') system.priority = 500;
    this.systems.push(system);
    this._systemsDirty = true;
    return system;
  }

  removeSystem(system) {
    const i = this.systems.indexOf(system);
    if (i >= 0) {
      this.systems.splice(i, 1);
      system.dispose?.();
    }
  }

  getSystem(name) {
    return this.systems.find((s) => s.name === name) ?? null;
  }

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.cockpitCamera.aspect = w / h;
    this.cockpitCamera.updateProjectionMatrix();
    this.post?.setSize(w, h);
    for (const s of this.systems) s.resize?.(w, h, this);
  }

  start() {
    this.clock.start();
    const tick = () => {
      this._raf = requestAnimationFrame(tick);
      this.step();
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  /** Advance one frame. Exposed so capture tooling can pump frames by hand. */
  step(forcedDt = null) {
    const raw = forcedDt ?? (this.deterministic ? this.fixedDt : this.clock.getDelta());
    // Clamp so an alt-tab or a slow SwiftShader frame never tunnels a projectile
    // through a hull.
    this.dt = Math.min(raw, 0.1) * this.timeScale;
    if (this.paused) this.dt = 0;
    this.elapsed += this.dt;
    this.frame++;

    this.input.beginFrame();

    if (this._systemsDirty) {
      this.systems.sort((a, b) => a.priority - b.priority);
      this._systemsDirty = false;
    }

    for (const s of this.systems) {
      if (s.enabled === false) continue;
      s.update(this.dt, this);
    }

    this.render();

    this.input.endFrame();

    this._fpsAccum += raw;
    this._fpsFrames++;
    if (this._fpsAccum >= 0.5) {
      this.stats.fps = this._fpsFrames / this._fpsAccum;
      this._fpsAccum = 0;
      this._fpsFrames = 0;
    }
  }

  render() {
    if (!this.renderEnabled) return;
    const info = this.renderer.info;
    info.reset();
    if (this.post) {
      this.post.render(this.dt);
    } else {
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      this.renderer.clearDepth();
      this.renderer.render(this.cockpitScene, this.cockpitCamera);
    }
    this.stats.drawCalls = info.render.calls;
    this.stats.triangles = info.render.triangles;
    this.stats.programs = info.programs?.length ?? 0;
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    for (const s of this.systems) s.dispose?.();
    this.systems.length = 0;
    this.input.dispose();
    this.registry.dispose();
    this.post?.dispose();
    this.renderer.dispose();
  }
}
