import * as THREE from 'three';
import { getPreset, PRESET_IDS, DEFAULT_PRESET } from './Presets.js';
import { generateNebula } from './Nebula.js';
import { createStarfield } from './Starfield.js';
import { createPrimaryStar } from './PrimaryStar.js';
import { createPlanet } from './Planets.js';
import { createAsteroidField } from './Asteroids.js';
import { createDressing } from './Dressing.js';

/**
 * World — sky, star, planets, asteroids, set dressing.
 *
 * Contract (ARCHITECTURE §5.1 + the world brief):
 *
 *   createWorld(engine, { seed, preset }) => {
 *     system, setPreset, addPlanet, addAsteroidField,
 *     star, envMap, queryAsteroids, ...
 *   }
 *
 * Two structural decisions worth knowing about if you consume this module:
 *
 * 1. **The sky is built lazily, on the first `update()`.** Capture scenes call
 *    `setPreset()` immediately after `createWorld()`, and baking two 1024²
 *    cubemaps to throw one away is a second of wasted load time. `envMap` is a
 *    getter that forces the bake if something needs it earlier, so the property
 *    is never observably null.
 *
 * 2. **Everything at sky distance lives under `skyGroup`, which is re-centred on
 *    the camera every frame.** Stars and the primary therefore have exactly zero
 *    parallax — they are at infinity by construction rather than by picking a
 *    large radius and hoping.
 *
 * The key light is created eagerly in `createWorld()` so the capture harness's
 * fallback hemisphere light never installs itself over the top of ours.
 */

export async function createWorld(engine, { seed = 1337, preset = DEFAULT_PRESET } = {}) {
  const scene = engine.scene;
  const timings = {};
  const bootT0 = performance.now();

  let presetName = PRESET_IDS.includes(preset) ? preset : DEFAULT_PRESET;
  let active = getPreset(presetName);

  // ---------------------------------------------------------------- sky group
  const skyGroup = new THREE.Group();
  skyGroup.name = 'sky';
  scene.add(skyGroup);

  const starfield = createStarfield(engine, { seed, count: 24000, spikes: 40 });
  timings.starfield = starfield.stats.ms;
  skyGroup.add(starfield.object3D);

  const primary = createPrimaryStar(engine);
  skyGroup.add(primary.object3D);

  // Lights live in world space, not the sky group — a directional light only
  // cares about its direction and this keeps its matrix static.
  scene.add(primary.light, primary.light.target, primary.rimLight, primary.rimLight.target);

  // ------------------------------------------------------------- set dressing
  const dressing = createDressing(engine, { seed });
  timings.dressing = dressing.ms;
  scene.add(dressing.object3D);

  // -------------------------------------------------------------------- state
  /** @type {Array<ReturnType<typeof createPlanet>>} */
  const planets = [];
  /** @type {Array<ReturnType<typeof createAsteroidField>>} */
  const fields = [];

  let sky = null;              // { texture, envMap, dispose }
  let skyDirty = true;
  const ambient = new THREE.Vector3();

  function ambientFor(p) {
    const s = p.sky;
    return new THREE.Vector3(
      s.gasMid[0] * 0.055 + s.band[0] * 0.16 + s.deep[0] * 2.4,
      s.gasMid[1] * 0.055 + s.band[1] * 0.16 + s.deep[1] * 2.4,
      s.gasMid[2] * 0.055 + s.band[2] * 0.16 + s.deep[2] * 2.4,
    );
  }

  function applyPresetToScene() {
    ambient.copy(ambientFor(active));
    primary.applyPreset(active);
    starfield.setPole(active.sky.galNormal);
    for (const p of planets) p.applyPreset(active, ambient);

    const tint = new THREE.Color(
      active.star.color[0] * 0.5 + active.sky.gasMid[0] * 0.6,
      active.star.color[1] * 0.5 + active.sky.gasMid[1] * 0.6,
      active.star.color[2] * 0.5 + active.sky.gasMid[2] * 0.6,
    );
    dressing.setTint(tint);
    scene.environmentIntensity = active.envIntensity;
  }

  /** Bake the nebula cubemap + PMREM for the active preset. */
  function ensureSky() {
    if (!skyDirty) return sky;
    skyDirty = false;
    const t0 = performance.now();
    sky?.dispose();
    sky = generateNebula(engine.renderer, active.sky, { size: 1024, structureSize: 384 });
    timings.nebula = { ...sky.timings, total: +(performance.now() - t0).toFixed(1) };

    scene.background = sky.texture;
    scene.backgroundIntensity = 1;
    scene.backgroundBlurriness = 0;
    scene.environment = sky.envMap;
    scene.environmentIntensity = active.envIntensity;
    starfield.setSky(sky.texture);
    api.envMapTexture = sky.envMap;

    if (!timings.__logged) {
      timings.__logged = true;
      timings.boot = +(performance.now() - bootT0).toFixed(1);
      // eslint-disable-next-line no-console
      console.log('[world] generation (ms):', JSON.stringify(timings));
    }
    return sky;
  }

  applyPresetToScene();

  // ------------------------------------------------------------------- system
  const _sphere = new THREE.Sphere();

  const system = {
    name: 'world',
    priority: 500,
    update(dt, eng) {
      ensureSky();
      const camera = eng.camera;
      skyGroup.position.copy(camera.position);
      primary.update(dt, camera, camera.position);
      for (const p of planets) p.update(dt, camera);
      for (const f of fields) f.update(dt);
      dressing.update(dt, camera);
    },
    resize(w, h) {
      starfield.resize(w, h);
      dressing.resize(w, h);
    },
    dispose() {
      for (const p of planets) { scene.remove(p.object3D); p.dispose(); }
      for (const f of fields) { scene.remove(f.object3D); f.dispose(); }
      planets.length = 0;
      fields.length = 0;
      scene.remove(skyGroup, dressing.object3D, primary.light, primary.light.target, primary.rimLight, primary.rimLight.target);
      starfield.dispose();
      primary.dispose();
      dressing.dispose();
      if (sky && scene.background === sky.texture) scene.background = null;
      sky?.dispose();
      sky = null;
      scene.environment = null;
    },
  };

  const api = {
    system,
    seed,
    timings,
    planets,
    fields,
    star: primary,
    /** Filled in by ensureSky(); read through the `envMap` getter below. */
    envMapTexture: null,

    get preset() { return active; },
    get presetName() { return presetName; },
    get presets() { return PRESET_IDS.slice(); },

    /** Nebula skybox cube texture (HDR). Alpha channel is baked dust opacity. */
    get skyTexture() { ensureSky(); return sky.texture; },

    /**
     * PMREM environment map — the only fill light in the game.
     * Also assigned to `engine.scene.environment`.
     */
    get envMap() { ensureSky(); return sky.envMap; },

    /** Switch the environment palette. Rebakes the sky on the next frame. */
    setPreset(name) {
      const next = PRESET_IDS.includes(name) ? name : DEFAULT_PRESET;
      if (next === presetName && sky) return api;
      presetName = next;
      active = getPreset(next);
      skyDirty = true;
      applyPresetToScene();
      return api;
    },

    /**
     * @param {object} opts { position, radius, type: 'gas-giant'|'rocky'|'ice'|'terrestrial', seed, rings }
     */
    addPlanet(opts = {}) {
      const planet = createPlanet(engine, {
        seed: (seed ^ (planets.length * 7919)) >>> 0,
        ...opts,
      });
      planet.applyPreset(active, ambient);
      scene.add(planet.object3D);
      planets.push(planet);
      timings[`planet:${planet.type}`] = planet.ms;
      return planet;
    },

    /**
     * @param {object} opts { center, radius, count, seed }
     */
    addAsteroidField(opts = {}) {
      const field = createAsteroidField(engine, {
        seed: (seed ^ 0x51de) >>> 0,
        ...opts,
      });
      scene.add(field.object3D);
      fields.push(field);
      timings.asteroids = { ms: field.ms, count: field.count, tris: field.triangles, draws: field.drawCalls };
      return field;
    },

    /**
     * Broadphase query for flight/combat collision.
     * @param {THREE.Sphere|{center:THREE.Vector3, radius:number}} sphere
     * @returns {Array<{position:THREE.Vector3, radius:number, size:number}>}
     */
    queryAsteroids(sphere, out = []) {
      const s = sphere.isSphere ? sphere : _sphere.set(sphere.center, sphere.radius);
      for (const f of fields) f.query(s, out);
      return out;
    },

    /** Total collidable asteroid count across every field. */
    get asteroidCount() {
      let n = 0;
      for (const f of fields) n += f.count;
      return n;
    },

    dispose() { system.dispose(); },
  };

  // Convenience handle so flight/combat can reach queryAsteroids without
  // threading it through Game.
  engine.world = api;

  return api;
}
