/**
 * src/ui/hud/Objectives.js — the live objective tracker.
 *
 * Deliberately small and deliberately at the edge of frame. The cockpit HUD
 * (src/cockpit/) owns the centre and both margins between roughly 22 % and 55 %
 * of frame height; this sits above the shield gauge and below the nav readout,
 * and never grows past four rows. If a mission has more objectives than that,
 * completed ones fall off the top — what a pilot needs mid-fight is what is
 * still outstanding.
 *
 * Rows animate on change (`objective:update`) so a completed goal registers
 * peripherally without the player having to read the panel.
 */
import { el, clear } from './../dom.js';

const MAX_ROWS = 4;
const MARK = { pending: '·', active: '◆', complete: '✓', failed: '✕' };

export function createObjectives() {
  const listEl = el('div');
  const countEl = el('span', { text: '0/0' });
  const root = el('div.wc-objtrack', {}, [
    el('div.wc-objtrack__head', {}, ['Objectives', countEl]),
    listEl,
  ]);

  /** @type {Array<{id,text,type,status}>} */
  let objectives = [];
  let flash = new Set();
  let enabled = true;

  function visible() {
    // Outstanding work first; completed rows only fill the leftover space.
    const live = objectives.filter((o) => o.status === 'active' || o.status === 'pending');
    const done = objectives.filter((o) => o.status === 'complete' || o.status === 'failed');
    return [...live, ...done.slice(-Math.max(0, MAX_ROWS - live.length))].slice(0, MAX_ROWS);
  }

  function paint() {
    clear(listEl);
    for (const o of visible()) {
      listEl.append(el('div', {
        class: `wc-obj wc-obj--${o.type} is-${o.status}${flash.has(o.id) ? ' is-flash' : ''}`,
      }, [
        el('span.wc-obj__mark', { text: MARK[o.status] ?? '·' }),
        el('span.wc-obj__text', { text: o.text }),
        o.progress ? el('span.wc-obj__tag', { text: `${o.progress.current}/${o.progress.total}` }) : null,
      ]));
    }
    const done = objectives.filter((o) => o.status === 'complete').length;
    const total = objectives.filter((o) => o.type === 'primary').length || objectives.length;
    countEl.textContent = `${done}/${total}`;
    root.classList.toggle('is-live', enabled && objectives.length > 0);
  }

  return {
    root,
    /** Replace the whole set — called when a mission starts. */
    setAll(list) {
      objectives = (list ?? []).map((o) => ({ ...o }));
      flash.clear();
      paint();
    },
    /** Merge one update. Unknown ids are appended, which is how a mission adds
     *  an objective mid-flight ("new orders"). */
    update(o) {
      if (!o) return;
      const i = objectives.findIndex((x) => x.id === o.id);
      if (i >= 0) objectives[i] = { ...objectives[i], ...o };
      else objectives.push({ ...o });
      flash.add(o.id);
      paint();
      // The flash class is a two-shot CSS animation; clearing it after lets the
      // same objective flash again on its next change.
      setTimeout(() => { flash.delete(o.id); paint(); }, 2300);
    },
    /** Flash one row without changing it — the board arrived wholesale. */
    flash(id) {
      if (!id) return;
      flash.add(id);
      paint();
      setTimeout(() => { flash.delete(id); paint(); }, 2300);
    },
    setEnabled(v) { enabled = !!v; paint(); },
    reset() { objectives = []; flash = new Set(); paint(); },
    get all() { return objectives; },
  };
}
