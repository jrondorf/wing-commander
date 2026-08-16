import * as THREE from 'three';

/**
 * Scene setups for the capture harness — one per entry in tools/scenarios.js.
 *
 * Each scene is written to degrade gracefully: subsystems still under construction
 * are absent, and a scene must still frame *something* rather than throw. Owned by
 * the lead; subsystem agents should not edit this file, but may request additions.
 */

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** Point the world camera at a target from a given offset, with a slight roll for life. */
function frame(engine, eye, target, { roll = 0, fov = 52 } = {}) {
  engine.camera.fov = fov;
  engine.camera.position.copy(eye);
  engine.camera.up.set(0, 1, 0);
  engine.camera.lookAt(target);
  if (roll) engine.camera.rotateZ(roll);
  engine.camera.updateProjectionMatrix();
  engine.camera.updateMatrixWorld(true);
}

/** Freeze the camera rig so a scripted capture keeps the framing it asked for. */
function lockCamera(game) {
  if (game.cameraRig) game.cameraRig.enabled = false;
}

function usePlayerCockpit(game) {
  game.viewMode = 'cockpit';
  if (game.cameraRig) {
    game.cameraRig.enabled = true;
    game.cameraRig.setMode?.('cockpit');
  }
}

/** Fallback lighting so a scene is never pitch black while world/ is unbuilt. */
function ensureFallbackLight(engine) {
  if (engine.scene.userData.__fallbackLit) return;
  if (engine.scene.children.some((c) => c.isLight)) return;
  const key = new THREE.DirectionalLight(0xcfe0ff, 4);
  key.position.set(1, 0.55, 0.7).normalize().multiplyScalar(1000);
  engine.scene.add(key);
  const fill = new THREE.HemisphereLight(0x2a3d55, 0x120a18, 0.35);
  engine.scene.add(fill);
  engine.scene.userData.__fallbackLit = true;
}

function spawnWing(game, classId, faction, origin, count, spread = 90) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const p = origin.clone().add(V((i - (count - 1) / 2) * spread, (i % 2 ? 1 : -1) * spread * 0.25, i * spread * 0.4));
    const s = game.spawnShip(classId, { faction, position: p, name: `${faction}-${i}` });
    if (s) out.push(s);
  }
  return out;
}

export const SHOT_SCENES = {
  // ---------------------------------------------------------------- hero shot
  'hero-fighter': {
    async setup(ctx) {
      const { game, engine } = ctx;
      ensureFallbackLight(engine);
      lockCamera(game);
      game.world?.setPreset?.('nebula-teal');
      const ship = game.spawnShip('confed_vampire', { faction: 'confed', position: V(0, 0, 0), seed: 7 });
      if (ship) {
        ship.group.rotation.set(0.06, -0.72, 0.14);
        // Idle engine glow without full throttle, so the nozzles read as hot but calm.
        if (ship.body) ship.body.controls.throttle = 0.35;
      }
      frame(engine, V(26, 9.5, 32), V(0, 0.5, 0), { fov: 38 });
    },
  },

  // ------------------------------------------------------------ cockpit idle
  'cockpit-idle': {
    async setup(ctx) {
      const { game, engine } = ctx;
      ensureFallbackLight(engine);
      game.world?.setPreset?.('nebula-magenta');
      const p = game.spawnShip('confed_vampire', { faction: 'confed', position: V(0, 0, 0), isPlayer: true, seed: 3 });
      if (p?.body) p.body.controls.throttle = 0.5;
      usePlayerCockpit(game);
      // A wingman off the starboard bow gives the frame a subject and scale.
      game.spawnShip('confed_vampire', { faction: 'confed', position: V(120, -18, -320), seed: 11 });
    },
  },

  // ---------------------------------------------------------- cockpit combat
  'cockpit-combat': {
    async setup(ctx) {
      const { game, engine } = ctx;
      ensureFallbackLight(engine);
      game.world?.setPreset?.('nebula-ember');
      const p = game.spawnShip('confed_vampire', { faction: 'confed', position: V(0, 0, 0), isPlayer: true, seed: 3 });
      if (p?.body) p.body.controls.throttle = 0.85;
      usePlayerCockpit(game);
      spawnWing(game, 'confed_vampire', 'confed', V(-160, 30, -200), 1);
      spawnWing(game, 'alien_manta', 'nephilim', V(220, -60, -900), 3, 140);
      game.combat?.setPlayerFiring?.(true);
    },
    tick(ctx, t) {
      // Hold the trigger down through the capture so tracers are in flight.
      if (t > 1) ctx.game.engine.input.injectPress('fire');
    },
  },

  // ---------------------------------------------------------- external chase
  'dogfight-chase': {
    async setup(ctx) {
      const { game, engine } = ctx;
      ensureFallbackLight(engine);
      game.world?.setPreset?.('nebula-teal');
      const p = game.spawnShip('confed_vampire', { faction: 'confed', position: V(0, 0, 0), isPlayer: true, seed: 3 });
      if (p?.body) p.body.controls.throttle = 1;
      game.viewMode = 'chase';
      game.cameraRig?.setMode?.('chase');
      spawnWing(game, 'confed_vampire', 'confed', V(-120, 40, -140), 1);
      spawnWing(game, 'alien_manta', 'nephilim', V(180, -40, -700), 3, 120);
    },
    tick(ctx, t) {
      if (t > 2) ctx.game.engine.input.injectPress('fire');
    },
  },

  // ------------------------------------------------------------ capital ship
  'capital-ship': {
    async setup(ctx) {
      const { game, engine } = ctx;
      ensureFallbackLight(engine);
      lockCamera(game);
      game.world?.setPreset?.('nebula-deep-blue');
      const cap = game.spawnShip('confed_carrier', { faction: 'confed', position: V(0, 0, 0), seed: 21 });
      if (cap) cap.group.rotation.set(0.02, -0.5, 0.01);
      spawnWing(game, 'confed_vampire', 'confed', V(-260, -90, 420), 3, 60);
      frame(engine, V(700, 190, 900), V(-40, -10, 0), { fov: 44 });
    },
  },

  // --------------------------------------------------------------- explosion
  explosion: {
    async setup(ctx) {
      const { game, engine } = ctx;
      ensureFallbackLight(engine);
      lockCamera(game);
      game.world?.setPreset?.('nebula-ember');
      const victim = game.spawnShip('alien_manta', { faction: 'nephilim', position: V(0, 0, 0), seed: 5 });
      ctx.victim = victim;
      spawnWing(game, 'confed_vampire', 'confed', V(-140, 30, 260), 2, 70);
      frame(engine, V(70, 26, 130), V(0, 0, 0), { fov: 42 });
    },
    tick(ctx, t) {
      // Detonate a little before the shot so the fireball is in its most
      // photogenic phase — expanding, debris thrown, shockwave still visible.
      if (!ctx._boomed && t > 8.4 && ctx.victim) {
        ctx._boomed = true;
        ctx.game.events.emit('ship:destroyed', {
          ship: ctx.victim,
          position: ctx.victim.group.position.clone(),
          scale: 1.4,
        });
      }
    },
  },

  // ------------------------------------------------------------ nebula vista
  'nebula-vista': {
    async setup(ctx) {
      const { game, engine } = ctx;
      ensureFallbackLight(engine);
      lockCamera(game);
      game.world?.setPreset?.('nebula-vista');
      game.world?.addPlanet?.({ position: V(-9000, -1400, -42000), radius: 7000, type: 'gas-giant' });
      game.world?.addAsteroidField?.({ center: V(1800, -300, -6000), radius: 4200, count: 420, seed: 9 });
      frame(engine, V(0, 0, 0), V(-0.22, -0.03, -1), { fov: 62 });
    },
  },

  // ------------------------------------------------------------ asteroid run
  'asteroid-run': {
    async setup(ctx) {
      const { game, engine } = ctx;
      ensureFallbackLight(engine);
      game.world?.setPreset?.('nebula-deep-blue');
      game.world?.addAsteroidField?.({ center: V(0, 0, -3000), radius: 3000, count: 600, seed: 4 });
      const p = game.spawnShip('confed_vampire', { faction: 'confed', position: V(0, 0, 1200), isPlayer: true, seed: 3 });
      if (p?.body) p.body.controls.throttle = 1;
      usePlayerCockpit(game);
    },
  },

  // ---------------------------------------------------------- carrier launch
  'carrier-launch': {
    async setup(ctx) {
      const { game, engine } = ctx;
      ensureFallbackLight(engine);
      lockCamera(game);
      game.world?.setPreset?.('nebula-deep-blue');
      const cap = game.spawnShip('confed_carrier', { faction: 'confed', position: V(0, 0, -600), seed: 21 });
      ctx.carrier = cap;
      const p = game.spawnShip('confed_vampire', { faction: 'confed', position: V(0, -6, -40), isPlayer: true, seed: 3 });
      if (p?.body) p.body.controls.throttle = 0.2;
      frame(engine, V(0, 3.5, 26), V(0, -2, -160), { fov: 55 });
    },
  },

  // ------------------------------------------------------------- missile shot
  'missile-lock': {
    async setup(ctx) {
      const { game, engine } = ctx;
      ensureFallbackLight(engine);
      lockCamera(game);
      game.world?.setPreset?.('nebula-magenta');
      const p = game.spawnShip('confed_vampire', { faction: 'confed', position: V(0, 0, 0), isPlayer: true, seed: 3 });
      if (p?.body) p.body.controls.throttle = 0.7;
      ctx.target = game.spawnShip('alien_manta', { faction: 'nephilim', position: V(60, 20, -1400), seed: 8 });
      frame(engine, V(-30, 14, 46), V(10, 2, -260), { fov: 40 });
    },
    tick(ctx, t) {
      if (!ctx._fired && t > 5 && ctx.game.combat?.fireMissile) {
        ctx._fired = true;
        ctx.game.combat.fireMissile(ctx.game.player, ctx.target);
      }
    },
  },
};
