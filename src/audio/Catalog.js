/**
 * Catalog.js — the sound list.
 *
 * One entry per sound id. The entry owns everything the mixer needs to place the
 * sound (bus, priority, spatialisation, instance limits) and everything the
 * offline self-test needs to judge it (render length and expected level window).
 *
 * `priority` drives voice stealing: 1.0 never dies (player alerts), 0.2 is the
 * first thing dropped in a 40-ship furball.
 */
import * as W from './synth/weapons.js';
import * as X from './synth/explosions.js';
import * as I from './synth/impacts.js';
import * as M from './synth/missiles.js';
import * as U from './synth/ui.js';
import * as E from './synth/engines.js';
import * as A from './synth/ambience.js';
import * as V from './synth/voice.js';

/**
 * @typedef {Object} SoundDef
 * @property {string}  bus          music | sfx | engine | ui | voice
 * @property {number}  priority     0..1, higher survives voice stealing
 * @property {boolean} spatial      placed with a PannerNode when a position is given
 * @property {boolean} sustained    runs until stop(handle)
 * @property {number}  level        voice gain
 * @property {number}  send         reverb send amount (0 = dry)
 * @property {number}  minInterval  retrigger throttle, seconds
 * @property {number}  maxInstances live instances of this id (0 = unlimited)
 * @property {Function} synth       (ctx, out, t, opts, rng) => { duration, sources, pitch }
 * @property {Object}  test         offline-render expectations
 */

const def = (o) => ({
  bus: 'sfx', priority: 0.5, spatial: true, sustained: false,
  level: 1, send: 0, minInterval: 0, maxInstances: 0,
  test: {}, ...o,
});

export const CATALOG = {
  // ------------------------------------------------------------------ weapons
  'weapon.massdriver': def({
    synth: W.synthMassDriver, bus: 'sfx', priority: 0.45, level: 0.9,
    minInterval: 0.02, maxInstances: 6,
    test: { dur: 0.6, minPeak: 0.1, maxPeak: 0.99, minRms: 0.004 },
  }),
  'weapon.laser': def({
    synth: W.synthLaser, bus: 'sfx', priority: 0.45, level: 0.85, send: 0.08,
    minInterval: 0.02, maxInstances: 6,
    test: { dur: 0.8, minPeak: 0.08, maxPeak: 0.99, minRms: 0.003 },
  }),
  'weapon.ion': def({
    synth: W.synthIonCannon, bus: 'sfx', priority: 0.45, level: 0.9, send: 0.1,
    minInterval: 0.02, maxInstances: 5,
    test: { dur: 0.8, minPeak: 0.08, maxPeak: 0.99, minRms: 0.004 },
  }),
  'weapon.particle': def({
    synth: W.synthParticleCannon, bus: 'sfx', priority: 0.45, level: 0.9, send: 0.1,
    minInterval: 0.02, maxInstances: 5,
    test: { dur: 0.9, minPeak: 0.08, maxPeak: 0.99, minRms: 0.004 },
  }),
  'weapon.turret': def({
    synth: W.synthTurret, bus: 'sfx', priority: 0.55, level: 1, send: 0.22,
    minInterval: 0.05, maxInstances: 4,
    test: { dur: 1.5, minPeak: 0.15, maxPeak: 0.99, minRms: 0.01 },
  }),
  'weapon.dry': def({
    synth: W.synthDryFire, bus: 'ui', priority: 0.3, spatial: false, level: 0.7,
    minInterval: 0.08, maxInstances: 2,
    test: { dur: 0.3, minPeak: 0.02, maxPeak: 0.99, minRms: 0.0008 },
  }),

  // ----------------------------------------------------------------- missiles
  'missile.launch': def({
    synth: M.synthMissileLaunch, bus: 'sfx', priority: 0.7, level: 1, send: 0.2,
    minInterval: 0.03, maxInstances: 4,
    test: { dur: 1.2, minPeak: 0.15, maxPeak: 0.99, minRms: 0.01 },
  }),
  'missile.thrust': def({
    synth: M.synthMissileThrust, bus: 'sfx', priority: 0.4, sustained: true, level: 0.7,
    maxInstances: 6,
    test: { dur: 2.0, stopAt: 1.4, minPeak: 0.05, maxPeak: 0.99, minRms: 0.01 },
  }),
  'missile.lockSeek': def({
    synth: M.synthLockBlip, bus: 'ui', priority: 0.8, spatial: false, level: 0.8,
    minInterval: 0.04,
    test: { dur: 0.3, minPeak: 0.05, maxPeak: 0.99, minRms: 0.008 },
  }),
  'missile.lockTone': def({
    synth: M.synthLockTone, bus: 'ui', priority: 0.85, spatial: false, sustained: true, level: 0.7,
    maxInstances: 1,
    test: { dur: 1.2, stopAt: 0.9, minPeak: 0.05, maxPeak: 0.99, minRms: 0.01 },
  }),
  'missile.incoming': def({
    synth: M.synthMissileWarning, bus: 'ui', priority: 1.0, spatial: false, level: 0.9,
    maxInstances: 1,
    test: { dur: 2.4, minPeak: 0.1, maxPeak: 0.99, minRms: 0.02 },
  }),
  'missile.decoy': def({
    synth: M.synthDecoy, bus: 'sfx', priority: 0.6, level: 0.8,
    minInterval: 0.05,
    test: { dur: 0.6, minPeak: 0.05, maxPeak: 0.99, minRms: 0.005 },
  }),

  // ------------------------------------------------------------------ impacts
  'impact.shield': def({
    synth: I.synthShieldImpact, bus: 'sfx', priority: 0.6, level: 0.9, send: 0.16,
    minInterval: 0.02, maxInstances: 5,
    test: { dur: 1.2, minPeak: 0.08, maxPeak: 0.99, minRms: 0.006 },
  }),
  'impact.armor': def({
    synth: I.synthArmorImpact, bus: 'sfx', priority: 0.6, level: 1, send: 0.1,
    minInterval: 0.02, maxInstances: 5,
    test: { dur: 0.7, minPeak: 0.1, maxPeak: 0.99, minRms: 0.008 },
  }),
  'impact.hull': def({
    synth: I.synthHullBreach, bus: 'sfx', priority: 0.75, level: 1, send: 0.25,
    minInterval: 0.05, maxInstances: 3,
    test: { dur: 2.0, minPeak: 0.12, maxPeak: 0.99, minRms: 0.01 },
  }),
  'impact.debris': def({
    synth: I.synthDebrisTick, bus: 'sfx', priority: 0.2, level: 0.6,
    minInterval: 0.01, maxInstances: 6,
    test: { dur: 0.25, minPeak: 0.02, maxPeak: 0.99, minRms: 0.002 },
  }),
  'impact.collision': def({
    synth: I.synthCollision, bus: 'sfx', priority: 0.8, level: 1, send: 0.25,
    minInterval: 0.06, maxInstances: 3,
    test: { dur: 1.2, minPeak: 0.12, maxPeak: 0.99, minRms: 0.01 },
  }),

  // --------------------------------------------------------------- explosions
  explosion: def({
    synth: X.synthExplosion, bus: 'sfx', priority: 0.85, level: 1, send: 0.35,
    minInterval: 0.02, maxInstances: 6,
    test: { dur: 4.0, minPeak: 0.2, maxPeak: 0.99, minRms: 0.02 },
  }),
  'explosion.capital': def({
    synth: X.synthCapitalExplosion, bus: 'sfx', priority: 1.0, level: 1, send: 0.5,
    minInterval: 0.1, maxInstances: 2,
    test: { dur: 8.0, minPeak: 0.25, maxPeak: 0.99, minRms: 0.02, opts: { size: 6 } },
  }),

  // ------------------------------------------------------------------ engines
  'engine.loop': def({
    synth: E.synthEngineLoop, bus: 'engine', priority: 0.55, sustained: true, level: 0.8,
    test: { dur: 2.5, stopAt: 1.8, minPeak: 0.03, maxPeak: 0.99, minRms: 0.008, opts: { throttle: 0.8, speed: 380 } },
  }),
  'engine.afterburner': def({
    synth: E.synthAfterburnerIgnite, bus: 'engine', priority: 0.7, level: 0.9, send: 0.12,
    minInterval: 0.1, maxInstances: 3,
    test: { dur: 1.4, minPeak: 0.12, maxPeak: 0.99, minRms: 0.02 },
  }),
  'engine.afterburnerCut': def({
    synth: E.synthAfterburnerCut, bus: 'engine', priority: 0.5, level: 0.8,
    minInterval: 0.1, maxInstances: 3,
    test: { dur: 0.9, minPeak: 0.05, maxPeak: 0.99, minRms: 0.01 },
  }),
  'engine.spool': def({
    synth: E.synthEngineSpool, bus: 'engine', priority: 0.6, level: 0.8,
    minInterval: 0.5, maxInstances: 2,
    test: { dur: 3.0, minPeak: 0.06, maxPeak: 0.99, minRms: 0.02 },
  }),

  // ------------------------------------------------------- cockpit & warnings
  'cockpit.air': def({
    synth: A.synthCockpitAir, bus: 'sfx', priority: 0.95, spatial: false, sustained: true, level: 1,
    maxInstances: 1,
    test: { dur: 3.0, stopAt: 2.4, minPeak: 0.004, maxPeak: 0.6, minRms: 0.0006 },
  }),
  'cockpit.hum': def({
    synth: A.synthCockpitHum, bus: 'sfx', priority: 0.95, spatial: false, sustained: true, level: 1,
    maxInstances: 1,
    test: { dur: 2.5, stopAt: 2.0, minPeak: 0.005, maxPeak: 0.6, minRms: 0.0008 },
  }),
  'cockpit.servo': def({
    synth: A.synthServo, bus: 'sfx', priority: 0.9, spatial: false, sustained: true, level: 1,
    maxInstances: 1,
    test: { dur: 1.6, stopAt: 1.2, minPeak: 0.004, maxPeak: 0.9, minRms: 0.0008, set: { load: 0.9 } },
  }),
  'cockpit.creak': def({
    synth: A.synthCreak, bus: 'sfx', priority: 0.5, spatial: false, level: 0.8,
    minInterval: 0.4, maxInstances: 2,
    test: { dur: 1.4, minPeak: 0.02, maxPeak: 0.99, minRms: 0.003 },
  }),
  'alert.klaxon': def({
    synth: A.synthKlaxon, bus: 'ui', priority: 1.0, spatial: false, level: 0.85,
    minInterval: 0.3, maxInstances: 1,
    test: { dur: 1.6, minPeak: 0.1, maxPeak: 0.99, minRms: 0.02 },
  }),
  'alert.caution': def({
    synth: A.synthCaution, bus: 'ui', priority: 0.9, spatial: false, level: 0.8,
    minInterval: 0.3, maxInstances: 1,
    test: { dur: 0.6, minPeak: 0.04, maxPeak: 0.99, minRms: 0.006 },
  }),

  // ----------------------------------------------------------------------- UI
  'ui.lock': def({
    synth: U.synthTargetLock, bus: 'ui', priority: 0.8, spatial: false, level: 0.8,
    minInterval: 0.05,
    test: { dur: 0.5, minPeak: 0.04, maxPeak: 0.99, minRms: 0.004 },
  }),
  'ui.beep': def({
    synth: U.synthBeep, bus: 'ui', priority: 0.7, spatial: false, level: 0.7,
    minInterval: 0.02,
    test: { dur: 0.2, minPeak: 0.03, maxPeak: 0.99, minRms: 0.004 },
  }),
  'ui.select': def({
    synth: U.synthSelect, bus: 'ui', priority: 0.7, spatial: false, level: 0.7,
    minInterval: 0.02,
    test: { dur: 0.25, minPeak: 0.03, maxPeak: 0.99, minRms: 0.004 },
  }),
  'ui.deny': def({
    synth: U.synthDeny, bus: 'ui', priority: 0.7, spatial: false, level: 0.7,
    minInterval: 0.05,
    test: { dur: 0.35, minPeak: 0.03, maxPeak: 0.99, minRms: 0.004 },
  }),
  'ui.mfd': def({
    synth: U.synthMfdSwitch, bus: 'ui', priority: 0.65, spatial: false, level: 0.7,
    minInterval: 0.02,
    test: { dur: 0.25, minPeak: 0.02, maxPeak: 0.99, minRms: 0.002 },
  }),
  'ui.squelchOpen': def({
    synth: U.synthSquelchOpen, bus: 'ui', priority: 0.85, spatial: false, level: 0.7,
    minInterval: 0.05,
    test: { dur: 0.4, minPeak: 0.02, maxPeak: 0.99, minRms: 0.003 },
  }),
  'ui.squelchClose': def({
    synth: U.synthSquelchClose, bus: 'ui', priority: 0.85, spatial: false, level: 0.7,
    minInterval: 0.05,
    test: { dur: 0.3, minPeak: 0.02, maxPeak: 0.99, minRms: 0.003 },
  }),
  'ui.targetCycle': def({
    synth: U.synthTargetCycle, bus: 'ui', priority: 0.6, spatial: false, level: 0.7,
    minInterval: 0.02,
    test: { dur: 0.15, minPeak: 0.01, maxPeak: 0.99, minRms: 0.001 },
  }),

  // -------------------------------------------------------------------- voice
  'voice.line': def({
    synth: V.synthVoiceLine, bus: 'voice', priority: 0.95, spatial: false, level: 1,
    minInterval: 0.05, maxInstances: 1,
    test: { dur: 2.6, minPeak: 0.05, maxPeak: 0.99, minRms: 0.01, opts: { line: 'shields critical' } },
  }),
};

export const SOUND_IDS = Object.keys(CATALOG);

/** Weapon type string (from combat/) -> catalogue id. Substring matched. */
const WEAPON_MAP = [
  [/mass|slug|kinetic|gatling|ballistic|chain/, 'weapon.massdriver'],
  [/laser|blaster/, 'weapon.laser'],
  [/ion|plasma|meson|stormfire/, 'weapon.ion'],
  [/particle|tachyon|neutron|photon|reaper/, 'weapon.particle'],
  [/turret|flak|aaa|capital|main.?gun|antimatter/, 'weapon.turret'],
];

export function weaponSoundId(type = '') {
  const s = String(type).toLowerCase();
  for (const [re, id] of WEAPON_MAP) if (re.test(s)) return id;
  return 'weapon.laser';
}
