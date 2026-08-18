/**
 * src/ui/screens/Credits.js — the roll.
 *
 * Short, and honest about what this project is: a procedurally-generated
 * homage. It scrolls because a static credits page is the one screen nobody
 * would ever look at twice, and it wraps so it can be left running as an
 * attract mode.
 */
import { el } from './../dom.js';
import { createScreenShell, topBar, bottomBar } from './../screenshell.js';

const ROLL = [
  ['h3', 'Terran Confederation Flight Simulation'],
  ['p', 'In the spirit of Wing Commander: Prophecy'],
  ['h3', 'Engine'],
  ['p', 'Three.js · WebGL2 · HDR deferred post pipeline'],
  ['h3', 'Everything You Can See'],
  ['p', 'Hulls, panel lines, rivets, wear and soot — generated at runtime'],
  ['p', 'Nebulae, starfields, planets and asteroid fields — generated at runtime'],
  ['p', 'Explosions, shields, trails and debris — generated at runtime'],
  ['h3', 'Everything You Can Hear'],
  ['p', 'Engines, guns, missiles, impacts and the adaptive score'],
  ['p', 'Synthesised in WebAudio. No samples ship with this build.'],
  ['h3', 'Faces'],
  ['p', 'Every pilot portrait on the comms channel is drawn from their callsign'],
  ['h3', 'Rules of the House'],
  ['p', 'No external assets. No network. Nothing calls Math.random().'],
  ['h3', 'For'],
  ['p', 'Origin Systems, 1990–1998'],
  ['p', 'and everyone who ever flew the Midway home on one engine'],
];

export function createCredits(ctx) {
  const { ui } = ctx;
  const shell = createScreenShell({ seed: ui.seed + 977, palette: 'crimson' });
  const roll = el('div.wc-credits__roll');
  const view = el('div.wc-credits', {}, [roll]);
  let y = 0;

  for (const [tag, text] of ROLL) roll.append(el(tag, { text }));

  shell.content.append(
    topBar('Credits', [el('span', { text: 'ATTRACT MODE' })]),
    view,
    bottomBar([['ESC', 'BACK'], ['ENTER', 'BACK']]),
  );

  return {
    root: shell.root,
    name: 'credits',
    musicState: 'calm',
    mount() { y = view.clientHeight || 400; roll.style.transform = `translateY(${y}px)`; shell.show(); },
    unmount() { shell.hide(); },
    update(dt) {
      shell.update(dt);
      const h = roll.scrollHeight || 600;
      y -= dt * 34;
      if (y < -h) y = (view.clientHeight || 400);
      roll.style.transform = `translateY(${y.toFixed(1)}px)`;
    },
    handleKey(e) {
      if (['Escape', 'Enter', 'NumpadEnter', 'Space', 'Backspace'].includes(e.code)) {
        ui.sfx('ui.select');
        ui.popScreen();
        return true;
      }
      return false;
    },
    resize() { shell.resize(); },
    dispose() { shell.dispose(); },
  };
}
