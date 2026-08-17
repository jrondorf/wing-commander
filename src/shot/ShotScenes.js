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

/**
 * Frame a subject from its real world-space bounds.
 *
 * Static "hero" shots cannot place the camera at setup time: the flight system
 * flies the subject hundreds of metres downrange during warm-up. These shots call
 * this from `beforeShot`, once the sim has settled, so the framing is composed
 * against where the ship actually ended up and at a size derived from its bounds
 * rather than a hardcoded distance.
 *
 * @param {number} azimuth   radians around the subject; 0 looks up its +Z
 * @param {number} elevation radians above the horizon
 * @param {number} fill      fraction of frame height the subject should occupy
 */
function frameSubject(engine, object, { azimuth = 0.7, elevation = 0.28, fill = 0.62, fov = 40, roll = 0 } = {}) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return null;
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5;
  // Fit against whichever frame axis is tighter. Using vertical FOV alone pushes a
  // wide, flat fighter far too far back: its bounding sphere is set by a 28 m
  // wingspan while its on-screen height is only 7.6 m, so it lands small in frame.
  const vTan = Math.tan((fov * Math.PI) / 360);
  const hTan = vTan * engine.camera.aspect;
  const dist = (radius / Math.min(vTan, hTan)) / Math.max(0.05, fill);
  const dir = new THREE.Vector3(
    Math.cos(elevation) * Math.sin(azimuth),
    Math.sin(elevation),
    Math.cos(elevation) * Math.cos(azimuth),
  );
  engine.camera.fov = fov;
  engine.camera.position.copy(centre).addScaledVector(dir, dist);
  engine.camera.up.set(0, 1, 0);
  engine.camera.lookAt(centre);
  if (roll) engine.camera.rotateZ(roll);
  engine.camera.updateProjectionMatrix();
  engine.camera.updateMatrixWorld(true);
  return { centre, size, dist };
}

/**
 * Freeze the simulation for a static hero shot.
 *
 * Spawned ships that are not the player get an AI pilot attached, which flies them
 * hundreds of metres downrange during warm-up and overrides any throttle the scene
 * sets. For a composed still we want the subject exactly where it was placed, and a
 * zero velocity field so motion blur leaves the frame sharp.
 */
function freezeSim(game) {
  for (const name of ['ai', 'flight']) {
    const sys = game.engine.getSystem(name);
    if (sys) sys.enabled = false;
  }
}

/** Hold a ship still so a hero shot composes against a fixed subject. */
function anchor(ship) {
  if (!ship?.body) return;
  ship.body.velocity?.set?.(0, 0, 0);
  ship.body.angularVelocity?.set?.(0, 0, 0);
  ship.body.controls.throttle = 0;
  // Engine bells should still read hot even with the ship parked.
  ship.body.idleGlow = 0.4;
  ship.anchored = true;
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
      ctx.subject = ship;
      if (ship) {
        ship.group.rotation.set(0.06, -0.72, 0.14);
        anchor(ship);
      }
      freezeSim(game);
    },
    beforeShot(ctx) {
      // Three-quarter view from slightly above — the classic box-art angle, and the
      // one that shows silhouette, panel detail and engine bells at once.
      // Longer lens and a tighter fill: 38mm-equivalent framing left the fighter
      // adrift in the frame. A hero shot should be nearly filled by its subject.
      if (ctx.subject) frameSubject(ctx.engine, ctx.subject.group, { azimuth: 0.85, elevation: 0.24, fill: 1.35, fov: 34, roll: 0.03 });
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
      ctx.subject = cap;
      if (cap) { cap.group.rotation.set(0.02, -0.5, 0.01); anchor(cap); }
      // Fighters near the camera side of the hull give the eye a scale reference.
      spawnWing(game, 'confed_vampire', 'confed', V(-260, -90, 420), 3, 60);
    },
    beforeShot(ctx) {
      if (ctx.subject) frameSubject(ctx.engine, ctx.subject.group, { azimuth: 1.15, elevation: 0.18, fill: 0.7, fov: 44 });
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
      if (victim) anchor(victim);
      spawnWing(game, 'confed_vampire', 'confed', V(-140, 30, 260), 2, 70);
      // Frame the victim now — once it detonates its group may be gone, so the
      // camera has to be composed on the blast site before the kill.
      frameSubject(engine, victim?.group ?? engine.scene, { azimuth: 0.6, elevation: 0.22, fill: 0.28, fov: 42 });
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
