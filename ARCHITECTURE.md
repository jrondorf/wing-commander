# Wing Commander — Architecture & Contribution Contract

**Read this fully before writing a single line.** Many agents work on this codebase in
parallel. The rules below are what keep the result composable.

> **Calibrated constants — do not "tidy" these.** Several numbers in this codebase were
> solved against measurements, not chosen by eye. Changing them without redoing the
> measurement will silently undo real work:
>
> | Constant | Value | Where | Why |
> |---|---|---|---|
> | Tone-map exposure | 3.2 | `render/PostProcessing.js` | At 1.0 a correctly-authored hull albedo (~0.17 linear) sits so far down the ACES curve that ships read as black silhouettes. |
> | `envIntensity` | per preset | `world/Presets.js` | Each is solved so the nebula PMREM's measured irradiance lands at 12 % of that preset's key radiance. Nebulae are not equally bright; a shared constant is the wrong shape. Per-preset irradiance figures are in that file's header. |
> | Anamorphic streaks | 0.10 | `render/PostProcessing.js` | At 0.17 one blown-out hull threw a hard horizontal band across the frame. |
> | Film grain | 0.010 | `render/PostProcessing.js` | Grain is shadow-weighted; over mostly-dark space 0.026 read as noise across the whole image. |
>
> **Debugging a bad-looking frame:** use the diagnostic switches before forming a
> hypothesis. `?diag=1` dumps the scene graph, camera, ship bounds and every material's
> parameters. `?flatmat=1` swaps in a neutral grey material — if the ship lights up, the
> fault is texture authoring, not lighting or geometry. `?dropmaps=map,aoMap` detaches
> named texture slots and reports each one's average colour. `?post=tonemap.exposure=4`
> overrides any pipeline setting live. `?nopost=1` bypasses post entirely.
> Guessing at a dark frame wasted more time on this project than any other single thing.

---

## 0. The bar

Target: **Wing Commander: Prophecy / Secret Ops** (1997–98), but rendered to modern
AAA standards. Prophecy's look is the reference for *art direction* — chunky
military-industrial Confederation fighters, organic chitinous alien craft, deep
coloured nebulae, hard key light from a single star, dense readable cockpits.
Modern PBR, HDR and post-processing is the *execution* standard.

A shot is done when a harsh critic, shown it blind next to a real Prophecy
screenshot, picks ours. Not "ours is fine" — ours *wins*.

---

## 1. Hard rules

1. **No external assets.** No CDN, no downloaded textures/models/audio. Everything is
   generated procedurally at runtime from code. The whole game must run from `dist/`
   with no network. This is non-negotiable — it is also the single biggest driver of
   quality, because it forces real texture synthesis rather than stock art.
2. **Own your directory. Never edit another agent's.** File-level ownership is listed
   in §4. If you need something from another module, import its documented export. If
   the export you need does not exist yet, code against the contract in §5 and leave a
   `TODO(contract)` — do not reach into another module's internals.
3. **Determinism.** Never call `Math.random()`. Use `makeRng(seed)` from
   `src/core/Rand.js`. Every generator takes an explicit seed.
4. **Everything is cached.** Textures/geometries/materials go through
   `engine.registry.get(key, factory)`. Generating a 2048² texture twice is a bug.
5. **Dispose what you allocate.** Systems implement `dispose()`.
6. **Units.** 1 world unit = 1 metre. Fighters are 18–30 m. Capital ships 400–1200 m.
   Speeds in m/s (fighters cruise 250–500, afterburner 1200–1600). Combat happens at
   200 m–8 km. `camera.near = 1`, `far = 8e6`; the cockpit uses its own camera at
   `near = 0.01`.
7. **Linear/HDR discipline.** The world renders into a `HalfFloatType` target with
   **no tone mapping**. Emissives are allowed to exceed 1.0 (engine cores run 4–30).
   Tone mapping (ACES) happens once, in the final post pass. Never set
   `renderer.toneMapping`. Colour textures that represent albedo are `SRGBColorSpace`;
   normal/roughness/metal/AO/height maps are `NoColorSpace`.
8. **Performance budget.** 60 fps at 1080p on a mid GPU: ≤ 900 draw calls,
   ≤ 3.5 M triangles, ≤ 400 MB VRAM. Instance everything repeated (asteroids,
   greebles, particles, projectiles). Procedural generation happens once at load.
9. **No frame-rate coupling.** All motion is `* dt`. Never assume 60 fps.

---

## 2. Directory map

```
src/
  core/        Engine, Input, Registry, Rand, math helpers      [OWNER: lead]
  render/      Post-processing stack, shader chunks, material lib [OWNER: agent-render]
  procgen/     Texture synthesis, noise, greebles, mesh utils    [OWNER: agent-procgen]
  ships/       Ship geometry builders + stat definitions         [OWNER: agent-ships]
  flight/      Flight model, thrusters, collision                [OWNER: agent-flight]
  combat/      Weapons, projectiles, damage, targeting           [OWNER: agent-combat]
  ai/          Pilot AI, behaviours, formations, wingman orders   [OWNER: agent-ai]
  vfx/         Particles, explosions, trails, shields, debris     [OWNER: agent-vfx]
  world/       Skybox/nebula, starfield, star, planets, asteroids [OWNER: agent-world]
  cockpit/     Cockpit geometry, HUD, MFDs, ITTS                  [OWNER: agent-cockpit]
  audio/       Procedural WebAudio synthesis + mixer              [OWNER: agent-audio]
  ui/          Menus, briefing, comms, subtitles                  [OWNER: agent-ui]
  mission/     Mission definitions, objectives, nav, flow         [OWNER: agent-mission]
  main.js      Bootstrap + wiring                                 [OWNER: lead]
tools/         Capture + critic harness                           [OWNER: lead]
```

---

## 3. Frame order (system `priority`)

| Priority | System | Notes |
|---|---|---|
| 100 | `input` | folded into Engine |
| 200 | `flight` | integrates player + NPC rigid bodies |
| 250 | `ai` | writes control inputs consumed next frame |
| 300 | `combat` | fire control, projectile integration, hit resolution |
| 350 | `damage` | applies queued damage, spawns destruction events |
| 400 | `mission` | objectives, spawns, nav |
| 500 | `world` | streaming, planet/star updates |
| 600 | `vfx` | particles, trails, explosions (consumes events from 300–400) |
| 700 | `camera` | chase/cockpit/cinematic rigs — after motion, before HUD |
| 800 | `cockpit` | cockpit animation, MFD render-to-texture, HUD projection |
| 900 | `audio` | listener follows camera; must run after 700 |
| 950 | `ui` | DOM overlay |

---

## 4. Ownership

An agent may create/edit **only** files under its own directory, plus its own entry in
`src/registry/*.js` if one is specified in its brief. `src/main.js`, `src/core/**`,
`tools/**` and this file belong to the lead. If you believe a shared file must change,
say so in your final report — do not edit it.

---

## 5. Module contracts

### 5.1 System object

```js
export function createFooSystem(engine, opts) {
  return {
    name: 'foo',
    priority: 600,
    update(dt, engine) {},
    resize(w, h, engine) {},   // optional
    dispose() {},              // optional
  };
}
```

### 5.2 `src/procgen/` — texture synthesis (agent-procgen)

Everything returns three.js textures ready to hang on a material.

```js
// All generators: (opts) => THREE.DataTexture | THREE.CanvasTexture
generateHullMaterialSet({ size, seed, palette, style, wear, panelScale, insignia })
//   => { map, normalMap, roughnessMap, metalnessMap, aoMap, emissiveMap, heightMap }
//   `style`: 'confed' | 'kilrathi' | 'alien' | 'capital' | 'civilian'
fbm(x, y, opts) / ridgedNoise / worley / curlNoise      // scalar noise field fns
heightToNormal(heightData, size, strength) => Float32Array
generateGreebleAtlas({ size, seed })
```

### 5.3 `src/render/` — materials & post (agent-render)

```js
createHullMaterial(engine, { style, seed, palette, ... }) => THREE.MeshPhysicalMaterial
createEmissiveMaterial(engine, { color, intensity })
createPostPipeline(engine, opts) => { render(dt), setSize(w,h), dispose(), settings }
```

The post pipeline is assigned to `engine.post` by `main.js` and must render both
`engine.scene`/`engine.camera` and `engine.cockpitScene`/`engine.cockpitCamera`.

Required post stages, in order: HDR MSAA resolve → velocity buffer → TAA/FXAA →
per-object motion blur → bloom (progressive dual-filter, no hard threshold) →
anamorphic streaks → god rays (radial occlusion from star) → lens dirt →
chromatic aberration → ACES filmic tone map → film grain → vignette → sRGB out.

### 5.4 `src/ships/` (agent-ships)

```js
SHIP_CLASSES // record keyed by id
buildShip(engine, classId, { seed, faction, livery }) => THREE.Group
//   Group.userData.hardpoints = { guns:[{pos,dir}], missiles:[...], engines:[{pos,radius}],
//                                 turrets:[...], thrusters:[{pos,dir}] }
//   Group.userData.stats = { mass, maxSpeed, accel, pitchRate, yawRate, rollRate,
//                            shields:{fore,aft,recharge}, armor:{f,a,l,r}, ... }
```

### 5.5 `src/flight/` (agent-flight)

```js
createFlightSystem(engine) // priority 200
class FlightBody { position, quaternion, velocity, angularVelocity, controls{pitch,yaw,roll,throttle,afterburner}, stats }
```

### 5.6 Event bus

Cross-module signalling uses `engine.registry` slot `'events'`:
`engine.events.emit('ship:destroyed', { ship, position, scale })`.
Documented events: `weapon:fired`, `weapon:hit`, `shield:impact`, `ship:destroyed`,
`missile:launched`, `missile:lock`, `explosion`, `debris:spawn`, `comms:message`,
`objective:update`.

---

## 6. Capture harness (how your work gets judged)

`tools/shoot.mjs` builds the app, serves `dist/`, and drives headless Chromium with
SwiftShader. Scenarios are declared in `tools/scenarios.js` and selected by URL:

```
?shot=<scenario>&seed=<n>&t=<seconds>&w=<px>&h=<px>
```

In shot mode the engine runs **deterministically** (fixed 1/60 dt, no wall clock), pumps
`t * 60` frames, then signals readiness via `window.__READY__ = true`.

```bash
npm run shot -- --scenario cockpit-combat --t 12      # one shot
npm run critic                                        # every scenario
```

Output lands in `captures/<scenario>.png`. Look at your own captures with the Read
tool before claiming anything is done.

---

## 7. Art direction bible

**Lighting.** One hard key light (the system's star) — colour varies per mission
(F-class white-blue `#cfe0ff`, K-class amber `#ffd0a0`, red giant `#ff8a5c`).
Intensity 3–6. Fill comes *only* from the nebula environment map (an equirect HDR
generated in `world/`), never from a generic hemisphere light. A subtle rim/back
light at 8–15 % key sells silhouette separation against black. Hulls must never
read as flat-lit.

**Materials.** Fighters are painted metal over composite: base roughness 0.35–0.55
with a *varying* roughness map (this is the number-one tell of cheap CG — constant
roughness). Metalness is mostly 0 for painted areas, 1 for exposed panels/engine
nacelles. Clearcoat 0.15–0.3 on canopy and painted surfaces. Every hull needs:
panel-line height detail, rivets, weld seams, differential wear at edges
(cavity-driven), soot around thruster ports and gun muzzles, faded squadron
insignia and hull numbers, micro-scratches with anisotropic direction.

**Colour.** Confederation: gunmetal/slate grey-blue (`#4a5560`) with off-white
(`#c8cdd2`) panels, safety orange (`#e07a2a`) accents, cyan engine glow (`#5ec8ff`).
Kilrathi/alien: desaturated ochre and oxidised bronze (`#7a6540`, `#3d4a3a`) with
sickly green-yellow engine glow (`#b8ff4a`) and organic chitin sheen. Never use
pure saturated primaries anywhere except HUD and engine cores.

**Composition.** Space is *not* empty black. Every frame needs a nebula gradient
providing colour separation, a visible star with god rays, and at least one
large-scale object (planet, capship, asteroid) giving depth cues. Reference
Prophecy's habit of framing dogfights against a coloured nebula wall.

**Cockpit.** Dense, physical, occupying the lower 35–45 % of the frame. Real 3D
geometry with depth — not a flat overlay. Bevelled panel edges catching the key
light, emissive readouts with slight bloom and scanlines, canopy glass with a faint
reflection of the dashboard and a smeared specular from the star, visible frame
struts that occlude. Two MFDs (target camera + damage schematic) rendered to
texture at 512². HUD colour is `#7fe4ff` at ~1.6 intensity so it blooms gently.

**Motion.** Nothing is static. Idle drift on the ship, subtle camera shake under
afterburner and impacts, thruster flare responding to control input, cockpit
inertia lag when manoeuvring.

**Sins that instantly fail review.** Flat unlit-looking hulls · constant roughness ·
untextured smooth-shaded primitives · pure `#000` background · aliased HUD text ·
bloom that whites out the frame · particles that are obvious camera-facing discs ·
uniform grey "programmer art" · explosions that are just an orange sphere · a
starfield of identical white dots.
