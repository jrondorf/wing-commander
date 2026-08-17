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
 *
 * The second rule that matters: **albedo is a light budget.** A `MeshPhysicalMaterial`
 * lit by one directional light reflects `albedo * intensity / pi * N·L`, so a hull
 * painted at 0.07 linear under the art bible's intensity 3–6 tops out around 0.11 —
 * a black cutout with a rim, no matter what the maps underneath it contain. Hull
 * albedo therefore has to average 0.15–0.30 linear (which is also where real
 * aircraft paint sits), and `adaptPalette` below exists to keep ship liveries from
 * quietly collapsing it back down.
 *
 * The third: **`envMapIntensity` is the shadow side.** There is no hemisphere light
 * in this game by design (bible §7) — the nebula PMREM is the only thing lighting a
 * surface the star cannot see. Measured against the shipped nebulae it delivers about
 * 0.02 irradiance per unit of `scene.environmentIntensity * material.envMapIntensity`,
 * against about 0.27 per unit of key intensity, so the two numbers have to multiply
 * out to ~5 before the unlit hemisphere carries any nebula colour at all. Below that
 * the hull is a lit half and a black half, which reads as a cutout, not a solid. The
 * world presets hold ~2.4 of that product; the ~2.1 here is the other half.
 * `envMapIntensity` is a light-response dial, not a look dial: change it only in
 * concert with `world/Presets.js`, never to brighten one material on its own.
 */

import * as THREE from 'three';
import { generateHullMaterialSet, HULL_STYLES } from '../procgen/textures.js';
import { hashSeed } from '../core/Rand.js';

const CLEARCOAT_RANGE = [0.15, 0.3];

// ------------------------------------------------------------------ colour math

const _ca = new THREE.Color();
const _cb = new THREE.Color();

/** Blend two sRGB hexes in linear light. `t = 0` keeps `a`. */
function mixHex(a, b, t) {
  return `#${_ca.set(a).lerp(_cb.set(b), t).getHexString()}`;
}

/** Scale a colour's linear luminance, keeping hue. */
function scaleHex(a, k) {
  _ca.set(a);
  _ca.setRGB(Math.min(1, _ca.r * k), Math.min(1, _ca.g * k), Math.min(1, _ca.b * k));
  return `#${_ca.getHexString()}`;
}

/**
 * Ship liveries and the texture generator both use the names `base`, `panel`,
 * `metal` and `accent`, but they do not mean the same thing, and taking the
 * livery's word for it is what made every Confederation fighter render as a
 * silhouette.
 *
 * A ship palette names its **darkest** hull tone `base` and its **lightest**
 * `panel`. The generator's `base` is the *dominant* plate colour — roughly half
 * the hull — so copying `base` across paints 50 % of the airframe in the darkest
 * colour in the livery (`#4a5560`, 0.068 linear) and there is no key light inside
 * the art bible's 3–6 range that can rescue that.
 *
 * So: the livery's two tones become the two *ends* of the scheme (`baseAlt` and
 * `panelAlt`) and the generator's mid tones are interpolated between them. The
 * livery still reads — same hues, same darkest and lightest values — but the hull
 * spans them instead of pinning to the bottom.
 *
 * Palettes that speak the generator's own language (numeric plate rates, explicit
 * `panelAlt`/`baseAlt`) are passed through untouched; a livery is recognised by
 * the ship-only keys it carries.
 */
function adaptPalette(palette, kind) {
  const isLivery = palette
    && (palette.glow !== undefined || palette.dark !== undefined || palette.glowIntensity !== undefined);

  let p;
  if (!palette) p = {};
  else if (!isLivery) p = { ...palette };
  else {
    // Which of the livery's two tones is the dark one is a convention, not a
    // guarantee — the Nephilim livery pairs an ochre `base` with a *darker* green
    // `panel`. Sort by luminance instead of trusting the names, or that scheme
    // ends up inverted and the hull goes dark again.
    let dark = palette.base ?? '#4a5560';
    let light = palette.panel ?? '#c8cdd2';
    const lum = (h) => { _ca.set(h); return _ca.r * 0.2126 + _ca.g * 0.7152 + _ca.b * 0.0722; };
    if (lum(dark) > lum(light)) { const t = dark; dark = light; light = t; }
    p = {
      baseAlt: dark,
      base: mixHex(dark, light, 0.26),
      panel: mixHex(dark, light, 0.70),
      panelAlt: light,
    };
    if (palette.metal) { p.metal = palette.metal; p.metalBright = scaleHex(palette.metal, 2.1); }
    if (palette.accent) p.accent = palette.accent;
    if (palette.glow) p.emissive = palette.glow;
    // Carry through any generator-native keys the livery also happens to set.
    for (const k of ['roughBase', 'roughSpread', 'clearcoat', 'barePlate', 'primerPlate',
      'lightPlate', 'altPlate', 'oxidise', 'grime', 'streak', 'soot', 'markLight', 'markDark']) {
      if (palette[k] !== undefined) p[k] = palette[k];
    }
  }

  // Ship builders ask for four material slots per hull and expect them to differ.
  // Biasing the plate-kind rates rather than the colours keeps every slot inside
  // the same livery while giving the assembler real tonal separation to compose
  // with — light plating over slate, bare alloy on spars, orange trim.
  if (kind === 'panel') {
    p.lightPlate = (p.lightPlate ?? 0.30) + 0.30;
    p.altPlate = (p.altPlate ?? 0.11) + 0.12;
  } else if (kind === 'metal') {
    p.barePlate = 0.62;
    p.lightPlate = 0.06;
    p.altPlate = 0.02;
    p.oxidise = (p.oxidise ?? 0.25) + 0.30;
  } else if (kind === 'accent') {
    const acc = p.accent ?? '#e07a2a';
    p.base = acc;
    p.baseAlt = scaleHex(acc, 0.55);
    p.panel = mixHex(acc, '#ffffff', 0.30);
    p.panelAlt = mixHex(acc, '#ffffff', 0.55);
    p.lightPlate = 0.14;
    p.altPlate = 0.05;
    p.barePlate = 0.03;
  }
  return Object.keys(p).length ? p : null;
}

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
 * @param {number} [opts.size] texture edge; defaults by `kind` (2048 for the big
 *        surfaces, 1024/512 for trim, which keeps four slots per hull inside the
 *        VRAM budget)
 * @param {object} [opts.palette] a ship livery or a generator palette — see
 *        `adaptPalette`
 * @param {'hull'|'panel'|'metal'|'accent'} [opts.kind='hull'] which of the four
 *        slots a ship builder is asking for
 * @param {number} [opts.wear=0.5]
 * @param {number} [opts.panelScale=1]
 * @param {object|string} [opts.insignia]
 * @param {object} [opts.ports] real hardpoint UVs: {thrusters,muzzles,vents}
 * @param {number} [opts.emissiveIntensity=4.0] running lights run hot (bible: 4–30)
 * @returns {THREE.MeshPhysicalMaterial}
 */
export function createHullMaterial(engine, opts = {}) {
  const kindOf = opts.kind ?? 'hull';
  const {
    style = 'confed', seed = 1,
    size = kindOf === 'accent' ? 512 : kindOf === 'metal' ? 1024 : 2048,
    palette = null, wear = 0.5,
    panelScale = 1, insignia = null, ports = null, kind = 'hull',
    emissiveIntensity = 4.0, envMapIntensity = 2.1, normalScale = 1.15,
    clearcoat = null, side = THREE.FrontSide, name = '',
  } = opts;

  const pal = adaptPalette(palette, kind);

  const key = keyOf('mat/hull', {
    style, seed, size, palette, kind, wear, panelScale, insignia, ports,
    emissiveIntensity, envMapIntensity, normalScale, clearcoat, side,
  });

  const build = () => {
    const set = generateHullMaterialSet(engine, { size, seed, style, palette: pal, wear, panelScale, insignia, ports });
    const sd = set.style ?? HULL_STYLES[style] ?? HULL_STYLES.confed;

    // Painted surfaces have a thin lacquer over them; bare alien chitin does not.
    const cc = clearcoat ?? THREE.MathUtils.clamp(sd.clearcoat ?? 0.22, 0, 1);

    const mat = new THREE.MeshPhysicalMaterial({
      name: name || `hull-${style}-${kind}-${seed}`,
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
      // The lacquer is not a separate, perfectly smooth sheet floating above the
      // paint: it follows the panel steps underneath it and it is polished where
      // the crew wipe and dull where the grime sits. Reusing the hull's own normal
      // and ORM maps costs nothing (both are already bound) and it removes the last
      // constant-roughness term in the material.
      clearcoatRoughnessMap: set.roughnessMap,
      clearcoatRoughness: 0.78,
      clearcoatNormalMap: set.normalMap,
      clearcoatNormalScale: new THREE.Vector2(normalScale * 0.55, normalScale * 0.55),
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
  tint = 0x8fb6c8, transmission = 0.74, roughness = 0.07, thickness = 0.14,
  ior = 1.5, opacity = 0.26, cheap = false, name = '',
} = {}) {
  const key = keyOf('mat/glass', { tint, transmission, roughness, thickness, ior, opacity, cheap });
  const build = () => {
    // Callers reach for the livery's engine-glow colour when they want "the blue
    // of this faction", which as a *glass* colour is a saturated cyan sheet — a
    // plastic toy canopy. Keep the hue, throw away the value: a real canopy is
    // smoked, nearly black in its own body colour, and everything you see in it is
    // reflection.
    const body = _ca.set(tint).lerp(_cb.set(0x0b1218), 0.78).clone();
    return new THREE.MeshPhysicalMaterial({
      name: name || 'canopy',
      color: body,
      metalness: 0,
      roughness,
      transmission: cheap ? 0 : transmission,
      thickness: cheap ? 0 : thickness,
      ior,
      attenuationColor: body.clone().multiplyScalar(0.7),
      attenuationDistance: 1.6,
      transparent: true,
      opacity: cheap ? opacity : 1,
      depthWrite: false,
      // Hard, near-mirror lacquer: this is what smears the star into a specular
      // streak across the canopy instead of a dot.
      clearcoat: 1,
      clearcoatRoughness: 0.035,
      // Anti-reflective coating. A fighter canopy is vapour-coated and shifts
      // gold-to-violet as it turns — the single cheapest tell that this is a real
      // piece of aerospace glass and not an alpha-blended quad.
      iridescence: 0.35,
      iridescenceIOR: 1.34,
      iridescenceThicknessRange: [240, 560],
      // Held at the *product* it had before the fill rebalance: glass is a mirror, so
      // it is the one surface where the raised scene environment intensity would show
      // up as a brighter object rather than as a readable shadow side.
      envMapIntensity: 1.9,
      side: THREE.DoubleSide,
      premultipliedAlpha: false,
    });
  };
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
  // Chitin is a hull, so it gets the hull's fill budget. At the old 1.15 an alien
  // craft's shadow side went to pure black — the darkest albedo in the game with the
  // least environment fill behind it — and a Nephilim fighter read as a hole.
  envMapIntensity = 1.9, name = '',
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
      // Bare alloy is mostly metal, so the environment *is* its diffuse — a touch
      // above the hull's share rather than below it.
      envMapIntensity: 2.3,
    });
    mat.aoMap.channel = 0;
    mat.userData.textureSet = set;
    return mat;
  };
  return engine?.registry ? engine.registry.get(key, build) : build();
}

export { HULL_STYLES };
