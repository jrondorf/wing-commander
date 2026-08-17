#!/usr/bin/env node
/**
 * src/flight/__selftest.mjs — headless verification of the flight model.
 *
 *   node src/flight/__selftest.mjs
 *   node src/flight/__selftest.mjs --verbose
 *
 * No browser, no renderer, no WebGL: it instantiates FlightBodies against a stub
 * engine and asserts the properties the rest of the game relies on.
 *
 *   1. terminal velocity == commanded throttle × maxSpeed
 *   2. angular rates never exceed the per-ship limits (and do reach them)
 *   3. energy stays bounded under adversarial control chatter
 *   4. substepping prevents tunnelling (proved by disabling it)
 *   5. repeated runs are bit-identical
 *   plus: slip, auto-slide, RCS, full stop, afterburner/fuel, class weight,
 *         collisions, autopilot arrival + hostile abort, frame-rate independence.
 */
import * as THREE from 'three';
import { createFlightSystem } from './FlightSystem.js';
import { INTEGRATOR, resolveTuning } from './tuning.js';
import { makeRng } from '../core/Rand.js';

const VERBOSE = process.argv.includes('--verbose');
const DT = 1 / 60;

// ---------------------------------------------------------------------------
// tiny test framework
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];
let currentTest = '';

function test(name, fn) {
  currentTest = name;
  const t0 = Date.now();
  try {
    fn();
    passed++;
    console.log(`  ok   ${name} (${Date.now() - t0}ms)`);
  } catch (err) {
    failures.push({ name, message: err?.message ?? String(err) });
    console.log(`  FAIL ${name}\n       ${err?.message ?? err}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function near(actual, expected, tol, msg) {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${msg}: got ${fmt(actual)}, expected ${fmt(expected)} ±${tol}`);
  }
}
function between(actual, lo, hi, msg) {
  if (!(actual >= lo && actual <= hi)) {
    throw new Error(`${msg}: got ${fmt(actual)}, expected ${fmt(lo)}..${fmt(hi)}`);
  }
}
const fmt = (v) => (Number.isFinite(v) ? (Math.abs(v) >= 1000 ? v.toFixed(1) : v.toFixed(4)) : String(v));
const log = (...a) => { if (VERBOSE) console.log('       ', ...a); };

// ---------------------------------------------------------------------------
// stub engine / game
// ---------------------------------------------------------------------------
function makeHarness({ seed = 1337 } = {}) {
  const events = [];
  const engine = {
    events: {
      emit(type, payload) { events.push({ type, payload }); },
      on() { return () => {}; },
    },
    input: null,
    elapsed: 0,
    game: null,
  };
  engine.game = { seed, ships: [], player: null, world: null, engine };
  const flight = createFlightSystem(engine);
  return {
    engine,
    game: engine.game,
    flight,
    events,
    eventsOf: (type) => events.filter((e) => e.type === type),
    clearEvents: () => { events.length = 0; },
    step(n = 1, dt = DT) {
      for (let i = 0; i < n; i++) { flight.update(dt, engine); engine.elapsed += dt; }
    },
  };
}

/** A ship record shaped like the one Game.spawnShip builds. */
function makeShip(h, {
  classId = 'confed_vampire', faction = 'confed', stats = null,
  position = [0, 0, 0], size = null, isPlayer = false, alive = true,
} = {}) {
  const group = new THREE.Group();
  if (size) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]));
    group.add(mesh);
  }
  group.position.set(position[0], position[1], position[2]);
  const ship = {
    id: h.game.ships.length,
    classId, faction, isPlayer, alive,
    name: `${faction}-${h.game.ships.length}`,
    group,
    stats: stats ?? undefined,
  };
  h.game.ships.push(ship);
  h.flight.attach(ship);
  if (isPlayer) { h.game.player = ship; }
  return ship;
}

// The real stat blocks from src/ships/stats.js, so this exercises what actually
// ships. Turn rates are rad/s there, exactly as agent-ships authored them.
const FIGHTER_STATS = {
  mass: 14_500, length: 22,
  maxSpeed: 480, cruiseSpeed: 380, afterburnSpeed: 1400,
  accel: 190, afterburnAccel: 520, retroAccel: 130,
  pitchRate: 1.55, yawRate: 1.35, rollRate: 2.90,
};
const CAPITAL_STATS = {
  mass: 128_000_000, length: 900,
  maxSpeed: 130, cruiseSpeed: 95, afterburnSpeed: 130,
  accel: 5.5, afterburnAccel: 5.5, retroAccel: 4.0,
  pitchRate: 0.030, yawRate: 0.028, rollRate: 0.040,
};

const deg = (rad) => rad * (180 / Math.PI);

// ---------------------------------------------------------------------------
// 1. terminal velocity == commanded throttle
// ---------------------------------------------------------------------------
test('terminal velocity matches commanded throttle (fighter)', () => {
  for (const throttle of [0, 0.25, 0.5, 0.75, 1]) {
    const h = makeHarness();
    const ship = makeShip(h, { stats: FIGHTER_STATS });
    ship.body.controls.throttle = throttle;
    h.step(60 * 40);
    const expected = throttle * ship.body.tuning.maxSpeed;
    near(ship.body.forwardSpeed, expected, 0.25, `throttle ${throttle} nose speed`);
    near(ship.body.speed, expected, 2.0, `throttle ${throttle} total speed`);
    log(`throttle ${throttle} -> ${fmt(ship.body.speed)} m/s (want ${fmt(expected)})`);
  }
});

test('terminal velocity matches commanded throttle (capital)', () => {
  const h = makeHarness();
  const cap = makeShip(h, { classId: 'confed_carrier', stats: CAPITAL_STATS });
  cap.body.controls.throttle = 0.8;
  h.step(60 * 120);
  near(cap.body.forwardSpeed, 0.8 * cap.body.tuning.maxSpeed, 0.1, 'capital nose speed');
  assert(cap.body.tuning.className === 'capital', 'carrier must resolve to the capital class');
});

test('throttle changes are tracked, not snapped', () => {
  const h = makeHarness();
  const ship = makeShip(h, { stats: FIGHTER_STATS });
  const b = ship.body;
  b.controls.throttle = 1;
  h.step(1);
  assert(b.speed < 10, `one frame at full throttle must not teleport to cruise (got ${fmt(b.speed)})`);
  // Vampire: 480 m/s at 190 m/s^2 -> ~2.5 s. A WC fighter reaches cruise in a
  // couple of seconds; anything under a second reads as a slot car.
  let t = 0;
  while (b.speed < 0.99 * b.tuning.maxSpeed && t < 20) { h.step(1); t += DT; }
  between(t, 1.5, 5.0, 'time to reach 99% of cruise');
  log(`spool-up ${fmt(t)}s`);
});

// ---------------------------------------------------------------------------
// 2. angular rates respect limits
// ---------------------------------------------------------------------------
test('angular rates respect the per-ship limits', () => {
  const h = makeHarness();
  const ship = makeShip(h, { stats: FIGHTER_STATS });
  const b = ship.body;
  const T = b.tuning;
  b.controls.throttle = 1;
  h.step(60 * 6); // get up to speed so authority is full

  const axes = [
    ['pitch', 'x', T.pitchRate],
    ['yaw', 'y', T.yawRate],
    ['roll', 'z', T.rollRate],
  ];
  for (const [ctl, comp, limit] of axes) {
    b.controls.pitch = 0; b.controls.yaw = 0; b.controls.roll = 0;
    h.step(60 * 3);
    b.controls[ctl] = 1;
    let peak = 0;
    for (let i = 0; i < 60 * 8; i++) {
      h.step(1);
      peak = Math.max(peak, Math.abs(b.angularVelocity[comp]));
      assert(b.angularVelocity.length() <= T.maxRate + 1e-9,
        `${ctl}: |w| ${fmt(b.angularVelocity.length())} exceeded max rate ${fmt(T.maxRate)}`);
    }
    near(peak, limit, limit * 1e-6, `${ctl} steady rate`);
    log(`${ctl} steady ${fmt(deg(peak))} deg/s (limit ${fmt(deg(limit))})`);
    b.controls[ctl] = 0;
  }

  // ...and the strong angular damping stops the turn when the stick centres.
  b.controls.yaw = 1;
  h.step(60 * 3);
  b.controls.yaw = 0;
  h.step(Math.round(60 * 1.5));
  assert(Math.abs(b.angularVelocity.y) < T.yawRate * 0.05,
    `yaw should damp out within 1.5s, still ${fmt(deg(b.angularVelocity.y))} deg/s`);
});

test('angular acceleration is real (heavier ships feel heavier)', () => {
  const rise = (stats, classId) => {
    const h = makeHarness();
    const s = makeShip(h, { classId, stats });
    const b = s.body;
    b.controls.throttle = 1;
    h.step(60 * 30);
    b.controls.yaw = 1;
    const target = b.tuning.yawRate * 0.63;
    let t = 0;
    while (Math.abs(b.angularVelocity.y) < target && t < 60) { h.step(1); t += DT; }
    return t;
  };
  const tFighter = rise(FIGHTER_STATS, 'confed_vampire');
  const tCapital = rise(CAPITAL_STATS, 'confed_carrier');
  log(`63% rise time: fighter ${fmt(tFighter)}s, capital ${fmt(tCapital)}s`);
  between(tFighter, 0.1, 1.2, 'fighter rise time');
  assert(tCapital > tFighter * 4, `capital (${fmt(tCapital)}s) must feel far heavier than fighter (${fmt(tFighter)}s)`);
});

test('control authority is reduced at very low speed', () => {
  const h = makeHarness();
  const ship = makeShip(h, { stats: FIGHTER_STATS });
  const b = ship.body;
  b.controls.throttle = 0;
  h.step(60 * 2);
  b.controls.pitch = 1;
  h.step(60 * 4);
  const slow = Math.abs(b.angularVelocity.x);
  b.controls.throttle = 1;
  h.step(60 * 10);
  const fast = Math.abs(b.angularVelocity.x);
  log(`pitch rate stopped ${fmt(deg(slow))} deg/s vs cruising ${fmt(deg(fast))} deg/s`);
  assert(slow < fast * 0.75, 'low-speed authority loss should be noticeable');
  assert(slow > fast * 0.25, 'low-speed authority loss should not be crippling');
});

// ---------------------------------------------------------------------------
// 3. energy stays bounded
// ---------------------------------------------------------------------------
test('energy does not grow unbounded under adversarial input', () => {
  const h = makeHarness();
  const ship = makeShip(h, { stats: FIGHTER_STATS });
  const b = ship.body;
  const T = b.tuning;
  const rng = makeRng(90210);
  const angLimit = T.maxRate + T.trimRate + 1e-6;

  let peakSpeed = 0;
  let peakAng = 0;
  for (let i = 0; i < 60 * 240; i++) {
    if (i % 15 === 0) {
      b.controls.pitch = rng.range(-1, 1);
      b.controls.yaw = rng.range(-1, 1);
      b.controls.roll = rng.range(-1, 1);
      b.controls.throttle = rng();
      b.controls.strafeX = rng.range(-1, 1);
      b.controls.strafeY = rng.range(-1, 1);
      b.controls.afterburner = rng.bool(0.45);
      b.controls.brake = rng.bool(0.15) ? 1 : 0;
      if (rng.bool(0.05)) b.toggleAutoSlide();
    }
    h.step(1);
    peakSpeed = Math.max(peakSpeed, b.speed);
    peakAng = Math.max(peakAng, b.angularVelocity.length());
    assert(Number.isFinite(b.speed) && Number.isFinite(b.position.x), 'state went non-finite');
    assert(b.speed <= T.hardSpeedCap + 1e-6,
      `speed ${fmt(b.speed)} exceeded the hard cap ${fmt(T.hardSpeedCap)} at t=${fmt(i * DT)}`);
    assert(b.angularVelocity.length() <= angLimit,
      `|w| ${fmt(b.angularVelocity.length())} exceeded ${fmt(angLimit)} at t=${fmt(i * DT)}`);
    near(b.quaternion.length(), 1, 1e-9, 'quaternion drifted off unit length');
  }
  log(`peak speed ${fmt(peakSpeed)} (cap ${fmt(T.hardSpeedCap)}), peak |w| ${fmt(deg(peakAng))} deg/s`);
  assert(peakSpeed > T.maxSpeed, 'the burner should have pushed past cruise at some point');
});

// ---------------------------------------------------------------------------
// 4. substepping prevents tunnelling
// ---------------------------------------------------------------------------
function tunnelRun(maxSubsteps, dt = DT) {
  const saved = INTEGRATOR.maxSubsteps;
  INTEGRATOR.maxSubsteps = maxSubsteps;
  try {
    const h = makeHarness();
    // The fastest thing in the game: an interceptor at the top of the WC band.
    const runner = makeShip(h, {
      stats: { ...FIGHTER_STATS, afterburnSpeed: 1600 }, size: [16, 6, 24], position: [0, 0, 0],
    });
    const wall = makeShip(h, {
      stats: FIGHTER_STATS, size: [16, 6, 24], position: [0, 0, -1000],
    });
    wall.body.setStatic(true);

    // Launch straight down -Z at full afterburner speed.
    runner.body.velocity.set(0, 0, -1600);
    runner.body.controls.throttle = 1;
    runner.body.controls.afterburner = true;
    runner.body.assist.enabled = false;
    // No trim wobble — we want a dead-straight ram.
    runner.body.tuning.trimRate = 0;
    runner.body.tuning.trimAccel = 0;

    let maxSub = 0;
    for (let i = 0; i < Math.ceil(2 / dt); i++) {
      h.step(1, dt);
      maxSub = Math.max(maxSub, h.flight.stats.substeps);
      if (h.eventsOf('collision').length) break;
    }
    return { hits: h.eventsOf('collision').length, maxSub, passedZ: runner.body.position.z };
  } finally {
    INTEGRATOR.maxSubsteps = saved;
  }
}

test('substepping prevents tunnelling at 1600 m/s', () => {
  // 60 Hz: 26.7 m of travel per frame against a 24 m hull.
  const at60 = tunnelRun(INTEGRATOR.maxSubsteps, 1 / 60);
  assert(at60.hits > 0,
    `a 1600 m/s ram must register a collision (ship ended at z=${fmt(at60.passedZ)})`);
  assert(at60.maxSub > 1, 'the integrator should have substepped');
  log(`60 Hz: ${at60.hits} collision event(s), ${at60.maxSub} substeps/frame`);

  // 20 Hz (a bad hitch): 80 m of travel per frame against a 29 m contact
  // envelope. Single-stepped, the ship goes clean through — precisely the
  // failure substepping exists to prevent...
  const control = tunnelRun(1, 1 / 20);
  assert(control.hits === 0,
    'the single-step control run should tunnel — if it does not, the test proves nothing');
  assert(control.passedZ < -1100, 'the control run should have passed clean through the target');
  log(`20 Hz single-step control tunnelled to z=${fmt(control.passedZ)} as expected`);

  // ...and with substepping restored, the same frame budget catches it.
  const at20 = tunnelRun(INTEGRATOR.maxSubsteps, 1 / 20);
  assert(at20.hits > 0, 'substepping must catch the ram through a 20 Hz hitch too');
  log(`20 Hz substepped: ${at20.hits} collision event(s), ${at20.maxSub} substeps/frame`);
});

test('collisions apply impulse, damage and shake', () => {
  const h = makeHarness();
  const a = makeShip(h, { stats: FIGHTER_STATS, size: [16, 6, 24], position: [0, 0, 0] });
  const b = makeShip(h, { stats: FIGHTER_STATS, size: [16, 6, 24], position: [0, 0, -300] });
  a.body.velocity.set(0, 0, -300);
  a.body.controls.throttle = 0.6;
  b.body.controls.throttle = 0;
  h.step(60 * 3);

  const hits = h.eventsOf('collision');
  assert(hits.length > 0, 'head-on approach must collide');
  const ev = hits[0].payload;
  assert(ev.kind === 'ship', 'kind should be "ship"');
  assert(ev.damageA > 0 && ev.damageB > 0, 'both hulls should take damage');
  assert(ev.relativeSpeed > 100, `closing speed should be substantial, got ${fmt(ev.relativeSpeed)}`);
  assert(b.body.speed > 5, 'the struck ship must be pushed');
  assert(a.body.shake > 0 && b.body.shake > 0, 'both ships should shake');
  assert(h.eventsOf('shield:impact').length >= 2, 'a hull strike should raise shield impacts');
  // ...and they must not end up interpenetrating.
  const sep = a.body.position.distanceTo(b.body.position);
  assert(sep > 8, `hulls should be pushed apart, separation ${fmt(sep)}`);
  log(`impact ${fmt(ev.relativeSpeed)} m/s -> dmg ${fmt(ev.damageA)}/${fmt(ev.damageB)}`);
});

test('asteroid queries are used when the world provides them', () => {
  const h = makeHarness();
  h.game.world = {
    queryAsteroids(sphere) {
      assert(sphere && typeof sphere.radius === 'number', 'query should receive a sphere');
      return [{ position: new THREE.Vector3(0, 0, -500), radius: 60 }];
    },
  };
  const ship = makeShip(h, { stats: FIGHTER_STATS, size: [16, 6, 24] });
  ship.body.velocity.set(0, 0, -400);
  ship.body.controls.throttle = 0.9;
  h.step(60 * 3);
  const hits = h.eventsOf('collision').filter((e) => e.payload.kind === 'asteroid');
  assert(hits.length > 0, 'ship should bounce off the asteroid');
  assert(ship.body.velocity.z > -400, 'the impulse should have slowed the ship down');
  log(`asteroid impact at ${fmt(hits[0].payload.relativeSpeed)} m/s`);
});

test('a missing world query is harmless', () => {
  const h = makeHarness();
  h.game.world = { queryAsteroids() { throw new Error('world exploded'); } };
  const ship = makeShip(h, { stats: FIGHTER_STATS });
  ship.body.controls.throttle = 1;
  h.step(120);
  assert(Number.isFinite(ship.body.speed), 'a broken world query must not take flight down');
});

// ---------------------------------------------------------------------------
// 5. determinism
// ---------------------------------------------------------------------------
function scenarioRun(seed) {
  const h = makeHarness({ seed });
  const ships = [
    makeShip(h, { stats: FIGHTER_STATS, size: [16, 6, 24], position: [0, 0, 0], faction: 'confed' }),
    makeShip(h, { stats: FIGHTER_STATS, size: [16, 6, 24], position: [40, 10, -120], faction: 'confed' }),
    makeShip(h, { stats: { ...FIGHTER_STATS, maxSpeed: 380 }, size: [18, 7, 22], position: [-90, -30, -600], faction: 'nephilim' }),
    makeShip(h, { classId: 'confed_carrier', stats: CAPITAL_STATS, size: [120, 90, 700], position: [300, 0, -2400], faction: 'confed' }),
  ];
  const rng = makeRng(seed ^ 0x5eed);
  h.flight.engageAutopilot(ships[1], new THREE.Vector3(0, 0, -8000), { abortOnHostiles: false });

  let hash = 2166136261 >>> 0;
  const buf = new Float64Array(16);
  const bytes = new Uint8Array(buf.buffer);

  for (let i = 0; i < 60 * 45; i++) {
    if (i % 20 === 0) {
      for (const s of ships) {
        if (s.body.autopilot) continue;
        s.body.controls.pitch = rng.range(-1, 1);
        s.body.controls.yaw = rng.range(-1, 1);
        s.body.controls.roll = rng.range(-1, 1);
        s.body.controls.throttle = rng();
        s.body.controls.afterburner = rng.bool(0.3);
      }
    }
    h.step(1);
    for (const s of ships) {
      const snap = s.body.snapshot();
      buf.fill(0);
      for (let k = 0; k < snap.length && k < buf.length; k++) buf[k] = snap[k];
      for (let k = 0; k < bytes.length; k++) {
        hash ^= bytes[k];
        hash = Math.imul(hash, 16777619) >>> 0;
      }
    }
  }
  return { hash, final: ships.map((s) => s.body.snapshot()), events: h.events.length };
}

test('repeated runs are bit-identical', () => {
  const a = scenarioRun(4242);
  const b = scenarioRun(4242);
  assert(a.hash === b.hash, `state hash differs: ${a.hash} vs ${b.hash}`);
  assert(a.events === b.events, `event count differs: ${a.events} vs ${b.events}`);
  for (let s = 0; s < a.final.length; s++) {
    for (let i = 0; i < a.final[s].length; i++) {
      // Bit-exact, not approximate: Object.is separates -0 from 0 and catches NaN.
      assert(Object.is(a.final[s][i], b.final[s][i]),
        `ship ${s} field ${i} differs: ${a.final[s][i]} vs ${b.final[s][i]}`);
    }
  }
  const c = scenarioRun(99);
  assert(c.hash !== a.hash, 'a different seed should produce a different trajectory');
  log(`hash ${a.hash} reproduced exactly over ${60 * 45} frames × 4 ships`);
});

test('the integrator is frame-rate independent', () => {
  const settle = (dt) => {
    const h = makeHarness();
    const s = makeShip(h, { stats: FIGHTER_STATS });
    s.body.tuning.trimRate = 0;
    s.body.tuning.trimAccel = 0;
    s.body.controls.throttle = 0.7;
    s.body.controls.yaw = 0.5;
    h.step(Math.round(30 / dt), dt);
    return { speed: s.body.forwardSpeed, yawRate: s.body.angularVelocity.y };
  };
  const a = settle(1 / 60);
  const b = settle(1 / 240);
  const c = settle(1 / 30);
  near(b.speed, a.speed, 0.5, 'terminal speed must not depend on dt');
  near(c.speed, a.speed, 0.5, 'terminal speed must not depend on dt');
  near(b.yawRate, a.yawRate, Math.abs(a.yawRate) * 0.01, 'steady turn rate must not depend on dt');
  near(c.yawRate, a.yawRate, Math.abs(a.yawRate) * 0.01, 'steady turn rate must not depend on dt');
  log(`speed @60/240/30 Hz: ${fmt(a.speed)} / ${fmt(b.speed)} / ${fmt(c.speed)}`);
});

// ---------------------------------------------------------------------------
// feel: slip, auto-slide, RCS, full stop, afterburner
// ---------------------------------------------------------------------------
test('lateral slip: the velocity vector lags a hard turn, then realigns', () => {
  const h = makeHarness();
  const ship = makeShip(h, { stats: FIGHTER_STATS });
  const b = ship.body;
  b.controls.throttle = 1;
  h.step(60 * 8);
  near(b.slipAngle, 0, 0.02, 'straight and level should not slip');

  b.controls.yaw = 1;
  let peak = 0;
  for (let i = 0; i < 60 * 3; i++) { h.step(1); peak = Math.max(peak, b.slipAngle); }
  log(`peak slip in a hard turn: ${fmt(deg(peak))} deg`);
  between(deg(peak), 8, 70, 'slip angle in a sustained hard turn');

  b.controls.yaw = 0;
  h.step(60 * 4);
  assert(deg(b.slipAngle) < 1.5, `slip should wash out when wings level, got ${fmt(deg(b.slipAngle))} deg`);
});

test('auto-slide decouples facing from velocity', () => {
  const measure = (autoSlide) => {
    const h = makeHarness();
    const ship = makeShip(h, { stats: FIGHTER_STATS });
    const b = ship.body;
    b.controls.throttle = 1;
    h.step(60 * 8);
    b.setAutoSlide(autoSlide);
    b.controls.yaw = 1;
    h.step(60 * 2);
    return b.slipAngle;
  };
  const normal = measure(false);
  const slide = measure(true);
  log(`slip after 2s of yaw: normal ${fmt(deg(normal))} deg, auto-slide ${fmt(deg(slide))} deg`);
  assert(slide > normal * 2, 'auto-slide should slide far more than the normal flight model');
  assert(deg(slide) > 80, 'auto-slide should let the nose come right round off the velocity vector');
});

test('RCS thrusters translate laterally', () => {
  const h = makeHarness();
  const ship = makeShip(h, { stats: FIGHTER_STATS });
  const b = ship.body;
  b.controls.throttle = 0;
  h.step(60);
  const x0 = b.position.x;
  b.controls.strafeX = 1;
  h.step(60 * 3);
  const lateral = b.velocity.dot(b.right);
  log(`strafe: ${fmt(lateral)} m/s sideways, moved ${fmt(b.position.x - x0)} m`);
  assert(lateral > 20, `RCS should build real lateral speed, got ${fmt(lateral)}`);
  assert(b.position.x - x0 > 20, 'and actually translate');
  b.controls.strafeX = 0;
  h.step(60 * 5);
  assert(Math.abs(b.velocity.dot(b.right)) < 2, 'lateral speed should bleed off when the RCS stops');
});

test('full stop decelerates believably, not instantly', () => {
  const h = makeHarness();
  const ship = makeShip(h, { stats: FIGHTER_STATS });
  const b = ship.body;
  b.controls.throttle = 1;
  h.step(60 * 10);
  const v0 = b.speed;
  assert(v0 > 400, 'should be at cruise before stopping');

  b.requestFullStop(true);
  let t = 0;
  let prev = b.speed;
  let monotone = true;
  while (b.fullStopActive && t < 30) {
    h.step(1); t += DT;
    if (b.speed > prev + 0.5) monotone = false;
    prev = b.speed;
  }
  log(`full stop from ${fmt(v0)} m/s took ${fmt(t)}s`);
  assert(monotone, 'speed should fall monotonically during a full stop');
  between(t, 1.2, 12, 'full-stop duration');
  assert(b.speed < 1, `should be at rest, got ${fmt(b.speed)} m/s`);
  assert(b.controls.throttle === 0, 'full stop should leave the throttle closed');

  // ...but never *perfectly* still: idle trim keeps the hull alive.
  const p0 = b.position.clone();
  h.step(60 * 5);
  assert(b.position.distanceTo(p0) > 1e-4, 'a "stationary" ship must still drift a little');
  assert(b.position.distanceTo(p0) < 5, 'idle drift must stay tiny');
});

test('afterburner: overspeed, fuel drain, burnout, distinct falloff', () => {
  const h = makeHarness();
  const ship = makeShip(h, { stats: FIGHTER_STATS });
  const b = ship.body;
  const T = b.tuning;
  b.controls.throttle = 1;
  h.step(60 * 8);
  const cruise = b.speed;
  near(cruise, T.maxSpeed, 2, 'cruise speed');
  between(T.abSpeed, 1200, 1600, 'afterburner top speed must land in the WC band');

  b.controls.afterburner = true;
  let t = 0;
  while (b.fuel > 0 && t < 30) { h.step(1); t += DT; }
  log(`burner ran ${fmt(t)}s before burnout; peak ${fmt(b.speed)} m/s`);
  between(t, 6, 14, 'burner endurance');
  assert(b.burnout, 'running the tank dry must trigger burnout');
  assert(b.speed > T.maxSpeed * 2.5, `should have reached overspeed, got ${fmt(b.speed)}`);

  // Burnout: holding the key does nothing until the tank recovers.
  h.step(1);
  assert(!b.afterburner, 'burnout must lock the burner out');
  b.controls.afterburner = false;

  // Falling back to the commanded speed takes a few seconds — not instant, and
  // firmer than a normal coast-down.
  let tDown = 0;
  while (b.speed > cruise * 1.02 && tDown < 30) { h.step(1); tDown += DT; }
  log(`burner falloff ${fmt(tDown)}s`);
  between(tDown, 1.0, 8.0, 'afterburner deceleration back to cruise');
  h.step(60);
  assert(!b.afterburner && b.burnout, 'burnout should persist until the tank recovers');

  // Fuel regenerates slowly.
  const fuelBefore = b.fuel;
  h.step(60 * 10);
  assert(b.fuel > fuelBefore, 'fuel should regenerate');
  assert(b.fuel < 1, 'fuel regeneration should be slow, not instant');
});

test('idle trim keeps a hands-off ship alive', () => {
  const h = makeHarness();
  const ship = makeShip(h, { stats: FIGHTER_STATS });
  const b = ship.body;
  const q0 = b.quaternion.clone();
  h.step(60 * 10);
  assert(b.quaternion.angleTo(q0) > 1e-4, 'a hands-off ship should wander a little');
  assert(deg(b.quaternion.angleTo(q0)) < 8, 'idle trim must stay subtle');
  assert(b.speed < 1, 'idle trim must not build real speed');
});

test('a pinned (static) body holds station for beauty shots', () => {
  const h = makeHarness();
  const ship = makeShip(h, { stats: FIGHTER_STATS, position: [3, 4, 5] });
  ship.body.controls.throttle = 0.35;
  ship.body.setStatic(true);
  h.step(60 * 10);
  const d = ship.body.position.distanceTo(new THREE.Vector3(3, 4, 5));
  assert(d < 1, `a pinned ship must not translate, drifted ${fmt(d)} m`);
  assert(d > 0, 'but still is not perfectly frozen');
});

// ---------------------------------------------------------------------------
// derived values other systems consume
// ---------------------------------------------------------------------------
test('published derived values are sane', () => {
  const h = makeHarness();
  const ship = makeShip(h, { stats: FIGHTER_STATS });
  const b = ship.body;
  b.controls.throttle = 1;
  h.step(60 * 8);
  near(b.forward.length(), 1, 1e-9, 'forward should be unit length');
  near(b.right.length(), 1, 1e-9, 'right should be unit length');
  near(b.up.length(), 1, 1e-9, 'up should be unit length');
  near(b.forward.dot(b.right), 0, 1e-9, 'basis should be orthogonal');
  assert(b.forward.z < -0.99, 'default facing should be -Z (three.js convention)');
  near(b.gLoad, 0, 0.05, 'straight and level should read ~0 G');

  b.controls.yaw = 1;
  h.step(60 * 2);
  between(b.gLoad, 1.5, 12, 'a hard corner should read as a few G');
  assert(b.gLoadRaw > b.gLoad, 'raw G should exceed inertially damped G');
  log(`hard corner: ${fmt(b.gLoad)} G felt, ${fmt(b.gLoadRaw)} G raw`);
});

test('the transform is written back onto ship.group, and external writes win', () => {
  const h = makeHarness();
  const ship = makeShip(h, { stats: FIGHTER_STATS });
  ship.body.controls.throttle = 1;
  h.step(60 * 2);
  assert(ship.group.position.distanceTo(ship.body.position) === 0, 'group must track the body');
  assert(ship.group.position.z < -50, 'the ship should have travelled');

  // A shot scene / mission script writes straight onto the group: it wins.
  ship.group.position.set(1000, 0, 0);
  ship.group.rotation.set(0.06, -0.72, 0.14);
  const q = ship.group.quaternion.clone();
  h.step(1);
  near(ship.body.position.distanceTo(new THREE.Vector3(1000, 0, 0)), 0, 12,
    'the body should adopt an externally written position');
  assert(ship.body.quaternion.angleTo(q) < 0.05, 'the body should adopt an externally written rotation');
});

// ---------------------------------------------------------------------------
// autopilot
// ---------------------------------------------------------------------------
test('autopilot flies to a nav point and arrives', () => {
  const h = makeHarness();
  const ship = makeShip(h, { stats: FIGHTER_STATS });
  const target = new THREE.Vector3(14_000, 2_000, -9_000);
  // Start pointing 90 degrees off so the align phase gets exercised.
  const ok = h.flight.engageAutopilot(ship, target);
  assert(ok, 'autopilot should engage with no hostiles about');
  assert(h.eventsOf('autopilot:engaged').length === 1, 'engage event');

  let t = 0;
  let peak = 0;
  while (ship.body.autopilot && t < 300) {
    h.step(1); t += DT;
    peak = Math.max(peak, ship.body.speed);
  }
  const dist = ship.body.position.distanceTo(target);
  log(`autopilot: ${fmt(t)}s, peak ${fmt(peak)} m/s, final range ${fmt(dist)} m`);
  assert(h.eventsOf('autopilot:complete').length === 1, 'should report completion');
  assert(dist < ship.body.tuning.apArriveRadius * 1.5, `should arrive, ended ${fmt(dist)} m out`);
  assert(ship.body.speed < 120, `should arrive slowly, at ${fmt(ship.body.speed)} m/s`);
  assert(peak > ship.body.tuning.maxSpeed, 'should have used the burner on a long leg');
});

test('autopilot aborts when hostiles are near', () => {
  const h = makeHarness();
  const ship = makeShip(h, { stats: FIGHTER_STATS, faction: 'confed' });
  makeShip(h, { stats: FIGHTER_STATS, faction: 'nephilim', position: [0, 0, -1200] });
  const ok = h.flight.engageAutopilot(ship, new THREE.Vector3(0, 0, -40_000));
  assert(!ok, 'engaging with a hostile 1.2 km away should be refused');
  assert(h.eventsOf('autopilot:abort').length === 1, 'abort event');
  assert(!ship.body.autopilot, 'autopilot must not stay engaged');
});

test('autopilot aborts mid-flight when a hostile shows up', () => {
  const h = makeHarness();
  const ship = makeShip(h, { stats: FIGHTER_STATS, faction: 'confed' });
  assert(h.flight.engageAutopilot(ship, new THREE.Vector3(0, 0, -60_000)), 'engage');
  h.step(60 * 5);
  assert(ship.body.autopilot, 'still under autopilot');
  const bogey = makeShip(h, { stats: FIGHTER_STATS, faction: 'nephilim' });
  bogey.body.position.copy(ship.body.position).add(new THREE.Vector3(0, 0, -900));
  bogey.group.position.copy(bogey.body.position);
  h.step(60);
  assert(!ship.body.autopilot, 'autopilot should have dropped');
  assert(h.eventsOf('autopilot:abort').length === 1, 'abort event');
});

// ---------------------------------------------------------------------------
// contract / robustness
// ---------------------------------------------------------------------------
test('the system exposes the contracted shape', () => {
  const h = makeHarness();
  const f = h.flight;
  assert(f.name === 'flight', 'name');
  assert(f.priority === 200, 'priority');
  for (const fn of ['update', 'attach', 'detach', 'dispose', 'engageAutopilot', 'getBody']) {
    assert(typeof f[fn] === 'function', `missing ${fn}()`);
  }
  const ship = makeShip(h, { stats: FIGHTER_STATS });
  assert(ship.body, 'attach must create ship.body');
  for (const k of ['position', 'quaternion', 'velocity', 'angularVelocity', 'controls', 'stats']) {
    assert(ship.body[k] != null, `FlightBody must expose ${k}`);
  }
  for (const k of ['pitch', 'yaw', 'roll', 'throttle', 'afterburner', 'strafeX', 'strafeY', 'brake']) {
    assert(k in ship.body.controls, `controls must expose ${k}`);
  }
  assert(f.attach(ship) === ship.body, 'attach must be idempotent');
  assert(f.detach(ship) === true, 'detach');
  assert(ship.body == null, 'detach must clear ship.body');
  f.dispose();
});

test('ships with no stat block still fly (agent-ships not landed yet)', () => {
  const h = makeHarness();
  const ship = makeShip(h, { stats: null });
  ship.body.controls.throttle = 1;
  h.step(60 * 8);
  between(ship.body.speed, 180, 620, 'a statless ship must fall back to sane fighter defaults');
  assert(ship.body.tuning.className === 'fighter', 'default class');
});

test('mis-united and absurd stats are clamped into a flyable range', () => {
  const radians = resolveTuning(
    { mass: 14000, maxSpeed: 450, accel: 125, pitchRate: 1.4, yawRate: 1.2, rollRate: 2.9, rateUnits: 'rad' },
    'confed_vampire',
  );
  between(deg(radians.pitchRate), 60, 110, 'rad-declared pitch rate');
  const absurd = resolveTuning({ maxSpeed: 99_000, accel: 1e9, pitchRate: 100_000 }, 'confed_vampire');
  between(absurd.maxSpeed, 180, 620, 'absurd maxSpeed clamped');
  between(deg(absurd.pitchRate), 45, 120, 'absurd pitch rate clamped');
});

test('a destroyed hull coasts instead of flying', () => {
  const h = makeHarness();
  const ship = makeShip(h, { stats: FIGHTER_STATS });
  ship.body.controls.throttle = 1;
  h.step(60 * 8);
  const v = ship.body.velocity.clone();
  ship.alive = false;
  ship.body.controls.throttle = 1;
  ship.body.controls.pitch = 1;
  h.step(60 * 5);
  near(ship.body.speed, v.length(), 1.0, 'a dead hull should coast at its last velocity');
  assert(ship.body.angularVelocity.length() < 0.05, 'a dead hull should not steer');
});

// ---------------------------------------------------------------------------
console.log('');
if (failures.length) {
  console.log(`FLIGHT SELFTEST: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log(`FLIGHT SELFTEST: ${passed} passed, 0 failed`);
process.exit(0);
