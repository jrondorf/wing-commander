/**
 * src/ui/UISystem.js — the DOM overlay. Priority 950, last in the frame.
 *
 * Owns two very different things, and keeps them apart on purpose:
 *
 *   **Screens** (main menu, briefing, debrief, options, credits) take the whole
 *   viewport, take the keyboard, and are driven by this module's *own* rAF loop.
 *   They have to be: `main.js` awaits `showMainMenu()` *before* `game.start()`,
 *   so at menu time the engine is not running and nothing is calling `update`.
 *
 *   **Flight overlays** (comms subtitles, objective tracker, wingman command
 *   menu) are driven by the engine's `update(dt)` so they freeze with the sim
 *   when it pauses, and they live at the edges of frame. The cockpit HUD
 *   (src/cockpit/) owns the centre and the instrument margins; this layer must
 *   not compete with it, so in flight it draws only those three things.
 *
 * `#ui-root` is `pointer-events: none` (index.html). Only panels that need a
 * pointer opt back in — otherwise a full-screen div silently eats every click
 * meant for the canvas.
 *
 * ## Keyboard
 * One capture-phase listener on `window`, ahead of `core/Input`'s bubble-phase
 * listener. When the UI consumes a key it calls `stopPropagation()`, so the sim
 * never sees the digit that picked a comms order. While a screen is up the UI
 * swallows everything except the browser's own function keys.
 *
 * ## Diagnostics
 * `?ui=<list>` forces a screen up without playing the game, which is how these
 * screens get captured: `?ui=briefing`, `?ui=menu`, `?ui=debrief`, `?ui=options`,
 * `?ui=credits`, `?ui=demo` (flight overlays with sample traffic), `?ui=cmd`
 * (flight overlays with the wingman menu open).
 */
import { el, clear } from './dom.js';
import { injectStyle } from './theme.js';
import { createMainMenu } from './screens/MainMenu.js';
import { createBriefing } from './screens/Briefing.js';
import { createDebrief } from './screens/Debrief.js';
import { createOptions } from './screens/Options.js';
import { createCredits } from './screens/Credits.js';
import { createComms } from './hud/Comms.js';
import { createObjectives } from './hud/Objectives.js';
import { createCommandMenu } from './hud/CommandMenu.js';
import { normalizeMission, normalizeResult, normObjective, attachWingmanRoster } from './missiondata.js';

const OPTIONS_KEY = 'wc.options.v1';
const RECORD_KEY = 'wc.record.v1';

const DEFAULT_OPTIONS = {
  quality: 'high',
  vol: { master: 8, music: 6, sfx: 9, engine: 8, voice: 10 },
  invertY: false,
  mouseFlight: false,
  subtitles: true,
};

const DEFAULT_RECORD = {
  name: 'Lt. Casey', rank: 'Lieutenant', squadron: 'Black Widows',
  missions: 0, kills: 0,
};

/** Keys the browser keeps regardless of what the UI is doing. */
const PASSTHROUGH = /^F\d{1,2}$/;

export function createUISystem(engine, rootEl) {
  const host = rootEl ?? document.getElementById('ui-root') ?? document.body;
  const style = injectStyle(host);

  const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  const debug = new Set(String(params.get('ui') ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const seed = Number(params.get('seed') ?? 1337) || 1337;

  const root = el('div.wc-root');
  const screenLayer = el('div.wc-layer.wc-layer--screen');
  const flightLayer = el('div.wc-layer.wc-layer--flight');
  const toastLayer = el('div.wc-toasts');
  root.append(screenLayer, flightLayer, toastLayer);
  host.appendChild(root);

  // ---------------------------------------------------------------- state ----
  const options = loadJSON(OPTIONS_KEY, DEFAULT_OPTIONS);
  options.vol = { ...DEFAULT_OPTIONS.vol, ...(options.vol ?? {}) };
  const record = loadJSON(RECORD_KEY, DEFAULT_RECORD);

  /** Running tally, so a debrief has real numbers even if `mission` omits them. */
  const tally = blankTally();

  let _api = null;
  let visible = true;
  let disposed = false;
  const stack = [];
  const screens = {};
  let rafId = null;
  let lastNow = 0;
  let currentMission = null;
  let launchResolve = null;
  let briefResolve = null;
  let debriefResolve = null;
  let debriefShown = false;
  let missionClock = 0;
  let missionRunning = false;
  let pendingPromotion = null;
  /** Filled by a guarded dynamic import; absent if `src/mission/` is not built. */
  let missionMod = null;

  // ------------------------------------------------------------- flight UI ---
  const comms = createComms(engine, api());
  const objectives = createObjectives();
  const cmdMenu = createCommandMenu(engine, api());
  flightLayer.append(comms.root, objectives.root, cmdMenu.root);

  const pauseEl = el('div', {
    style: {
      position: 'absolute', inset: '0', display: 'none', placeItems: 'center',
      background: 'rgba(2,5,8,0.42)', letterSpacing: '.5em', textTransform: 'uppercase',
      color: 'var(--wc-cyan)', fontSize: 'clamp(18px, 3vw, 46px)',
      textShadow: '0 0 .5em rgba(127,228,255,.5)',
    },
  }, [el('div', { text: 'Paused' })]);
  flightLayer.append(pauseEl);

  // ------------------------------------------------------------ event wiring -
  const unsubs = [];
  const on = (type, fn) => { const off = engine?.events?.on?.(type, fn); if (off) unsubs.push(off); };

  on('comms:message', (p) => comms.push(p));

  /**
   * `mission/objectives.js` rides the *whole* board along on every emission
   * (its header calls that out explicitly), so the tracker repaints from the
   * list and then flashes the one row that actually changed. A payload without
   * the list — anything else emitting this event — still works as a single
   * update.
   */
  on('objective:update', (p) => {
    if (!p) return;
    const list = Array.isArray(p) ? p : Array.isArray(p.objectives) ? p.objectives : null;
    if (list) {
      objectives.setAll(list.map(normObjective).filter(Boolean));
      if (p.id) objectives.flash(String(p.id));
      return;
    }
    const o = normObjective(p.objective ?? p, 0);
    if (o) objectives.update(o);
  });

  // Mission lifecycle is advisory — `src/mission/` may or may not emit these.
  on('mission:start', (p) => {
    resetTally();
    missionRunning = true;
    missionClock = 0;
    debriefShown = false;
    const m = p?.mission ?? p;
    if (m && typeof m === 'object') {
      currentMission = normalizeMission(m, { seed });
      objectives.setAll(currentMission.objectives);
    }
  });
  on('campaign:promotion', (p) => { pendingPromotion = p ?? null; });

  /**
   * `mission:complete` / `mission:failed` carry `{ mission, result, debrief }`.
   * `debrief` is the CO's lines, authored per mission in `mission/missions.js`;
   * they belong in the debrief screen's remark, not only on the radio.
   */
  const endMission = (outcome) => (p) => {
    missionRunning = false;
    if (debriefShown) return;
    const r = { ...(p?.result ?? p ?? {}) };
    if (!r.outcome && outcome) r.outcome = outcome;
    if (r.outcome === 'complete') r.outcome = 'success';
    if (r.outcome === 'failed') r.outcome = 'failure';
    if (!r.remark && Array.isArray(p?.debrief) && p.debrief.length) r.remark = p.debrief.join(' ');
    if (Array.isArray(r.losses)) r.wingmenLost = r.losses.length;
    if (Number.isFinite(r.playerKills)) r.kills = r.playerKills;
    if (pendingPromotion) {
      r.promotion = pendingPromotion.to ?? pendingPromotion.rank?.name ?? '';
      pendingPromotion = null;
    }
    if (!r.medal && r.perfect) r.medal = 'Flight Cross';
    api().showDebrief(r);
  };
  on('mission:complete', endMission('success'));
  on('mission:failed', endMission('failure'));
  on('mission:end', endMission(null));

  // ---- tally: read-only observation of combat events -------------------------
  const isPlayer = (s) => !!s && (s === engine?.game?.player || s.isPlayer === true);
  const shipOf = (p, keys) => { for (const k of keys) if (p?.[k]) return p[k]; return null; };

  on('weapon:fired', (p) => {
    const src = shipOf(p, ['ship', 'shooter', 'owner', 'source', 'from']);
    if (!isPlayer(src)) return;
    if (p?.kind === 'missile' || p?.type === 'missile') tally.missiles++;
    else tally.shotsFired += Math.max(1, Number(p?.count) || 1);
  });
  on('missile:launched', (p) => { if (isPlayer(shipOf(p, ['ship', 'shooter', 'owner', 'source']))) tally.missiles++; });
  on('weapon:hit', (p) => {
    const src = shipOf(p, ['shooter', 'owner', 'source', 'attacker', 'from']);
    const victim = shipOf(p, ['target', 'ship', 'victim', 'hit']);
    if (isPlayer(src)) tally.shotsHit++;
    if (isPlayer(victim)) tally.hullTaken = Math.min(1, tally.hullTaken + (Number(p?.damage) || 0) / 400);
  });
  on('ship:destroyed', (p) => {
    const victim = shipOf(p, ['ship', 'victim', 'target']);
    const killer = shipOf(p, ['killer', 'attacker', 'source', 'by']);
    if (isPlayer(killer) && victim && !isPlayer(victim)) {
      tally.kills++;
      tally.killList.push(String(victim.classId ?? victim.name ?? 'contact'));
    }
    if (victim && !isPlayer(victim) && victim.faction && engine?.game?.player?.faction
      && victim.faction === engine.game.player.faction) tally.wingmenLost++;
  });

  // ------------------------------------------------------------- keyboard ----
  function onKeyCapture(e) {
    if (disposed || !visible) return;
    const top = stack[stack.length - 1];
    if (top) {
      if (PASSTHROUGH.test(e.code) || e.metaKey || e.ctrlKey) return;
      top.handleKey?.(e);
      // Everything is swallowed while a screen owns the viewport: a stray
      // afterburner keypress behind the briefing is not a feature.
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (cmdMenu.isOpen && cmdMenu.handleKey(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
  window.addEventListener('keydown', onKeyCapture, true);

  // ------------------------------------------------------------ input patch --
  /**
   * Invert-Y has to be applied between `Input.beginFrame()` (which runs at the
   * top of `Engine.step`) and `flight` (priority 200) reading the axes, so it
   * cannot live in this system at 950. Registering a tiny system of our own at
   * 150 is the contract-clean way to get that slot without editing `core/`.
   */
  const inputPatch = {
    name: 'ui:input',
    priority: 150,
    update() {
      if (options.invertY && engine?.input?.axes) engine.input.axes.pitch *= -1;
    },
  };
  engine?.registerSystem?.(inputPatch);

  // ---------------------------------------------------------------- screens --
  function screen(name) {
    if (screens[name]) return screens[name];
    const ctx = { engine, ui: api() };
    const made = name === 'menu' ? createMainMenu(ctx)
      : name === 'briefing' ? createBriefing(ctx)
        : name === 'debrief' ? createDebrief(ctx)
          : name === 'options' ? createOptions(ctx)
            : name === 'credits' ? createCredits(ctx)
              : null;
    if (made) { screens[name] = made; screenLayer.appendChild(made.root); }
    return made;
  }

  function pushScreen(name, data) {
    const s = screen(name);
    if (!s) return null;
    const top = stack[stack.length - 1];
    if (top === s) { s._lastData = data; s.mount?.(data); return s; }
    if (top) { top.unmount?.(); top.root.style.display = 'none'; }
    stack.push(s);
    s._lastData = data;
    s.root.style.display = '';
    s.mount?.(data);
    syncLayers();
    startLoop();
    setMusic(s.musicState);
    return s;
  }

  function popScreen() {
    const s = stack.pop();
    if (s) { s.unmount?.(); s.root.style.display = 'none'; }
    const top = stack[stack.length - 1];
    if (top) { top.root.style.display = ''; top.mount?.(top._lastData); setMusic(top.musicState); }
    syncLayers();
    if (!stack.length) setMusic('auto');
    return top ?? null;
  }

  function popAll() {
    while (stack.length) {
      const s = stack.pop();
      s.unmount?.();
      s.root.style.display = 'none';
    }
    syncLayers();
  }

  function syncLayers() {
    const open = stack.length > 0;
    screenLayer.classList.toggle('is-open', open);
    // Flight overlays must not sit on top of a briefing.
    flightLayer.style.display = open ? 'none' : '';
    if (open) cmdMenu.close();
  }

  function setMusic(state) {
    if (!state) return;
    try { engine?.game?.audio?.setMusicState?.(state); } catch { /* audio may be silent */ }
  }

  // -------------------------------------------------------------- own loop ---
  function startLoop() {
    if (rafId != null) return;
    lastNow = performance.now();
    const tick = (now) => {
      rafId = requestAnimationFrame(tick);
      // A generous clamp: this loop drives typing and roll-ups, and a 0.1 s
      // cap turns a 6 fps software-rasterised frame into slow motion.
      const dt = Math.min(0.5, (now - lastNow) / 1000);
      lastNow = now;
      const top = stack[stack.length - 1];
      if (top) top.update?.(dt);
      else stopLoop();
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
  }

  // --------------------------------------------------------------- options ---
  function applyOptions() {
    try { engine?.post?.setQuality?.(options.quality); } catch { /* pipeline may be absent */ }
    const audio = engine?.game?.audio;
    if (audio?.setBus) {
      audio.setBus('master', options.vol.master / 10);
      audio.setBus('music', options.vol.music / 10);
      audio.setBus('sfx', options.vol.sfx / 10);
      audio.setBus('engine', options.vol.engine / 10);
      audio.setBus('voice', options.vol.voice / 10);
      audio.setBus('ui', options.vol.sfx / 10);
    }
    if (engine?.input) engine.input.mouseFlight = !!options.mouseFlight;
    comms.setEnabled(options.subtitles !== false);
  }

  function saveOptions() { saveJSON(OPTIONS_KEY, options); }
  function saveRecord() { saveJSON(RECORD_KEY, record); }

  // ---------------------------------------------------------------- toasts ---
  function toast(text, kind = '', seconds = 2.4) {
    const node = el('div', { class: `wc-toast${kind ? ` wc-toast--${kind}` : ''}`, text });
    toastLayer.appendChild(node);
    setTimeout(() => {
      node.classList.add('is-out');
      setTimeout(() => node.remove(), 320);
    }, seconds * 1000);
  }

  function sfx(id) {
    try { engine?.game?.audio?.play?.(id, { gain: 0.8 }); } catch { /* pre-unlock */ }
  }

  // ------------------------------------------------------------- mission -----
  /**
   * Choose and *load* the next mission, then read back its definition for the
   * briefing.
   *
   * `MissionSystem.load()` is deliberately separate from `start()`: load builds
   * the objective board, nav course and trigger graph but puts nothing in the
   * world, which is exactly the state a briefing wants to read. `start()` is
   * what spawns, and that waits for the player to accept.
   *
   * Everything is optional-chained: with `src/mission/` absent this falls back
   * to the placeholder briefing rather than failing.
   */
  function loadNextMission({ fresh = false } = {}) {
    const ms = engine?.game?.mission ?? null;
    if (!ms) return normalizeMission(null, { seed });
    let id = null;
    try {
      const order = ms.campaignOrder ?? [];
      id = fresh ? order[0] : (ms.campaign?.nextMission?.(order) ?? order[0]);
    } catch { id = null; }
    try {
      if (typeof ms.load === 'function') ms.load(id ?? undefined);
    } catch (err) {
      console.warn('[ui] mission load failed —', err?.message ?? err);
    }
    let def = null;
    try { def = ms.definition ?? null; } catch { def = null; }
    return normalizeMission(def, { seed });
  }

  /** Read-only: whatever the mission system currently has loaded. */
  function resolveMission() {
    const ms = engine?.game?.mission ?? null;
    let def = null;
    try { def = ms?.definition ?? null; } catch { def = null; }
    if (!def) return loadNextMission({ fresh: false });
    return normalizeMission(def, { seed });
  }

  /** Service record for the main menu, from the campaign save when there is one. */
  function serviceRecord() {
    const c = engine?.game?.mission?.campaign ?? null;
    if (!c?.summary) return record;
    try {
      const s2 = c.summary();
      return {
        name: record.name,
        rank: s2.rank ?? record.rank,
        squadron: record.squadron,
        missions: s2.missionsFlown ?? 0,
        kills: s2.kills ?? 0,
        medals: s2.medals ?? [],
      };
    } catch { return record; }
  }

  function blankTally() {
    return { kills: 0, killList: [], shotsFired: 0, shotsHit: 0, missiles: 0, missileHits: 0, hullTaken: 0, wingmenLost: 0, time: 0 };
  }
  function resetTally() { Object.assign(tally, blankTally()); tally.killList = []; }

  // ------------------------------------------------------------------ API ----
  function api() {
    if (_api) return _api;
    _api = {
      name: 'ui',
      priority: 950,
      seed,
      options,
      get record() { return serviceRecord(); },

      // ---- required system interface ---------------------------------------
      update(dt, eng) {
        if (disposed) return;
        if (stack.length) return; // screens run on their own loop
        const input = (eng ?? engine)?.input;
        if (input?.pressed?.('commsMenu')) cmdMenu.toggle();
        if (input?.pressed?.('pause')) {
          const e2 = eng ?? engine;
          e2.paused = !e2.paused;
          pauseEl.style.display = e2.paused ? 'grid' : 'none';
          sfx(e2.paused ? 'ui.mfd' : 'ui.select');
        }
        cmdMenu.update();
        comms.update(dt);
        if (missionRunning) { missionClock += dt; tally.time = missionClock; }
        if (debug.size) demoTick(dt);
      },

      resize(w, h) {
        for (const s of Object.values(screens)) s.resize?.(w, h);
      },

      dispose() {
        if (disposed) return;
        disposed = true;
        stopLoop();
        window.removeEventListener('keydown', onKeyCapture, true);
        for (const off of unsubs) { try { off(); } catch { /* already gone */ } }
        unsubs.length = 0;
        engine?.removeSystem?.(inputPatch);
        for (const s of Object.values(screens)) s.dispose?.();
        clear(root);
        root.remove();
        style?.remove();
      },

      // ---- screens ----------------------------------------------------------
      /**
       * Resolves when the player leaves the menu for the cockpit. `main.js`
       * awaits this before `game.start()`, so the engine loop only spins up
       * once there is something to fly.
       */
      showMainMenu() {
        applyOptions();
        pushScreen('menu');
        forceDebugScreen();
        return new Promise((res) => { launchResolve = res; });
      },

      showBriefing(mission) {
        currentMission = normalizeMission(mission, { seed });
        objectives.setAll(currentMission.objectives);
        pushScreen('briefing', currentMission);
        return new Promise((res) => { briefResolve = res; });
      },

      showDebrief(result) {
        debriefShown = true;
        missionRunning = false;
        const r = normalizeResult(result, tally, currentMission);
        record.missions += 1;
        record.kills += r.kills;
        saveRecord();
        pushScreen('debrief', r);
        return new Promise((res) => { debriefResolve = res; });
      },

      showComms(msg) { comms.push(msg); },

      setVisible(v) {
        visible = !!v;
        root.style.display = visible ? '' : 'none';
      },

      // ---- screen-to-system callbacks --------------------------------------
      startCampaign({ fresh = true } = {}) {
        if (fresh) {
          record.missions = 0; record.kills = 0; saveRecord();
          try { engine?.game?.mission?.campaign?.reset?.(); } catch { /* no save */ }
        }
        const m = loadNextMission({ fresh });
        currentMission = m;
        objectives.setAll(m.objectives);
        pushScreen('briefing', m);
      },

      launchMission() {
        popAll();
        stopLoop();
        resetTally();
        missionRunning = true;
        missionClock = 0;
        debriefShown = false;
        setMusic('auto');
        // The mission was loaded at briefing time; this is the go order.
        // `start()` is what puts hulls in the world, so it happens here and not
        // a moment earlier.
        try { engine?.game?.mission?.start?.(); } catch (err) { console.warn('[ui] mission start failed —', err?.message ?? err); }
        try {
          engine?.events?.emit?.('ui:launch', { mission: currentMission?.raw ?? null, id: currentMission?.id ?? null });
        } catch { /* bus is optional */ }
        briefResolve?.('launch'); briefResolve = null;
        launchResolve?.('launch'); launchResolve = null;
      },

      abortBriefing() {
        popAll();
        briefResolve?.('abort'); briefResolve = null;
        pushScreen('menu');
      },

      closeDebrief() {
        popAll();
        debriefResolve?.('continue'); debriefResolve = null;
        pushScreen('menu');
      },

      openOptions() { pushScreen('options'); },
      openCredits() { pushScreen('credits'); },
      popScreen,
      pushScreen,

      applyOptions,
      saveOptions,
      toast,
      sfx,

      // ---- handles other modules may want -----------------------------------
      get comms() { return comms; },
      get objectives() { return objectives; },
      get commandMenu() { return cmdMenu; },
      get mission() { return currentMission; },
      get tally() { return tally; },
      get screenOpen() { return stack.length > 0; },
    };
    return _api;
  }

  // ---------------------------------------------------------------- debug ----
  const DEMO_LINES = [
    { from: 'Maestro', text: 'Tally two, breaking high. Watch your six, Lead.', tone: 'calm', priority: 1, kind: 'engage' },
    { from: 'Spectre', text: "I'm hit! Shields are gone on my port side!", tone: 'pain', priority: 2, kind: 'hit' },
    { from: 'Bloodmaw', text: 'Your hull sings as it opens.', tone: 'grim', priority: 0, kind: 'tauntAlien', faction: 'alien' },
    { from: 'Midway', text: 'All wings, be advised: capital contact bearing 034 mark 12.', tone: 'calm', priority: 2, kind: 'broadcast' },
    { from: 'Maestro', text: 'Get him off me! I cannot shake this thing!', tone: 'panic', priority: 3, kind: 'help' },
  ];
  let demoIdx = 0;
  let demoTimer = 0;
  let demoReady = false;

  function demoTick(dt) {
    if (!debug.has('demo') && !debug.has('cmd')) return;
    if (!demoReady) {
      demoReady = true;
      objectives.setAll([
        { id: 'a', text: 'Destroy the alien strike group', type: 'primary', status: 'active' },
        { id: 'b', text: 'Protect the transport Kellogg', type: 'primary', status: 'pending' },
        { id: 'c', text: 'Return to TCS Midway', type: 'primary', status: 'pending' },
        { id: 'd', text: 'No wingmen lost', type: 'secondary', status: 'complete' },
      ]);
      if (debug.has('cmd')) cmdMenu.toggle();
    }
    demoTimer -= dt;
    if (!comms.busy && demoTimer <= 0) {
      comms.push(DEMO_LINES[demoIdx % DEMO_LINES.length]);
      demoIdx++;
      demoTimer = 0.2;
    }
  }

  // The squadron roster lives in `src/mission/`, which may not be built. A
  // dynamic import keeps this subsystem loadable either way; briefings just
  // show raw wingman keys until it resolves.
  import('../mission/wingmen.js')
    .then((m) => attachWingmanRoster(m.resolveWingman))
    .catch(() => { /* no roster; normalizeMission degrades */ });

  applyOptions();

  /**
   * Forced screens for capture (`?ui=briefing` and friends).
   *
   * This has to run *after* `main.js` calls `showMainMenu()`, or the menu lands
   * on top of the screen we were asked to look at. So it is invoked from
   * `showMainMenu` itself, with a timer as the fallback for capture runs where
   * `main.js` never gets that far (`?shot=` returns early).
   */
  let forcedDone = false;
  function forceDebugScreen() {
    if (forcedDone || !debug.size) return;
    forcedDone = true;
    if (debug.has('briefing')) { const m = loadNextMission({ fresh: true }); currentMission = m; pushScreen('briefing', m); }
    else if (debug.has('debrief')) {
      api().showDebrief({
        outcome: 'success', kills: 6, shotsFired: 412, shotsHit: 121, missiles: 4,
        time: 604, wingmenLost: 0, medal: 'Gold Star', promotion: 'Captain',
        objectives: [
          { text: 'Destroy the alien strike group', type: 'primary', status: 'complete' },
          { text: 'Protect the transport Kellogg', type: 'primary', status: 'complete' },
          { text: 'Return to TCS Midway', type: 'primary', status: 'complete' },
          { text: 'No wingmen lost', type: 'secondary', status: 'failed' },
        ],
      });
    } else if (debug.has('options')) api().openOptions();
    else if (debug.has('credits')) api().openCredits();
    else if (debug.has('menu')) api().showMainMenu();
  }
  if (debug.size) setTimeout(forceDebugScreen, 2500);

  return api();
}

// ------------------------------------------------------------------ storage --

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { ...fallback };
    return { ...fallback, ...JSON.parse(raw) };
  } catch { return { ...fallback }; }
}

function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

export default createUISystem;
