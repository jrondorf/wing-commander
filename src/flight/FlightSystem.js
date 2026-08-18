import * as THREE from 'three';
import { ACTIONS } from '../core/Input.js';
import { FlightBody } from './FlightBody.js';
import { INTEGRATOR, PLAYER, ASSIST } from './tuning.js';
import {
  computeLocalBounds, resolveShipCollisions, resolveAsteroidCollisions,
} from './Collision.js';
import {
  createAutopilotState, updateAutopilot, findNavTarget,
} from './Autopilot.js';
import { clamp01, clamp11 } from './util.js';

/**
 * FlightSystem — priority 200. Integrates every ship's rigid body.
 *
 * Frame order inside this system (ARCHITECTURE §3 puts us before ai/combat):
 *   1. adopt any transform another system wrote onto ship.group
 *   2. map player input onto the player's body
 *   3. run autopilot (it writes controls, so it wins over the stick)
 *   4. resolve controls -> servo targets, once per frame
 *   5. N substeps of { integrate all bodies, resolve collisions }
 *   6. publish derived values and write transforms back onto ship.group
 *
 * Substepping is what makes a 1600 m/s afterburner pass safe: the step count is
 * chosen from the fastest body and the smallest collidable radius in the sim, so
 * nothing ever advances far enough to tunnel through a 30 m fighter. It is also
 * a pure function of simulation state, which keeps captures reproducible.
 *
 * NPC control inputs are written by the AI system at priority 250 — one frame
 * later than we read them. That is intentional and correct: it gives every pilot
 * in the sim, player included, the same one-frame reaction latency.
 */
export function createFlightSystem(engine) {
  /** @type {FlightBody[]} — insertion order, iterated deterministically. */
  const bodies = [];
  const byShip = new Map();

  const settings = {
    /** Master switch for sphere/OBB collision resolution. */
    collisions: true,
    /** Master switch for reading engine.input onto the player's body. */
    playerControl: true,
    /** Defaults copied onto every new body's `assist`. */
    assist: { ...ASSIST },
    /** Set false to freeze the whole sim without touching engine.paused. */
    enabled: true,
  };

  // ---- diagnostics, cheap enough to always keep -------------------------
  const stats = { bodies: 0, substeps: 1, dt: 0 };

  const _vec = new THREE.Vector3();

  // =======================================================================
  // attach / detach
  // =======================================================================

  /**
   * Create `ship.body` and wire `ship.group` to it. Called by Game.spawnShip.
   * Safe to call twice; the existing body is returned.
   */
  function attach(ship) {
    if (!ship) return null;
    const existing = byShip.get(ship);
    if (existing) return existing;

    const body = new FlightBody(ship, { seed: engine?.game?.seed ?? 0 });
    Object.assign(body.assist, settings.assist);

    // Bounds come off the real mesh when agent-ships has built one, and off the
    // class table when it has not.
    const bounds = computeLocalBounds(ship.group, body.tuning.radius);
    body.boundsCenter.copy(bounds.center);
    body.halfExtents.copy(bounds.half);
    body.boundsRadius = bounds.sphereRadius;
    body.radius = bounds.radius;
    body.boundsMeasured = bounds.measured;

    ship.body = body;
    bodies.push(body);
    byShip.set(ship, body);
    stats.bodies = bodies.length;

    engine?.events?.emit?.('flight:attached', { ship, body });
    return body;
  }

  function detach(ship) {
    const body = byShip.get(ship);
    if (!body) return false;
    byShip.delete(ship);
    const i = bodies.indexOf(body);
    if (i >= 0) bodies.splice(i, 1);
    if (ship.body === body) ship.body = null;
    body.autopilot = null;
    body.group = null;
    stats.bodies = bodies.length;
    engine?.events?.emit?.('flight:detached', { ship });
    return true;
  }

  const getBody = (ship) => byShip.get(ship) ?? ship?.body ?? null;

  // =======================================================================
  // player input  (ACTIONS live in src/core/Input.js)
  // =======================================================================

  const held = (input, action) => {
    if (!action || typeof input.held !== 'function') return false;
    return input.held(action);
  };
  const pressed = (input, action) => {
    if (!action || typeof input.pressed !== 'function') return false;
    return input.pressed(action);
  };

  function applyPlayerInput(dt) {
    if (!settings.playerControl) return;
    const game = engine?.game;
    const ship = game?.player ?? engine?.player ?? null;
    const body = getBody(ship);
    const input = engine?.input;
    if (!body || !input || ship?.alive === false) return;

    const c = body.controls;
    const axes = input.axes ?? {};
    const OPT = PLAYER.optionalActions;

    // ---- stick ---------------------------------------------------------
    let pitchAxis = clamp11(axes.pitch ?? 0);
    if (PLAYER.invertPitchAxis) pitchAxis = -pitchAxis;
    const yawAxis = clamp11(axes.yaw ?? 0);
    const rollAxis = clamp11(axes.roll ?? 0);

    // Any real stick deflection drops the autopilot — the WC "you took the
    // controls" moment.
    const manual = Math.abs(pitchAxis) + Math.abs(yawAxis) + Math.abs(rollAxis);
    if (body.autopilot && manual > PLAYER.manualOverrideThreshold) {
      body.autopilotDisengage('manual');
      engine?.events?.emit?.('autopilot:disengaged', { ship, reason: 'manual' });
    }

    c.pitch = pitchAxis;
    c.yaw = yawAxis;
    c.roll = rollAxis;

    // ---- throttle: the -/= keys walk the commanded speed ----------------
    const tAxis = clamp11(axes.throttle ?? 0);
    if (tAxis !== 0) {
      c.throttle = clamp01(c.throttle + tAxis * PLAYER.throttleRate * dt);
      if (body.fullStopActive) body.requestFullStop(false);
    }

    // ---- buttons --------------------------------------------------------
    c.afterburner = held(input, ACTIONS.afterburner);
    if (c.afterburner && body.fullStopActive) body.requestFullStop(false);

    c.brake = held(input, ACTIONS.brake) ? 1 : 0;

    if (pressed(input, ACTIONS.fullStop)) {
      body.requestFullStop(!body.fullStopActive);
    }

    if (pressed(input, ACTIONS.matchSpeed)) {
      matchSpeed(ship, currentTarget(ship));
    }

    if (pressed(input, ACTIONS.autopilot)) {
      if (body.autopilot) {
        body.autopilotDisengage('manual');
        engine?.events?.emit?.('autopilot:disengaged', { ship, reason: 'manual' });
      } else {
        const nav = findNavTarget(engine, ship);
        if (nav) engageAutopilot(ship, nav);
      }
    }

    // ---- optional bindings ---------------------------------------------
    // Not in ACTIONS yet. `input.held()` is a Set lookup, so an unbound name is
    // simply false — this costs nothing and lights up the moment core binds it.
    const sx = (held(input, OPT.strafeRight) ? 1 : 0) - (held(input, OPT.strafeLeft) ? 1 : 0);
    const sy = (held(input, OPT.strafeUp) ? 1 : 0) - (held(input, OPT.strafeDown) ? 1 : 0);
    c.strafeX = sx;
    c.strafeY = sy;

    if (pressed(input, OPT.autoSlide)) body.toggleAutoSlide();
    if (pressed(input, OPT.flightAssist)) body.assist.enabled = !body.assist.enabled;
  }

  /** Whatever the combat/targeting system considers the player's current target. */
  function currentTarget(ship) {
    const game = engine?.game;
    try {
      return game?.combat?.getTarget?.(ship) ?? ship?.target ?? null;
    } catch {
      return ship?.target ?? null;
    }
  }

  // =======================================================================
  // substepping
  // =======================================================================

  /**
   * How many substeps this frame needs. Depends only on simulation state, so a
   * capture replays identically.
   */
  function substepCount(dt) {
    let maxTravel = 0;
    let maxTurn = 0;
    let minRadius = Infinity;

    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      const travel = b.velocity.length() * dt;
      if (travel > maxTravel) maxTravel = travel;
      const turn = Math.max(b.angularVelocity.length(), b._cmdOmega.length()) * dt;
      if (turn > maxTurn) maxTurn = turn;
      if (b.collides && !b.static && b.boundsRadius < minRadius) minRadius = b.boundsRadius;
    }

    const radiusLimit = Number.isFinite(minRadius)
      ? minRadius * INTEGRATOR.travelSafetyFactor
      : INTEGRATOR.maxTravelPerSubstep;
    const limit = Math.max(0.25, Math.min(INTEGRATOR.maxTravelPerSubstep, radiusLimit));

    let n = Math.ceil(maxTravel / limit);
    const byTurn = Math.ceil(maxTurn / INTEGRATOR.maxTurnPerSubstep);
    if (byTurn > n) n = byTurn;
    if (n < 1) n = 1;
    if (n > INTEGRATOR.maxSubsteps) n = INTEGRATOR.maxSubsteps;
    return n;
  }

  // =======================================================================
  // frame
  // =======================================================================

  function update(dt, eng) {
    const e = eng ?? engine;
    stats.dt = dt;
    if (!settings.enabled) return;
    if (!(dt > INTEGRATOR.minDt) || bodies.length === 0) return;

    const step = dt > INTEGRATOR.maxDt ? INTEGRATOR.maxDt : dt;

    // 1. another system may have moved a ship (mission script, shot scene,
    //    docking). Whatever is on the group wins.
    for (let i = 0; i < bodies.length; i++) bodies[i].syncExternal();

    // 2. pilot, then 3. autopilot (which overrides the stick it just read).
    applyPlayerInput(step);
    for (let i = 0; i < bodies.length; i++) {
      if (bodies[i].autopilot) updateAutopilot(bodies[i], e, step);
    }

    // 4. controls -> servo targets.
    for (let i = 0; i < bodies.length; i++) bodies[i].beginFrame(step);

    // 5. integrate + collide.
    const n = substepCount(step);
    stats.substeps = n;
    const h = step / n;
    for (let s = 0; s < n; s++) {
      for (let i = 0; i < bodies.length; i++) bodies[i].substep(h);
      if (settings.collisions) {
        resolveShipCollisions(bodies, e);
        resolveAsteroidCollisions(bodies, e);
      }
    }

    // 6. publish.
    for (let i = 0; i < bodies.length; i++) bodies[i].endFrame(step);
  }

  // =======================================================================
  // public API
  // =======================================================================

  /**
   * Fly `ship` to `targetPos` under autopilot. Aborts automatically if a hostile
   * comes inside the ship's abort range.
   * @returns {boolean} false if the ship has no body or a hostile is already close.
   */
  function engageAutopilot(ship, targetPos, opts = {}) {
    const body = getBody(ship);
    if (!body || !targetPos) return false;
    _vec.set(targetPos.x, targetPos.y, targetPos.z);

    body.requestFullStop(false);
    body.autopilot = createAutopilotState(_vec, opts);
    body.autopilotActive = true;

    // One immediate scan so "enemies in the area" refuses to engage at all
    // rather than engaging for a quarter of a second first.
    const status = updateAutopilot(body, engine, 0);
    if (status === 'abort') return false;
    if (status === 'complete') return true; // already there

    engine?.events?.emit?.('autopilot:engaged', { ship, target: _vec.clone() });
    return true;
  }

  function disengageAutopilot(ship, reason = 'manual') {
    const body = getBody(ship);
    if (!body?.autopilot) return false;
    body.autopilotDisengage(reason);
    engine?.events?.emit?.('autopilot:disengaged', { ship, reason });
    return true;
  }

  /** Match a target's speed (WC's [S] key). */
  function matchSpeed(ship, target) {
    const body = getBody(ship);
    if (!body) return false;
    const tb = target?.body ?? getBody(target);
    if (!tb) return false;
    body.setThrottleForSpeed(tb.speed);
    return true;
  }

  const setAutoSlide = (ship, on) => getBody(ship)?.setAutoSlide(on) ?? false;
  const toggleAutoSlide = (ship) => getBody(ship)?.toggleAutoSlide() ?? false;
  const fullStop = (ship, on = true) => getBody(ship)?.requestFullStop(on) ?? false;
  const setStatic = (ship, on = true) => getBody(ship)?.setStatic(on) ?? false;

  /** World-space impulse (kg·m/s) — weapon knockback, tractor beams, blasts. */
  function applyImpulse(ship, impulse) {
    const body = getBody(ship);
    if (!body) return false;
    body.applyImpulse(impulse);
    return true;
  }

  function dispose() {
    for (const body of bodies) {
      if (body.ship && body.ship.body === body) body.ship.body = null;
      body.autopilot = null;
      body.group = null;
    }
    bodies.length = 0;
    byShip.clear();
    stats.bodies = 0;
  }

  return {
    name: 'flight',
    priority: 200,

    update,
    attach,
    detach,
    dispose,

    // --- extended API used by mission, ui, ai, combat -------------------
    engageAutopilot,
    disengageAutopilot,
    matchSpeed,
    setAutoSlide,
    toggleAutoSlide,
    fullStop,
    setStatic,
    applyImpulse,
    getBody,

    bodies,
    settings,
    stats,
  };
}

export { FlightBody } from './FlightBody.js';
export { resolveTuning, CLASS_TUNING, inferClass } from './tuning.js';
