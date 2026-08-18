/**
 * src/ui/screens/Briefing.js — the ready room.
 *
 * This is the screen the whole UI exists for. Wing Commander's briefings did
 * three jobs at once: they told you the story, they told you the *shape* of the
 * mission (where you are going and what is waiting there), and they told you
 * who is flying with you — which is what makes losing a wingman land later.
 *
 * So the layout is: situation text typing in at terminal cadence on the left,
 * under it the threat call and the flight roster with drawn portraits; on the
 * right the nav plot, big, with the objective list under it.
 *
 * Left/right arrows step the selected nav point and print its note, so a pilot
 * can walk the route before flying it.
 */
import { el, clear, roman, fmtDistance } from './../dom.js';
import { createScreenShell, topBar, bottomBar } from './../screenshell.js';
import { createTypewriter } from './../typewriter.js';
import { createNavMap } from './../navmap.js';
import { paintPortraitTo } from './../portrait.js';

const THREAT_TEXT = {
  low: 'Light or no opposition anticipated.',
  moderate: 'Enemy fighter activity expected. Stay with your wing.',
  high: 'Heavy opposition. Expect multiple hostile flights.',
  extreme: 'Capital-scale opposition. Survival is the primary objective.',
};

export function createBriefing(ctx) {
  const { ui } = ctx;
  const shell = createScreenShell({ seed: ui.seed + 7, palette: 'teal', scrim: 'even' });

  let mission = null;
  let navIndex = 0;

  // ---- head ---------------------------------------------------------------
  const nameEl = el('div.wc-brief__name', { text: 'MISSION BRIEFING' });
  const metaEl = el('div.wc-brief__meta');

  // ---- situation ----------------------------------------------------------
  const textEl = el('div.wc-brief__text');
  const typer = createTypewriter(textEl, { cps: 96 });
  /** Leg-by-leg course listing, under the situation text. */
  const courseEl = el('ul.wc-list');

  // ---- threat -------------------------------------------------------------
  const threatEl = el('div');
  const threatNote = el('div', {
    style: { fontFamily: 'var(--wc-f-mono)', fontSize: '.78em', color: 'var(--wc-dim)', lineHeight: '1.5' },
  });
  const contactsEl = el('ul.wc-list');

  // ---- flight -------------------------------------------------------------
  const wingEl = el('div');

  // ---- nav ----------------------------------------------------------------
  const navCanvas = el('canvas');
  const navMap = createNavMap(navCanvas);
  const navNote = el('div', {
    style: {
      fontFamily: 'var(--wc-f-mono)', fontSize: '.78em', color: 'var(--wc-cyan-dim)',
      letterSpacing: '.06em', padding: '.4em .1em 0', minHeight: '2.6em',
      whiteSpace: 'pre-wrap', lineHeight: '1.5',
    },
  });

  // ---- objectives ---------------------------------------------------------
  const objEl = el('div');

  const panel = (title, small, body, opts = {}) => el('div.wc-panel', {
    style: { display: 'flex', flexDirection: 'column', minHeight: '0', ...(opts.style ?? {}) },
  }, [
    el('div.wc-panel__title', {}, [title, small ? el('small', { text: small }) : null]),
    el('div.wc-panel__body', {
      style: { flex: opts.grow ? '1' : '0 0 auto', minHeight: '0', display: 'flex', flexDirection: 'column' },
    }, [].concat(body)),
  ]);

  shell.content.append(
    topBar('Mission Briefing · Ready Room 2', [el('span', { text: 'TACTICAL NET · SECURE' })]),
    el('div.wc-brief__head', {}, [nameEl, metaEl]),
    el('div.wc-brief', {}, [
      el('div.wc-brief__col', {}, [
        panel('Situation', 'FLT-OPS', [
          textEl,
          el('div.wc-rule', { style: { margin: '.7em 0 .45em' } }),
          el('div', {
            text: 'COURSE',
            style: { fontSize: '.68em', letterSpacing: '.3em', color: 'var(--wc-cyan-dim)', marginBottom: '.2em' },
          }),
          courseEl,
          el('div', { style: { flex: '1' } }),
        ], { grow: true, style: { flex: '1 1 auto' } }),
        panel('Threat Assessment', null, [threatEl, threatNote, contactsEl]),
        panel('Flight Assignment', null, [wingEl]),
      ]),
      el('div.wc-brief__col', {}, [
        panel('Nav Plot', 'PLAN VIEW', [
          el('div.wc-navmap', { style: { flex: '1', minHeight: '0' } }, [navCanvas]),
          navNote,
        ], { grow: true, style: { flex: '1 1 auto' } }),
        panel('Mission Objectives', null, [objEl]),
      ]),
    ]),
    bottomBar([['ENTER', 'LAUNCH'], ['SPACE', 'SKIP TEXT'], ['← →', 'NAV POINT'], ['ESC', 'ABORT']]),
  );

  function paintThreat() {
    const t = mission.threat;
    clear(threatEl).append(el('div', { class: `wc-threat wc-threat--${t.level}` }, [
      el('span', { text: t.level }),
      el('span.wc-threat__bar', {}, [
        el('i.wc-threat__fill', { style: { right: `${(1 - t.rating) * 100}%` } }),
      ]),
      el('span', { text: `${Math.round(t.rating * 100)}%`, style: { fontFamily: 'var(--wc-f-mono)', letterSpacing: '.06em' } }),
    ]));
    threatNote.textContent = t.text || THREAT_TEXT[t.level] || '';
    clear(contactsEl);
    for (const c of t.contacts.slice(0, 5)) {
      contactsEl.append(el('li', {}, [
        el('span.wc-lead', { text: c.count > 0 ? `×${c.count}` : '—' }),
        el('span', { text: c.label }),
      ]));
    }
  }

  function paintWing() {
    clear(wingEl);
    if (!mission.wingmen.length) {
      wingEl.append(el('div', {
        text: 'FLYING ALONE — NO WING ASSIGNED',
        style: { fontFamily: 'var(--wc-f-mono)', fontSize: '.78em', color: 'var(--wc-dim)', letterSpacing: '.08em' },
      }));
      return;
    }
    for (const wm of mission.wingmen.slice(0, 4)) {
      const pip = el('canvas');
      wingEl.append(el('div.wc-wing', {}, [
        el('div.wc-wing__pip', {}, [pip]),
        el('div', {}, [
          el('div.wc-wing__name', { text: wm.callsign }),
          el('div.wc-wing__sub', { text: [wm.name, wm.ship].filter(Boolean).join(' · ') || 'CONFED FIGHTER' }),
          wm.bio ? el('div.wc-wing__sub', { text: wm.bio, style: { opacity: '.75' } }) : null,
        ]),
        el('span.wc-wing__slot', { text: wm.slot }),
      ]));
      // Painted next frame: the pip has no laid-out size until it is in the DOM.
      requestAnimationFrame(() => paintPortraitTo(pip, wm.callsign, wm.faction));
    }
  }

  /**
   * The written course. The plot shows the shape; this gives the numbers, and
   * it is what a pilot actually copies onto a kneeboard: leg, distance, and
   * whether anything is expected to be sitting there.
   */
  function paintCourse() {
    clear(courseEl);
    const pts = mission.navPoints;
    pts.forEach((p, i) => {
      const prev = pts[i - 1];
      const leg = prev ? fmtDistance(Math.hypot(p.x - prev.x, p.y - prev.y)) : '—';
      courseEl.append(el('li', {}, [
        el('span.wc-lead', { text: String(i + 1).padStart(2, '0') }),
        el('span', { text: p.name, style: { flex: '1' } }),
        el('span', {
          text: leg,
          style: { fontFamily: 'var(--wc-f-mono)', fontSize: '.86em', color: 'var(--wc-cyan-dim)' },
        }),
        el('span', {
          text: p.hostile ? 'THREAT' : p.kind === 'base' ? 'HOME' : 'CLEAR',
          style: {
            fontFamily: 'var(--wc-f-mono)', fontSize: '.74em', letterSpacing: '.12em',
            minWidth: '5em', textAlign: 'right',
            color: p.hostile ? 'var(--wc-red)' : p.kind === 'base' ? 'var(--wc-green)' : 'var(--wc-dim)',
          },
        }),
      ]));
    });
  }

  function paintObjectives() {
    clear(objEl);
    for (const o of mission.objectives) {
      objEl.append(el('div', { class: `wc-obj wc-obj--${o.type} is-${o.status}` }, [
        el('span.wc-obj__mark', { text: o.type === 'primary' ? '◆' : '◇' }),
        el('span.wc-obj__text', { text: o.detail ? `${o.text} — ${o.detail}` : o.text }),
        el('span.wc-obj__tag', { text: o.type }),
      ]));
    }
  }

  function paintNavNote() {
    const pts = mission.navPoints;
    const p = pts[navIndex];
    if (!p) { navNote.textContent = ''; return; }
    const prev = pts[navIndex - 1];
    const legTxt = prev ? ` · LEG ${fmtDistance(Math.hypot(p.x - prev.x, p.y - prev.y))}` : '';
    navNote.textContent = `${String(navIndex + 1).padStart(2, '0')} ${p.name.toUpperCase()}${legTxt}\n`
      + (p.note || (p.hostile ? 'Hostile contact expected at this point.'
        : p.kind === 'base' ? 'Friendly. Docking and rearm available.'
          : 'No contact reported. Sweep and proceed.'));
  }

  function stepNav(d) {
    const n = mission?.navPoints?.length ?? 0;
    if (!n) return;
    navIndex = (navIndex + d + n) % n;
    navMap.setSelected(navIndex);
    paintNavNote();
    ui.sfx('ui.beep');
  }

  return {
    root: shell.root,
    name: 'briefing',
    musicState: 'tension',
    mount(m) {
      mission = m;
      navIndex = 0;
      shell.backdrop.setPalette(mission.palette);
      navMap.setMission(mission);
      navMap.setSelected(0);

      nameEl.textContent = mission.codename
        ? `${mission.title.toUpperCase()} — OPERATION ${mission.codename.toUpperCase()}`
        : mission.title.toUpperCase();
      const meta = [
        ['MISSION', roman(mission.number)],
        ['TYPE', mission.type ? mission.type.toUpperCase() : ''],
        ['SECTOR', mission.sector ? mission.sector.toUpperCase() : ''],
        ['SYSTEM', mission.system ? mission.system.toUpperCase() : ''],
        ['CARRIER', mission.carrier ? mission.carrier.toUpperCase() : ''],
        ['STARDATE', mission.stardate ?? ''],
      ];
      clear(metaEl);
      // Filter before appending: `Node.append(null)` inserts the *string*
      // "null", which is how `SYSTEM null` reached a capture.
      for (const [k, v] of meta) {
        if (!v) continue;
        metaEl.append(el('span', {}, [`${k} `, el('b', { text: v })]));
      }

      paintThreat();
      paintCourse();
      paintWing();
      paintObjectives();
      paintNavNote();
      typer.start(mission.summary);
      shell.show();
    },
    unmount() { shell.hide(); },
    update(dt) {
      shell.update(dt);
      typer.update(dt);
      navMap.draw(dt);
    },
    handleKey(e) {
      switch (e.code) {
        case 'Space':
          // First press dumps the rest of the text; a second launches, which is
          // how an impatient pilot expects a briefing to behave.
          if (typer.finish()) { ui.sfx('ui.mfd'); return true; }
          ui.sfx('ui.select');
          ui.launchMission();
          return true;
        case 'Enter': case 'NumpadEnter':
          typer.finish();
          ui.sfx('ui.select');
          ui.launchMission();
          return true;
        case 'ArrowLeft': stepNav(-1); return true;
        case 'ArrowRight': stepNav(1); return true;
        case 'Escape': case 'Backspace':
          ui.sfx('ui.deny');
          ui.abortBriefing();
          return true;
        default: return false;
      }
    },
    resize() { shell.resize(); },
    dispose() { shell.dispose(); },
  };
}
