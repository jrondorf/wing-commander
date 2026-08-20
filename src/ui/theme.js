/**
 * src/ui/theme.js — palette and the single stylesheet for the whole UI layer.
 *
 * ## Why one big string
 * Every rule the UI needs ships in one `<style>` injected under `#ui-root`.
 * There is no build step for CSS in this project and no external asset is
 * permitted (ARCHITECTURE §1), so the alternative would be inline styles on a
 * few hundred nodes — unreadable, and impossible to keep consistent.
 *
 * ## The look
 * Wing Commander's menus were diegetic: a terminal bolted to a carrier's
 * bulkhead, not a web page. So everything here is built from
 *   - a phosphor palette keyed to the cockpit HUD's `#7fe4ff` (cockpit/layout.js),
 *   - hairline rules rather than boxes and fills,
 *   - uppercase, letter-spaced display type over a monospaced data face,
 *   - and a CRT treatment: scanlines, an edge-darkening barrel vignette, a slow
 *     refresh sweep, glass reflection and a low-amplitude flicker.
 *
 * The CRT layer is pure CSS on purpose. A shader-based curvature would have to
 * live in the render pipeline (agent-render's directory) and would drag the DOM
 * through a texture; the cheap version reads correctly at 1080p and costs one
 * composited layer.
 *
 * ## Sizing
 * Screens set `font-size` from a viewport clamp and lay out in `em`, so a
 * resize needs no JavaScript beyond re-fitting the canvases.
 */

export const PALETTE = {
  /** Matches cockpit HUD_COLOR so the DOM layer and the in-world HUD agree. */
  cyan: '#7fe4ff',
  cyanDim: '#4d8fa6',
  cyanDeep: '#1d4757',
  amber: '#ffb04a',
  orange: '#e07a2a',
  red: '#ff5a45',
  green: '#6bffae',
  ink: '#04070c',
  panel: 'rgba(7,14,21,0.78)',
  text: '#cfdbe3',
  textDim: '#7d8f9b',
};

/** Faction tints, used for comms portraits and callsign plates. */
export const FACTION_TINT = {
  confed: '#7fe4ff',
  militia: '#8fd6a8',
  civilian: '#d8d2c0',
  pirate: '#ffb04a',
  kilrathi: '#ffa05a',
  alien: '#b8ff4a',
};

export const CSS = `
.wc-root {
  --wc-cyan: ${PALETTE.cyan};
  --wc-cyan-dim: ${PALETTE.cyanDim};
  --wc-cyan-deep: ${PALETTE.cyanDeep};
  --wc-amber: ${PALETTE.amber};
  --wc-red: ${PALETTE.red};
  --wc-green: ${PALETTE.green};
  --wc-ink: ${PALETTE.ink};
  --wc-text: ${PALETTE.text};
  --wc-dim: ${PALETTE.textDim};
  --wc-rule: rgba(127,228,255,0.30);
  --wc-rule-soft: rgba(127,228,255,0.13);
  --wc-glow: 0 0 0.5em rgba(127,228,255,0.35);
  --wc-f-display: 'Eurostile', 'Bank Gothic', 'Rajdhani', 'Oswald', 'Arial Narrow',
                  ui-sans-serif, system-ui, 'DejaVu Sans', sans-serif;
  --wc-f-mono: ui-monospace, 'SF Mono', 'DejaVu Sans Mono', Menlo, Consolas,
               'Liberation Mono', monospace;
  position: absolute; inset: 0;
  color: var(--wc-text);
  font-family: var(--wc-f-display);
  -webkit-font-smoothing: antialiased;
}
.wc-root *, .wc-root *::before, .wc-root *::after { box-sizing: border-box; }

/* ------------------------------------------------------------------ layers */
.wc-layer { position: absolute; inset: 0; pointer-events: none; }
.wc-layer--screen { display: none; }
.wc-layer--screen.is-open { display: block; pointer-events: auto; }

/* Fullscreen screens fade/scale in like a CRT warming up. */
.wc-screen {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  font-size: clamp(11px, calc(0.62vw + 0.52vh), 20px);
  opacity: 0;
  transform: scale(0.994);
  transition: opacity .34s ease, transform .34s ease;
}
.wc-screen.is-shown { opacity: 1; transform: none; }

/* ------------------------------------------------------- backdrop + CRT ---- */
.wc-backdrop { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.wc-crt { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }

/* Scanlines. 3px pitch reads as a CRT at 1080p; 2px aliases into moire. */
.wc-crt__lines {
  position: absolute; inset: -2%;
  background: repeating-linear-gradient(to bottom,
    rgba(0,0,0,0.30) 0px, rgba(0,0,0,0.30) 1px,
    rgba(0,0,0,0.00) 1px, rgba(0,0,0,0.00) 3px);
  mix-blend-mode: multiply;
  opacity: .85;
}
/* Aperture-grille tint: a faint vertical RGB triad over the scanlines. */
.wc-crt__grille {
  position: absolute; inset: 0;
  background: repeating-linear-gradient(to right,
    rgba(255,60,60,0.045) 0px, rgba(60,255,120,0.045) 1px, rgba(60,120,255,0.045) 2px,
    rgba(0,0,0,0) 3px);
  mix-blend-mode: screen;
}
/* Barrel vignette. The tube's corners fall away; this is what sells curvature
   more than any transform does. */
.wc-crt__vignette {
  position: absolute; inset: 0;
  background:
    radial-gradient(128% 116% at 46% 48%, rgba(0,0,0,0) 38%, rgba(0,0,0,0.42) 68%, rgba(0,0,0,0.72) 86%, rgba(0,0,0,0.95) 100%),
    radial-gradient(100% 70% at 50% 0%, rgba(127,228,255,0.055), rgba(0,0,0,0) 70%);
}
/* Glass: one broad off-axis reflection, plus the tube's edge highlight. */
.wc-crt__glass {
  position: absolute; inset: 0;
  background:
    linear-gradient(107deg, rgba(190,235,255,0.075) 0%, rgba(190,235,255,0.018) 18%,
                    rgba(0,0,0,0) 34%, rgba(0,0,0,0) 100%);
  border-radius: 2.6em / 4.2em;
  box-shadow:
    inset 0 0 0 1px rgba(127,228,255,0.14),
    inset 0 0 3.5em rgba(0,0,0,0.85),
    inset 0 0.12em 0 rgba(190,240,255,0.09);
}
/* Slow vertical refresh band. */
.wc-crt__sweep {
  position: absolute; left: -10%; right: -10%; height: 22%;
  background: linear-gradient(to bottom, rgba(127,228,255,0) 0%,
              rgba(127,228,255,0.045) 45%, rgba(190,240,255,0.075) 52%,
              rgba(127,228,255,0.02) 62%, rgba(127,228,255,0) 100%);
  animation: wc-sweep 8.5s linear infinite;
  will-change: transform;
}
@keyframes wc-sweep { from { transform: translateY(-140%); } to { transform: translateY(560%); } }
/* Mains hum flicker — tiny, but a perfectly steady CRT reads as a PNG. */
.wc-crt__flicker {
  position: absolute; inset: 0;
  background: rgba(127,228,255,0.02);
  animation: wc-flicker 5.3s steps(1, end) infinite;
}
@keyframes wc-flicker {
  0%,100% { opacity: .35; } 12% { opacity: .9; } 13% { opacity: .2; }
  47% { opacity: .75; } 48% { opacity: .3; } 71% { opacity: 1; } 72% { opacity: .25; }
}

/* A left-edge scrim. The backdrop is deliberately busy; type has to win. */
.wc-scrim {
  position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(100deg, rgba(2,5,9,0.88) 0%, rgba(2,5,9,0.72) 26%,
              rgba(2,5,9,0.32) 52%, rgba(2,5,9,0.10) 72%, rgba(2,5,9,0) 100%);
}
.wc-scrim--even {
  background: linear-gradient(to bottom, rgba(2,5,9,0.80) 0%, rgba(2,5,9,0.58) 30%,
              rgba(2,5,9,0.52) 70%, rgba(2,5,9,0.82) 100%);
}

/* --------------------------------------------------------------- chrome ---- */
.wc-bar {
  display: flex; align-items: center; gap: 1.4em;
  padding: 0.85em 2.4em;
  font-size: 0.78em; letter-spacing: 0.26em; text-transform: uppercase;
  color: var(--wc-cyan-dim);
}
.wc-bar--top { border-bottom: 1px solid var(--wc-rule-soft); }
.wc-bar--bottom { margin-top: auto; border-top: 1px solid var(--wc-rule-soft); }
.wc-bar .wc-spacer { flex: 1; }
.wc-bar b { color: var(--wc-cyan); font-weight: 600; text-shadow: var(--wc-glow); }

.wc-rule { height: 1px; background: linear-gradient(to right,
  var(--wc-rule) 0%, var(--wc-rule-soft) 55%, rgba(127,228,255,0) 100%); }
.wc-rule--full { background: var(--wc-rule-soft); }

.wc-tick { color: var(--wc-cyan); opacity: .55; }
.wc-cursor::after {
  content: '\\2588'; color: var(--wc-cyan); margin-left: .12em;
  animation: wc-blink 1.05s steps(1, end) infinite;
}
@keyframes wc-blink { 0%,55% { opacity: 1; } 56%,100% { opacity: 0; } }

/* --------------------------------------------------------------- panels ---- */
.wc-panel {
  position: relative;
  background: linear-gradient(160deg, rgba(8,17,25,0.90), rgba(3,7,11,0.94));
  border: 1px solid var(--wc-rule-soft);
  box-shadow: inset 0 0 2.2em rgba(0,0,0,.55);
}
/* Corner brackets — the cheapest way to make a rectangle read as military. */
.wc-panel::before, .wc-panel::after {
  content: ''; position: absolute; width: 0.85em; height: 0.85em;
  border: 1px solid var(--wc-cyan); opacity: .5; pointer-events: none;
}
.wc-panel::before { top: -1px; left: -1px; border-right: 0; border-bottom: 0; }
.wc-panel::after { bottom: -1px; right: -1px; border-left: 0; border-top: 0; }

.wc-panel__title {
  display: flex; align-items: baseline; gap: .8em;
  padding: .55em .95em .5em;
  font-size: .74em; letter-spacing: .3em; text-transform: uppercase;
  color: var(--wc-cyan); text-shadow: var(--wc-glow);
  border-bottom: 1px solid var(--wc-rule-soft);
  background: linear-gradient(to right, rgba(127,228,255,0.09), rgba(127,228,255,0));
}
.wc-panel__title small { margin-left: auto; color: var(--wc-cyan-dim); letter-spacing: .18em; }
.wc-panel__body { padding: .85em .95em; }

/* ------------------------------------------------------------- menu list --- */
.wc-menu { list-style: none; margin: 0; padding: 0; }
.wc-menu__item {
  position: relative;
  display: flex; align-items: center; gap: .8em;
  padding: .48em .5em .48em 2.1em;
  font-size: 1.5em; letter-spacing: .2em; text-transform: uppercase;
  color: var(--wc-cyan-dim);
  cursor: pointer;
  transition: color .12s linear, background .12s linear, padding-left .12s ease;
}
.wc-menu__item::before {
  content: '\\25B8'; position: absolute; left: .75em;
  opacity: 0; color: var(--wc-amber); transform: translateX(-.4em);
  transition: opacity .12s linear, transform .12s ease;
}
.wc-menu__item.is-sel {
  color: var(--wc-cyan); text-shadow: var(--wc-glow);
  background: linear-gradient(to right, rgba(127,228,255,0.14), rgba(127,228,255,0) 72%);
  padding-left: 2.35em;
}
.wc-menu__item.is-sel::before { opacity: 1; transform: none; }
.wc-menu__item.is-disabled { color: #3d4a52; cursor: default; }
.wc-menu__item.is-disabled.is-sel { color: #56666f; text-shadow: none; }
.wc-menu__hint {
  margin-left: auto; font-family: var(--wc-f-mono);
  font-size: .48em; letter-spacing: .1em; color: var(--wc-dim); text-transform: none;
}

/* --------------------------------------------------------------- title ----- */
.wc-title { line-height: .86; }
.wc-title__sub {
  font-size: .82em; letter-spacing: .62em; color: var(--wc-cyan-dim);
  text-transform: uppercase; margin-bottom: .5em;
}
.wc-title__main {
  font-size: 5.2em; font-weight: 300; letter-spacing: .1em; text-transform: uppercase;
  color: #eaf7ff;
  text-shadow: 0 0 .06em rgba(190,240,255,.55), 0 0 .5em rgba(127,228,255,.42),
               0 0 1.6em rgba(60,150,200,.28);
}
.wc-title__rule { margin: .7em 0 .55em; height: 2px;
  background: linear-gradient(to right, var(--wc-cyan), rgba(127,228,255,0.06) 70%, transparent); }
.wc-title__tag {
  font-family: var(--wc-f-mono); font-size: .74em; letter-spacing: .24em;
  color: var(--wc-cyan-dim); text-transform: uppercase;
}

/* ------------------------------------------------------------ data lists --- */
.wc-kv { display: grid; grid-template-columns: auto 1fr; gap: .3em 1em; font-size: .84em; }
.wc-kv dt { color: var(--wc-dim); letter-spacing: .18em; text-transform: uppercase; }
.wc-kv dd { margin: 0; font-family: var(--wc-f-mono); color: var(--wc-text); letter-spacing: .04em; }

.wc-list { list-style: none; margin: 0; padding: 0; }
.wc-list li {
  display: flex; gap: .7em; align-items: baseline;
  padding: .3em 0; border-bottom: 1px dotted rgba(127,228,255,.10);
  font-size: .86em;
}
.wc-list li:last-child { border-bottom: 0; }
.wc-list .wc-lead { color: var(--wc-cyan); font-family: var(--wc-f-mono); font-size: .86em; }

/* Objective rows share styling between briefing, tracker and debrief. */
.wc-obj { display: flex; align-items: baseline; gap: .7em; padding: .26em 0; font-size: .86em; }
.wc-obj__mark {
  flex: 0 0 auto; width: 1.15em; text-align: center;
  font-family: var(--wc-f-mono); color: var(--wc-cyan-dim);
}
.wc-obj__text { flex: 1; letter-spacing: .04em; }
.wc-obj__tag {
  font-family: var(--wc-f-mono); font-size: .72em; letter-spacing: .14em;
  color: var(--wc-dim); text-transform: uppercase;
}
.wc-obj--primary .wc-obj__mark { color: var(--wc-cyan); }
.wc-obj--secondary { opacity: .82; }
.wc-obj.is-complete .wc-obj__mark, .wc-obj.is-complete .wc-obj__tag { color: var(--wc-green); }
.wc-obj.is-complete .wc-obj__text { color: var(--wc-green); }
.wc-obj.is-failed .wc-obj__mark, .wc-obj.is-failed .wc-obj__tag { color: var(--wc-red); }
.wc-obj.is-failed .wc-obj__text { color: var(--wc-red); text-decoration: line-through;
  text-decoration-color: rgba(255,90,69,.5); }
.wc-obj.is-active .wc-obj__mark { color: var(--wc-amber); animation: wc-pulse 1.6s ease-in-out infinite; }
@keyframes wc-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }

/* ------------------------------------------------------------- briefing ---- */
.wc-brief { flex: 1; display: grid; grid-template-columns: 1.15fr 1.5fr;
  gap: 1.1em; padding: 1.1em 2.4em 0.6em; min-height: 0; }
.wc-brief__col { display: flex; flex-direction: column; gap: 1.1em; min-height: 0; }
.wc-brief__head { padding: 1.2em 2.4em 0; }
.wc-brief__name {
  font-size: 2.5em; letter-spacing: .12em; text-transform: uppercase; color: #e8f6ff;
  text-shadow: 0 0 .5em rgba(127,228,255,.35);
}
.wc-brief__meta { display: flex; gap: 2.2em; margin-top: .5em;
  font-family: var(--wc-f-mono); font-size: .8em; letter-spacing: .12em; color: var(--wc-cyan-dim); }
.wc-brief__meta b { color: var(--wc-cyan); font-weight: 500; }
.wc-brief__text {
  font-family: var(--wc-f-mono); font-size: .92em; line-height: 1.62;
  color: var(--wc-text); letter-spacing: .01em;
  white-space: pre-wrap; overflow: hidden; flex: 0 1 auto; min-height: 0;
}
.wc-brief__text .wc-em { color: var(--wc-amber); }
.wc-navmap { flex: 1; min-height: 0; position: relative; }
.wc-navmap canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.wc-threat {
  display: flex; align-items: center; gap: .6em; margin-bottom: .5em;
  font-size: .82em; letter-spacing: .2em; text-transform: uppercase;
}
.wc-threat__bar { flex: 1; height: .5em; background: rgba(127,228,255,.09);
  border: 1px solid var(--wc-rule-soft); position: relative; overflow: hidden; }
.wc-threat__fill { position: absolute; inset: 0 auto 0 0; background: currentColor;
  box-shadow: 0 0 .6em currentColor; }
.wc-threat--low { color: var(--wc-green); }
.wc-threat--moderate { color: var(--wc-cyan); }
.wc-threat--high { color: var(--wc-amber); }
.wc-threat--extreme { color: var(--wc-red); }

.wc-wing { display: flex; align-items: center; gap: .75em; padding: .34em 0;
  border-bottom: 1px dotted rgba(127,228,255,.10); }
.wc-wing:last-child { border-bottom: 0; }
.wc-wing__pip { width: 2.6em; height: 2.6em; flex: 0 0 auto; border: 1px solid var(--wc-rule-soft); }
.wc-wing__pip canvas { display: block; width: 100%; height: 100%; }
.wc-wing__name { font-size: .95em; letter-spacing: .16em; text-transform: uppercase; color: var(--wc-cyan); }
.wc-wing__sub { font-family: var(--wc-f-mono); font-size: .72em; color: var(--wc-dim); letter-spacing: .06em; }
.wc-wing__slot { margin-left: auto; font-family: var(--wc-f-mono); font-size: .72em;
  color: var(--wc-cyan-dim); letter-spacing: .14em; }

/* --------------------------------------------------------------- comms ----- */
.wc-comms {
  position: absolute; left: 1.6vw; top: 2.0vh; width: min(30vw, 30em);
  font-size: clamp(10px, calc(0.42vw + 0.42vh), 16px);
  opacity: 0; transform: translateX(-1.2em);
  transition: opacity .18s ease, transform .18s ease;
}
.wc-comms.is-live { opacity: 1; transform: none; }
.wc-comms__row { display: flex; gap: .7em; align-items: stretch; }
.wc-comms__plate {
  position: relative; flex: 0 0 auto; width: 5.4em; height: 6.4em;
  border: 1px solid var(--wc-rule); background: #030608;
  box-shadow: 0 0 1.2em rgba(0,0,0,.7), inset 0 0 1.2em rgba(0,0,0,.85);
}
.wc-comms__plate canvas { display: block; width: 100%; height: 100%; }
.wc-comms__plate::after {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  background: repeating-linear-gradient(to bottom,
    rgba(0,0,0,.30) 0 1px, rgba(0,0,0,0) 1px 3px),
    radial-gradient(120% 100% at 50% 40%, rgba(0,0,0,0) 55%, rgba(0,0,0,.6) 100%);
}
.wc-comms__body { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.wc-comms__head {
  display: flex; align-items: center; gap: .6em;
  padding: .18em .5em; border: 1px solid var(--wc-rule-soft); border-bottom: 0;
  background: linear-gradient(to right, rgba(127,228,255,.14), rgba(127,228,255,0));
  font-size: .82em; letter-spacing: .22em; text-transform: uppercase;
  color: var(--wc-cyan); text-shadow: var(--wc-glow);
}
.wc-comms__chan { margin-left: auto; font-family: var(--wc-f-mono); font-size: .74em;
  letter-spacing: .1em; color: var(--wc-cyan-dim); }
.wc-comms__vu { display: flex; gap: 1px; align-items: flex-end; height: .78em; }
.wc-comms__vu i { width: 2px; background: var(--wc-cyan); opacity: .8; height: 20%; }
.wc-comms__text {
  flex: 1; padding: .38em .55em; border: 1px solid var(--wc-rule-soft);
  background: rgba(3,8,12,.72);
  font-family: var(--wc-f-mono); font-size: .92em; line-height: 1.42;
  letter-spacing: .01em; color: #dff2fb;
  text-shadow: 0 0 .6em rgba(127,228,255,.28);
}
.wc-comms__log { margin-top: .28em; padding-left: 6.1em; }
.wc-comms__log div {
  font-family: var(--wc-f-mono); font-size: .74em; line-height: 1.4;
  color: var(--wc-dim); letter-spacing: .01em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.wc-comms__log div b { color: var(--wc-cyan-dim); font-weight: 500; }
.wc-comms--panic .wc-comms__head { color: var(--wc-red); background:
  linear-gradient(to right, rgba(255,90,69,.20), rgba(255,90,69,0)); }
.wc-comms--panic .wc-comms__text { color: #ffd9d2; }
.wc-comms--urgent .wc-comms__head { color: var(--wc-amber); background:
  linear-gradient(to right, rgba(255,176,74,.18), rgba(255,176,74,0)); }
.wc-comms--order .wc-comms__head { color: var(--wc-green); background:
  linear-gradient(to right, rgba(107,255,174,.16), rgba(107,255,174,0)); }
.wc-comms__queue { position: absolute; right: .1em; top: -1.1em; display: flex; gap: 2px; }
.wc-comms__queue i { width: .38em; height: .38em; background: var(--wc-cyan-dim); opacity: .6;
  transform: rotate(45deg); }

/* ---------------------------------------------------------- objectives ----- */
.wc-objtrack {
  position: absolute; right: 1.5vw; top: 15.5vh; width: min(21vw, 20em);
  font-size: clamp(9px, calc(0.36vw + 0.36vh), 14px);
  opacity: 0; transition: opacity .25s ease;
}
.wc-objtrack.is-live { opacity: 1; }
.wc-objtrack__head {
  display: flex; align-items: center; gap: .5em;
  font-size: .84em; letter-spacing: .26em; text-transform: uppercase;
  color: var(--wc-cyan); text-shadow: var(--wc-glow);
  border-bottom: 1px solid var(--wc-rule); padding-bottom: .18em; margin-bottom: .28em;
}
.wc-objtrack__head span { margin-left: auto; font-family: var(--wc-f-mono);
  font-size: .82em; letter-spacing: .06em; color: var(--wc-cyan-dim); }
.wc-objtrack .wc-obj {
  font-size: .9em; padding: .16em 0; text-align: left;
  text-shadow: 0 0 .5em rgba(0,0,0,.9), 0 0 .2em rgba(0,0,0,.9);
}
.wc-objtrack .wc-obj__text { letter-spacing: .06em; text-transform: uppercase; }
.wc-objtrack .wc-obj.is-flash { animation: wc-objflash 1.1s ease-out 2; }
@keyframes wc-objflash { 0%,100% { background: rgba(127,228,255,0); }
  35% { background: rgba(127,228,255,.22); } }

/* --------------------------------------------------------- command menu ---- */
.wc-cmd {
  position: absolute; left: 16vw; bottom: 46vh; width: min(24vw, 24em);
  font-size: clamp(10px, calc(0.40vw + 0.40vh), 15px);
  pointer-events: auto;
  opacity: 0; transform: translateY(.6em) scale(.985);
  transition: opacity .13s ease, transform .13s ease;
}
.wc-cmd.is-open { opacity: 1; transform: none; }
.wc-cmd__head {
  display: flex; align-items: baseline; gap: .6em;
  padding: .3em .7em; font-size: .84em; letter-spacing: .26em; text-transform: uppercase;
  color: var(--wc-cyan); text-shadow: var(--wc-glow);
  background: linear-gradient(to right, rgba(127,228,255,.20), rgba(127,228,255,.02));
  border: 1px solid var(--wc-rule); border-bottom: 0;
}
.wc-cmd__head small { margin-left: auto; font-family: var(--wc-f-mono);
  letter-spacing: .08em; color: var(--wc-cyan-dim); font-size: .8em; }
.wc-cmd__body { border: 1px solid var(--wc-rule); background: rgba(3,9,13,.88);
  box-shadow: 0 .6em 2em rgba(0,0,0,.6); }
.wc-cmd__item {
  display: flex; align-items: baseline; gap: .7em; padding: .26em .7em;
  letter-spacing: .1em; text-transform: uppercase; color: var(--wc-text); cursor: pointer;
}
.wc-cmd__item b { color: var(--wc-amber); font-family: var(--wc-f-mono); font-weight: 600;
  min-width: 1.1em; }
.wc-cmd__item.is-sel { background: rgba(127,228,255,.18); color: #eafaff;
  text-shadow: var(--wc-glow); }
.wc-cmd__item.is-disabled { color: #46545d; }
.wc-cmd__item.is-disabled b { color: #46545d; }
.wc-cmd__item em { margin-left: auto; font-style: normal; font-family: var(--wc-f-mono);
  font-size: .78em; letter-spacing: .04em; color: var(--wc-cyan-dim); text-transform: none; }
.wc-cmd__foot { padding: .24em .7em; border-top: 1px solid var(--wc-rule-soft);
  font-family: var(--wc-f-mono); font-size: .74em; letter-spacing: .06em; color: var(--wc-dim); }

/* -------------------------------------------------------------- debrief ---- */
.wc-debrief { flex: 1; display: grid; grid-template-columns: 1.25fr 1fr;
  gap: 1.4em; padding: 1.2em 2.6em .6em; min-height: 0; }
.wc-verdict { font-size: 3.4em; letter-spacing: .22em; text-transform: uppercase; line-height: 1; }
.wc-verdict--success { color: var(--wc-green); text-shadow: 0 0 .5em rgba(107,255,174,.45); }
.wc-verdict--failure { color: var(--wc-red); text-shadow: 0 0 .5em rgba(255,90,69,.45); }
.wc-stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: .55em 1.6em; }
.wc-stat { border-bottom: 1px solid var(--wc-rule-soft); padding-bottom: .22em; }
.wc-stat__k { font-size: .68em; letter-spacing: .24em; text-transform: uppercase; color: var(--wc-dim); }
.wc-stat__v { font-family: var(--wc-f-mono); font-size: 1.5em; color: var(--wc-cyan);
  text-shadow: var(--wc-glow); letter-spacing: .02em; }
.wc-stat__v small { font-size: .5em; color: var(--wc-dim); letter-spacing: .1em; margin-left: .4em; }
.wc-medal { display: flex; align-items: center; gap: 1em; padding: .7em 0; }
.wc-medal canvas { width: 4.6em; height: 4.6em; display: block; }
.wc-medal__t { font-size: 1.15em; letter-spacing: .2em; text-transform: uppercase; color: var(--wc-amber);
  text-shadow: 0 0 .5em rgba(255,176,74,.4); }
.wc-medal__s { font-family: var(--wc-f-mono); font-size: .78em; color: var(--wc-dim); letter-spacing: .06em; }

/* -------------------------------------------------------------- options ---- */
.wc-opts { width: min(52em, 74vw); margin: 0 auto; padding: 1.4em 0; }
.wc-opt {
  display: flex; align-items: center; gap: 1.2em; padding: .5em .9em;
  border-bottom: 1px solid var(--wc-rule-soft); cursor: pointer;
}
.wc-opt.is-sel { background: linear-gradient(to right, rgba(127,228,255,.13), rgba(127,228,255,0) 80%); }
.wc-opt__label { flex: 0 0 40%; font-size: 1.0em; letter-spacing: .18em; text-transform: uppercase;
  color: var(--wc-cyan-dim); }
.wc-opt.is-sel .wc-opt__label { color: var(--wc-cyan); text-shadow: var(--wc-glow); }
.wc-opt__ctl { flex: 1; display: flex; align-items: center; gap: .8em; }
.wc-opt__val { font-family: var(--wc-f-mono); font-size: .95em; letter-spacing: .12em;
  color: var(--wc-text); min-width: 6em; text-transform: uppercase; }
.wc-opt__meter { flex: 1; height: .62em; display: flex; gap: 2px; }
.wc-opt__meter i { flex: 1; background: rgba(127,228,255,.12); border: 1px solid rgba(127,228,255,.10); }
.wc-opt__meter i.on { background: var(--wc-cyan); box-shadow: 0 0 .5em rgba(127,228,255,.6);
  border-color: var(--wc-cyan); }
.wc-opt__arrows { font-family: var(--wc-f-mono); color: var(--wc-amber); opacity: 0; letter-spacing: .3em; }
.wc-opt.is-sel .wc-opt__arrows { opacity: 1; }
.wc-opt__note { font-family: var(--wc-f-mono); font-size: .72em; color: var(--wc-dim);
  padding: 0 .9em .5em; letter-spacing: .04em; }

/* -------------------------------------------------------------- credits --- */
.wc-credits { flex: 1; overflow: hidden; position: relative; }
.wc-credits__roll { position: absolute; left: 0; right: 0; text-align: center; }
.wc-credits h3 { font-size: .8em; letter-spacing: .4em; color: var(--wc-cyan-dim);
  text-transform: uppercase; margin: 1.6em 0 .35em; font-weight: 400; }
.wc-credits p { font-family: var(--wc-f-mono); font-size: .92em; color: var(--wc-text);
  margin: .12em 0; letter-spacing: .04em; }

/* -------------------------------------------------------------- toasts ----- */
.wc-toasts { position: absolute; left: 50%; top: 6.5vh; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: .3em; }
.wc-toast {
  font-size: clamp(11px, calc(0.42vw + 0.42vh), 17px);
  letter-spacing: .28em; text-transform: uppercase; padding: .3em 1.2em;
  border: 1px solid var(--wc-rule); background: rgba(3,9,13,.78);
  color: var(--wc-cyan); text-shadow: var(--wc-glow);
  animation: wc-toast-in .3s ease both;
}
.wc-toast--warn { color: var(--wc-amber); border-color: rgba(255,176,74,.4); }
.wc-toast--bad { color: var(--wc-red); border-color: rgba(255,90,69,.45); }
.wc-toast--good { color: var(--wc-green); border-color: rgba(107,255,174,.4); }
.wc-toast.is-out { animation: wc-toast-out .3s ease both; }
@keyframes wc-toast-in { from { opacity: 0; transform: translateY(-.5em); } to { opacity: 1; } }
@keyframes wc-toast-out { to { opacity: 0; transform: translateY(-.4em); } }

/* ------------------------------------------------------- tactical plot ----- */
/* Left of frame and under half the width: the cockpit HUD owns the centre and
   the right-hand nav/shield stack, and this is an overlay on a live fight —
   the sim keeps running while it is up, so it must not blind the pilot. */
/* The panel ground is CSS, not a fillRect inside the canvas. Painted in the
   canvas it composited far short of its stated alpha and the dashboard read
   straight through the plot; as an element background it is simply opaque, and
   it is one less full-panel fill per frame. */
.wc-tacmap {
  position: absolute; left: 2vw; bottom: 3.5vh;
  width: min(30vw, 42vh); aspect-ratio: 1 / 1;
  background: #050b12;
  border: 1px solid rgba(127,228,255,0.42);
  box-shadow: 0 0 2em rgba(0,0,0,.55);
}
.wc-tacmap__canvas { width: 100%; height: 100%; display: block; }
.wc-tacmap__hint {
  position: absolute; left: 0; right: 0; top: -1.5em; text-align: center;
  font-size: clamp(9px, calc(0.3vw + 0.3vh), 12px); letter-spacing: .3em;
  color: var(--wc-cyan-dim); text-transform: uppercase;
}
@media (prefers-reduced-motion: reduce) {
  .wc-crt__sweep, .wc-crt__flicker, .wc-obj.is-active .wc-obj__mark { animation: none; }
}
`;

/** Inject the stylesheet once. Returns the `<style>` node so dispose can pull it. */
export function injectStyle(root) {
  const doc = root?.ownerDocument ?? document;
  const style = doc.createElement('style');
  style.id = 'wc-ui-style';
  style.textContent = CSS;
  (doc.head ?? root).appendChild(style);
  return style;
}
