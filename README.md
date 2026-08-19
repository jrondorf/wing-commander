# Wing Commander

A space combat flight simulator in the spirit of *Wing Commander: Prophecy*, built with
Three.js. **Every asset is generated procedurally at runtime** — there are no texture
files, no models, no audio samples. The whole game runs from `dist/` with no network.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # -> dist/
```

## Controls

| | |
|---|---|
| Arrow keys | Pitch / yaw |
| `Q` / `E` | Roll |
| `-` / `=` | Throttle down / up |
| `Tab` | Afterburner |
| `Backspace` | Brake · `` ` `` full stop |
| `Space` | Guns · `Enter` missile |
| `T` / `R` / `A` | Next target / nearest enemy / target attacker |
| `W` / `M` | Cycle gun / cycle missile |
| `F` / `B` | Cycle view / look back |
| `1` `2` `3` | Power to guns / shields / engines |
| `,` `.` `/` | Shields forward / aft / balanced |
| `V` | Tactical map |
| `C` | Comms · `N` autopilot · `P` pause |

## Architecture

`ARCHITECTURE.md` is the binding contract — directory ownership, system frame order,
module APIs, the art-direction bible, and the table of calibrated constants that must
not be changed without redoing the measurement behind them. Read it before editing.

```
src/core/     Engine, Input, Registry, seeded RNG, event bus
src/procgen/  Noise kernels, panel layout, PBR texture synthesis, decals, greebles
src/render/   Post-processing stack, material library, camera rig, shader chunks
src/ships/    Geometry kit, part assembler, ship classes, stat tables
src/world/    Nebula, starfield, primary star, planets, asteroids, set dressing
src/flight/   Flight model, collision, autopilot, tuning table
src/combat/   Weapons, projectiles, missiles, damage, targeting
src/ai/       Behaviours, manoeuvres, gunnery, formations, wingmen, chatter
src/vfx/      Particles, explosions, trails, shields
src/cockpit/  Cockpit geometry, HUD, MFDs
src/audio/    Procedural synthesis and adaptive score
```

Nothing calls `Math.random()`. Every generator takes a seed, so a given seed always
produces a byte-identical ship, texture and asteroid field — which is what makes the
capture harness's comparisons meaningful.

## The capture harness

Quality is judged on rendered frames, not on intentions.

```bash
npm run shot -- --scenario hero-fighter     # one deterministic capture
npm run critic                              # all ten scenarios
node tools/loop.mjs                          # archive, re-capture, build blind A/B pairs
```

Captures run headless through Chromium/SwiftShader at a fixed 1/60 step with
rasterization disabled during warm-up, so twenty simulated seconds of dogfight costs
physics time and one rendered frame. Each capture is validated on **real pixel
statistics** — luminance mean and standard deviation, dark and blown fractions,
distinct-colour count — so a black, flat, or blown-out frame fails rather than passing
as "done".

`tools/compare.mjs` builds side-by-side A/B composites with a coin-flipped side
assignment, writing the answer key to a file the reviewer never sees.
`tools/CRITIC_BRIEF.md` is the scoring rubric and the automatic-fail list.

### The playtest harness

The capture harness composes a scene and photographs it, which is the right way to
judge art and the wrong way to find out whether the game is playable — no scenario
ever presses a key, so a build where the player spawned at zero throttle and no
contact but the locked one had any symbology passed every capture.

```bash
npm run playtest        # menu -> briefing -> cockpit, then engage and open fire
```

It plays the real flow, then asserts on what the pilot can actually see: contacts
resolved, target locked, projectiles alive, nav point steerable, tactical plot
opening. Exits non-zero when any of those is missing. Frames land in
`captures/playtest/`.

### Diagnostic switches

Append to any URL. These exist because guessing at a dark frame wasted more time on
this project than anything else.

| Switch | Effect |
|---|---|
| `?diag=1` | Dump scene graph, camera, ship bounds, every material's parameters |
| `?flatmat=1` | Replace ship materials with neutral grey — isolates form and light from texture |
| `?dropmaps=map,aoMap` | Detach named texture slots and report each one's average colour |
| `?post=tonemap.exposure=4` | Override any post-processing setting live |
| `?nopost=1` | Bypass the post stack entirely |

## Reading the fight

Four displays answer "where is everything", and they are calibrated against each
other rather than tuned in isolation:

* **HUD contact symbology** — every ship in the frame gets a corner box, hostiles
  red with a centre pip, friendlies green; the locked target keeps the full
  bracket, shield ring and data block. Boxes are floored at a legible size, because
  a 22 m fighter at 2 km is nine pixels of dark hull against a dark nebula and is
  not findable by eye. Hostiles outside the frame become edge carets.
* **Radar globe** — the glass is scaled to an 8 km scope, not to the ship's 24 km
  detection range; anything between the two pins just inside the shell, dimmed.
  Contact colours are held below the tone-map shoulder so friend, foe and target
  stay distinguishable instead of all clipping to white.
* **Tactical plot (`V`)** — ego-centric north-up plan view with the nav course,
  live contacts, vertical-separation stalks, your own heading and world position.
  The sim keeps running while it is up.
* **Tracers** — bolts are drawn as the segment they swept during the frame, so a
  burst reads as a continuous line rather than beads 25–50 m apart, and their
  cross-section is floored in screen space so a tracer at 3 km is still visible.

## Status

Working: engine, procedural texture synthesis, post-processing stack, ship geometry
(eight classes), nebula/starfield/star/planets/asteroids, flight model, AI, audio
synthesis, and the capture and comparison tooling.

Partial: cockpit, VFX, combat. Not yet built: UI and mission flow.
