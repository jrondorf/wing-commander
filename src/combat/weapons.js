/**
 * src/combat/weapons.js — the gun table, the capacitor, and gun harmonisation.
 *
 * ## The loadout
 *
 * A ship's guns come from two places and both matter:
 *   - `stats.guns[]`      (src/ships/stats.js) — what the ship *carries*, with
 *                          per-ship damage/refire/energy tuning
 *   - `hardpoints.guns[]` (the mesh) — where the muzzles physically *are*
 *
 * We marry them: every hardpoint becomes an emitter, matched to the stat entry
 * with the same `type` (falling back to the first entry), so a Vampire fires
 * particle cannon from the wing mounts and lasers from the chin pod, out of the
 * barrels the modeller actually built.
 *
 * ## Energy
 *
 * Guns draw from a capacitor which recharges from the power plant at a rate set
 * by the guns/shields/engines triangle. Sustained fire on a balanced setting
 * *loses* — that is deliberate. The Wing Commander pilot's core skill is trigger
 * discipline: short bursts inside a firing solution, not a held trigger.
 *
 * ## Convergence
 *
 * Real gun harmonisation. Wing-root cannon are 3 m apart; if they fire straight
 * ahead they never both hit the same 20 m fighter. Each emitter is toed in so
 * every barrel passes through one point at `convergence` metres down the
 * boresight. Set it long for capital-ship strafing, short for knife-fight range.
 */
import * as THREE from 'three';
import { clamp, clamp01, lerp, num } from './util.js';

// ---------------------------------------------------------------------------
// the gun table
// ---------------------------------------------------------------------------

/**
 * Per weapon:
 *   damage       points per bolt, at the muzzle
 *   refire       seconds between shots, per emitter
 *   speed        muzzle velocity, m/s (added to the ship's own velocity)
 *   energy       capacitor draw per bolt
 *   range        metres — sets the bolt's lifetime
 *   convergence  default harmonisation distance, metres
 *   falloff      fraction of damage lost by max range (0 = no falloff)
 *   shieldMul    damage multiplier against shields
 *   armorMul     damage multiplier against armour and internals
 *   radius       bolt collision radius, metres
 *   spread       dispersion half-angle, radians
 *   color        HDR tracer colour (values are allowed to exceed 1 after gain)
 */
const T = (o) => Object.freeze(o);

export const WEAPONS = Object.freeze({
  mass_driver: T({
    id: 'mass_driver', label: 'Mass Driver', kind: 'gun',
    damage: 34, refire: 0.22, speed: 1900, energy: 5, range: 3200,
    convergence: 800, falloff: 0, shieldMul: 0.85, armorMul: 1.2,
    radius: 0.45, spread: 0.0009, boltLength: 14, glow: 1.6, color: '#ffd08a',
    // Solid slugs do not lose energy with distance. That is the whole point of
    // carrying one: cheap, honest, and it hits as hard at 3 km as at 300 m.
    note: 'kinetic slug — no falloff, light on the capacitor',
  }),

  laser: T({
    id: 'laser', label: 'Laser Cannon', kind: 'gun',
    damage: 20, refire: 0.13, speed: 3000, energy: 5, range: 3600,
    convergence: 1000, falloff: 0.4, shieldMul: 1.2, armorMul: 0.75,
    radius: 0.3, spread: 0.0006, boltLength: 26, glow: 2.1, color: '#ff9a4a',
    note: 'near-hitscan, high refire, bleeds off badly at range',
  }),

  ion: T({
    id: 'ion', label: 'Ion Cannon', kind: 'gun',
    damage: 66, refire: 0.36, speed: 1100, energy: 20, range: 4200,
    convergence: 650, falloff: 0.15, shieldMul: 1.55, armorMul: 0.7,
    radius: 0.8, spread: 0.0015, boltLength: 9, glow: 2.6, color: '#7fe4ff',
    note: 'slow heavy bolt — shreds shields, poor against armour',
  }),

  particle: T({
    id: 'particle', label: 'Particle Cannon', kind: 'gun',
    damage: 44, refire: 0.26, speed: 1500, energy: 13, range: 3800,
    convergence: 750, falloff: 0.2, shieldMul: 1.0, armorMul: 1.0,
    radius: 0.5, spread: 0.001, boltLength: 12, glow: 2.0, color: '#9fd8ff',
    note: 'the all-rounder — good damage, expensive to hold down',
  }),

  tachyon: T({
    id: 'tachyon', label: 'Tachyon Gun', kind: 'gun',
    damage: 38, refire: 0.18, speed: 2200, energy: 16, range: 4400,
    convergence: 900, falloff: 0.08, shieldMul: 1.1, armorMul: 1.05,
    radius: 0.38, spread: 0.0007, boltLength: 20, glow: 2.3, color: '#c8a8ff',
    note: 'flat trajectory, long reach, drinks the capacitor',
  }),

  plasma: T({
    id: 'plasma', label: 'Plasma Cannon', kind: 'gun',
    damage: 58, refire: 0.32, speed: 1250, energy: 19, range: 3400,
    convergence: 600, falloff: 0.28, shieldMul: 0.9, armorMul: 1.4,
    radius: 0.9, spread: 0.0018, boltLength: 8, glow: 2.8, color: '#b8ff4a',
    note: 'fat slow ball of hate — armour killer, easy to dodge',
  }),

  bio_lance: T({
    id: 'bio_lance', label: 'Bio-Lance', kind: 'gun',
    damage: 88, refire: 0.55, speed: 980, energy: 30, range: 4600,
    convergence: 700, falloff: 0.2, shieldMul: 1.3, armorMul: 1.25,
    radius: 1.05, spread: 0.0012, boltLength: 16, glow: 3.0, color: '#d8ff7a',
    note: 'Nephilim capital-grade lance mounted on a heavy fighter',
  }),

  // --- turret weapons -------------------------------------------------------
  turret_aa: T({
    id: 'turret_aa', label: 'AA Turret', kind: 'turret',
    damage: 30, refire: 0.22, speed: 1700, energy: 8, range: 2800,
    convergence: 0, falloff: 0.2, shieldMul: 1.0, armorMul: 1.0,
    radius: 0.42, spread: 0.004, boltLength: 12, glow: 1.9, color: '#ffb46a',
    note: 'anti-fighter and point defence',
  }),

  turret_antiship: T({
    id: 'turret_antiship', label: 'Anti-Ship Battery', kind: 'turret',
    damage: 210, refire: 1.6, speed: 1400, energy: 60, range: 9000,
    convergence: 0, falloff: 0.05, shieldMul: 1.2, armorMul: 1.3,
    radius: 2.2, spread: 0.0025, boltLength: 30, glow: 3.4, color: '#ffd0a0',
    note: 'capital main battery — will one-shot a fighter',
  }),
});

/** Ship stat blocks use short names; map them onto the table. */
const ALIASES = Object.freeze({
  mass: 'mass_driver', massdriver: 'mass_driver', 'mass-driver': 'mass_driver',
  md: 'mass_driver', slug: 'mass_driver', kinetic: 'mass_driver',
  laser: 'laser', blaster: 'laser',
  ion: 'ion', 'ion-cannon': 'ion',
  particle: 'particle', neutron: 'particle', photon: 'particle',
  tachyon: 'tachyon', reaper: 'tachyon',
  plasma: 'plasma', stormfire: 'plasma',
  'bio-lance': 'bio_lance', biolance: 'bio_lance', bio_lance: 'bio_lance',
  turret: 'turret_aa', aa: 'turret_aa', pd: 'turret_aa', flak: 'turret_aa',
  antiship: 'turret_antiship', 'anti-ship': 'turret_antiship', main: 'turret_antiship',
});

export const WEAPON_IDS = Object.keys(WEAPONS);

export function weaponIdFor(type) {
  const k = String(type ?? '').toLowerCase().trim();
  if (WEAPONS[k]) return k;
  return ALIASES[k] ?? 'particle';
}

const _color = new THREE.Color();

/**
 * Resolve a weapon spec: table entry + per-ship overrides from `stats.guns[]`.
 * The result is a plain frozen-ish object; consumers must not mutate it.
 */
export function resolveWeapon(type, overrides = null) {
  const base = WEAPONS[weaponIdFor(type)];
  const w = { ...base, type: base.id, sourceType: String(type ?? base.id) };
  if (overrides) {
    for (const k of ['damage', 'refire', 'speed', 'energy', 'range', 'convergence',
      'falloff', 'shieldMul', 'armorMul', 'radius', 'spread', 'color']) {
      if (overrides[k] != null && (typeof overrides[k] !== 'number' || Number.isFinite(overrides[k]))) {
        w[k] = overrides[k];
      }
    }
  }
  if (!w.convergence) w.convergence = base.convergence || 750;
  _color.set(w.color);
  w.rgb = [_color.r, _color.g, _color.b];
  w.lifetime = Math.max(0.15, w.range / Math.max(1, w.speed));
  return w;
}

// ---------------------------------------------------------------------------
// power distribution — the guns / shields / engines triangle
// ---------------------------------------------------------------------------

/** Nominal share; every derived rate is expressed relative to this. */
export const NOMINAL_SHARE = 1 / 3;

export const POWER_PRESETS = Object.freeze({
  balanced: { guns: 1 / 3, shields: 1 / 3, engines: 1 / 3 },
  attack: { guns: 0.56, shields: 0.24, engines: 0.20 },
  defensive: { guns: 0.20, shields: 0.58, engines: 0.22 },
  run: { guns: 0.16, shields: 0.24, engines: 0.60 },
});

export function createPowerPlant(stats = {}) {
  const p = {
    output: Math.max(1, num(stats.powerPlant, 600)),
    guns: 1 / 3,
    shields: 1 / 3,
    engines: 1 / 3,
    /** How far the triangle may be pushed toward one vertex. */
    maxShare: 0.7,
    minShare: 0.08,
  };

  /** Renormalise so the three shares always sum to exactly 1. */
  function normalise() {
    p.guns = clamp(p.guns, p.minShare, p.maxShare);
    p.shields = clamp(p.shields, p.minShare, p.maxShare);
    p.engines = clamp(p.engines, p.minShare, p.maxShare);
    const s = p.guns + p.shields + p.engines;
    p.guns /= s; p.shields /= s; p.engines /= s;
  }

  /** Move `amount` of the pie toward one vertex, taking it from the other two. */
  p.shift = (which, amount = 0.08) => {
    if (!(which in POWER_PRESETS.balanced)) return p;
    const others = ['guns', 'shields', 'engines'].filter((k) => k !== which);
    const take = Math.min(amount, Math.max(0, p[others[0]] - p.minShare) + Math.max(0, p[others[1]] - p.minShare));
    if (take <= 0) return p;
    const a = Math.max(0, p[others[0]] - p.minShare);
    const b = Math.max(0, p[others[1]] - p.minShare);
    const tot = a + b;
    if (tot > 1e-6) {
      p[others[0]] -= take * (a / tot);
      p[others[1]] -= take * (b / tot);
    }
    p[which] += take;
    normalise();
    return p;
  };

  p.set = (guns, shields, engines) => {
    p.guns = num(guns, p.guns);
    p.shields = num(shields, p.shields);
    p.engines = num(engines, p.engines);
    normalise();
    return p;
  };

  p.preset = (name) => {
    const preset = POWER_PRESETS[name];
    if (preset) p.set(preset.guns, preset.shields, preset.engines);
    return p;
  };

  return p;
}

/** Capacitor recharge, in points/second, for the current triangle setting. */
export const GUN_CHARGE_COEFF = 0.55;
export function capacitorRate(power, damageScale = 1) {
  return power.output * power.guns * GUN_CHARGE_COEFF * clamp01(damageScale);
}

/**
 * Engine share -> hard throttle scale. Starving the engines genuinely slows the
 * ship; over-feeding them does nothing (throttle is already capped at 1), which
 * is exactly the asymmetry Wing Commander used.
 */
export function engineSpeedScale(power) {
  return clamp(0.55 + power.engines * 1.35, 0.55, 1);
}

/** Shield share -> regeneration multiplier, 1.0 at the balanced setting. */
export function shieldRegenScale(power) {
  return clamp(power.shields / NOMINAL_SHARE, 0.2, 2.1);
}

export function createCapacitor(stats = {}) {
  const max = Math.max(40, num(stats.capacitor, 400));
  return { max, energy: max, rate: 0, drained: false, dryFor: 0 };
}

// ---------------------------------------------------------------------------
// loadout
// ---------------------------------------------------------------------------

const _v = new THREE.Vector3();

/**
 * Build the emitter list for a ship.
 *
 * Emitters are the physical barrels. Groups are what the pilot selects with the
 * weapon-select key: one per distinct gun type, plus "all" when there is more
 * than one type — the WC convention (`FULL GUNS` vs a single bank).
 */
export function createLoadout(ship) {
  const stats = ship?.stats ?? ship?.group?.userData?.stats ?? {};
  const statGuns = Array.isArray(stats.guns) ? stats.guns : [];
  const hardpoints = (ship?.hardpoints?.guns ?? ship?.group?.userData?.hardpoints?.guns ?? []);

  /** Stat entry whose `type` matches this hardpoint, else the first entry. */
  const statFor = (type) => {
    if (!statGuns.length) return null;
    const want = weaponIdFor(type);
    return statGuns.find((g) => weaponIdFor(g.type) === want) ?? statGuns[0];
  };

  const emitters = [];

  if (hardpoints.length) {
    for (let i = 0; i < hardpoints.length; i++) {
      const hp = hardpoints[i];
      const override = statFor(hp.type);
      // Turret barrels declared as guns are driven by the turret controller.
      const w = resolveWeapon(hp.type ?? override?.type ?? 'particle', override);
      if (w.kind === 'turret') continue;
      emitters.push(makeEmitter(i, w, hp.pos, hp.dir));
    }
  }

  // A ship whose mesh declares no barrels still shoots — from its nose.
  if (!emitters.length && statGuns.length) {
    for (let i = 0; i < statGuns.length; i++) {
      const g = statGuns[i];
      const w = resolveWeapon(g.type, g);
      if (w.kind === 'turret') continue;
      const x = (i % 2 ? 1 : -1) * Math.max(1.2, num(stats.length, 20) * 0.16);
      const z = -Math.max(2, num(stats.length, 20) * 0.42);
      emitters.push(makeEmitter(i, w, new THREE.Vector3(x, 0, z), new THREE.Vector3(0, 0, -1)));
    }
  }

  // Stagger the initial cooldowns inside each weapon type so a bank ripples
  // rather than firing as one slab — the classic WC "brrap".
  const byType = new Map();
  for (const e of emitters) {
    if (!byType.has(e.weapon.type)) byType.set(e.weapon.type, []);
    byType.get(e.weapon.type).push(e);
  }
  for (const [, list] of byType) {
    for (let i = 0; i < list.length; i++) {
      list[i].cool = (list[i].weapon.refire * i) / list.length;
      list[i].bankIndex = i;
    }
  }

  const groups = [];
  for (const [type, list] of byType) {
    groups.push({ id: type, label: list[0].weapon.label, emitters: list });
  }
  if (groups.length > 1) groups.push({ id: 'all', label: 'Full Guns', emitters });

  return {
    emitters,
    groups,
    /** Index into `groups`. Defaults to "everything". */
    group: groups.length > 1 ? groups.length - 1 : 0,
    /** Harmonisation distance, metres. 0 = use each weapon's own default. */
    convergence: 0,
    /** Auto-harmonise onto the current target's range. */
    autoConverge: true,
  };
}

function makeEmitter(index, weapon, pos, dir) {
  return {
    index,
    weapon,
    /** Muzzle position and boresight, ship-local. */
    pos: pos?.isVector3 ? pos.clone() : new THREE.Vector3(0, 0, -3),
    dir: dir?.isVector3 ? dir.clone().normalize() : new THREE.Vector3(0, 0, -1),
    cool: 0,
    bankIndex: 0,
    shots: 0,
  };
}

export function activeGroup(loadout) {
  if (!loadout?.groups?.length) return null;
  return loadout.groups[clamp(loadout.group | 0, 0, loadout.groups.length - 1)];
}

export function cycleGroup(loadout, dir = 1) {
  if (!loadout?.groups?.length) return null;
  loadout.group = (loadout.group + dir + loadout.groups.length) % loadout.groups.length;
  return activeGroup(loadout);
}

/**
 * Aim one emitter, harmonised.
 *
 * The convergence point sits `range` metres down the *ship's* boresight from
 * the hull origin; every barrel is toed in to pass through it. Beyond that
 * point the shots cross and diverge again, exactly like real gun harmonisation
 * — which is why the range you pick matters.
 *
 * @param muzzleWorld  world-space muzzle position
 * @param shipPos      world-space hull origin
 * @param shipFwd      unit boresight, world space
 * @param range        harmonisation distance in metres; <=0 disables toe-in
 * @param fallbackDir  world-space emitter direction if convergence is off
 */
export function convergeDirection(muzzleWorld, shipPos, shipFwd, range, fallbackDir, out) {
  if (!(range > 1)) return out.copy(fallbackDir).normalize();
  _v.copy(shipPos).addScaledVector(shipFwd, range).sub(muzzleWorld);
  const len = _v.length();
  if (len < 1e-3) return out.copy(fallbackDir).normalize();
  return out.copy(_v).multiplyScalar(1 / len);
}

/** Damage a bolt of `weapon` still carries after flying `travelled` metres. */
export function rangeFalloff(weapon, travelled) {
  if (!weapon.falloff) return 1;
  const t = clamp01(travelled / Math.max(1, weapon.range));
  return lerp(1, 1 - clamp01(weapon.falloff), t * t);
}
