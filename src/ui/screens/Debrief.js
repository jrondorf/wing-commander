/**
 * src/ui/screens/Debrief.js — after-action.
 *
 * The debrief is where a mission stops being a dogfight and becomes a career.
 * Wing Commander understood that: the numbers matter less than the *verdict*
 * and the beat where somebody pins something on you. So the layout leads with
 * the verdict, backs it with the tally, then holds a moment for a promotion or
 * a decoration — drawn, since no image asset may ship (ARCHITECTURE §1).
 *
 * The stat counters roll up rather than appearing, which buys the screen the
 * two seconds it needs to feel earned.
 */
import { el, clear, fmtClock } from './../dom.js';
import { createScreenShell, topBar, bottomBar } from './../screenshell.js';
import { createTypewriter } from './../typewriter.js';
import { drawMedal } from './../insignia.js';
import { createMenuList } from './../menulist.js';

const REMARKS = {
  success: [
    'Clean work out there. The board is green and the flight deck is clear.',
    'Objectives met. Fleet Intelligence has what it asked for.',
    'Good flying. Get some rack time — you are on the board again in six hours.',
  ],
  failure: [
    'That did not go the way any of us wanted. Read the tape and learn from it.',
    'We lost the objective. Command will want an explanation, and so will I.',
    'You came home. That is the only line in the good column tonight.',
  ],
};

export function createDebrief(ctx) {
  const { ui } = ctx;
  const shell = createScreenShell({ seed: ui.seed + 31, palette: 'teal', scrim: 'even' });

  let result = null;
  let roll = 0;

  const verdictEl = el('div.wc-verdict');
  const subEl = el('div', {
    style: { fontFamily: 'var(--wc-f-mono)', fontSize: '.86em', color: 'var(--wc-dim)', letterSpacing: '.1em', marginTop: '.3em' },
  });
  const statsEl = el('div.wc-stats');
  const objEl = el('div');
  const awardEl = el('div');
  const remarkEl = el('div', {
    style: { fontFamily: 'var(--wc-f-mono)', fontSize: '.88em', lineHeight: '1.6', color: 'var(--wc-text)', minHeight: '4em' },
  });
  const typer = createTypewriter(remarkEl, { cps: 58 });

  const menu = createMenuList([{ id: 'continue', label: 'Continue' }], {
    onSelect: () => ui.sfx('ui.beep'),
    onCommit: () => { ui.sfx('ui.select'); ui.closeDebrief(); },
  });

  const stat = (k, node) => el('div.wc-stat', {}, [el('div.wc-stat__k', { text: k }), node]);

  /** Counters that animate up. Held so `update` can drive them. */
  const counters = [];
  function counter(key, target, { suffix = '', decimals = 0 } = {}) {
    const v = el('div.wc-stat__v', { text: '0' });
    counters.push({ v, target, suffix, decimals });
    return stat(key, v);
  }

  const panel = (title, small, body) => el('div.wc-panel', {}, [
    el('div.wc-panel__title', {}, [title, small ? el('small', { text: small }) : null]),
    el('div.wc-panel__body', {}, [].concat(body)),
  ]);

  const leftCol = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '1.1em', minHeight: '0' } });
  const rightCol = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '1.1em', minHeight: '0' } });

  shell.content.append(
    topBar('Mission Debrief · Flight Operations', [el('span', { text: 'AFTER ACTION REPORT' })]),
    el('div.wc-debrief', {}, [leftCol, rightCol]),
    bottomBar([['ENTER', 'CONTINUE'], ['ESC', 'CONTINUE']]),
  );

  function build() {
    const good = result.outcome === 'success';
    verdictEl.className = `wc-verdict wc-verdict--${good ? 'success' : 'failure'}`;
    verdictEl.textContent = good ? 'Mission Accomplished' : 'Mission Failed';
    subEl.textContent = `FLIGHT TIME ${fmtClock(result.time)}  ·  ${result.wingmenLost > 0
      ? `${result.wingmenLost} WINGMAN LOST` : 'FLIGHT INTACT'}`;

    counters.length = 0;
    clear(statsEl).append(
      counter('Confirmed kills', result.kills),
      counter('Gun accuracy', result.accuracy * 100, { suffix: '%', decimals: 1 }),
      counter('Rounds fired', result.shotsFired),
      counter('Rounds on target', result.shotsHit),
      counter('Missiles expended', result.missiles),
      counter('Hull integrity lost', result.hullTaken * 100, { suffix: '%', decimals: 0 }),
    );

    clear(objEl);
    for (const o of result.objectives) {
      objEl.append(el('div', { class: `wc-obj wc-obj--${o.type} is-${o.status}` }, [
        el('span.wc-obj__mark', { text: o.status === 'complete' ? '✓' : o.status === 'failed' ? '✕' : '–' }),
        el('span.wc-obj__text', { text: o.text }),
        el('span.wc-obj__tag', { text: o.status }),
      ]));
    }
    if (!result.objectives.length) {
      objEl.append(el('div', {
        text: 'NO OBJECTIVES ON FILE',
        style: { fontFamily: 'var(--wc-f-mono)', fontSize: '.8em', color: 'var(--wc-dim)' },
      }));
    }

    clear(awardEl);
    if (result.promotion || result.medal) {
      const cv = el('canvas', { width: 128, height: 128 });
      awardEl.append(el('div.wc-medal', {}, [
        cv,
        el('div', {}, [
          el('div.wc-medal__t', { text: result.medal || 'Promotion' }),
          el('div.wc-medal__s', {
            text: result.promotion
              ? `Promoted to ${result.promotion}`
              : 'Awarded for conduct in the presence of the enemy',
          }),
        ]),
      ]));
      const c2d = cv.getContext('2d');
      if (c2d) drawMedal(c2d, 128, 128, result.medal || result.promotion || 'Service Star');
    } else {
      awardEl.append(el('div', {
        text: 'NO DECORATION RECOMMENDED THIS SORTIE',
        style: { fontFamily: 'var(--wc-f-mono)', fontSize: '.8em', color: 'var(--wc-dim)', letterSpacing: '.08em', padding: '.6em 0' },
      }));
    }

    clear(leftCol).append(
      el('div', {}, [verdictEl, subEl]),
      panel('Tally', 'GUN CAMERA', [statsEl]),
      panel('Objectives', null, [objEl]),
    );
    clear(rightCol).append(
      panel('Commanding Officer', 'CAG', [remarkEl]),
      panel('Decorations', null, [awardEl]),
      el('div', { style: { marginTop: 'auto' } }, [menu.root]),
    );

    const pool = REMARKS[result.outcome] ?? REMARKS.success;
    typer.start(result.remark || pool[Math.abs(Math.round(result.kills * 7 + result.shotsFired)) % pool.length]);
    roll = 0;
  }

  return {
    root: shell.root,
    name: 'debrief',
    get musicState() { return result?.outcome === 'success' ? 'victory' : 'defeat'; },
    mount(r) {
      result = r;
      build();
      shell.show();
    },
    unmount() { shell.hide(); },
    update(dt) {
      shell.update(dt);
      typer.update(dt);
      // 1.4 s roll-up, eased, so the numbers land instead of appearing.
      if (roll < 1) {
        roll = Math.min(1, roll + dt / 1.4);
        const e = 1 - Math.pow(1 - roll, 3);
        for (const c of counters) {
          const v = c.target * e;
          c.v.textContent = `${v.toFixed(c.decimals)}${c.suffix}`;
        }
      }
    },
    handleKey(e) {
      if (e.code === 'Escape') { ui.sfx('ui.select'); ui.closeDebrief(); return true; }
      return menu.handleKey(e);
    },
    resize() { shell.resize(); },
    dispose() { shell.dispose(); },
  };
}
