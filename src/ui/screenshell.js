/**
 * src/ui/screenshell.js — the chassis every full-screen menu is built into.
 *
 * Stacking order matters and is the whole reason this is shared code:
 *   1 backdrop canvas  (drifting hangar view)
 *   2 content          (the screen's own DOM)
 *   3 CRT overlay      (scanlines, sweep, glass) — must sit *over* the text,
 *                      otherwise the type looks pasted on top of the tube
 * The CRT layer stays `pointer-events: none` so clicks reach the content.
 */
import { el } from './dom.js';
import { createCRT } from './crt.js';
import { createBackdrop } from './backdrop.js';

export function createScreenShell({ seed = 1337, palette = 'teal', scrim = 'side' } = {}) {
  const canvas = el('canvas.wc-backdrop');
  const scrimEl = el('div', { class: `wc-scrim${scrim === 'even' ? ' wc-scrim--even' : ''}` });
  const content = el('div', {
    style: {
      position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column',
      minHeight: '0', overflow: 'hidden',
    },
  });
  const root = el('div.wc-screen', {}, [canvas, scrimEl, content, createCRT()]);
  const backdrop = createBackdrop(canvas, { seed, palette });

  return {
    root,
    content,
    backdrop,
    update(dt) { backdrop.draw(dt); },
    show() { requestAnimationFrame(() => root.classList.add('is-shown')); },
    hide() { root.classList.remove('is-shown'); },
    resize() { backdrop.resize(); },
    dispose() { backdrop.dispose(); root.remove(); },
  };
}

/** Standard top strip: system identity on the left, live readouts on the right. */
export function topBar(left, right = []) {
  return el('div.wc-bar.wc-bar--top', {}, [
    el('span', { text: '◆', class: 'wc-tick' }),
    el('b', { text: left }),
    el('div.wc-spacer'),
    ...[].concat(right),
  ]);
}

/** Standard bottom strip: key hints. `[ENTER] LAUNCH` renders the bracket dim. */
export function bottomBar(hints) {
  const kids = [];
  for (const h of hints) {
    if (!h) continue;
    const [key, label] = Array.isArray(h) ? h : [h, ''];
    kids.push(el('span', {}, [el('b', { text: key }), label ? ` ${label}` : '']));
  }
  return el('div.wc-bar.wc-bar--bottom', {}, kids);
}
