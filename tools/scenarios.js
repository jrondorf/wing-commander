/**
 * Capture scenarios. Each one frames a specific quality claim so the critic can
 * judge it against a real Wing Commander: Prophecy screenshot of the same kind.
 *
 * `t` is simulated seconds warmed up before the shot (deterministic 1/60 steps).
 * Warm-up frames skip rendering, so a t of 20 costs physics time, not raster time.
 */
export const SCENARIOS = [
  {
    id: 'hero-fighter',
    t: 6,
    desc: 'Confed fighter, three-quarter hero angle, key light raking across the hull. Judges: hull texturing, panel detail, material response, silhouette.',
  },
  {
    id: 'cockpit-idle',
    t: 4,
    desc: 'Cockpit view, no combat, nebula and star ahead. Judges: cockpit geometry depth, HUD legibility, canopy glass, MFD readouts.',
  },
  {
    id: 'cockpit-combat',
    t: 6,
    desc: 'Cockpit view mid-dogfight, guns firing, target locked, enemy crossing. Judges: the actual gameplay frame — the one that must beat Prophecy. NB: the skybox is direction-dependent, so t controls which part of the nebula the ship happens to face; longer warm-ups have rotated it into a bright core and blown the frame out.',
  },
  {
    id: 'dogfight-chase',
    t: 16,
    desc: 'External chase cam, four fighters in a turning fight, tracers and engine trails. Judges: VFX, motion, composition.',
  },
  {
    id: 'capital-ship',
    t: 10,
    desc: 'Capital ship broadside with fighters for scale, turrets firing. Judges: large-scale geometry, greebling, scale cues, lighting falloff.',
  },
  {
    id: 'explosion',
    t: 12,
    desc: 'A fighter mid-destruction: fireball, shockwave, debris, secondary detonations. Judges: explosion art.',
  },
  {
    id: 'nebula-vista',
    t: 5,
    desc: 'Wide vista — nebula, star with god rays, planet, asteroid field. Judges: environment art and colour.',
  },
  {
    id: 'asteroid-run',
    t: 12,
    desc: 'Threading an asteroid field at speed, cockpit view. Judges: asteroid geometry/texture variety, depth, motion.',
  },
  {
    id: 'carrier-launch',
    t: 8,
    desc: 'Launching from the carrier flight deck. Judges: interior lighting, emissive signage, scale drama.',
  },
  {
    id: 'missile-lock',
    t: 10,
    desc: 'Missile away, tracking a target, lock reticle and smoke trail. Judges: missile VFX and HUD lock states.',
  },
];

export const SCENARIO_IDS = SCENARIOS.map((s) => s.id);
export const byId = (id) => SCENARIOS.find((s) => s.id === id);
