/**
 * src/ui/screens/MainMenu.js — the shipboard terminal.
 *
 * Wing Commander never had a "main menu"; it had a terminal bolted to a
 * bulkhead on the flight deck. So this is laid out as one: an authenticated
 * session on the carrier's tactical net, with a self-test log printing down the
 * right-hand column, the pilot's service record underneath it, and the actual
 * choices as a terminal list rather than buttons.
 *
 * The whole screen is keyboard-first — arrows/Enter, digits as accelerators —
 * because the sim is flown on a stick.
 */
import { el, clear } from './../dom.js';
import { createScreenShell, topBar, bottomBar } from './../screenshell.js';
import { createMenuList } from './../menulist.js';
import { createTypewriter } from './../typewriter.js';

const BOOT_LOG = [
  'FLTNET LINK ......... ESTABLISHED',
  'AUTH TOKEN .......... ACCEPTED',
  'TACTICAL DATABASE ... 4,118 CONTACTS',
  'ORDNANCE STORES ..... NOMINAL',
  'FLIGHT DECK ......... GREEN',
];

export function createMainMenu(ctx) {
  const { engine, ui } = ctx;
  const shell = createScreenShell({ seed: ui.seed, palette: 'teal' });

  let clock = 0;
  const clockEl = el('span', { text: '00:00:00' });
  const stardateEl = el('b', { text: '2681.114' });

  const logEl = el('div', {
    style: {
      fontFamily: 'var(--wc-f-mono)', fontSize: '0.78em', lineHeight: '1.75',
      color: 'var(--wc-cyan-dim)', letterSpacing: '0.06em', whiteSpace: 'pre-wrap',
      minHeight: '9em',
    },
  });
  const typer = createTypewriter(logEl, { cps: 110 });

  const menu = createMenuList([], {
    onSelect: () => ui.sfx('ui.beep'),
    onCommit: (item, i, ok) => {
      if (!ok) { ui.sfx('ui.deny'); return; }
      ui.sfx('ui.select');
      choose(item.id);
    },
  });

  function choose(id) {
    if (id === 'new') ui.startCampaign({ fresh: true });
    else if (id === 'continue') ui.startCampaign({ fresh: false });
    else if (id === 'options') ui.openOptions();
    else if (id === 'credits') ui.openCredits();
  }

  function rebuild() {
    const rec = ui.record;
    menu.setItems([
      { id: 'new', label: 'New Campaign', hint: 'BEGIN TOUR' },
      { id: 'continue', label: 'Continue', hint: rec.missions > 0 ? `MISSION ${rec.missions + 1}` : 'NO RECORD', disabled: rec.missions <= 0 },
      { id: 'options', label: 'Options', hint: 'CONFIGURE' },
      { id: 'credits', label: 'Credits', hint: '' },
    ]);
    menu.selectFirstEnabled();
    clear(recordEl).append(
      kv('Pilot', rec.name),
      kv('Rank', rec.rank),
      kv('Squadron', rec.squadron),
      kv('Missions', String(rec.missions)),
      kv('Kills', String(rec.kills)),
      kv('Decorations', rec.medals?.length ? rec.medals.join(', ') : 'None'),
      kv('Status', rec.missions > 0 ? 'ACTIVE' : 'AWAITING ASSIGNMENT'),
    );
  }

  const kv = (k, v) => el('div', {
    style: { display: 'flex', gap: '.6em', padding: '.16em 0', fontSize: '.8em' },
  }, [
    el('span', { text: k.toUpperCase(), style: { color: 'var(--wc-dim)', letterSpacing: '.16em', flex: '0 0 8.5em', whiteSpace: 'nowrap' } }),
    el('span', { text: v, style: { fontFamily: 'var(--wc-f-mono)', color: 'var(--wc-text)', letterSpacing: '.04em', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }),
  ]);

  const recordEl = el('div');

  const titleBlock = el('div.wc-title', {}, [
    el('div.wc-title__sub', { text: 'Terran Confederation · Fleet Operations' }),
    el('div.wc-title__main', { text: 'Wing Commander' }),
    el('div.wc-title__rule'),
    el('div.wc-title__tag', { text: 'Prophecy-class simulation · Build 1.0 · All assets generated at runtime' }),
  ]);

  const left = el('div', {
    style: { flex: '1 1 58%', display: 'flex', flexDirection: 'column', justifyContent: 'center', minWidth: '0' },
  }, [titleBlock, el('div', { style: { height: '1.6em' } }), menu.root]);

  const right = el('div', {
    style: { flex: '0 1 30em', display: 'flex', flexDirection: 'column', gap: '1.1em', minWidth: '0', justifyContent: 'center' },
  }, [
    el('div.wc-panel', {}, [
      el('div.wc-panel__title', {}, ['Terminal Self-Test', el('small', { text: 'TCS MIDWAY' })]),
      el('div.wc-panel__body', {}, [logEl]),
    ]),
    el('div.wc-panel', {}, [
      el('div.wc-panel__title', {}, ['Service Record', el('small', { text: 'FLT-PERS' })]),
      el('div.wc-panel__body', {}, [recordEl]),
    ]),
  ]);

  shell.content.append(
    topBar('Confederation Fleet Data Terminal', [
      el('span', {}, ['STARDATE ', stardateEl]),
      el('span', { text: '·' }),
      clockEl,
    ]),
    el('div', {
      style: {
        flex: '1', display: 'flex', alignItems: 'center', gap: '3vw',
        padding: '2vh 4vw', minHeight: '0',
      },
    }, [left, right]),
    bottomBar([['↑↓', 'SELECT'], ['ENTER', 'CONFIRM'], ['1-4', 'DIRECT'], ['ESC', 'BACK']]),
  );

  return {
    root: shell.root,
    name: 'menu',
    musicState: 'calm',
    mount() {
      rebuild();
      typer.start(BOOT_LOG.join('\n'));
      shell.show();
    },
    unmount() { shell.hide(); },
    update(dt) {
      shell.update(dt);
      typer.update(dt);
      clock += dt;
      // A running clock is the cheapest proof the terminal is live.
      const s = Math.floor(clock) + 43200;
      clockEl.textContent = `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      stardateEl.textContent = (2681.114 + clock * 0.00002).toFixed(3);
    },
    handleKey(e) {
      if (e.code === 'Escape') return true; // nothing above the main menu
      return menu.handleKey(e);
    },
    resize() { shell.resize(); },
    dispose() { shell.dispose(); },
  };
}
