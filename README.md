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

## Status

Working: engine, procedural texture synthesis, post-processing stack, ship geometry
(eight classes), nebula/starfield/star/planets/asteroids, flight model, AI, audio
synthesis, and the capture and comparison tooling.

Partial: cockpit, VFX, combat. Not yet built: UI and mission flow.
