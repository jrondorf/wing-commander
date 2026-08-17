/**
 * src/combat/damage.js — Wing Commander's damage model, reproduced.
 *
 * Priority 350. Combat (300) resolves *where* a hit landed; this applies it.
 * Queuing rather than applying inline keeps the frame deterministic: every hit
 * in a frame is resolved against the same shield state, in spawn order, no
 * matter which system found it.
 *
 * ## The three layers
 *
 * 1. **Shields — four quadrants** (fore / aft / left / right). They soak damage
 *    and regenerate from the power plant. The facing is decided in the hull's
 *    own shape-normalised local space, so a 900 m carrier struck amidships
 *    reads as a flank hit, not a bow hit.
 *
 * 2. **Armour — per facing, underneath, and it never comes back.** This is what
 *    makes a long mission a war of attrition: you can hide behind shields all
 *    day, but every point of armour you lose is gone until you land.
 *
 * 3. **Components — once a facing's armour is gone.** Guns, engines, shield
 *    generator, targeting computer, thrusters, life support. Each one is
 *    individually destroyable, each with a real consequence: a dead engine caps
 *    your speed, a dead targeting computer kills the lead pipper, a dead shield
 *    generator means the quadrant you just lost is never coming back.
 *
 * Which component eats an internal hit is decided by facing: a nose-on gun pass
 * wrecks guns then the targeting computer; a shot up the tailpipe kills engines
 * then thrusters. That ordering is doctrine, not randomness, and the self-test
 * asserts it.
 *
 * ## Events (ARCHITECTURE §5.6) — vfx/audio/ui consume these
 *   weapon:hit          every resolved hit, with the shield/armour split
 *   shield:impact       shields took some of it: point + normal for the ripple
 *   armor:breach        a facing's armour reached zero
 *   component:damaged / component:destroyed
 *   ship:destroyed      with position + a scale hint for the fireball
 */
import * as THREE from 'three';
import { makeRng, hashSeed } from '../core/Rand.js';
import {
  clamp, clamp01, lerp, num, FACINGS, facingFromLocalPoint, isCapitalShip,
} from './util.js';
import { shieldRegenScale, engineSpeedScale } from './weapons.js';

// ---------------------------------------------------------------------------
// components
// ---------------------------------------------------------------------------

/**
 * `hp` is a fraction of the ship's mean per-facing armour, so a carrier's
 * engines are proportionally as tough as a Vampire's.
 */
export const COMPONENTS = Object.freeze([
  { id: 'guns', label: 'Weapons', hp: 0.26 },
  { id: 'engines', label: 'Engines', hp: 0.34 },
  { id: 'shieldGenerator', label: 'Shield Generator', hp: 0.24 },
  { id: 'targeting', label: 'Targeting Computer', hp: 0.15 },
  { id: 'thrusters', label: 'Manoeuvring Thrusters', hp: 0.20 },
  { id: 'lifeSupport', label: 'Life Support', hp: 0.17 },
]);

export const COMPONENT_IDS = COMPONENTS.map((c) => c.id);

/**
 * Which internals sit behind which facing, most exposed first. A hit that gets
 * through the armour on a facing works down this list.
 */
export const COMPONENT_ORDER = Object.freeze({
  fore: ['guns', 'targeting', 'lifeSupport', 'shieldGenerator', 'thrusters', 'engines'],
  aft: ['engines', 'thrusters', 'shieldGenerator', 'lifeSupport', 'guns', 'targeting'],
  left: ['thrusters', 'shieldGenerator', 'guns', 'engines', 'targeting', 'lifeSupport'],
  right: ['thrusters', 'shieldGenerator', 'guns', 'engines', 'targeting', 'lifeSupport'],
});

/** Seconds of life support after the scrubbers die before the pilot does. */
export const LIFE_SUPPORT_SECONDS = 300;

const _local = new THREE.Vector3();
const _iq = new THREE.Quaternion();
const _point = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _tmp = new THREE.Vector3();

// ---------------------------------------------------------------------------
// per-ship state
// ---------------------------------------------------------------------------

export function createDamageState(ship) {
  const stats = ship?.stats ?? ship?.group?.userData?.stats ?? {};
  const sh = stats.shields ?? {};
  const ar = stats.armor ?? {};

  const fore = Math.max(0, num(sh.fore, 400));
  const aft = Math.max(0, num(sh.aft, fore * 0.85));
  // Ship stats declare fore/aft banks; the flanks are the mean unless authored.
  const side = Math.max(0, num(sh.left, num(sh.side, (fore + aft) * 0.42)));

  const shieldMax = {
    fore,
    aft,
    left: side,
    right: Math.max(0, num(sh.right, side)),
  };

  const armorMax = {
    fore: Math.max(1, num(ar.fore, num(ar.f, 300))),
    aft: Math.max(1, num(ar.aft, num(ar.a, 260))),
    left: Math.max(1, num(ar.left, num(ar.l, 240))),
    right: Math.max(1, num(ar.right, num(ar.r, 240))),
  };

  const meanArmor = (armorMax.fore + armorMax.aft + armorMax.left + armorMax.right) / 4;

  const components = {};
  for (const c of COMPONENTS) {
    const max = Math.max(1, c.hp * meanArmor);
    components[c.id] = { id: c.id, label: c.label, hp: max, max, alive: true };
  }

  return {
    ship,
    shields: { ...shieldMax },
    shieldMax,
    armor: { ...armorMax },
    armorMax,
    components,
    /** Structural core, reached only once a facing's armour is gone. */
    coreMax: Math.max(1, meanArmor * 0.75),
    core: Math.max(1, meanArmor * 0.75),
    /** Base regen per bank, points/second (ships/ stats.shields.recharge). */
    shieldRecharge: Math.max(0, num(sh.recharge, 40)),
    /** Seconds since each bank last took a hit — regen is briefly suppressed. */
    lastHit: { fore: 99, aft: 99, left: 99, right: 99 },
    hullFrac: 1,
    shieldFrac: 1,
    lifeSupportLeft: LIFE_SUPPORT_SECONDS,
    destroyed: false,
    lastAttacker: null,
    totalTaken: 0,
    /** Derived each frame and consumed by CombatSystem — see applyEffects(). */
    effects: {
      gunDamage: 1,
      gunOnline: true,
      throttleCap: 1,
      turnScale: 1,
      shieldRegen: 1,
      targetingOnline: true,
      lifeSupport: true,
    },
    rng: makeRng(hashSeed(`damage:${ship?.classId ?? 'x'}:${ship?.id ?? 0}`)),
  };
}

/** 0..1 for the AI's "finish the wounded" scoring and for the HUD. */
function recomputeFractions(st) {
  let a = 0; let am = 0; let s = 0; let sm = 0;
  for (const f of FACINGS) {
    a += st.armor[f]; am += st.armorMax[f];
    s += st.shields[f]; sm += st.shieldMax[f];
  }
  st.hullFrac = clamp01((a + st.core) / Math.max(1e-3, am + st.coreMax));
  st.shieldFrac = sm > 0 ? clamp01(s / sm) : 0;
  const ship = st.ship;
  if (ship) {
    // Mirrors the AI (`ai/threat.js: hullFraction`) and the HUD read directly.
    ship.hullFrac = st.hullFrac;
    ship.shieldFrac = st.shieldFrac;
  }
}

/** Recompute the gameplay consequences of the current component state. */
function recomputeEffects(st) {
  const c = st.components;
  const e = st.effects;
  const frac = (id) => clamp01(c[id].hp / c[id].max);

  // A wrecked gun bay still fires, badly. A destroyed one does not.
  e.gunOnline = c.guns.alive;
  e.gunDamage = c.guns.alive ? lerp(0.45, 1, frac('guns')) : 0;

  // Dead engines cap you at a crawl — the single most punishing hit in WC.
  e.throttleCap = c.engines.alive ? lerp(0.35, 1, frac('engines')) : 0.18;

  // Thrusters gone: the ship still points where it did, just slowly.
  e.turnScale = c.thrusters.alive ? lerp(0.5, 1, frac('thrusters')) : 0.3;

  e.shieldRegen = c.shieldGenerator.alive ? lerp(0.25, 1, frac('shieldGenerator')) : 0;
  e.targetingOnline = c.targeting.alive;
  e.lifeSupport = c.lifeSupport.alive;
}

// ---------------------------------------------------------------------------
// the system
// ---------------------------------------------------------------------------

export function createDamageSystem(engine) {
  /** @type {Map<object, ReturnType<createDamageState>>} */
  const states = new Map();
  const queue = [];
  const pool = [];

  const settings = {
    /** Global damage scale — mission difficulty knob. */
    scale: 1,
    /** Seconds a quadrant stops regenerating after taking a hit. */
    regenDelay: 0.9,
    /** Fraction of an internal hit that goes to the structural core. */
    coreShare: 0.5,
    /** Friendly fire on/off. */
    friendlyFire: true,
    /**
     * Fraction of a hit that bleeds past an intact bank. Wing Commander's
     * shields absorb strictly, so this is 0 by default; raise it if a mission
     * wants attrition to bite through a turtling capital ship.
     */
    shieldLeak: 0,
    /** Overcharge ceiling when transferring shield power between banks. */
    transferCeiling: 1.5,
  };

  const stats = { applied: 0, kills: 0, queued: 0 };

  function attach(ship) {
    if (!ship) return null;
    let st = states.get(ship);
    if (st) return st;
    st = createDamageState(ship);
    recomputeEffects(st);
    recomputeFractions(st);
    states.set(ship, st);
    ship.damage = st;
    return st;
  }

  function detach(ship) {
    const st = states.get(ship);
    if (!st) return false;
    states.delete(ship);
    if (ship.damage === st) ship.damage = null;
    return true;
  }

  const stateOf = (ship) => states.get(ship) ?? null;

  // ---------------------------------------------------------------- queueing

  /**
   * Queue a hit. Vectors are copied, so callers may pass scratch.
   *
   * @param {{target:object, amount:number, shooter?:object, weapon?:object,
   *          point?:THREE.Vector3, normal?:THREE.Vector3,
   *          direction?:THREE.Vector3, kind?:string, blast?:boolean}} h
   */
  function queueDamage(h) {
    if (!h?.target || !(h.amount > 0)) return false;
    const st = states.get(h.target) ?? attach(h.target);
    if (!st || st.destroyed) return false;
    const rec = pool.pop() ?? {
      target: null, shooter: null, weapon: null, amount: 0, kind: 'gun',
      point: new THREE.Vector3(), normal: new THREE.Vector3(),
      direction: new THREE.Vector3(), hasPoint: false, blast: false,
    };
    rec.target = h.target;
    rec.shooter = h.shooter ?? null;
    rec.weapon = h.weapon ?? null;
    rec.amount = h.amount;
    rec.kind = h.kind ?? 'gun';
    rec.blast = !!h.blast;
    rec.hasPoint = !!h.point;
    if (h.point) rec.point.copy(h.point);
    if (h.normal) rec.normal.copy(h.normal); else rec.normal.set(0, 0, 0);
    if (h.direction) rec.direction.copy(h.direction); else rec.direction.set(0, 0, 0);
    queue.push(rec);
    stats.queued++;
    return true;
  }

  // -------------------------------------------------------------- resolution

  /** Local-space hit point, for facing selection. Falls back to the direction. */
  function localiseHit(st, rec) {
    const ship = rec.target;
    const body = ship.body ?? null;
    const origin = body?.position ?? ship.group?.position;
    const quat = body?.quaternion ?? ship.group?.quaternion;
    if (!origin || !quat) { _local.set(0, 0, -1); return; }
    _iq.copy(quat).invert();
    if (rec.hasPoint) {
      _local.copy(rec.point).sub(origin).applyQuaternion(_iq);
    } else if (rec.direction.lengthSq() > 1e-6) {
      // No impact point (a blast, a collision): the facing is whichever side
      // the damage came *from*, i.e. against the travel direction.
      _local.copy(rec.direction).applyQuaternion(_iq).multiplyScalar(-1);
    } else {
      _local.set(0, 0, -1);
    }
  }

  function halfExtentsOf(ship) {
    const h = ship.body?.halfExtents;
    if (h) return h;
    const L = Math.max(4, num(ship.stats?.length, 20));
    return _tmp.set(L * 0.42, L * 0.22, L * 0.5);
  }

  function applyOne(rec) {
    const st = states.get(rec.target);
    if (!st || st.destroyed) return;
    const ship = rec.target;
    const weapon = rec.weapon;
    const events = engine?.events;

    localiseHit(st, rec);
    const facing = facingFromLocalPoint(_local, halfExtentsOf(ship));

    let remaining = rec.amount * settings.scale;
    st.totalTaken += remaining;
    if (rec.shooter && rec.shooter !== ship) st.lastAttacker = rec.shooter;

    // Impact point/normal for the vfx agent. When we only had a direction,
    // synthesise a point on the hull so a shield ripple still has somewhere
    // to go.
    const origin = ship.body?.position ?? ship.group?.position;
    const quat = ship.body?.quaternion ?? ship.group?.quaternion;
    if (rec.hasPoint && rec.normal.lengthSq() > 1e-6) {
      _point.copy(rec.point);
      _normal.copy(rec.normal).normalize();
    } else if (origin) {
      // Synthesise a plausible skin point from the facing so a shield ripple
      // still has somewhere to go.
      const r = num(ship.body?.boundsRadius, num(ship.group?.userData?.radius, 12));
      _normal.copy(_local);
      if (_normal.lengthSq() < 1e-9) _normal.set(0, 0, -1);
      _normal.normalize();
      if (quat) _normal.applyQuaternion(quat);
      _point.copy(rec.hasPoint ? rec.point : _tmp.copy(origin).addScaledVector(_normal, r * 0.85));
    } else {
      _point.set(0, 0, 0);
      _normal.set(0, 1, 0);
    }

    // ---- 1. shields ------------------------------------------------------
    let shieldDamage = 0;
    const bank = st.shields[facing];
    if (bank > 0) {
      // `mul` is the weapon's effectiveness against shields: an ion cannon
      // spends its damage 1.55x as fast on a bank, and burns through 1.55x as
      // much of it per point of incoming damage.
      const mul = weapon?.shieldMul ?? 1;
      const absorbed = Math.min(bank, remaining * mul * (1 - clamp01(settings.shieldLeak)));
      if (absorbed > 0) {
        st.shields[facing] = bank - absorbed;
        shieldDamage = absorbed;
        remaining -= absorbed / mul;
      }
      if (remaining < 0) remaining = 0;
      st.lastHit[facing] = 0;
      events?.emit('shield:impact', {
        ship, target: ship, shooter: rec.shooter ?? null,
        facing,
        position: _point.clone(),
        point: _point.clone(),
        normal: _normal.clone(),
        damage: shieldDamage,
        strength: shieldDamage,
        remaining: st.shields[facing],
        max: st.shieldMax[facing],
        fraction: clamp01(st.shields[facing] / Math.max(1e-3, st.shieldMax[facing])),
        down: st.shields[facing] <= 0,
        weapon: weapon ?? null,
        kind: rec.kind,
      });
    }

    // ---- 2. armour -------------------------------------------------------
    let armorDamage = 0;
    let breach = false;
    if (remaining > 0) {
      const mul = weapon?.armorMul ?? 1;
      const want = remaining * mul;
      const arm = st.armor[facing];
      if (arm > 0) {
        armorDamage = Math.min(arm, want);
        st.armor[facing] = arm - armorDamage;
        remaining -= armorDamage / mul;
        if (st.armor[facing] <= 0) {
          breach = true;
          events?.emit('armor:breach', {
            ship, target: ship, facing, position: _point.clone(), shooter: rec.shooter ?? null,
          });
        }
      }
      if (remaining < 0) remaining = 0;
    }

    // ---- 3. internals ----------------------------------------------------
    let coreDamage = 0;
    const componentHits = [];
    if (remaining > 0) {
      breach = true;
      const mul = weapon?.armorMul ?? 1;
      const internal = remaining * mul;
      coreDamage = internal * settings.coreShare;
      st.core = Math.max(0, st.core - coreDamage);
      let toComponents = internal - coreDamage;

      const order = COMPONENT_ORDER[facing] ?? COMPONENT_ORDER.fore;
      for (let i = 0; i < order.length && toComponents > 0; i++) {
        const comp = st.components[order[i]];
        if (!comp || !comp.alive) continue;
        const take = Math.min(comp.hp, toComponents);
        comp.hp -= take;
        toComponents -= take;
        componentHits.push(comp.id);
        if (comp.hp <= 0) {
          comp.hp = 0;
          comp.alive = false;
          if (comp.id === 'lifeSupport') st.lifeSupportLeft = LIFE_SUPPORT_SECONDS;
          events?.emit('component:destroyed', {
            ship, target: ship, component: comp.id, label: comp.label,
            facing, position: _point.clone(), shooter: rec.shooter ?? null,
            isPlayer: !!ship.isPlayer,
          });
        } else {
          events?.emit('component:damaged', {
            ship, target: ship, component: comp.id, label: comp.label,
            fraction: clamp01(comp.hp / comp.max), facing,
          });
        }
      }
      // Everything internal is gone: the rest goes straight into the core.
      if (toComponents > 0) st.core = Math.max(0, st.core - toComponents);
    }

    recomputeEffects(st);
    recomputeFractions(st);

    events?.emit('weapon:hit', {
      target: ship,
      ship,
      victim: ship,
      shooter: rec.shooter ?? null,
      weapon: weapon ?? null,
      type: weapon?.type ?? rec.kind,
      kind: rec.kind,
      facing,
      position: _point.clone(),
      point: _point.clone(),
      normal: _normal.clone(),
      damage: rec.amount * settings.scale,
      shieldDamage,
      armorDamage,
      coreDamage,
      shield: shieldDamage > 0,
      shielded: shieldDamage > 0 && armorDamage === 0 && coreDamage === 0,
      breach,
      components: componentHits,
      hullFrac: st.hullFrac,
      shieldFrac: st.shieldFrac,
      isPlayer: !!ship.isPlayer,
    });

    if (st.core <= 0) destroy(st, rec.shooter ?? null, rec.kind);
  }

  function destroy(st, killer, cause = 'weapon') {
    if (st.destroyed) return;
    st.destroyed = true;
    const ship = st.ship;
    ship.alive = false;
    ship.hullFrac = 0;
    stats.kills++;
    const pos = (ship.body?.position ?? ship.group?.position ?? _point).clone();
    const radius = num(ship.body?.boundsRadius, num(ship.group?.userData?.radius, 12));
    engine?.events?.emit('ship:destroyed', {
      ship, position: pos, killer, cause,
      // vfx sizes the fireball off this: ~1 for a fighter, 6+ for a capital.
      scale: clamp(radius / 12, 0.7, 12),
      size: clamp(radius / 12, 0.7, 12),
      isCapital: isCapitalShip(ship),
      faction: ship.faction ?? null,
      byPlayer: !!killer?.isPlayer,
    });
  }

  // ------------------------------------------------------------------ frame

  function update(dt) {
    // 1. resolve everything queued this frame, in order.
    for (let i = 0; i < queue.length; i++) {
      applyOne(queue[i]);
      queue[i].target = null;
      queue[i].shooter = null;
      queue[i].weapon = null;
      pool.push(queue[i]);
      stats.applied++;
    }
    queue.length = 0;

    if (dt <= 0) return;

    // 2. shield regeneration and the life-support clock.
    for (const st of states.values()) {
      if (st.destroyed) continue;
      const ship = st.ship;
      const power = ship.combat?.power ?? null;
      const powerScale = power ? shieldRegenScale(power) : 1;
      const rate = st.shieldRecharge * powerScale * st.effects.shieldRegen;
      if (rate > 0) {
        for (const f of FACINGS) {
          st.lastHit[f] += dt;
          if (st.lastHit[f] < settings.regenDelay) continue;
          const max = st.shieldMax[f];
          if (st.shields[f] < max) {
            st.shields[f] = Math.min(max, st.shields[f] + rate * dt);
          }
        }
      } else {
        for (const f of FACINGS) st.lastHit[f] += dt;
      }

      if (!st.effects.lifeSupport) {
        st.lifeSupportLeft -= dt;
        if (st.lifeSupportLeft <= 0) destroy(st, st.lastAttacker, 'life-support');
      }
      recomputeFractions(st);
    }
  }

  // ------------------------------------------------------------------- API

  /**
   * Shift shield power between the fore and aft banks — WC's `,` / `.` keys.
   * Moves *current* charge; the receiving bank may overcharge up to
   * `settings.transferCeiling` of its nominal maximum.
   */
  function transferShield(ship, toFacing, amount = 0.25) {
    const st = states.get(ship);
    if (!st) return false;
    const from = toFacing === 'fore' ? 'aft' : 'fore';
    const take = st.shields[from] * clamp01(amount);
    if (take <= 0) return false;
    const ceiling = st.shieldMax[toFacing] * settings.transferCeiling;
    st.shields[from] -= take;
    st.shields[toFacing] = Math.min(ceiling, st.shields[toFacing] + take);
    recomputeFractions(st);
    engine?.events?.emit('shield:transfer', { ship, to: toFacing, from, amount: take });
    return true;
  }

  function balanceShields(ship) {
    const st = states.get(ship);
    if (!st) return false;
    let total = 0;
    let totalMax = 0;
    for (const f of FACINGS) { total += st.shields[f]; totalMax += st.shieldMax[f]; }
    if (totalMax <= 0) return false;
    for (const f of FACINGS) st.shields[f] = Math.min(st.shieldMax[f], total * (st.shieldMax[f] / totalMax));
    recomputeFractions(st);
    engine?.events?.emit('shield:transfer', { ship, to: 'balanced', from: 'all', amount: 0 });
    return true;
  }

  /** Repair everything (rearm/refit between missions). */
  function restore(ship) {
    const st = states.get(ship);
    if (!st) return false;
    for (const f of FACINGS) { st.shields[f] = st.shieldMax[f]; st.armor[f] = st.armorMax[f]; }
    for (const id of COMPONENT_IDS) { st.components[id].hp = st.components[id].max; st.components[id].alive = true; }
    st.core = st.coreMax;
    st.destroyed = false;
    st.lifeSupportLeft = LIFE_SUPPORT_SECONDS;
    if (st.ship) st.ship.alive = true;
    recomputeEffects(st);
    recomputeFractions(st);
    return true;
  }

  /**
   * The consequences, pushed onto the flight body.
   *
   * Throttle is clamped through `body.controls`, which is the documented input
   * surface. Turn rate and top speed have no such surface, so they are scaled
   * from a baseline captured at attach time.
   * TODO(contract): agent-flight — a `body.setPerformanceScale({turn, speed})`
   * would let combat express battle damage without touching `body.tuning`.
   */
  function applyEffects(ship, baseline) {
    const st = states.get(ship);
    const body = ship?.body;
    if (!st || !body || !baseline) return;
    const e = st.effects;
    const power = ship.combat?.power;
    const speedScale = Math.min(e.throttleCap, power ? engineSpeedScale(power) : 1);

    if (body.controls) {
      body.controls.throttle = Math.min(body.controls.throttle, speedScale);
    }
    const T = body.tuning;
    if (T) {
      T.maxSpeed = baseline.maxSpeed * speedScale;
      T.pitchRate = baseline.pitchRate * e.turnScale;
      T.yawRate = baseline.yawRate * e.turnScale;
      T.rollRate = baseline.rollRate * e.turnScale;
    }
  }

  function dispose() {
    states.clear();
    queue.length = 0;
    pool.length = 0;
  }

  return {
    name: 'damage',
    priority: 350,
    update,
    attach,
    detach,
    dispose,

    queue: queueDamage,
    stateOf,
    destroy: (ship, killer, cause) => {
      const st = states.get(ship);
      if (st) destroy(st, killer ?? null, cause ?? 'scripted');
    },
    transferShield,
    balanceShields,
    restore,
    applyEffects,
    states,
    settings,
    stats,
  };
}
