/**
 * MaterialLibrary — every surface in the game is made here.
 *
 * All materials are `MeshPhysicalMaterial` wired to procedurally generated map
 * sets from `procgen/textures.js`. Nothing loads an image; nothing sets
 * `renderer.toneMapping` (the post stack owns that); emissives are free to exceed
 * 1.0 because the world renders to a HalfFloat target.
 *
 * The one rule that matters for look: `roughness` and `metalness` are left at 1.0
 * so the packed ORM map drives them outright. A material that overrides them with
 * a scalar throws away the texture's structure, and flat roughness is the single
 * fastest way to make a hull read as cheap CG.
 *
 * Channel packing follows glTF ORM — one RGB texture serves aoMap (.r),
 * roughnessMap (.g) and metalnessMap (.b).
 */

import * as THREE from 'three';
import { generateHullMaterialSet, HULL_STYLES } from '../procgen/textures.js';
import { hashSeed } from '../core/Rand.js';

const CLEARCOAT_RANGE = [0.15, 0.3];

function keyOf(prefix, opts) {
  const parts = Object.keys(opts).sort().map((k) => {
    const v = opts[k];
    if (v === null || v === undefined) return `${k}:_`;
    if (typeof v === 'object') return `${k}:${hashSeed(JSON.stringify(v))}`;
    return `${k}:${v}`;
  });
  return `${prefix}|${parts.join('|')}`;
}

/**
 * Painted metal over composite — the standard hull surface.
 *
 * @param {object} engine
 * @param {object} opts
 * @param {'confed'|'kilrathi'|'alien'|'capital'|'civilian'} [opts.style='confed']
 * @param {number} [opts.seed=1]
 * @param {number} [opts.size=2048]
 * @param {object} [opts.palette] partial palette override (see HULL_STYLES)
 * @param {number} [opts.wear=0.5]
 * @param {number} [opts.panelScale=1]
 * @param {object|string} [opts.insignia]
 * @param {object} [opts.ports] real hardpoint UVs: {thrusters,muzzles,vents}
 * @param {number} [opts.emissiveIntensity=2.2] engine/running lights run hot
 * @returns {THREE.MeshPhysicalMaterial}
 */
export function createHullMaterial(engine, opts = {}) {
  const {
    style = 'confed', seed = 1, size = 2048, palette = null, wear = 0.5,
    panelScale = 1, insignia = null, ports = null,
    emissiveIntensity = 2.2, envMapIntensity = 1.0, normalScale = 1,
    clearcoat = null, side = THREE.FrontSide, name = '',
  } = opts;

  const key = keyOf('mat/hull', {
    style, seed, size, palette, wear, panelScale, insignia, ports,
    emissiveIntensity, envMapIntensity, normalScale, clearcoat, side,
  });

  const build = () => {
    const set = generateHullMaterialSet(engine, { size, seed, style, palette, wear, panelScale, insignia, ports });
    const sd = set.style ?? HULL_STYLES[style] ?? HULL_STYLES.confed;

    // Painted surfaces have a thin lacquer over them; bare alien chitin does not.
    const cc = clearcoat ?? THREE.MathUtils.clamp(sd.clearcoat ?? 0.22, 0, 1);

    const mat = new THREE.MeshPhysicalMaterial({
      name: name || `hull-${style}-${seed}`,
      map: set.map,
      normalMap: set.normalMap,
      normalScale: new THREE.Vector2(normalScale, normalScale),
      roughnessMap: set.roughnessMap,
      metalnessMap: set.metalnessMap,
      aoMap: set.aoMap,
      emissiveMap: set.emissiveMap,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity,
      // Left at 1.0 on purpose — the ORM map is the authority.
      roughness: 1,
      metalness: 1,
      aoMapIntensity: 1,
      clearcoat: Math.min(CLEARCOAT_RANGE[1], Math.max(CLEARCOAT_RANGE[0], cc)),
      clearcoatRoughness: 0.34,
      envMapIntensity,
      side,
      dithering: true,
    });
    // aoMap defaults to the second UV set in three; hulls only ship one.
    mat.aoMap.channel = 0;
    mat.userData.textureSet = set;
    return mat;
  };

  return engine?.registry ? engine.registry.get(key, build) : build();
}

/**
 * Self-lit surfaces: engine cores, running lights, HUD panels, drive plumes.
 * Intensity is deliberately allowed above 1 — the HDR target and bloom pass
 * expect over-range values and a "glowing" surface clamped to 1.0 looks grey.
 */
export function createEmissiveMaterial(engine, {
  color = 0x5ec8ff, intensity = 6, map = null, transparent = false,
  opacity = 1, blending = THREE.NormalBlending, depthWrite = true, name = '',
} = {}) {
  const key = keyOf('mat/emissive', { color, intensity, transparent, opacity, blending, depthWrite, map: map?.uuid ?? null });
  const build = () => {
    const mat = new THREE.MeshBasicMaterial({
      name: name || 'emissive',
      color: new THREE.Color(color).multiplyScalar(intensity),
      map,
      transparent,
      opacity,
      blending,
      depthWrite,
      toneMapped: false,
      side: THREE.FrontSide,
    });
    mat.userData.emissiveIntensity = intensity;
    return mat;
  };
  return engine?.registry ? engine.registry.get(key, build) : build();
}

/**
 * Canopy glass — transmissive with a faint tint and a hard clearcoat so the star
 * leaves a smeared specular streak across it.
 *
 * `cheap: true` swaps transmission for plain alpha, which skips the extra
 * transmission render target. Use it for distant ships; the player's own canopy
 * is worth the real thing.
 */
export function createGlassMaterial(engine, {
  tint = 0x8fb6c8, transmission = 0.92, roughness = 0.06, thickness = 0.12,
  ior = 1.46, opacity = 0.22, cheap = false, reflectivity = 0.6, name = '',
} = {}) {
  const key = keyOf('mat/glass', { tint, transmission, roughness, thickness, ior, opacity, cheap, reflectivity });
  const build = () => new THREE.MeshPhysicalMaterial({
    name: name || 'canopy',
    color: new THREE.Color(tint),
    metalness: 0,
    roughness,
    transmission: cheap ? 0 : transmission,
    thickness: cheap ? 0 : thickness,
    ior,
    attenuationColor: new THREE.Color(tint).multiplyScalar(0.85),
    attenuationDistance: 2.5,
    transparent: true,
    opacity: cheap ? opacity : 1,
    depthWrite: false,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    reflectivity,
    envMapIntensity: 1.6,
    side: THREE.DoubleSide,
    premultipliedAlpha: false,
  });
  return engine?.registry ? engine.registry.get(key, build) : build();
}

/**
 * Kilrathi / alien chitin: an iridescent thin-film sheen over a dark organic
 * shell, with an anisotropic highlight running along the plate ribbing and a
 * sheen term standing in for the subsurface wrap you get on real carapace.
 */
export function createChitinMaterial(engine, {
  seed = 1, size = 2048, style = 'alien', palette = null, wear = 0.45,
  panelScale = 1.4, iridescence = 0.65, anisotropy = 0.45,
  anisotropyRotation = 0.6, sheen = 0.55, sheenColor = 0x9fd06a,
  envMapIntensity = 1.15, name = '',
} = {}) {
  const key = keyOf('mat/chitin', {
    seed, size, style, palette, wear, panelScale, iridescence, anisotropy,
    anisotropyRotation, sheen, sheenColor, envMapIntensity,
  });
  const build = () => {
    const set = generateHullMaterialSet(engine, { size, seed, style, palette, wear, panelScale });
    const mat = new THREE.MeshPhysicalMaterial({
      name: name || `chitin-${seed}`,
      map: set.map,
      normalMap: set.normalMap,
      normalScale: new THREE.Vector2(1.25, 1.25),
      roughnessMap: set.roughnessMap,
      metalnessMap: set.metalnessMap,
      aoMap: set.aoMap,
      emissiveMap: set.emissiveMap,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 2.6,
      roughness: 1,
      metalness: 1,
      // Thin-film interference: the oil-slick shift across a beetle's back.
      iridescence,
      iridescenceIOR: 1.68,
      iridescenceThicknessRange: [180, 620],
      // A stretched highlight along the ribbing sells "grown" rather than "milled".
      anisotropy,
      anisotropyRotation,
      // Stand-in for subsurface wrap at the terminator.
      sheen,
      sheenColor: new THREE.Color(sheenColor),
      sheenRoughness: 0.65,
      clearcoat: 0.45,
      clearcoatRoughness: 0.25,
      envMapIntensity,
    });
    mat.aoMap.channel = 0;
    mat.userData.textureSet = set;
    return mat;
  };
  return engine?.registry ? engine.registry.get(key, build) : build();
}

/**
 * Unpainted structural metal — landing gear, gun barrels, exposed spars. Shares
 * the hull generator so the detail family matches, but strips the paint layer by
 * forcing full metalness.
 */
export function createStructuralMaterial(engine, {
  seed = 1, size = 1024, style = 'confed', wear = 0.7, panelScale = 0.6, name = '',
} = {}) {
  const key = keyOf('mat/structural', { seed, size, style, wear, panelScale });
  const build = () => {
    const set = generateHullMaterialSet(engine, {
      size, seed, style, wear, panelScale,
      palette: { barePlate: 0.85, primerPlate: 0.05, lightPlate: 0.05, oxidise: 0.9 },
    });
    const mat = new THREE.MeshPhysicalMaterial({
      name: name || `structural-${seed}`,
      map: set.map,
      normalMap: set.normalMap,
      roughnessMap: set.roughnessMap,
      metalnessMap: set.metalnessMap,
      aoMap: set.aoMap,
      roughness: 1,
      metalness: 1,
      clearcoat: 0,
      envMapIntensity: 1.2,
    });
    mat.aoMap.channel = 0;
    mat.userData.textureSet = set;
    return mat;
  };
  return engine?.registry ? engine.registry.get(key, build) : build();
}

export { HULL_STYLES };
