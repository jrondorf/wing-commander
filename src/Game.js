import * as THREE from 'three';
import { Engine } from './core/Engine.js';
import { Events } from './core/Events.js';
import { makeRng } from './core/Rand.js';

/**
 * Game — assembles the engine and every subsystem.
 *
 * Subsystems are loaded through `optional()`, which tolerates a module that has not
 * landed yet. Many agents build this codebase in parallel; a missing module degrades
 * the scene instead of white-screening it, and `game.modules` reports exactly what
 * loaded so the capture harness can tell "not built yet" from "built and broken".
 */
export class Game {
  constructor({ canvas, seed = 1337 } = {}) {
    this.engine = new Engine({ canvas });
    this.engine.events = new Events();
    this.events = this.engine.events;
    this.engine.game = this;
    this.seed = seed;
    this.rng = makeRng(seed);
    this.modules = {};
    this.missing = [];
    /** Subsystems that exist but threw while loading — always a real bug. */
    this.broken = [];
    this.player = null;
    /** Every active ship (player + NPCs). Systems iterate this. */
    this.ships = [];
    this.viewMode = 'cockpit'; // 'cockpit' | 'chase' | 'cinematic' | 'free'
  }

  async optional(name, path, factory) {
    try {
      const mod = await import(/* @vite-ignore */ path);
      const result = await factory(mod);
      this.modules[name] = result ?? true;
      return result;
    } catch (err) {
      this.missing.push(name);
      // A module that has not been written yet and a module that throws on
      // evaluation both land here, and conflating them hides real breakage: a
      // stray backtick inside a GLSL template literal once took the entire world
      // offline while the log read "subsystem unavailable", exactly like an
      // unbuilt module. A 404 is the only benign case.
      const msg = String(err?.message ?? err);
      const notBuilt = /Failed to fetch dynamically imported module|Cannot find module|404/i.test(msg);
      if (notBuilt) {
        console.warn(`[game] subsystem "${name}" not built yet — ${msg}`);
      } else {
        this.broken.push({ name, error: msg });
        console.error(`[game] subsystem "${name}" FAILED TO LOAD (it exists but threw):`, err);
      }
      return null;
    }
  }

  async init(opts = {}) {
    const engine = this.engine;

    // ---- rendering foundation ------------------------------------------------
    await this.optional('render', './render/PostProcessing.js', async (m) => {
      engine.post = m.createPostPipeline(engine, opts.post ?? {});
      return engine.post;
    });

    await this.optional('materials', './render/MaterialLibrary.js', (m) => {
      this.materials = m;
      return m;
    });

    // ---- world ---------------------------------------------------------------
    await this.optional('world', './world/World.js', async (m) => {
      this.world = await m.createWorld(engine, { seed: this.seed, ...(opts.world ?? {}) });
      engine.registerSystem(this.world.system);
      return this.world;
    });

    // ---- simulation ----------------------------------------------------------
    await this.optional('flight', './flight/FlightSystem.js', (m) => {
      this.flight = m.createFlightSystem(engine);
      engine.registerSystem(this.flight);
      return this.flight;
    });

    await this.optional('combat', './combat/CombatSystem.js', (m) => {
      this.combat = m.createCombatSystem(engine);
      engine.registerSystem(this.combat);
      return this.combat;
    });

    await this.optional('ai', './ai/AISystem.js', (m) => {
      this.ai = m.createAISystem(engine);
      engine.registerSystem(this.ai);
      return this.ai;
    });

    await this.optional('vfx', './vfx/VFXSystem.js', (m) => {
      this.vfx = m.createVFXSystem(engine);
      engine.registerSystem(this.vfx);
      return this.vfx;
    });

    // ---- presentation --------------------------------------------------------
    await this.optional('camera', './render/CameraRig.js', (m) => {
      this.cameraRig = m.createCameraRig(engine);
      engine.registerSystem(this.cameraRig);
      return this.cameraRig;
    });

    await this.optional('cockpit', './cockpit/CockpitSystem.js', (m) => {
      this.cockpit = m.createCockpitSystem(engine);
      engine.registerSystem(this.cockpit);
      return this.cockpit;
    });

    await this.optional('audio', './audio/AudioSystem.js', (m) => {
      this.audio = m.createAudioSystem(engine);
      engine.registerSystem(this.audio);
      return this.audio;
    });

    await this.optional('ui', './ui/UISystem.js', (m) => {
      this.ui = m.createUISystem(engine, document.getElementById('ui-root'));
      engine.registerSystem(this.ui);
      return this.ui;
    });

    await this.optional('mission', './mission/MissionSystem.js', (m) => {
      this.mission = m.createMissionSystem(engine);
      engine.registerSystem(this.mission);
      return this.mission;
    });

    if (this.missing.length) {
      console.warn(`[game] booted without: ${this.missing.join(', ')}`);
    }
    return this;
  }

  /** Spawn a ship and register it with every system that tracks ships. */
  spawnShip(classId, { faction = 'confed', position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), isPlayer = false, seed = null, name = '', ai = null } = {}) {
    if (!this.modules.ships && !this._shipsMod) return null;
    const mod = this._shipsMod;
    const group = mod.buildShip(this.engine, classId, { seed: seed ?? this.rng.int(1, 1e6), faction });
    group.position.copy(position);
    group.quaternion.copy(quaternion);
    this.engine.scene.add(group);

    const ship = {
      id: this.ships.length,
      classId, faction, name, group, isPlayer,
      stats: group.userData.stats,
      hardpoints: group.userData.hardpoints,
      alive: true,
    };
    this.flight?.attach?.(ship);
    this.combat?.attach?.(ship);
    if (!isPlayer) this.ai?.attach?.(ship, ai);
    this.ships.push(ship);
    if (isPlayer) {
      this.player = ship;
      this.engine.player = ship;
    }
    this.events.emit('ship:spawned', { ship });
    return ship;
  }

  async loadShips() {
    await this.optional('ships', './ships/Ships.js', (m) => {
      this._shipsMod = m;
      return m;
    });
  }

  start() { this.engine.start(); }
  dispose() { this.engine.dispose(); }
}
