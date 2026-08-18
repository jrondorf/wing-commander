/**
 * src/ai/capital.js — capital-ship AI: turrets, point defence, and the slow
 * business of bringing a broadside to bear.
 *
 * A capital ship is not a big fighter. It has three separate brains:
 *
 *   1. **Turrets** — independent gunners, each with a physical arc they cannot
 *      shoot through, their own slew rate, their own lead solution and their own
 *      trigger discipline. Independence is what makes a capship read as *crewed*.
 *   2. **Point defence** — a subset of turrets that drop everything for an
 *      inbound missile, because a hit missile is worth ten hit fighters.
 *   3. **The bridge** — a very slow steering loop that tries to put the main
 *      threat on the beam, where the most guns bear, and away from the engines.
 *
 * Everything degrades gracefully: if `hardpoints.turrets` is missing or shaped
 * differently than expected, the ship simply flies and does not shoot.
 */
import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothRange, leadPoint, solveSteering, DEG, hash01 } from './aimath.js';
import { isHostile, isCapital } from './threat.js';

const _wp = new THREE.Vector3(); // turret world position
const _wd = new THREE.Vector3(); // turret world base direction
const _to = new THREE.Vector3();
const _lead = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _q = new THREE.Quaternion();

const V3 = (v, fallback) => {
  if (!v) return fallback.clone();
  if (v.isVector3) return v.clone();
  if (Array.isArray(v)) return new THREE.Vector3(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
  if (typeof v === 'object' && 'x' in v) return new THREE.Vector3(v.x ?? 0, v.y ?? 0, v.z ?? 0);
  return fallback.clone();
};

/**
 * Build turret records from whatever ships/ declared. Tolerates:
 *   { pos|position, dir|direction|normal, arc, type|role, speed, range, node }
 */
export function buildTurrets(ship, rngSeed) {
  const src = ship?.hardpoints?.turrets;
  if (!Array.isArray(src) || !src.length) return [];
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const t = src[i] ?? {};
    const pos = V3(t.pos ?? t.position, new THREE.Vector3());
    const dir = V3(t.dir ?? t.direction ?? t.normal, new THREE.Vector3(0, 1, 0)).normalize();
    const role = t.type ?? t.role ?? (t.pointDefence ? 'pd' : i % 3 === 0 ? 'pd' : 'gun');
    const pd = role === 'pd' || role === 'pointDefence' || t.pointDefence === true;
    out.push({
      index: i,
      hp: t,
      pos,
      dir,
      arc: t.arc ?? (pd ? 150 * DEG : 110 * DEG), // half-angle from `dir`
      pd,
      speed: t.speed ?? (pd ? 2200 : 1600),
      range: t.range ?? (pd ? 2200 : 4200),
      slew: t.slew ?? (pd ? 2.4 : 1.1), // rad/s
      aim: dir.clone(),
      target: null,
      firing: false,
      good: 0,
      burst: 0,
      gap: hash01(rngSeed, i) * 0.5,
      seed: (rngSeed | 0) + i * 7919,
    });
  }
  return out;
}

/**
 * Score a target for one turret. Point-defence turrets see missiles as
 * overwhelmingly the most important thing in the sky; main batteries prefer
 * whatever is closest and actually inside their arc.
 */
function pickTurretTarget(turret, ship, ai, shipBody) {
  let best = null;
  let bestScore = -Infinity;

  const consider = (obj, pos, vel, weight) => {
    _to.copy(pos).sub(_wp);
    const d = _to.length();
    if (d > turret.range || d < 1e-3) return;
    _to.multiplyScalar(1 / d);
    const off = Math.acos(clamp(_wd.dot(_to), -1, 1));
    if (off > turret.arc) return; // physically cannot traverse there
    let sc = weight + (1 - smoothRange(d, 200, turret.range)) * 60;
    sc += (1 - smoothRange(off, 0, turret.arc)) * 20;
    if (sc > bestScore) {
      bestScore = sc;
      best = { obj, pos, vel };
    }
  };

  if (turret.pd) {
    for (const m of ai.missiles) {
      if (!m.alive) continue;
      if (m.target && m.target !== ship && !isCapital(m.target)) continue;
      if (m.shooter && !isHostile(ship, m.shooter)) continue;
      consider(m.obj, m.pos, m.vel, 400);
    }
  }

  const ships = ai.contacts;
  for (let i = 0; i < ships.length; i++) {
    const s = ships[i];
    if (s === ship || s.alive === false || !isHostile(ship, s)) continue;
    const b = ai.bodyOf(s);
    if (!b) continue;
    // Main batteries against fighters, but never waste the whole broadside on
    // one fighter while a hostile capital is in range.
    consider(s, b.position, b.velocity ?? _tmp.set(0, 0, 0), isCapital(s) ? 120 : turret.pd ? 10 : 40);
  }
  return best;
}

/** One turret: choose, slew, lead, fire. */
function updateTurret(turret, ship, body, ai, dt) {
  _wp.copy(turret.pos).applyQuaternion(body.quaternion).add(body.position);
  _wd.copy(turret.dir).applyQuaternion(body.quaternion);

  turret.retarget = (turret.retarget ?? 0) - dt;
  if (turret.retarget <= 0 || !turret.target || turret.target.alive === false) {
    const pick = pickTurretTarget(turret, ship, ai, body);
    turret.target = pick?.obj ?? null;
    turret.targetPos = pick?.pos ?? null;
    turret.targetVel = pick?.vel ?? null;
    turret.retarget = 0.35 + hash01(turret.seed, ai.frame & 1023) * 0.3;
  } else {
    // Refresh the cached kinematics of the object we already chose.
    const b = ai.bodyOf(turret.target);
    if (b) {
      turret.targetPos = b.position;
      turret.targetVel = b.velocity ?? null;
    } else {
      const m = ai.missiles.find((x) => x.obj === turret.target && x.alive);
      if (m) {
        turret.targetPos = m.pos;
        turret.targetVel = m.vel;
      } else {
        turret.target = null;
      }
    }
  }

  if (!turret.target || !turret.targetPos) {
    // Idle: drift back to the rest position so a becalmed capship still looks
    // alive rather than frozen mid-track.
    turret.aim.lerp(_wd, 1 - Math.exp(-dt * 0.7)).normalize();
    turret.firing = false;
    applyTurretNodes(turret, body);
    return;
  }

  const tof = leadPoint(_wp, body.velocity ?? _tmp.set(0, 0, 0), turret.targetPos, turret.targetVel ?? _tmp.set(0, 0, 0), turret.speed, _lead);
  if (tof < 0) {
    turret.firing = false;
    applyTurretNodes(turret, body);
    return;
  }

  _aim.copy(_lead).sub(_wp);
  const dist = _aim.length();
  if (dist < 1e-3) return;
  _aim.multiplyScalar(1 / dist);

  // Clamp the demand into the arc: a turret does not shoot through its own hull.
  const off = Math.acos(clamp(_wd.dot(_aim), -1, 1));
  if (off > turret.arc) {
    _tmp.copy(_wd).cross(_aim);
    if (_tmp.lengthSq() > 1e-9) {
      _q.setFromAxisAngle(_tmp.normalize(), turret.arc);
      _aim.copy(_wd).applyQuaternion(_q);
    }
  }

  // Slew at a finite rate — instant tracking is the classic tell of fake turrets.
  const maxStep = turret.slew * dt;
  const cur = turret.aim;
  const ang = Math.acos(clamp(cur.dot(_aim), -1, 1));
  if (ang > maxStep) {
    _tmp.copy(cur).cross(_aim);
    if (_tmp.lengthSq() > 1e-9) {
      _q.setFromAxisAngle(_tmp.normalize(), maxStep);
      cur.applyQuaternion(_q).normalize();
    }
  } else {
    cur.copy(_aim);
  }

  const onTarget = ang < (turret.pd ? 0.05 : 0.03) && dist < turret.range;
  turret.good = onTarget ? turret.good + dt : 0;
  const ready = turret.good > (turret.pd ? 0.06 : 0.22);

  // Burst discipline, slightly different per turret so a broadside ripples.
  turret.gap -= dt;
  if (ready && turret.gap <= 0) {
    turret.firing = true;
    turret.burst -= dt;
    if (turret.burst <= 0) {
      turret.burst = turret.pd ? 0.18 : lerp(0.35, 0.8, hash01(turret.seed, 9));
      turret.gap = turret.pd ? 0.1 : lerp(0.4, 1.2, hash01(turret.seed, 11));
      const combat = ai.engine.game?.combat;
      if (combat?.fireTurret) {
        try {
          combat.fireTurret(ship, turret.index, cur, turret.target);
        } catch { /* combat/ still under construction */ }
      } else {
        ai.engine.events?.emit('weapon:fired', {
          ship,
          turret: turret.index,
          position: _wp.clone(),
          direction: cur.clone(),
          speed: turret.speed,
          kind: turret.pd ? 'pointDefence' : 'turret',
        });
      }
    }
  } else {
    turret.firing = false;
  }

  applyTurretNodes(turret, body);
}

/**
 * Drive any Object3D the ship builder attached to the hardpoint so the turret
 * visibly tracks. Optional on both sides of the contract.
 */
function applyTurretNodes(turret, body) {
  const hp = turret.hp;
  const yawNode = hp?.yawNode ?? hp?.node ?? hp?.mesh;
  const pitchNode = hp?.pitchNode;
  if (!yawNode?.isObject3D) return;

  // Express the aim in the ship's frame, then in the turret's mount frame.
  _tmp.copy(turret.aim).applyQuaternion(_q.copy(body.quaternion).conjugate());
  const yaw = Math.atan2(_tmp.x, -_tmp.z);
  const pitch = Math.asin(clamp(_tmp.y, -1, 1));
  yawNode.rotation.y = yaw;
  if (pitchNode?.isObject3D) pitchNode.rotation.x = -pitch;
  else yawNode.rotation.x = -pitch * 0.35;
}

/**
 * Capital-ship helm.
 *
 * Goal: put the biggest threat on the beam (90° off the nose) so the maximum
 * number of turrets bear, while keeping the engines pointed away from it.
 * Rates are an order of magnitude below a fighter's, so this reads as a ship of
 * the line leaning into a turn over ten or twenty seconds.
 */
export function updateCapitalHelm(pilot, ctx, ai, dt) {
  const body = ctx.body;
  if (!body) return;
  const intent = ctx.intent;

  const threat = pilot.target ?? pilot.threat;
  const tb = threat ? ai.bodyOf(threat) : null;

  if (!tb) {
    // No contact: hold course, slow cruise.
    intent.aim.copy(ctx.fwd);
    intent.throttle = 0.28;
    intent.ab = 0;
    intent.label = 'station';
    return;
  }

  _to.copy(tb.position).sub(body.position);
  const range = _to.length();
  if (range > 1e-3) _to.multiplyScalar(1 / range);

  _up.set(0, 1, 0).applyQuaternion(body.quaternion);
  // Rotate the threat bearing 90° about our up axis: that heading puts them
  // abeam. Choose the side that is the shorter turn.
  _tmp.copy(_to).cross(_up);
  const side = _tmp.dot(_fwd.set(0, 0, -1).applyQuaternion(body.quaternion)) >= 0 ? 1 : -1;
  _q.setFromAxisAngle(_up, side * Math.PI * 0.5);
  _aim.copy(_to).applyQuaternion(_q).normalize();

  // Very close in, stop presenting the beam and just get the nose off them so
  // fighters cannot run the length of the hull.
  if (range < 900) _aim.lerp(_to, 0.35).normalize();

  intent.aim.copy(_aim);
  intent.throttle = range > 6000 ? 0.55 : 0.3;
  intent.ab = 0;
  intent.levelWeight = 0.9;
  intent.label = 'broadside';
}

/** Per-frame entry point for a capital ship's turret battery. */
export function updateTurrets(pilot, ctx, ai, dt) {
  const body = ctx.body;
  if (!body || !pilot.turrets?.length) return;
  // Stagger: a big ship's turrets do not all re-evaluate on the same frame.
  for (let i = 0; i < pilot.turrets.length; i++) {
    updateTurret(pilot.turrets[i], pilot.ship, body, ai, dt);
  }
  // Publish for cockpit/vfx/debug consumers.
  pilot.ship.turretAim = pilot.turrets.map((t) => ({
    index: t.index,
    aim: t.aim,
    target: t.target,
    firing: t.firing,
    pd: t.pd,
  }));
}
