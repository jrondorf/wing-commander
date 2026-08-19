/**
 * src/combat/missiles.js — seekers, guidance, countermeasures.
 *
 * ## The types, and how you beat each one
 *
 *   dumbfire   No seeker. Point the ship, launch, hope. Cheap and enormous.
 *   heat (IR)  Rear-aspect only. It is looking at your *engines*, so it can
 *              only be fired from inside your rear cone — and if you chop the
 *              throttle and kill the burner, its track quality decays and it
 *              goes ballistic. Afterburner discipline defeats it. Flares help
 *              a little.
 *   image      Image-recognition, all-aspect: it does not care where your
 *              tailpipe is, so there is no safe geometry. It is however
 *              looking at a *picture*, which is exactly what a decoy is, so
 *              decoys defeat it — and nothing else does.
 *   FF         Friend-or-foe. Fire-and-forget into a furball; it picks the
 *              nearest thing in the launch cone that is not yours.
 *   torpedo    Capital-ship killer. Ten and a half seconds of lock, held
 *              steady, while every turret on the target shoots at you. This is
 *              the Wing Commander bomber run, and it is meant to hurt.
 *
 * ## Guidance
 *
 * True proportional navigation:
 *
 *   Ω = (R × V) / (R·R)          LOS rotation vector
 *   a = N · (V × Ω)              commanded lateral acceleration
 *
 * with `a` clamped by the airframe's lateral-g limit *and* by its turn rate, and
 * thrust applied along the body axis only while the motor burns. After burnout
 * the missile coasts ballistic — which is why a late launch at long range is a
 * wasted missile, and why breaking *early* works.
 */
import * as THREE from 'three';
import { makeRng, hashSeed } from '../core/Rand.js';
import {
  clamp, clamp01, lerp, num, isAlive, isHostile, isCapitalShip,
  shipPosition, shipVelocity, shipForward, shipRadius,
  segmentVsOBB, segmentNearSphere, makeHitRef,
} from './util.js';

// ---------------------------------------------------------------------------
// the missile table
// ---------------------------------------------------------------------------

const T = (o) => Object.freeze(o);

/**
 * Per type:
 *   seeker       'none' | 'ir' | 'image' | 'ff' | 'torpedo'
 *   damage       direct-hit damage
 *   blast        blast radius, metres (falls off quadratically)
 *   proximity    proximity-fuse radius, metres
 *   thrust       motor acceleration, m/s²
 *   burn         motor burn time, seconds — after this it coasts, ballistic
 *   coast        extra seconds of flight before self-destruct
 *   maxSpeed     speed cap (raised to stay ahead of a fast launch platform)
 *   maxLateral   airframe lateral acceleration limit, m/s²
 *   turnRate     airframe turn-rate limit, rad/s
 *   N            proportional-navigation gain
 *   lockTime     base seconds to acquire, before aspect/range factors
 *   lockRange    maximum acquisition range, metres
 *   gimbal       seeker head half-angle off the launcher's nose, radians
 *   fov          seeker half-angle off the missile's own axis, radians
 *   rearCone     (ir) half-angle around the target's tail it can see, radians
 *   heatFloor    (ir) engine output below which the track starts to decay
 *   decoyProne   0..1 susceptibility to a decoy in the seeker basket
 */
export const MISSILES = Object.freeze({
  dumbfire: T({
    id: 'dumbfire', label: 'Dumbfire', seeker: 'none',
    damage: 380, blast: 55, proximity: 14,
    thrust: 1100, burn: 3.5, coast: 5, maxSpeed: 1300,
    maxLateral: 0, turnRate: 0, N: 0,
    lockTime: 0, lockRange: 2500, gimbal: 0.5, fov: 0,
    decoyProne: 0, color: '#ffb066', capitalOnly: false,
  }),

  IR: T({
    id: 'IR', label: 'Heat-Seeker', seeker: 'ir',
    damage: 300, blast: 42, proximity: 22,
    thrust: 900, burn: 7, coast: 6, maxSpeed: 1250,
    maxLateral: 700, turnRate: 4.0, N: 4,
    lockTime: 1.8, lockRange: 4500, gimbal: 0.42, fov: 0.95,
    rearCone: 1.22, heatFloor: 0.22, decoyProne: 0.3,
    color: '#ff8a5c', capitalOnly: false,
  }),

  IMREC: T({
    id: 'IMREC', label: 'Image-Rec', seeker: 'image',
    damage: 300, blast: 42, proximity: 22,
    thrust: 950, burn: 8, coast: 6, maxSpeed: 1300,
    maxLateral: 720, turnRate: 4.2, N: 4,
    lockTime: 2.8, lockRange: 5200, gimbal: 0.42, fov: 1.0,
    decoyProne: 0.75, color: '#9fd8ff', capitalOnly: false,
  }),

  FF: T({
    id: 'FF', label: 'Friend-or-Foe', seeker: 'ff',
    damage: 250, blast: 38, proximity: 20,
    thrust: 900, burn: 6.5, coast: 5, maxSpeed: 1200,
    maxLateral: 620, turnRate: 3.6, N: 3.5,
    lockTime: 0.5, lockRange: 4000, gimbal: 0.7, fov: 0.85,
    decoyProne: 0.45, color: '#c8ff9a', capitalOnly: false,
  }),

  torpedo: T({
    id: 'torpedo', label: 'Torpedo', seeker: 'torpedo',
    damage: 18_000, blast: 130, proximity: 45,
    thrust: 420, burn: 22, coast: 12, maxSpeed: 700,
    maxLateral: 120, turnRate: 0.9, N: 3,
    lockTime: 10.5, lockRange: 9000, gimbal: 0.3, fov: 0.7,
    decoyProne: 0.08, color: '#ffd0a0', capitalOnly: true,
    shieldMul: 2.0, armorMul: 1.5,
  }),
});

const MISSILE_ALIASES = Object.freeze({
  dumbfire: 'dumbfire', dumb: 'dumbfire', rocket: 'dumbfire',
  ir: 'IR', heat: 'IR', heatseeker: 'IR', 'heat-seeker': 'IR', javelin: 'IR',
  imrec: 'IMREC', image: 'IMREC', 'image-rec': 'IMREC', pilum: 'IMREC',
  'bio-seeker': 'IMREC', bioseeker: 'IMREC', spiculum: 'IMREC',
  ff: 'FF', foe: 'FF', 'friend-or-foe': 'FF',
  torpedo: 'torpedo', torp: 'torpedo', 'capship-missile': 'torpedo',
  'bio-torpedo': 'torpedo', lance: 'torpedo',
});

export const MISSILE_IDS = Object.keys(MISSILES);

export function missileIdFor(type) {
  const k = String(type ?? '').trim();
  if (MISSILES[k]) return k;
  return MISSILE_ALIASES[k.toLowerCase()] ?? 'IR';
}

export function resolveMissile(type) {
  return MISSILES[missileIdFor(type)];
}

/** Ordnance inventory from `stats.missiles[]`, in the order the pilot cycles. */
export function createMagazine(ship) {
  const stats = ship?.stats ?? ship?.group?.userData?.stats ?? {};
  const list = Array.isArray(stats.missiles) ? stats.missiles : [];
  const bays = [];
  for (const entry of list) {
    const spec = resolveMissile(entry.type);
    const count = Math.max(0, num(entry.count, 1) | 0);
    if (!count) continue;
    const existing = bays.find((b) => b.spec === spec);
    if (existing) existing.count += count;
    else bays.push({ spec, type: spec.id, sourceType: entry.type, count, max: count });
  }
  return { bays, index: 0, decoys: Math.max(0, num(stats.decoys, 12) | 0), decoysMax: Math.max(0, num(stats.decoys, 12) | 0) };
}

export function currentBay(mag) {
  if (!mag?.bays?.length) return null;
  return mag.bays[clamp(mag.index | 0, 0, mag.bays.length - 1)];
}

export function cycleBay(mag, dir = 1) {
  if (!mag?.bays?.length) return null;
  mag.index = (mag.index + dir + mag.bays.length) % mag.bays.length;
  return currentBay(mag);
}

// ---------------------------------------------------------------------------
// lock acquisition
// ---------------------------------------------------------------------------

const _mp = new THREE.Vector3();
const _tp = new THREE.Vector3();
const _tv = new THREE.Vector3();
const _mv = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _tfwd = new THREE.Vector3();
const _r = new THREE.Vector3();
const _vrel = new THREE.Vector3();
const _omega = new THREE.Vector3();
const _acc = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _seg = new THREE.Vector3();

/** Engine heat as the IR seeker sees it: 0 at idle, ~3 on full burner. */
function heatOf(ship) {
  const b = ship?.body;
  if (!b) return 1;
  const power = num(b.enginePower, num(b.controls?.throttle, 0.5));
  return power;
}

/**
 * Seconds needed to acquire, for this weapon against this target right now.
 * Returns Infinity when no lock is geometrically possible.
 */
export function lockTimeFor(spec, shooter, target) {
  if (!spec || !shooter || !target) return Infinity;
  if (spec.seeker === 'none') return 0;
  if (spec.capitalOnly && !isCapitalShip(target)) return Infinity;

  shipPosition(shooter, _mp);
  shipPosition(target, _tp);
  _r.copy(_tp).sub(_mp);
  const range = _r.length();
  if (range < 1e-3 || range > spec.lockRange) return Infinity;
  _r.multiplyScalar(1 / range);

  // The seeker head has to be able to see it off the launcher's nose.
  shipForward(shooter, _fwd);
  const off = Math.acos(clamp(_fwd.dot(_r), -1, 1));
  if (off > spec.gimbal) return Infinity;

  let aspectFactor = 1;
  if (spec.seeker === 'ir') {
    // Rear aspect only: we must be inside the cone behind the target, and its
    // engines must actually be lit.
    shipForward(target, _tfwd);
    const tailAngle = Math.acos(clamp(-_tfwd.dot(_r), -1, 1)); // 0 = dead astern
    if (tailAngle > spec.rearCone) return Infinity;
    const heat = heatOf(target);
    if (heat < spec.heatFloor) return Infinity;
    aspectFactor = lerp(1, 2.2, clamp01(tailAngle / spec.rearCone)) / clamp(heat, 0.25, 2);
  } else {
    // All-aspect heads still prefer a clean beam.
    aspectFactor = 1 + 0.45 * (1 - Math.cos(off));
  }

  const rangeFactor = 0.7 + 0.75 * clamp01(range / spec.lockRange);
  return spec.lockTime * aspectFactor * rangeFactor;
}

// ---------------------------------------------------------------------------
// geometry for the rendered missiles / decoys
// ---------------------------------------------------------------------------

function spindle(seg = 8, taper = 0.25) {
  const pos = [];
  const idx = [];
  pos.push(0, 0, 0.5);
  pos.push(0, 0, -0.5);
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pos.push(Math.cos(a) * 0.5, Math.sin(a) * 0.5, -0.5 + taper);
  }
  for (let i = 0; i < seg; i++) {
    const a = 2 + i;
    const b = 2 + ((i + 1) % seg);
    idx.push(0, a, b);
    idx.push(1, b, a);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function cachedAssets(engine) {
  const make = () => ({
    body: spindle(8, 0.32),
    flame: spindle(6, 0.5),
    bodyMat: new THREE.MeshStandardMaterial({
      color: 0x8d949c, roughness: 0.55, metalness: 0.65,
    }),
    flameMat: new THREE.MeshBasicMaterial({
      color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false,
      transparent: true, opacity: 0.85, toneMapped: false, side: THREE.DoubleSide,
    }),
    decoyMat: new THREE.MeshBasicMaterial({
      color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false,
      transparent: true, opacity: 0.9, toneMapped: false, side: THREE.DoubleSide,
    }),
  });
  return engine?.registry ? engine.registry.get('combat/missile/assets', make) : make();
}

/** Floor on the motor plume's on-screen radius, in framebuffer pixels. */
const MIN_PLUME_PX = 2.6;
const _camPos = new THREE.Vector3();
const _bufSize = new THREE.Vector2();

// ---------------------------------------------------------------------------
// the manager
// ---------------------------------------------------------------------------

export function createMissileManager(engine, {
  capacity = 128, decoyCapacity = 96, seed = 20477,
} = {}) {
  const rng = makeRng(seed);
  const hit = makeHitRef();
  const assets = cachedAssets(engine);

  /** @type {Array} live missiles; dead ones return to `freeMissiles`. */
  const missiles = [];
  const freeMissiles = [];
  const decoys = [];
  const freeDecoys = [];
  let nextId = 1;

  const settings = {
    /** Arming delay — a missile cannot fuse on the ship that launched it. */
    armTime: 0.28,
    armDistance: 45,
    /** Speed a missile leaves the rail with, relative to the launcher. */
    ejectSpeed: 90,
    /** A missile always ends up at least this much faster than its launcher. */
    minOvertake: 260,
    /** Radius inside which a decoy can be seen by a seeker. */
    decoyRadius: 420,
    /** Seconds a decoy burns. */
    decoyLife: 5.5,
    /** Emit `missile:lock` for AI-vs-AI locks too (noisy; off by default). */
    emitAllLocks: false,
  };

  const stats = { live: 0, launched: 0, hits: 0, seduced: 0, expired: 0, decoys: 0 };

  // ---- instanced rendering ------------------------------------------------
  const bodyMesh = new THREE.InstancedMesh(assets.body, assets.bodyMat, capacity);
  const flameMesh = new THREE.InstancedMesh(assets.flame, assets.flameMat, capacity);
  const decoyMesh = new THREE.InstancedMesh(assets.flame, assets.decoyMat, decoyCapacity);
  for (const m of [bodyMesh, flameMesh, decoyMesh]) {
    m.frustumCulled = false;
    m.count = 0;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }
  bodyMesh.name = 'combat:missiles';
  flameMesh.name = 'combat:missiles:flame';
  decoyMesh.name = 'combat:decoys';
  flameMesh.renderOrder = 5;
  decoyMesh.renderOrder = 5;
  flameMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  decoyMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(decoyCapacity * 3), 3);
  flameMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  decoyMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  engine?.scene?.add(bodyMesh, flameMesh, decoyMesh);

  const _m4 = new THREE.Matrix4();
  const _q4 = new THREE.Quaternion();
  const _sc = new THREE.Vector3();
  const _axis = new THREE.Vector3(0, 0, 1);
  const _col = new THREE.Color();

  // =======================================================================
  // launch
  // =======================================================================

  function makeRecord() {
    return {
      id: 0, alive: false, expired: false, dead: true,
      spec: null, type: '',
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      prevPosition: new THREE.Vector3(),
      shooter: null,
      target: null,          // what the pilot designated
      seekerTarget: null,    // what the seeker is actually tracking (may be a decoy)
      trackQuality: 1,
      age: 0,
      fuel: 0,
      speedCap: 0,
      lastRange: Infinity,
      armed: false,
      seduced: false,
      lost: false,
      hitRadius: 3.2,
      isMissile: true,
      launchDistance: 0,
    };
  }

  /**
   * @param {object} shooter
   * @param {object} target designated target (ship or subsystem-bearing ship)
   * @param {{type?:string, spec?:object, lock?:number, hardpoint?:object,
   *          position?:THREE.Vector3, direction?:THREE.Vector3}} opts
   * @returns {object|false} the missile record, or false if it could not launch
   */
  function fire(shooter, target, opts = {}) {
    if (!shooter) return false;
    const spec = opts.spec ?? resolveMissile(opts.type ?? 'IR');
    if (missiles.length >= capacity) return false;

    const m = freeMissiles.pop() ?? makeRecord();
    m.id = nextId++;
    m.alive = true;
    m.dead = false;
    m.expired = false;
    m.spec = spec;
    m.type = spec.id;
    m.shooter = shooter;
    m.age = 0;
    m.fuel = spec.burn;
    m.armed = false;
    m.seduced = false;
    m.lost = false;
    m.trackQuality = clamp01(opts.lock ?? 1);
    m.lastRange = Infinity;
    m.hitRadius = spec.id === 'torpedo' ? 6 : 3.2;
    m.launchDistance = 0;

    // ---- where it comes off the ship ------------------------------------
    shipPosition(shooter, _mp);
    shipForward(shooter, _fwd);
    shipVelocity(shooter, _mv);
    const q = shooter.body?.quaternion ?? shooter.group?.quaternion;
    const hp = opts.hardpoint ?? pickRail(shooter);
    if (opts.position) {
      m.position.copy(opts.position);
    } else if (hp?.pos && q) {
      m.position.copy(hp.pos).applyQuaternion(q).add(_mp);
    } else {
      m.position.copy(_mp).addScaledVector(_fwd, shipRadius(shooter) * 0.6);
    }
    m.prevPosition.copy(m.position);

    const dir = opts.direction ? _tmp.copy(opts.direction).normalize() : _tmp.copy(_fwd);
    m.velocity.copy(_mv).addScaledVector(dir, settings.ejectSpeed);
    m.speedCap = Math.max(spec.maxSpeed, _mv.length() + settings.minOvertake);

    // ---- seeker acquisition ---------------------------------------------
    if (spec.seeker === 'none') {
      m.seekerTarget = null;
      m.target = target ?? null;
    } else if (spec.seeker === 'ff') {
      m.target = target ?? null;
      m.seekerTarget = pickFoF(shooter, dir) ?? target ?? null;
    } else {
      m.target = target ?? null;
      m.seekerTarget = target ?? null;
    }

    missiles.push(m);
    stats.launched++;

    engine?.events?.emit('missile:launched', {
      ship: shooter,
      shooter,
      missile: m,
      projectile: m,
      target: m.seekerTarget ?? m.target ?? null,
      type: spec.id,
      weapon: spec,
      position: m.position.clone(),
      direction: dir.clone(),
      lock: m.trackQuality,
      byPlayer: !!shooter.isPlayer,
      byAI: !shooter.isPlayer,
    });
    return m;
  }

  /** Rotate through the ship's missile rails so launches alternate sides. */
  function pickRail(ship) {
    const rails = ship?.hardpoints?.missiles ?? ship?.group?.userData?.hardpoints?.missiles ?? null;
    if (!rails?.length) return null;
    const c = ship.combat ?? (ship.combat = {});
    c._railIndex = ((c._railIndex ?? -1) + 1) % rails.length;
    return rails[c._railIndex];
  }

  /** FF head: nearest thing in the launch cone that is not the shooter's own. */
  function pickFoF(shooter, dir) {
    const ships = engine?.game?.ships ?? [];
    shipPosition(shooter, _mp);
    let best = null;
    let bestScore = Infinity;
    for (const s of ships) {
      if (s === shooter || !isAlive(s) || !isHostile(shooter, s)) continue;
      shipPosition(s, _tp).sub(_mp);
      const d = _tp.length();
      if (d < 1e-3 || d > MISSILES.FF.lockRange) continue;
      _tp.multiplyScalar(1 / d);
      const ang = Math.acos(clamp(dir.dot(_tp), -1, 1));
      if (ang > 0.7) continue;
      const score = ang * 3000 + d;
      if (score < bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  // =======================================================================
  // countermeasures
  // =======================================================================

  /** Punch out a decoy. Returns the decoy record, or false when the rack is dry. */
  function deployDecoy(ship, { kind = 'decoy' } = {}) {
    if (decoys.length >= decoyCapacity || !ship) return false;
    const d = freeDecoys.pop() ?? {
      alive: false, isDecoy: true, kind,
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      life: 0, hitRadius: 2.5, shooter: null, seed: 0,
    };
    shipPosition(ship, _mp);
    shipVelocity(ship, _mv);
    shipForward(ship, _fwd);
    d.alive = true;
    d.kind = kind;
    d.shooter = ship;
    d.position.copy(_mp).addScaledVector(_fwd, -shipRadius(ship) * 0.9);
    // Tumbles off to one side so it separates from the ship it came off.
    d.velocity.copy(_mv).addScaledVector(_fwd, -35);
    d.velocity.x += (rng() - 0.5) * 24;
    d.velocity.y += (rng() - 0.5) * 24;
    d.velocity.z += (rng() - 0.5) * 24;
    d.life = settings.decoyLife;
    d.seed = (rng() * 1e6) | 0;
    decoys.push(d);
    stats.decoys++;
    engine?.events?.emit('countermeasure:deploy', {
      ship, kind, position: d.position.clone(), decoy: d, byPlayer: !!ship.isPlayer,
    });
    return d;
  }

  // =======================================================================
  // guidance
  // =======================================================================

  function targetPositionOf(obj, out) {
    if (!obj) return null;
    if (obj.isDecoy) return out.copy(obj.position);
    return shipPosition(obj, out);
  }

  function targetVelocityOf(obj, out) {
    if (!obj) return out.set(0, 0, 0);
    if (obj.isDecoy) return out.copy(obj.velocity);
    return shipVelocity(obj, out);
  }

  function targetAlive(obj) {
    if (!obj) return false;
    if (obj.isDecoy) return obj.alive;
    return isAlive(obj);
  }

  /** Seeker health check: aspect, heat, field of view. Decays trackQuality. */
  function updateSeeker(m, dt) {
    const spec = m.spec;
    if (spec.seeker === 'none') return;
    const tgt = m.seekerTarget;
    if (!targetAlive(tgt)) {
      // FF heads re-acquire; everything else has just been defeated.
      if (spec.seeker === 'ff') {
        _tmp.copy(m.velocity).normalize();
        m.seekerTarget = pickFoF(m.shooter, _tmp);
        if (m.seekerTarget) return;
      }
      m.seekerTarget = null;
      m.lost = true;
      return;
    }

    targetPositionOf(tgt, _tp);
    _r.copy(_tp).sub(m.position);
    const range = _r.length();
    if (range > 1e-4) _r.multiplyScalar(1 / range);

    // Off-axis: the seeker head cannot look round the back of the missile.
    _tmp.copy(m.velocity);
    const sp = _tmp.length();
    if (sp > 1e-4) _tmp.multiplyScalar(1 / sp);
    const off = Math.acos(clamp(_tmp.dot(_r), -1, 1));

    let healthy = off <= spec.fov;

    if (healthy && spec.seeker === 'ir' && !tgt.isDecoy) {
      // Still looking at a hot tailpipe?
      shipForward(tgt, _tfwd);
      const tailAngle = Math.acos(clamp(-_tfwd.dot(_r), -1, 1));
      const heat = heatOf(tgt);
      healthy = tailAngle <= spec.rearCone * 1.15 && heat >= spec.heatFloor * 0.8;
    }

    if (healthy) {
      m.trackQuality = Math.min(1, m.trackQuality + dt * 1.4);
    } else {
      // Two seconds of a cold, off-axis target and the track is gone for good.
      m.trackQuality -= dt * 0.5;
      if (m.trackQuality <= 0) {
        m.trackQuality = 0;
        m.lost = true;
        m.seekerTarget = null;
        engine?.events?.emit('missile:lost', { missile: m, shooter: m.shooter, target: m.target });
      }
    }
  }

  /** Roll for seduction against every decoy inside the seeker basket. */
  function checkDecoys(m, dt) {
    const spec = m.spec;
    if (!spec.decoyProne || m.seduced || !decoys.length) return;
    _tmp.copy(m.velocity);
    const sp = _tmp.length();
    if (sp > 1e-4) _tmp.multiplyScalar(1 / sp);
    for (let i = 0; i < decoys.length; i++) {
      const d = decoys[i];
      if (!d.alive) continue;
      // A decoy only fools a seeker chasing the ship that dropped it.
      if (m.seekerTarget && !m.seekerTarget.isDecoy && d.shooter !== m.seekerTarget) continue;
      _tmp2.copy(d.position).sub(m.position);
      const dist = _tmp2.length();
      if (dist > settings.decoyRadius || dist < 1e-3) continue;
      _tmp2.multiplyScalar(1 / dist);
      if (Math.acos(clamp(_tmp.dot(_tmp2), -1, 1)) > spec.fov) continue;

      // Closer decoys are more convincing; a strong track resists.
      const p = spec.decoyProne * (1 - m.trackQuality * 0.45)
        * (1 - clamp01(dist / settings.decoyRadius) * 0.6) * dt * 2.4;
      if (rng() < p) {
        m.seekerTarget = d;
        m.seduced = true;
        stats.seduced++;
        engine?.events?.emit('missile:seduced', {
          missile: m, decoy: d, shooter: m.shooter, target: m.target,
        });
        return;
      }
    }
  }

  /** True proportional navigation, clamped by the airframe. */
  function guide(m, dt) {
    const spec = m.spec;
    _acc.set(0, 0, 0);
    const tgt = m.seekerTarget;
    if (!tgt || m.lost || spec.N <= 0 || m.fuel <= 0) return _acc;

    targetPositionOf(tgt, _tp);
    targetVelocityOf(tgt, _tv);

    _r.copy(_tp).sub(m.position);
    const range = _r.lengthSq();
    if (range < 1e-6) return _acc;
    _vrel.copy(_tv).sub(m.velocity);

    // Ω = (R × V) / (R·R)
    _omega.copy(_r).cross(_vrel).multiplyScalar(1 / range);
    // a = N (V × Ω)
    _acc.copy(_vrel).cross(_omega).multiplyScalar(spec.N * lerp(0.4, 1, m.trackQuality));

    // Airframe limits: lateral g, then the implied turn rate.
    const speed = Math.max(1, m.velocity.length());
    let cap = spec.maxLateral;
    const turnCap = spec.turnRate * speed;
    if (turnCap < cap) cap = turnCap;
    const mag = _acc.length();
    if (mag > cap) _acc.multiplyScalar(cap / mag);

    // PN commands lateral acceleration only — strip anything along the body.
    _tmp.copy(m.velocity).multiplyScalar(1 / speed);
    _acc.addScaledVector(_tmp, -_acc.dot(_tmp));
    return _acc;
  }

  // =======================================================================
  // detonation
  // =======================================================================

  /**
   * @param {object} m
   * @param {object|null} directTarget ship taking the direct hit, if any
   * @param {object} ctx { hulls, damage }
   */
  function detonate(m, directTarget, ctx, point) {
    const spec = m.spec;
    const pos = point ?? m.position;
    const events = engine?.events;
    const weapon = {
      type: spec.id,
      shieldMul: spec.shieldMul ?? 1,
      armorMul: spec.armorMul ?? 1.15,
      kind: 'missile',
    };

    if (directTarget) {
      ctx.damage?.queue({
        target: directTarget,
        amount: spec.damage,
        shooter: m.shooter,
        weapon,
        point: pos,
        normal: _tmp.copy(pos).sub(shipPosition(directTarget, _tp)).normalize(),
        direction: _tmp2.copy(m.velocity).normalize(),
        kind: 'missile',
      });
      stats.hits++;
    }

    // Blast: quadratic falloff out to the blast radius.
    if (spec.blast > 0 && ctx.hulls) {
      for (let i = 0; i < ctx.hulls.length; i++) {
        const hull = ctx.hulls[i];
        if (!hull.ok || hull.ship === directTarget || !isAlive(hull.ship)) continue;
        const d = hull.center.distanceTo(pos) - hull.radius * 0.5;
        if (d > spec.blast) continue;
        const f = 1 - clamp01(Math.max(0, d) / spec.blast);
        ctx.damage?.queue({
          target: hull.ship,
          amount: spec.damage * f * f * 0.55,
          shooter: m.shooter,
          weapon,
          direction: _tmp.copy(hull.center).sub(pos).normalize(),
          kind: 'blast',
          blast: true,
        });
      }
    }

    events?.emit('explosion', {
      position: pos.clone(),
      point: pos.clone(),
      size: clamp(spec.blast / 40, 0.5, 4),
      scale: clamp(spec.blast / 40, 0.5, 4),
      kind: 'missile',
      source: m,
    });
    kill(m, 'detonated');
  }

  function kill(m, reason) {
    if (!m.alive) return;
    m.alive = false;
    m.dead = true;
    m.expired = reason === 'expired';
    engine?.events?.emit(reason === 'expired' ? 'missile:expired' : 'missile:destroyed', {
      missile: m, projectile: m, shooter: m.shooter, target: m.target, reason,
      position: m.position.clone(),
    });
  }

  // =======================================================================
  // frame
  // =======================================================================

  function update(dt, ctx) {
    if (dt > 0) {
      // ---- decoys --------------------------------------------------------
      for (let i = decoys.length - 1; i >= 0; i--) {
        const d = decoys[i];
        d.position.addScaledVector(d.velocity, dt);
        // Flares bleed off relative velocity so they hang behind the ship.
        d.velocity.multiplyScalar(Math.exp(-dt * 0.35));
        d.life -= dt;
        if (d.life <= 0) {
          d.alive = false;
          decoys.splice(i, 1);
          freeDecoys.push(d);
        }
      }

      // ---- missiles ------------------------------------------------------
      for (let i = missiles.length - 1; i >= 0; i--) {
        const m = missiles[i];
        if (!m.alive) { missiles.splice(i, 1); freeMissiles.push(m); continue; }
        const spec = m.spec;

        m.age += dt;
        m.prevPosition.copy(m.position);

        updateSeeker(m, dt);
        checkDecoys(m, dt);
        const acc = guide(m, dt);

        // Motor.
        if (m.fuel > 0) {
          const burn = Math.min(dt, m.fuel);
          m.fuel -= dt;
          _tmp.copy(m.velocity);
          const sp = _tmp.length();
          if (sp > 1e-4) _tmp.multiplyScalar(1 / sp); else _tmp.set(0, 0, -1);
          m.velocity.addScaledVector(_tmp, spec.thrust * burn);
          if (m.fuel <= 0) {
            engine?.events?.emit('missile:burnout', { missile: m, shooter: m.shooter });
          }
        }
        m.velocity.addScaledVector(acc, dt);

        const sp2 = m.velocity.length();
        if (sp2 > m.speedCap) m.velocity.multiplyScalar(m.speedCap / sp2);

        m.position.addScaledVector(m.velocity, dt);
        m.launchDistance += sp2 * dt;
        if (!m.armed && (m.age > settings.armTime || m.launchDistance > settings.armDistance)) {
          m.armed = true;
        }

        // ---- fusing ------------------------------------------------------
        if (m.armed) {
          let hitShip = null;
          let hitPoint = null;

          // Direct hit: swept, because a torpedo at 700 m/s still covers 12 m
          // a frame and a missile that passes *through* a carrier is absurd.
          const hulls = ctx.hulls ?? [];
          let bestT = Infinity;
          for (let h = 0; h < hulls.length; h++) {
            const hull = hulls[h];
            if (!hull.ok || !isAlive(hull.ship)) continue;
            if (hull.ship === m.shooter && m.age < 0.9) continue;
            _seg.copy(m.position).addScaledVector(hull.velocity, -dt);
            if (!segmentNearSphere(m.prevPosition, _seg, hull.center, hull.radius + m.hitRadius)) continue;
            if (!segmentVsOBB(m.prevPosition, _seg, hull.center, hull.quat, hull.half, m.hitRadius, hit)) continue;
            if (hit.t < bestT) { bestT = hit.t; hitShip = hull.ship; hitPoint = _tmp2.copy(hit.point); }
          }

          if (!hitShip) {
            // Proximity fuse, including the classic closest-approach trigger:
            // if we were closing and are now opening while still inside a few
            // fuse radii, that was our shot — take it.
            const tgt = m.seekerTarget ?? m.target;
            if (targetAlive(tgt)) {
              targetPositionOf(tgt, _tp);
              const d = m.position.distanceTo(_tp);
              const prox = spec.proximity + (tgt.isDecoy ? 0 : shipRadius(tgt) * 0.35);
              if (d <= prox) {
                hitShip = tgt.isDecoy ? null : tgt;
                hitPoint = _tmp2.copy(m.position);
              } else if (d < prox * 3.5 && d > m.lastRange) {
                hitShip = null;
                hitPoint = _tmp2.copy(m.position);
                detonate(m, null, ctx, hitPoint);
                continue;
              }
              m.lastRange = d;
            }
          }

          if (hitShip || hitPoint) {
            detonate(m, hitShip, ctx, hitPoint ?? m.position);
            continue;
          }
        }

        // ---- end of life ---------------------------------------------------
        if (m.age > spec.burn + spec.coast) {
          detonate(m, null, ctx, m.position);
          kill(m, 'expired');
        }
      }
    }

    syncInstances();
    stats.live = missiles.length;
  }

  function syncInstances() {
    // A missile body is 3.4 m long and its plume about 2.4 m across. At 2 km that
    // plume is half a pixel: the shot leaves the rail and is simply gone, which
    // is most of why "missile away" reads as nothing happening. The plume — not
    // the body, which stays honestly scaled — is floored in screen space so a
    // missile in flight is always a visible point of light with a trail behind it.
    const cam = engine?.camera ?? null;
    let plumeFloor = 0;
    if (cam?.isPerspectiveCamera) {
      cam.getWorldPosition(_camPos);
      const h = engine?.renderer?.getDrawingBufferSize?.(_bufSize)?.y ?? 0;
      // Scale-to-radius for the spindle is 0.5, hence the doubling.
      if (h > 0) plumeFloor = (2 * MIN_PLUME_PX) / (h / (2 * Math.tan((cam.fov * Math.PI) / 360)));
    }
    let n = 0;
    for (let i = 0; i < missiles.length && n < capacity; i++) {
      const m = missiles[i];
      if (!m.alive) continue;
      _tmp.copy(m.velocity);
      const sp = _tmp.length();
      if (sp > 1e-4) _tmp.multiplyScalar(1 / sp); else _tmp.set(0, 0, -1);
      _q4.setFromUnitVectors(_axis, _tmp);
      const len = m.spec.id === 'torpedo' ? 7.5 : 3.4;
      const rad = m.spec.id === 'torpedo' ? 0.9 : 0.36;
      _sc.set(rad * 2, rad * 2, len);
      _m4.compose(m.position, _q4, _sc);
      bodyMesh.setMatrixAt(n, _m4);

      // Motor plume, behind the body, pulsing while the motor burns.
      const burning = m.fuel > 0 ? 1 : 0.12;
      _tp.copy(m.position).addScaledVector(_tmp, -len * 0.75);
      const natural = rad * 3.4 * burning + 0.2;
      const plumeR = plumeFloor > 0
        ? Math.max(natural, _tp.distanceTo(_camPos) * plumeFloor * burning)
        : natural;
      _sc.set(plumeR, plumeR, Math.max(len * (0.9 + burning * 1.6), plumeR * 1.6));
      _m4.compose(_tp, _q4, _sc);
      flameMesh.setMatrixAt(n, _m4);
      _col.set(m.spec.color);
      const g = burning * 3.2;
      flameMesh.instanceColor.setXYZ(n, _col.r * g, _col.g * g, _col.b * g);
      n++;
    }
    bodyMesh.count = n;
    flameMesh.count = n;
    if (n > 0) {
      bodyMesh.instanceMatrix.needsUpdate = true;
      flameMesh.instanceMatrix.needsUpdate = true;
      flameMesh.instanceColor.needsUpdate = true;
    }

    let k = 0;
    for (let i = 0; i < decoys.length && k < decoyCapacity; i++) {
      const d = decoys[i];
      if (!d.alive) continue;
      const f = clamp01(d.life / settings.decoyLife);
      // Flicker deterministically off the decoy's own seed.
      const flick = 0.6 + 0.4 * Math.sin(d.seed * 0.017 + d.life * 41);
      const s = (2.2 + 3.4 * f) * flick;
      _sc.set(s, s, s * 1.6);
      _q4.identity();
      _m4.compose(d.position, _q4, _sc);
      decoyMesh.setMatrixAt(k, _m4);
      const g = 5 * f * flick;
      decoyMesh.instanceColor.setXYZ(k, g, g * 0.72, g * 0.4);
      k++;
    }
    decoyMesh.count = k;
    if (k > 0) {
      decoyMesh.instanceMatrix.needsUpdate = true;
      decoyMesh.instanceColor.needsUpdate = true;
    }
  }

  /** Soft targets for point defence: live missiles the turrets can shoot down. */
  function softTargets() {
    return missiles;
  }

  function clear() {
    for (const m of missiles) { m.alive = false; freeMissiles.push(m); }
    missiles.length = 0;
    for (const d of decoys) { d.alive = false; freeDecoys.push(d); }
    decoys.length = 0;
    bodyMesh.count = 0;
    flameMesh.count = 0;
    decoyMesh.count = 0;
  }

  function dispose() {
    clear();
    for (const m of [bodyMesh, flameMesh, decoyMesh]) {
      m.removeFromParent();
      m.dispose();
    }
  }

  return {
    fire, deployDecoy, update, clear, dispose, detonate, kill,
    softTargets,
    missiles, decoys,
    settings, stats, rng,
    meshes: [bodyMesh, flameMesh, decoyMesh],
  };
}
