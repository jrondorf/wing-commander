import * as THREE from 'three';
import { makeRng } from '../core/Rand.js';
import { resolveWeapon, createPowerPlant, WEAPONS, GUN_CHARGE_COEFF } from './weapons.js';
import { createProjectilePool } from './projectiles.js';
import { createMagazine, currentBay, cycleBay, createMissileManager } from './missiles.js';
import { createDamageSystem } from './damage.js';
import { createTargetingComputer, ittsSolution, solutionStatus } from './targeting.js';
import { isHostile, clamp01 } from './util.js';

/**
 * CombatSystem — the conductor for the combat modules.
 *
 * weapons/projectiles/missiles/damage/targeting each own a slice and were built to
 * be composed; this is the piece that owns fire control and per-ship combat state,
 * and republishes the sub-managers under one object so `Game.js` and the cockpit
 * HUD have a single place to talk to.
 *
 * Runs at priority 300 (see ARCHITECTURE.md §3): after flight and AI have written
 * positions and control inputs, before vfx consumes the events this emits.
 */
export function createCombatSystem(engine) {
  const events = engine.events;
  const rng = makeRng(0xc0ffee ^ (engine.game?.seed ?? 1337));

  const pool = createProjectilePool(engine, { capacity: 2048 });
  const targeting = createTargetingComputer(engine);
  const damage = createDamageSystem(engine);
  const missiles = createMissileManager(engine, {});

  // Projectile and missile meshes live in the world scene, not on any ship.
  for (const m of pool.meshes ?? []) engine.scene.add(m);
  for (const m of missiles.meshes ?? []) engine.scene.add(m);

  /** @type {Map<object, object>} per-ship combat state */
  const state = new Map();

  // Swept-segment collision needs an oriented box per ship each frame. The records
  // are cached and mutated in place: rebuilding this list every frame for a 40-ship
  // battle would allocate thousands of objects a second.
  /** @type {Map<object, object>} */
  const hullRecords = new Map();
  const hulls = [];
  let playerFiring = false;

  const _pos = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _vel = new THREE.Vector3();
  const _q = new THREE.Quaternion();

  function attach(ship) {
    if (!ship || state.has(ship)) return state.get(ship) ?? null;

    const stats = ship.stats ?? ship.group?.userData?.stats ?? {};
    const hardpoints = ship.hardpoints ?? ship.group?.userData?.hardpoints ?? {};
    const guns = (hardpoints.guns ?? []).map((hp) => ({
      pos: hp.pos?.clone?.() ?? new THREE.Vector3(),
      dir: hp.dir?.clone?.().normalize() ?? new THREE.Vector3(0, 0, -1),
      weapon: resolveWeapon(hp.type ?? stats.guns?.[0] ?? 'mass_driver'),
      cooldown: 0,
    }));

    const s = {
      ship,
      guns,
      // Round-robin so paired cannons alternate rather than firing as one slab.
      nextGun: 0,
      power: createPowerPlant(stats),
      // Gun capacitor. weapons.js owns the power *distribution* (guns/shields/
      // engines shares) but not the reservoir, so it lives here: sustained fire
      // drains it and forces trigger discipline, which is the whole point of the
      // Wing Commander power triangle.
      capacitor: Math.max(1, stats.capacitor ?? 120),
      charge: Math.max(1, stats.capacitor ?? 120),
      magazine: createMagazine(stats),
      lockProgress: 0,
      lockedTarget: null,
      firing: false,
      // Guns converge at a harmonisation range, exactly like real gun boresighting.
      convergence: stats.convergence ?? 450,
      solution: null,
    };
    state.set(ship, s);
    damage.attach?.(ship);
    return s;
  }

  function detach(ship) {
    state.delete(ship);
    damage.detach?.(ship);
  }

  function shipWorld(ship, outPos, outQuat) {
    const g = ship.group;
    if (g) { g.getWorldPosition(outPos); g.getWorldQuaternion(outQuat); }
    else { outPos.set(0, 0, 0); outQuat.identity(); }
  }

  /** Fire every gun that is off cooldown and has capacitor charge. */
  function fireGuns(s, dt) {
    const ship = s.ship;
    const body = ship.body;
    shipWorld(ship, _pos, _q);
    _vel.copy(body?.velocity ?? { x: 0, y: 0, z: 0 });

    const target = targeting.getTarget?.(ship) ?? null;

    for (let i = 0; i < s.guns.length; i++) {
      const gun = s.guns[(s.nextGun + i) % s.guns.length];
      if (gun.cooldown > 0) continue;
      const w = gun.weapon;
      // Explicit, not optional-chained: an absent capacitor must not silently
      // disable every gun in the game, which is exactly what `power.drawGun?.()`
      // did — it resolved to undefined and skipped the barrel on every frame.
      const cost = w.energy ?? 0;
      if (s.charge < cost) continue;
      s.charge -= cost;

      // Muzzle in world space.
      const muzzle = _pos.clone().add(gun.pos.clone().applyQuaternion(_q));
      // Converge on the harmonisation point rather than firing parallel, so
      // paired cannons actually cross where the pipper says they will.
      const aim = gun.dir.clone().applyQuaternion(_q);
      const converge = _pos.clone().add(
        new THREE.Vector3(0, 0, -1).applyQuaternion(_q).multiplyScalar(s.convergence),
      );
      _dir.copy(converge).sub(muzzle).normalize();
      if (!Number.isFinite(_dir.x)) _dir.copy(aim);

      pool.spawn({
        position: muzzle,
        direction: _dir,
        speed: w.speed,
        weapon: w,
        damage: w.damage,
        owner: ship,
        ownerVelocity: _vel,
        target,
        kind: 'bolt',
        jitter: w.spread ?? 0,
        rng,
      });

      // refire is the interval between shots in seconds, not a rate. Inverting it
      // turned the mass driver's 0.22 s cadence into a 4.5 s one and left only two
      // bolts in flight during a sustained burst.
      gun.cooldown = Math.max(0.02, w.refire ?? 0.2);
      events?.emit('weapon:fired', {
        ship, weapon: w, position: muzzle.clone(), direction: _dir.clone(),
      });
      s.nextGun = (s.nextGun + i + 1) % s.guns.length;
      // One barrel per frame keeps a burst staggered instead of a single slab.
      break;
    }
  }

  function fireMissile(ship, target = null) {
    const s = state.get(ship) ?? attach(ship);
    if (!s) return false;
    const bay = currentBay(s.magazine);
    if (!bay || bay.count <= 0) return false;
    const tgt = target ?? targeting.getTarget?.(ship) ?? null;
    const ok = missiles.fire?.(ship, tgt, { bay });
    if (ok !== false) {
      bay.count = Math.max(0, bay.count - 1);
      events?.emit('missile:launched', { ship, target: tgt, bay });
    }
    return ok !== false;
  }

  const _hc = new THREE.Vector3();

  /** Refresh the oriented-box colliders projectiles are tested against. */
  function refreshHulls(game) {
    hulls.length = 0;
    for (const ship of game?.ships ?? []) {
      const b = ship.body;
      if (!b || ship.alive === false) continue;
      let rec = hullRecords.get(ship);
      if (!rec) {
        rec = {
          ok: true, ship,
          center: new THREE.Vector3(),
          quat: new THREE.Quaternion(),
          half: new THREE.Vector3(1, 1, 1),
          radius: 1,
          velocity: new THREE.Vector3(),
        };
        hullRecords.set(ship, rec);
      }
      rec.ok = true;
      rec.quat.copy(b.quaternion);
      // Bounds centre is in ship-local space; put it where the hull actually is.
      _hc.copy(b.boundsCenter ?? { x: 0, y: 0, z: 0 }).applyQuaternion(b.quaternion);
      rec.center.copy(b.position).add(_hc);
      if (b.halfExtents) rec.half.copy(b.halfExtents);
      rec.radius = b.boundsRadius ?? b.radius ?? 12;
      rec.velocity.copy(b.velocity ?? { x: 0, y: 0, z: 0 });
      hulls.push(rec);
    }
  }

  function update(dt, eng) {
    const game = eng.game;
    const player = game?.player ?? null;

    for (const s of state.values()) {
      const ship = s.ship;
      if (ship.alive === false) continue;

      for (const g of s.guns) if (g.cooldown > 0) g.cooldown -= dt;

      // Capacitor recharge, scaled by the share of reactor output routed to guns.
      const gunShare = s.power.guns ?? (1 / 3);
      const output = s.power.output ?? 100;
      s.charge = Math.min(s.capacitor, s.charge + output * gunShare * GUN_CHARGE_COEFF * dt);

      // Fire control: the player's trigger comes from input or a scripted capture;
      // NPC triggers are set by the AI system, which ran at priority 250.
      const wantsFire = ship === player
        ? (playerFiring || eng.input?.held?.('fire') || eng.input?.pressed?.('fire'))
        : !!ship.controls?.fire || !!ship.body?.controls?.fire;

      if (wantsFire) fireGuns(s, dt);

      // Publish the ITTS solution — the cockpit HUD's lead pipper reads this and
      // must not duplicate the maths.
      const tgt = targeting.getTarget?.(ship) ?? null;
      if (tgt) {
        s.solution = ittsSolution(ship, tgt, { projSpeed: s.guns[0]?.weapon?.speed ?? 1200 });
        s.status = solutionStatus(s.solution);
      } else {
        s.solution = null;
        s.status = null;
      }
      ship.combat = s;
    }

    // pool.update expects a collision context, not the engine. Passing the engine
    // meant ctx.hulls was undefined, so every bolt flew straight through every
    // ship and nothing could ever be damaged.
    refreshHulls(game);
    pool.update(dt, { hulls, softTargets: missiles.missiles ?? null });
    missiles.update?.(dt, eng);
    damage.update?.(dt, eng);
    targeting.update?.(dt, eng);
  }

  return {
    name: 'combat',
    priority: 300,
    update,
    attach,
    detach,
    dispose() {
      pool.clear?.();
      missiles.clear?.();
      for (const m of pool.meshes ?? []) engine.scene.remove(m);
      for (const m of missiles.meshes ?? []) engine.scene.remove(m);
      state.clear();
    },

    // ---- fire control -------------------------------------------------------
    setPlayerFiring(v) { playerFiring = !!v; },
    fireMissile,

    // ---- targeting passthrough (single place for HUD and AI to ask) ---------
    getTarget: (ship) => targeting.getTarget?.(ship) ?? null,
    setTarget: (ship, t) => targeting.setTarget?.(ship, t),
    cycleTarget: (ship, mode) => targeting.cycleTarget?.(ship, mode),
    nearestEnemy: (ship, opts) => targeting.nearest?.(ship, opts),
    solutionFor: (ship) => state.get(ship)?.solution ?? null,
    stateOf: (ship) => state.get(ship) ?? null,

    // ---- sub-managers, exposed for the cockpit and vfx ----------------------
    pool, targeting, damage, missiles,
    WEAPONS,
  };
}
