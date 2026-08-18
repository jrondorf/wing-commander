/**
 * Ships — the fleet registry and the one entry point every other system uses.
 *
 *   import { SHIP_CLASSES, buildShip } from './ships/Ships.js';
 *   const group = buildShip(engine, 'confed_vampire', { seed, faction, livery });
 *
 * ## Conventions every consumer can rely on
 *
 * **-Z is forward**, +Y is up, +X is starboard, for every hull and every hardpoint
 * direction. `group.userData.forward` states it explicitly so nothing has to guess.
 * Units are metres and the origin sits at the ship's centre of mass.
 *
 * ## What comes back
 *
 * A `THREE.Group` containing a `THREE.LOD` with three levels. `userData` carries:
 *
 *   hardpoints  { guns, missiles, engines, thrusters, turrets, cockpit, hangars }
 *   stats       flight/combat block (see stats.js)
 *   lods        [{ distance, object, tris, draws }]
 *   radius      bounding-sphere radius, for culling and collision broad-phase
 *   bounds      THREE.Box3 in ship space
 *
 * Hardpoint positions are fresh Vector3s per ship, so a flight or combat system
 * may safely transform them in place.
 *
 * ## Caching
 *
 * Geometry generation is expensive and a wing of six fighters must not pay for it
 * six times. A *prototype* is built once per (class, geometry variant, faction,
 * livery) and cached in `engine.registry`; each spawn clones the prototype's
 * scene graph, which shares the underlying geometry and materials. The caller's
 * seed still varies the hull — it just quantises to a small family of variants so
 * a squadron looks varied without eight full rebuilds.
 */
import * as THREE from 'three';
import { makeRng, hashSeed } from '../core/Rand.js';
import { resolveMaterials, resolveGreebles, paletteFor, hasMaterialLibrary } from './materials.js';
import { fallbackGreebleSet, triCount } from './geometryKit.js';
import { ShipAssembler } from './assembler.js';
import { STATS } from './stats.js';

import * as confedVampire from './classes/confedVampire.js';
import * as confedPanther from './classes/confedPanther.js';
import * as confedDevastator from './classes/confedDevastator.js';
import * as alienManta from './classes/alienManta.js';
import * as alienMoray from './classes/alienMoray.js';
import * as alienLeviathan from './classes/alienLeviathan.js';
import * as confedCarrier from './classes/confedCarrier.js';
import * as civDrayman from './classes/civDrayman.js';

const MODULES = [
  confedVampire, confedPanther, confedDevastator,
  alienManta, alienMoray,
  confedCarrier, alienLeviathan, civDrayman,
];

/** Number of distinct geometry variants generated per class. */
const VARIANTS = 3;

/**
 * Public class table, keyed by id. Each entry is the class definition merged with
 * its stat block — enough for a briefing screen, a loadout UI or an AI difficulty
 * pass to reason about a ship without instantiating it.
 */
export const SHIP_CLASSES = Object.freeze(Object.fromEntries(
  MODULES.map((m) => [m.def.id, Object.freeze({ ...m.def, stats: STATS[m.def.id] ?? null })]),
));

export const SHIP_IDS = Object.keys(SHIP_CLASSES);

const BY_ID = new Map(MODULES.map((m) => [m.def.id, m]));

// ----------------------------------------------------------------- prototypes

function buildLevel(engine, mod, { detail, seed, faction, livery, mats, greebles }) {
  const rng = makeRng(seed + detail * 7919);
  const A = new ShipAssembler({ engine, rng, mats, detail, collectHardpoints: detail === 0 });
  mod.build(A, rng, greebles);
  const out = A.build();
  out.object.name = `${mod.def.id}:lod${detail}`;
  return { ...out, hardpoints: A.hardpoints };
}

function buildPrototype(engine, mod, { variant, faction, livery, seed }) {
  const palette = paletteFor(faction, mod.def.capital ? 'capital' : 'default');
  const mats = resolveMaterials(engine, { style: mod.def.style, seed: variant + 1, palette, faction: `${faction}/${livery}` });
  const greebles = resolveGreebles(engine, variant + 1, fallbackGreebleSet);

  const lod = new THREE.LOD();
  lod.name = mod.def.id;
  const levels = [];
  const distances = mod.def.lod ?? [0, 300, 1200];
  let hardpoints = null;
  for (let d = 0; d < 3; d++) {
    const built = buildLevel(engine, mod, { detail: d, seed, faction, livery, mats, greebles });
    lod.addLevel(built.object, distances[d]);
    levels.push({ distance: distances[d], object: built.object, tris: built.tris, draws: built.draws });
    if (d === 0) hardpoints = built.hardpoints;
  }

  // Bounds come from LOD0 — the only level with the full silhouette.
  const bounds = new THREE.Box3().setFromObject(levels[0].object);
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());

  return { lod, levels, hardpoints, bounds, radius: sphere.radius, center: sphere.center };
}

// -------------------------------------------------------------------- public

/**
 * Build a ship.
 *
 * @param {import('../core/Engine.js').Engine} engine
 * @param {string} classId one of SHIP_IDS
 * @param {{seed?:number, faction?:string, livery?:string}} opts
 * @returns {THREE.Group}
 */
export function buildShip(engine, classId, { seed = 1, faction = null, livery = 'line' } = {}) {
  let mod = BY_ID.get(classId);
  if (!mod) {
    console.warn(`[ships] unknown class "${classId}" — substituting ${confedVampire.def.id}`);
    mod = confedVampire;
  }
  const fac = faction ?? mod.def.faction;
  const s = (typeof seed === 'string' ? hashSeed(seed) : seed) >>> 0;
  const variant = s % VARIANTS;
  const key = `ships/proto/${mod.def.id}/${variant}/${fac}/${livery}`;

  const proto = engine.registry.get(key, () => {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    const built = buildPrototype(engine, mod, { variant, faction: fac, livery, seed: 1000 + variant * 977 });
    const ms = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    const l0 = built.levels[0];
    console.info(`[ships] ${mod.def.id} v${variant} — LOD0 ${l0.tris} tris / ${l0.draws} draws, ` +
      `LOD1 ${built.levels[1].tris}, LOD2 ${built.levels[2].tris} (${ms.toFixed(0)} ms)` +
      `${hasMaterialLibrary() ? '' : ' [fallback materials]'}`);
    return built;
  });

  const group = new THREE.Group();
  group.name = `${mod.def.id}#${s}`;
  const lod = proto.lod.clone();
  lod.autoUpdate = true;
  group.add(lod);

  group.userData.classId = mod.def.id;
  group.userData.def = SHIP_CLASSES[mod.def.id];
  group.userData.faction = fac;
  group.userData.livery = livery;
  group.userData.seed = s;
  group.userData.variant = variant;
  group.userData.forward = new THREE.Vector3(0, 0, -1);
  group.userData.up = new THREE.Vector3(0, 1, 0);
  group.userData.stats = cloneStats(STATS[mod.def.id]);
  group.userData.hardpoints = cloneHardpoints(proto.hardpoints);
  group.userData.lod = lod;
  group.userData.lods = lod.levels.map((l, i) => ({
    distance: l.distance,
    object: l.object,
    tris: proto.levels[i].tris,
    draws: proto.levels[i].draws,
  }));
  group.userData.radius = proto.radius;
  group.userData.bounds = proto.bounds.clone();
  group.userData.center = proto.center.clone();
  group.userData.tris = proto.levels[0].tris;
  group.userData.draws = proto.levels[0].draws;
  return group;
}

/** Triangle/draw-call report for every class — used by the perf budget checks. */
export function shipBudget(engine, { faction = null, livery = 'line' } = {}) {
  const rows = [];
  for (const id of SHIP_IDS) {
    const g = buildShip(engine, id, { seed: 1, faction, livery });
    rows.push({
      id,
      lod0: g.userData.lods[0].tris, lod1: g.userData.lods[1].tris, lod2: g.userData.lods[2].tris,
      draws: g.userData.lods[0].draws,
      radius: +g.userData.radius.toFixed(1),
      hardpoints: {
        guns: g.userData.hardpoints.guns.length,
        missiles: g.userData.hardpoints.missiles.length,
        engines: g.userData.hardpoints.engines.length,
        thrusters: g.userData.hardpoints.thrusters.length,
        turrets: g.userData.hardpoints.turrets.length,
      },
    });
  }
  return rows;
}

// ------------------------------------------------------------------ helpers

function cloneHardpoints(hp) {
  if (!hp) return { guns: [], missiles: [], engines: [], thrusters: [], turrets: [], cockpit: null, hangars: [] };
  const v = (o) => {
    const c = { ...o };
    for (const k of ['pos', 'dir']) if (c[k]?.isVector3) c[k] = c[k].clone();
    return c;
  };
  return {
    guns: hp.guns.map(v),
    missiles: hp.missiles.map(v),
    engines: hp.engines.map(v),
    thrusters: hp.thrusters.map(v),
    turrets: hp.turrets.map(v),
    hangars: (hp.hangars ?? []).map(v),
    cockpit: hp.cockpit ? { pos: hp.cockpit.pos.clone(), quaternion: hp.cockpit.quaternion.clone() } : null,
  };
}

function cloneStats(s) {
  if (!s) return null;
  return {
    ...s,
    shields: { ...s.shields },
    armor: { ...s.armor },
    guns: s.guns.map((g) => ({ ...g })),
    missiles: s.missiles.map((m) => ({ ...m })),
    turrets: s.turrets ? s.turrets.map((t) => ({ ...t })) : undefined,
  };
}

export default { SHIP_CLASSES, SHIP_IDS, buildShip, shipBudget };
