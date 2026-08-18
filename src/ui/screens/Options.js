/**
 * src/ui/screens/Options.js — configuration.
 *
 * Every row here writes straight through to the system that owns the setting —
 * `engine.post.setQuality`, `audio.setBus`, `engine.input.mouseFlight` — rather
 * than to a copy the UI keeps and hopes somebody reads. The store is persisted
 * to localStorage and re-applied on boot, so a pilot who drops the preset to
 * `low` on a weak machine does not have to do it again next launch.
 *
 * Left/right adjusts, up/down moves, Enter cycles — the same grammar as the
 * console games this is modelled on, and workable on a stick's hat switch.
 */
import { el, clear } from './../dom.js';
import { createScreenShell, topBar, bottomBar } from './../screenshell.js';

const QUALITY = ['low', 'medium', 'high', 'ultra'];

export function createOptions(ctx) {
  const { ui } = ctx;
  const shell = createScreenShell({ seed: ui.seed + 101, palette: 'teal', scrim: 'even' });
  const listEl = el('div.wc-opts');
  let index = 0;
  let rows = [];

  /** One row definition per setting. `get`/`set` talk to `ui.options`. */
  function defs() {
    const o = ui.options;
    const vol = (id, label) => ({
      id, label, type: 'range', min: 0, max: 10, step: 1,
      get: () => o.vol[id], set: (v) => { o.vol[id] = v; },
      format: (v) => (v === 0 ? 'MUTED' : `${v * 10}%`),
      note: null,
    });
    return [
      {
        id: 'quality',
        label: 'Graphics Preset',
        type: 'enum',
        values: QUALITY,
        get: () => o.quality,
        set: (v) => { o.quality = v; },
        format: (v) => v,
        note: 'Drives the post-processing stack: TAA, motion blur, streaks, god rays and lens dirt.',
      },
      { ...vol('master', 'Master Volume'), label: 'Master Volume' },
      { ...vol('music', 'Music'), label: 'Music' },
      { ...vol('sfx', 'Effects'), label: 'Effects' },
      { ...vol('engine', 'Engines'), label: 'Engines' },
      { ...vol('voice', 'Comms Voice'), label: 'Comms Voice' },
      {
        id: 'invertY',
        label: 'Invert Pitch Axis',
        type: 'toggle',
        get: () => o.invertY,
        set: (v) => { o.invertY = v; },
        note: 'Stick-forward pitches up, the way a real airframe behaves.',
      },
      {
        id: 'mouseFlight',
        label: 'Mouse Flight',
        type: 'toggle',
        get: () => o.mouseFlight,
        set: (v) => { o.mouseFlight = v; },
        note: 'Relative mouse steering with a deadzone. Click the viewport to capture the pointer.',
      },
      {
        id: 'subtitles',
        label: 'Comms Subtitles',
        type: 'toggle',
        get: () => o.subtitles,
        set: (v) => { o.subtitles = v; },
        note: 'Portrait plate and transcript for every radio transmission.',
      },
    ];
  }

  function build() {
    rows = defs();
    clear(listEl);
    rows.forEach((r, i) => {
      const val = el('div.wc-opt__val');
      const meter = el('div.wc-opt__meter');
      const row = el('div.wc-opt', {
        on: {
          mouseenter: () => { index = i; paint(); },
          click: () => { adjust(1); },
        },
      }, [
        el('div.wc-opt__label', { text: r.label }),
        el('div.wc-opt__ctl', {}, [
          el('span.wc-opt__arrows', { text: '◄' }),
          val,
          r.type === 'range' ? meter : el('div', { style: { flex: '1' } }),
          el('span.wc-opt__arrows', { text: '►' }),
        ]),
      ]);
      r.node = row; r.valEl = val; r.meterEl = meter;
      listEl.append(row);
      if (r.note) listEl.append(el('div.wc-opt__note', { text: r.note, style: { display: 'none' } }));
      r.noteEl = r.note ? listEl.lastChild : null;
    });
    paint();
  }

  function paint() {
    rows.forEach((r, i) => {
      r.node.classList.toggle('is-sel', i === index);
      if (r.noteEl) r.noteEl.style.display = i === index ? 'block' : 'none';
      const v = r.get();
      if (r.type === 'toggle') r.valEl.textContent = v ? 'ON' : 'OFF';
      else r.valEl.textContent = r.format ? r.format(v) : String(v);
      if (r.type === 'range') {
        clear(r.meterEl);
        for (let k = 1; k <= r.max; k++) r.meterEl.append(el('i', { class: k <= v ? 'on' : '' }));
      }
    });
  }

  function adjust(dir) {
    const r = rows[index];
    if (!r) return;
    if (r.type === 'toggle') r.set(!r.get());
    else if (r.type === 'enum') {
      const list = r.values;
      const i = Math.max(0, list.indexOf(r.get()));
      r.set(list[(i + dir + list.length) % list.length]);
    } else {
      const v = Math.max(r.min, Math.min(r.max, r.get() + dir * r.step));
      if (v === r.get()) { ui.sfx('ui.deny'); return; }
      r.set(v);
    }
    ui.sfx(r.type === 'range' ? 'ui.beep' : 'ui.mfd');
    ui.applyOptions();
    ui.saveOptions();
    paint();
  }

  function move(d) {
    index = (index + d + rows.length) % rows.length;
    ui.sfx('ui.beep');
    paint();
  }

  shell.content.append(
    topBar('Configuration · Pilot Preferences', [el('span', { text: 'STORED LOCALLY' })]),
    el('div', { style: { flex: '1', overflow: 'auto', padding: '2vh 0', minHeight: '0' } }, [
      el('div', { style: { width: 'min(56em, 78vw)', margin: '0 auto' } }, [
        el('div.wc-panel', {}, [
          el('div.wc-panel__title', {}, ['Options', el('small', { text: 'CFG-01' })]),
          el('div.wc-panel__body', { style: { padding: '.4em 0' } }, [listEl]),
        ]),
      ]),
    ]),
    bottomBar([['↑↓', 'SELECT'], ['← →', 'ADJUST'], ['ENTER', 'CYCLE'], ['ESC', 'BACK']]),
  );

  return {
    root: shell.root,
    name: 'options',
    mount() { index = 0; build(); shell.show(); },
    unmount() { shell.hide(); },
    update(dt) { shell.update(dt); },
    handleKey(e) {
      switch (e.code) {
        case 'ArrowUp': move(-1); return true;
        case 'ArrowDown': move(1); return true;
        case 'ArrowLeft': adjust(-1); return true;
        case 'ArrowRight': adjust(1); return true;
        case 'Enter': case 'NumpadEnter': case 'Space': adjust(1); return true;
        case 'Escape': case 'Backspace': ui.sfx('ui.select'); ui.popScreen(); return true;
        default: return false;
      }
    },
    resize() { shell.resize(); },
    dispose() { shell.dispose(); },
  };
}
