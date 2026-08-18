/**
 * src/ui/hud/CommandMenu.js — the wingman comms menu.
 *
 * Wing Commander's comms menu was a *gameplay* system, not a cosmetic one, and
 * `src/ai/wingmen.js` treats it that way: each order rewrites the recipient's
 * behaviour override and draws a spoken acknowledgement — or a refusal, when
 * the wingman is too busy staying alive. This is the front end for that, and
 * nothing more; every decision about what an order means lives in the AI.
 *
 * Two pages, the way the original worked:
 *   1. who   — All Wings, or one wingman by callsign
 *   2. what  — the order list from `wingmen.list()`, with availability flags
 *
 * Digits select directly on both pages, so a pilot who knows the menu can fly
 * "C 1 1" without looking. Escape/Backspace steps back a page, then closes.
 *
 * With no AI system loaded the menu still opens and reports the channel dead,
 * because a comms key that does nothing at all reads as a broken build.
 */
import { el, clear } from './../dom.js';

const FALLBACK_ORDERS = [
  { id: 'breakAndAttack', label: 'Break and attack' },
  { id: 'formOnMyWing', label: 'Form on my wing' },
  { id: 'helpMeOut', label: 'Help me out!' },
  { id: 'attackMyTarget', label: 'Attack my target' },
  { id: 'keepFormation', label: 'Keep formation' },
  { id: 'returnToBase', label: 'Return to base' },
  { id: 'damageReport', label: 'Damage report' },
];

export function createCommandMenu(engine, ui) {
  const headEl = el('div.wc-cmd__head', {}, ['Comms', el('small', { text: 'TAC 1' })]);
  const bodyEl = el('div.wc-cmd__body');
  const footEl = el('div.wc-cmd__foot', { text: '1-9 SELECT · ESC BACK' });
  const root = el('div.wc-cmd', {}, [headEl, el('div', {}, [bodyEl, footEl])]);

  let open = false;
  let page = 'who';   // 'who' | 'what'
  let index = 0;
  let rows = [];
  let target = 'all';
  let targetLabel = 'ALL WINGS';

  const commander = () => engine?.game?.ai?.wingmen ?? null;

  function wingList() {
    const wc = commander();
    if (!wc?.wingmen) return [];
    try {
      return wc.wingmen().map((p, i) => ({
        idx: i + 1,
        callsign: p?.profile?.callsign ?? `Wing ${i + 2}`,
        state: p?.state ?? '',
        hurt: p?.incoming || p?.state === 'evade' || p?.state === 'flee',
      }));
    } catch { return []; }
  }

  function orderList() {
    const wc = commander();
    if (!wc?.list) return FALLBACK_ORDERS.map((o) => ({ ...o, available: false }));
    try { return wc.list(); } catch { return FALLBACK_ORDERS.map((o) => ({ ...o, available: false })); }
  }

  function buildWho() {
    const wing = wingList();
    rows = [{ id: 'all', label: 'All Wings', note: wing.length ? `${wing.length} ON NET` : 'NO WING', disabled: false }];
    for (const w of wing) {
      rows.push({
        id: w.idx,
        label: w.callsign,
        note: w.hurt ? 'DEFENSIVE' : (w.state || 'ON STATION').toUpperCase(),
        disabled: false,
      });
    }
    headEl.firstChild.textContent = 'Comms — Select Recipient';
    footEl.textContent = '1-9 SELECT · ESC CLOSE';
  }

  function buildWhat() {
    rows = orderList().map((o, i) => ({
      id: o.id,
      label: o.label,
      note: o.available === false ? 'N/A' : '',
      disabled: o.available === false,
    }));
    headEl.firstChild.textContent = `Comms — ${targetLabel}`;
    footEl.textContent = '1-9 ORDER · ESC BACK';
  }

  function paint() {
    clear(bodyEl);
    if (!rows.length) {
      bodyEl.append(el('div.wc-cmd__item.is-disabled', {}, [el('b', { text: '—' }), el('span', { text: 'Channel dead' })]));
      return;
    }
    rows.forEach((r, i) => {
      bodyEl.append(el('div', {
        class: `wc-cmd__item${i === index ? ' is-sel' : ''}${r.disabled ? ' is-disabled' : ''}`,
        on: { mouseenter: () => { index = i; paint(); }, click: () => commit() },
      }, [
        el('b', { text: String(i + 1) }),
        el('span', { text: r.label }),
        r.note ? el('em', { text: r.note }) : null,
      ]));
    });
  }

  function commit() {
    const r = rows[index];
    if (!r) { ui.sfx('ui.deny'); return; }
    if (r.disabled) { ui.sfx('ui.deny'); return; }
    if (page === 'who') {
      target = r.id;
      targetLabel = r.label.toUpperCase();
      page = 'what';
      index = 0;
      buildWhat();
      paint();
      ui.sfx('ui.mfd');
      return;
    }
    const wc = commander();
    let taken = 0;
    try { taken = wc?.issue?.(r.id, { to: target }) ?? 0; } catch { taken = 0; }
    if (taken > 0) ui.sfx('ui.select');
    else { ui.sfx('ui.deny'); ui.toast('NO RESPONSE ON THE NET', 'warn'); }
    close();
  }

  function move(d) {
    if (!rows.length) return;
    index = (index + d + rows.length) % rows.length;
    ui.sfx('ui.beep');
    paint();
  }

  function show() {
    if (open) { close(); return; }
    open = true;
    page = 'who';
    index = 0;
    target = 'all';
    targetLabel = 'ALL WINGS';
    buildWho();
    paint();
    root.classList.add('is-open');
    ui.sfx('ui.mfd');
  }

  function close() {
    if (!open) return;
    open = false;
    root.classList.remove('is-open');
  }

  function handleKey(e) {
    if (!open) return false;
    switch (e.code) {
      case 'ArrowUp': move(-1); return true;
      case 'ArrowDown': move(1); return true;
      case 'Enter': case 'NumpadEnter': case 'Space': commit(); return true;
      case 'Escape': case 'Backspace':
        if (page === 'what') { page = 'who'; index = 0; buildWho(); paint(); ui.sfx('ui.beep'); }
        else { ui.sfx('ui.deny'); close(); }
        return true;
      case 'KeyC': close(); return true;
      default: {
        const d = /^Digit([1-9])$/.exec(e.code) ?? /^Numpad([1-9])$/.exec(e.code);
        if (d) {
          const i = Number(d[1]) - 1;
          if (i < rows.length) { index = i; paint(); commit(); return true; }
          ui.sfx('ui.deny');
          return true;
        }
        return false;
      }
    }
  }

  return {
    root,
    handleKey,
    toggle: show,
    close,
    get isOpen() { return open; },
    /** Keeps recipient states ("DEFENSIVE") live while the first page is up. */
    update() {
      if (!open || page !== 'who') return;
      const before = rows.map((r) => r.note).join('|');
      buildWho();
      if (rows.map((r) => r.note).join('|') !== before) {
        index = Math.min(index, Math.max(0, rows.length - 1));
        paint();
      }
    },
  };
}
