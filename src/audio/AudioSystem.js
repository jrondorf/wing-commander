/**
 * AudioSystem.js — the audio system for the sim. Priority 900: it runs after the
 * camera rig (700) so the listener is placed from the *final* camera transform of
 * the frame, not last frame's.
 *
 * Everything you hear is synthesised at runtime. There are no audio files in this
 * project and there never will be — see ARCHITECTURE.md §1.1. The synthesis lives
 * in `synth/`, the graph and voice pool in `Mixer.js`, the score in `Music.js`;
 * this file is the game-facing layer: events in, voices out.
 *
 *   createAudioSystem(engine) => {
 *     name: 'audio', priority: 900,
 *     update(dt, engine), dispose(),
 *     play(id, opts), playAt(id, position, opts), stop(handle),
 *     setBus(name, gain), unlock(),
 *   }
 *
 * Headless safety: the AudioContext is created lazily on the first user gesture.
 * The capture harness never gestures and has no audio device, so nothing is ever
 * constructed there — every entry point degrades to a silent no-op handle instead
 * of throwing. That is a hard requirement, not a nicety.
 */
import { CATALOG, weaponSoundId } from './Catalog.js';
import { createMixer, readPosition, readVelocity, BUS_NAMES } from './Mixer.js';
import { createMusicDirector } from './Music.js';
import { engineClassFor } from './synth/engines.js';
import { VOICE_LINES } from './synth/voice.js';
import { gain, clamp, lerp } from './dsp.js';

/** Returned when audio is unavailable or the voice pool is full. Always safe. */
const SILENT = Object.freeze({
  id: null, silent: true, voice: null,
  stop() {}, set() {},
});

const MAX_ENGINE_VOICES = 8;
const MAX_ENGINE_DIST = 5000;
const AUDIBLE_RANGE = 12000;

export function createAudioSystem(engine, opts = {}) {
  // ---------------------------------------------------------------- internals
  let ctx = null;
  let mixer = null;
  let music = null;
  let available = null;              // null = not yet attempted
  let unlocked = false;
  let disposed = false;
  const warned = new Set();

  const busLevels = { music: 0.55, sfx: 1, engine: 0.8, ui: 0.75, voice: 0.9, ...(opts.buses ?? {}) };
  let masterLevel = opts.master ?? 0.85;

  const unsubs = [];
  const gestureEvents = ['pointerdown', 'mousedown', 'keydown', 'touchstart'];

  // Listener tracking (camera-driven, computed without importing three).
  const lis = {
    pos: [0, 0, 0], prev: [0, 0, 0], vel: [0, 0, 0],
    fwd: [0, 0, -1], up: [0, 1, 0], primed: false,
  };

  // Engine loops, one per audible ship.
  const engineVoices = new Map();

  // Ambience beds.
  const beds = { air: null, hum: null, servo: null };

  // Missile motors, keyed by whatever object the combat system handed us.
  const missileVoices = new Map();

  const lock = {
    active: false, locked: false, progress: 0, nextBeep: 0, tone: null, lostAt: 0,
  };
  const incoming = { active: false, until: 0, nextBlast: 0, announced: false };
  const alerts = {
    hull: 1, shields: 1, prevHull: 1, prevShields: 1,
    nextCaution: 0, nextKlaxon: 0, saidHull: false, saidShields: false,
  };

  const threat = { value: 0, impulse: 0, baseline: 0 };
  let musicOverride = null;          // { mode, until }
  let duckUntil = 0;

  const stats = { voices: 0, engines: 0, missiles: 0, state: 'uninitialised', threat: 0, music: 'calm' };

  // ------------------------------------------------------------------ context
  function ensureContext() {
    if (ctx || available === false || disposed) return !!ctx;
    const AC = (typeof globalThis !== 'undefined') && (globalThis.AudioContext || globalThis.webkitAudioContext);
    if (!AC) {
      available = false;
      note('no AudioContext in this environment — audio disabled');
      return false;
    }
    try {
      ctx = new AC({ latencyHint: 'interactive' });
      mixer = createMixer(ctx, { seed: opts.seed ?? 91177, maxVoices: opts.maxVoices ?? 30, masterGain: masterLevel });
      for (const n of BUS_NAMES) mixer.setBus(n, busLevels[n]);
      music = createMusicDirector(ctx, { out: mixer.buses.music, send: mixer.reverbSend, seed: opts.musicSeed ?? 20461 });
      available = true;
      stats.state = ctx.state;
      return true;
    } catch (err) {
      available = false;
      ctx = null; mixer = null; music = null;
      note(`AudioContext unavailable — running silent (${err?.message ?? err})`);
      return false;
    }
  }

  function note(msg) {
    if (warned.has(msg)) return;
    warned.add(msg);
    console.info(`[audio] ${msg}`);
  }

  /** True only when it is safe to schedule: a live, running context. */
  function ready() {
    return !!(ctx && mixer && ctx.state === 'running' && !disposed);
  }

  // ------------------------------------------------------------------- unlock
  function unlock() {
    if (disposed) return Promise.resolve(false);
    if (!ensureContext()) return Promise.resolve(false);
    const done = () => {
      stats.state = ctx.state;
      if (ctx.state !== 'running') return false;
      if (!unlocked) {
        unlocked = true;
        removeGestureHooks();
        music?.start(ctx.currentTime);
        startAmbience();
      }
      return true;
    };
    try {
      const p = ctx.resume?.();
      if (p && typeof p.then === 'function') return p.then(done, () => false);
      return Promise.resolve(done());
    } catch {
      return Promise.resolve(false);
    }
  }

  function onGesture() { unlock(); }

  function addGestureHooks() {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    for (const e of gestureEvents) window.addEventListener(e, onGesture, { passive: true });
  }
  function removeGestureHooks() {
    if (typeof window === 'undefined' || !window.removeEventListener) return;
    for (const e of gestureEvents) window.removeEventListener(e, onGesture);
  }

  // -------------------------------------------------------------------- play
  function spawn(id, o = {}) {
    if (!ready()) return SILENT;
    const e = CATALOG[id];
    if (!e) { note(`unknown sound id "${id}"`); return SILENT; }

    const pos = o.position ?? (o.follow ? readPosition(o.follow) : null);
    // Cull anything beyond the stylised audible range before allocating.
    if (pos && e.spatial) {
      const d = Math.hypot(pos[0] - lis.pos[0], pos[1] - lis.pos[1], pos[2] - lis.pos[2]);
      if (d > (o.range ?? AUDIBLE_RANGE)) return SILENT;
    }

    const voice = mixer.allocate({
      id, bus: e.bus, priority: o.priority ?? e.priority,
      spatial: e.spatial && !!pos, position: pos,
      level: e.level * (o.gain ?? 1), sustained: e.sustained,
      minInterval: o.minInterval ?? e.minInterval, maxInstances: o.maxInstances ?? e.maxInstances,
    });
    if (!voice) return SILENT;

    voice.follow = o.follow ?? null;
    const v = o.velocity ?? (o.follow ? readVelocity(o.follow) : null);
    if (v) { voice.vel[0] = v[0]; voice.vel[1] = v[1]; voice.vel[2] = v[2]; }

    const t = ctx.currentTime + 0.006;   // a hair of lead so automation lands cleanly
    let send = null;
    if (e.send > 0) {
      send = gain(ctx, e.send);
      send.connect(mixer.reverbSend);
      voice.chainNodes.push(send);
    }

    let node = null;
    try {
      node = e.synth(ctx, voice.input, t, { ...o, send }, mixer.rng);
    } catch (err) {
      console.warn(`[audio] synth "${id}" failed:`, err);
      mixer.stop(voice, ctx.currentTime);
      return SILENT;
    }
    mixer.bind(voice, node, t);

    return {
      id, voice, silent: false,
      get active() { return !voice.released; },
      set(params) { try { node?.set?.(params, ctx.currentTime); } catch { /* noop */ } },
      stop(when) { mixer.stop(voice, when ?? ctx.currentTime); },
    };
  }

  function play(id, o = {}) { return spawn(id, o); }
  function playAt(id, position, o = {}) {
    const p = Array.isArray(position) ? position : readPosition(position);
    return spawn(id, { ...o, position: p, follow: o.follow ?? (Array.isArray(position) ? null : position) });
  }
  function stop(handle, when) {
    if (!handle) return;
    if (handle.voice && mixer) mixer.stop(handle.voice, when);
    else handle.stop?.(when);
  }

  // ---------------------------------------------------------------- ambience
  function startAmbience() {
    if (!ready()) return;
    if (!beds.air) beds.air = orNull(play('cockpit.air', { gain: 1 }));
    if (!beds.hum) beds.hum = orNull(play('cockpit.hum', { gain: 1 }));
    if (!beds.servo) beds.servo = orNull(play('cockpit.servo', { gain: 0.55 }));
  }
  const orNull = (h) => (h && !h.silent ? h : null);

  function updateAmbience(dt) {
    if (!ready()) return;
    startAmbience();
    const player = engine?.game?.player ?? engine?.player ?? null;
    const c = player?.body?.controls ?? player?.controls ?? engine?.input?.axes ?? null;
    let load = 0;
    if (c) {
      load = clamp((Math.abs(c.pitch ?? 0) + Math.abs(c.yaw ?? 0) + Math.abs(c.roll ?? 0)) / 2.2, 0, 1);
    }
    // Damage makes the airframe complain more.
    load = clamp(load * (1 + (1 - alerts.hull) * 0.5), 0, 1);
    const inCockpit = (engine?.game?.viewMode ?? 'cockpit') === 'cockpit';
    beds.servo?.set({ load: inCockpit ? load : load * 0.35 });
  }

  // ------------------------------------------------------------ engine voices
  function updateEngineVoices(dt) {
    if (!ready()) return;
    const ships = engine?.game?.ships ?? engine?.ships ?? [];
    const candidates = [];
    for (const ship of ships) {
      if (!ship || ship.alive === false) continue;
      const p = readPosition(ship);
      if (!p) continue;
      const d = ship.isPlayer ? -1 : Math.hypot(p[0] - lis.pos[0], p[1] - lis.pos[1], p[2] - lis.pos[2]);
      if (d > MAX_ENGINE_DIST) continue;
      candidates.push({ ship, d, p });
    }
    candidates.sort((a, b) => a.d - b.d);
    const keep = candidates.slice(0, MAX_ENGINE_VOICES);
    const keepSet = new Set(keep.map((c) => c.ship));

    for (const [ship, rec] of engineVoices) {
      if (!keepSet.has(ship)) {
        rec.handle.stop();
        engineVoices.delete(ship);
      }
    }

    for (const { ship, p } of keep) {
      let rec = engineVoices.get(ship);
      if (!rec) {
        const cls = engineClassFor(ship.classId ?? ship.class ?? '', ship.faction ?? '');
        const maxSpeed = ship.stats?.maxSpeed ?? (cls === 'capital' ? 120 : 500);
        const h = ship.isPlayer
          // Your own engine is not a point in space — it is all around you.
          ? play('engine.loop', { shipClass: cls, gain: 0.8, maxSpeed })
          : playAt('engine.loop', p, { shipClass: cls, follow: ship, gain: cls === 'capital' ? 1.1 : 0.85, maxSpeed });
        if (h.silent) continue;
        rec = { handle: h, cls, ab: 0 };
        engineVoices.set(ship, rec);
      }
      const c = ship.body?.controls ?? ship.controls ?? {};
      const vel = readVelocity(ship);
      const speed = vel ? Math.hypot(vel[0], vel[1], vel[2]) : (ship.speed ?? 0);
      const ab = clamp(typeof c.afterburner === 'number' ? c.afterburner : (c.afterburner ? 1 : 0), 0, 1);
      rec.handle.set({ throttle: clamp(c.throttle ?? 0.4, 0, 1), speed, afterburner: ab });
      if (ab > 0.5 && rec.ab <= 0.5) {
        if (ship.isPlayer) play('engine.afterburner', { gain: 0.9 });
        else playAt('engine.afterburner', p, { follow: ship, gain: 0.6 });
      } else if (ab <= 0.5 && rec.ab > 0.5) {
        if (ship.isPlayer) play('engine.afterburnerCut', { gain: 0.7 });
      }
      rec.ab = ab;
    }
    stats.engines = engineVoices.size;
  }

  // ------------------------------------------------------------ missile lock
  function setLock(stateName, progress = 0) {
    if (stateName === 'locked') {
      lock.active = true; lock.locked = true; lock.progress = 1;
      if (!lock.tone) lock.tone = orNull(play('missile.lockTone', { gain: 0.6 }));
      lock.lostAt = 0;
    } else if (stateName === 'seeking' || stateName === 'tracking') {
      if (!lock.active) lock.nextBeep = 0;
      lock.active = true; lock.locked = false;
      lock.progress = clamp(progress, 0, 1);
      if (lock.tone) { lock.tone.stop(); lock.tone = null; }
    } else {
      lock.active = false; lock.locked = false; lock.progress = 0;
      if (lock.tone) { lock.tone.stop(); lock.tone = null; }
    }
  }

  function updateLock(dt, now) {
    if (!ready()) return;
    if (lock.active && !lock.locked) {
      // The beep accelerates as the seeker converges — the WC lock ramp.
      const period = lerp(0.45, 0.1, lock.progress);
      if (now >= lock.nextBeep) {
        lock.nextBeep = now + period;
        play('missile.lockSeek', { progress: lock.progress, gain: 0.8 });
      }
      lock.progress = clamp(lock.progress + dt * 0.16, 0, 1);
      if (lock.progress >= 1) setLock('locked');
    }
    // A steady lock tone forever is torture; hold it for a few seconds.
    if (lock.locked && lock.tone) {
      lock.lostAt += dt;
      if (lock.lostAt > 4) { lock.tone.stop(); lock.tone = null; }
    }

    if (incoming.active) {
      if (now > incoming.until) { incoming.active = false; incoming.announced = false; }
      else if (now >= incoming.nextBlast) {
        incoming.nextBlast = now + 1.7;
        play('missile.incoming', { cycles: 4, rate: 6.4, gain: 0.9 });
        if (!incoming.announced) {
          incoming.announced = true;
          speak('incoming missile');
        }
      }
    }
  }

  function warnIncoming(seconds = 6) {
    const now = ctx?.currentTime ?? 0;
    incoming.active = true;
    incoming.until = now + seconds;
    if (incoming.nextBlast < now) incoming.nextBlast = now;
    bumpThreat(0.4);
  }

  // ------------------------------------------------------------------ alerts
  function setDamage({ hull, shields } = {}) {
    if (typeof hull === 'number') alerts.hull = clamp(hull, 0, 1);
    if (typeof shields === 'number') alerts.shields = clamp(shields, 0, 1);
  }

  function pollPlayerDamage() {
    const p = engine?.game?.player ?? engine?.player;
    if (!p) return;
    const hull = p.hullFrac ?? p.armorFrac ?? p.health?.hullFrac ?? null;
    const sh = p.shieldFrac ?? p.health?.shieldFrac ?? null;
    if (typeof hull === 'number') alerts.hull = clamp(hull, 0, 1);
    if (typeof sh === 'number') alerts.shields = clamp(sh, 0, 1);
  }

  function updateAlerts(dt, now) {
    if (!ready()) return;
    pollPlayerDamage();
    const h = alerts.hull;

    if (h < 0.3) {
      if (now >= alerts.nextKlaxon) {
        alerts.nextKlaxon = now + 3.4;
        play('alert.klaxon', { urgency: 1, cycles: 2, gain: 0.85 });
        if (!alerts.saidHull) { alerts.saidHull = true; speak('hull breach'); }
      }
    } else if (h < 0.62) {
      alerts.saidHull = false;
      if (now >= alerts.nextCaution) {
        alerts.nextCaution = now + 7;
        play('alert.caution', { gain: 0.7 });
      }
    } else {
      alerts.saidHull = false;
    }

    if (alerts.shields <= 0.02 && alerts.prevShields > 0.02) speak('shields down');
    else if (alerts.shields < 0.25 && alerts.prevShields >= 0.25) speak('shields critical');
    alerts.prevShields = alerts.shields;
    alerts.prevHull = h;
  }

  /** Flight-computer line. Ducks the music under it. */
  function speak(line, o = {}) {
    if (!VOICE_LINES[line]) return SILENT;
    const h = play('voice.line', { line, ...o });
    if (!h.silent) duck(1.4);
    return h;
  }

  function duck(seconds) {
    if (!ready()) return;
    const now = ctx.currentTime;
    duckUntil = Math.max(duckUntil, now + seconds);
    mixer.buses.music.gain.setTargetAtTime(busLevels.music * 0.4, now, 0.12);
  }

  function updateDuck(now) {
    if (!ready() || duckUntil === 0) return;
    if (now > duckUntil) {
      duckUntil = 0;
      mixer.buses.music.gain.setTargetAtTime(busLevels.music, now, 0.5);
    }
  }

  // ------------------------------------------------------------------- threat
  function bumpThreat(v) { threat.impulse = clamp(threat.impulse + v, 0, 1.6); }

  function updateThreat(dt) {
    // Baseline from how many hostiles are near the player.
    const ships = engine?.game?.ships ?? engine?.ships ?? [];
    const player = engine?.game?.player ?? engine?.player ?? null;
    let hostiles = 0;
    if (player) {
      const pp = readPosition(player);
      for (const s of ships) {
        if (!s || s === player || s.alive === false) continue;
        if (s.faction && player.faction && s.faction === player.faction) continue;
        const sp = readPosition(s);
        if (!sp || !pp) continue;
        if (Math.hypot(sp[0] - pp[0], sp[1] - pp[1], sp[2] - pp[2]) < 4000) hostiles++;
      }
    }
    threat.baseline = clamp(hostiles / 5, 0, 0.8);
    threat.impulse = Math.max(0, threat.impulse - dt * 0.09);
    const target = clamp(threat.baseline + threat.impulse, 0, 1);
    // Rise fast, fall slow — the mix should never flicker between stems.
    const k = target > threat.value ? 1.8 : 0.22;
    threat.value = clamp(threat.value + (target - threat.value) * clamp(dt * k, 0, 1), 0, 1);
    stats.threat = +threat.value.toFixed(3);
    music?.setThreat(threat.value);
  }

  function setMusicState(mode, holdSeconds = 0) {
    if (!music) { musicOverride = holdSeconds > 0 ? { mode, until: holdSeconds } : null; return; }
    musicOverride = holdSeconds > 0 ? { mode, until: (ctx?.currentTime ?? 0) + holdSeconds } : null;
    music.setState(mode);
  }

  function updateMusic(dt, now) {
    if (!ready() || !music) return;
    if (musicOverride && now > musicOverride.until) {
      musicOverride = null;
      music.setState('auto');
    }
    music.update(dt, now);
    stats.music = music.state.dominant;
  }

  // ------------------------------------------------------------------- events
  function bindEvents() {
    const ev = engine?.events;
    if (!ev?.on) return;
    const on = (type, fn) => unsubs.push(ev.on(type, fn));

    on('weapon:fired', (p = {}) => {
      const id = weaponSoundId(p.weapon?.type ?? p.weapon?.id ?? p.type ?? p.weaponType ?? p.weapon ?? '');
      const from = p.position ?? p.origin ?? p.ship ?? p.shooter ?? null;
      const isPlayer = p.ship?.isPlayer || p.shooter?.isPlayer || p.byPlayer;
      const pos = readPosition(from);
      const o = {
        power: clamp(p.power ?? ((p.damage ?? 30) / 30), 0.4, 2.5),
        gain: isPlayer ? 1 : 0.75,
      };
      if (isPlayer || !pos) play(id, o);
      else {
        playAt(id, pos, { ...o, velocity: readVelocity(p.ship ?? p.shooter) });
        bumpThreat(0.03);
      }
    });

    on('weapon:hit', (p = {}) => {
      const pos = p.position ?? p.point ?? readPosition(p.target);
      const onPlayer = p.target?.isPlayer || p.victim?.isPlayer;
      const shieldHit = p.shield === true || p.shielded === true || (p.shieldDamage ?? 0) > 0;
      const id = shieldHit ? 'impact.shield' : (p.breach ? 'impact.hull' : 'impact.armor');
      const strength = clamp((p.damage ?? 25) / 25, 0.3, 2.5);
      if (onPlayer) {
        play(id, { strength, gain: 1 });
        if (!shieldHit) play('cockpit.creak', { gain: 0.5 });
        bumpThreat(0.16);
      } else if (pos) {
        playAt(id, pos, { strength, gain: 0.8, follow: p.target ?? null });
      }
    });

    on('shield:impact', (p = {}) => {
      const pos = p.position ?? p.point ?? readPosition(p.target ?? p.ship);
      const onPlayer = p.target?.isPlayer || p.ship?.isPlayer;
      const strength = clamp((p.strength ?? p.damage ?? 25) / 25, 0.3, 2.5);
      if (onPlayer) { play('impact.shield', { strength, gain: 1 }); bumpThreat(0.14); }
      else if (pos) playAt('impact.shield', pos, { strength, gain: 0.75, follow: p.target ?? p.ship ?? null });
    });

    on('ship:destroyed', (p = {}) => {
      const pos = p.position ?? readPosition(p.ship);
      const cls = engineClassFor(p.ship?.classId ?? '', p.ship?.faction ?? '');
      const size = p.scale ?? p.size ?? (cls === 'capital' ? 6 : cls === 'bomber' ? 1.8 : 1.2);
      const id = size >= 3 ? 'explosion.capital' : 'explosion';
      if (pos) playAt(id, pos, { size, gain: 1 });
      else play(id, { size, gain: 1 });

      const rec = p.ship ? engineVoices.get(p.ship) : null;
      if (rec) { rec.handle.stop(); engineVoices.delete(p.ship); }

      if (p.ship?.isPlayer) {
        setMusicState('defeat', 24);
      } else {
        bumpThreat(0.08);
        const player = engine?.game?.player ?? engine?.player;
        if (player && p.ship?.faction && player.faction && p.ship.faction !== player.faction) {
          if (mixer && mixer.rng() < 0.35) speak('enemy destroyed');
        }
      }
    });

    on('missile:launched', (p = {}) => {
      const src = p.missile ?? p.projectile ?? null;
      const pos = p.position ?? readPosition(src) ?? readPosition(p.ship);
      const fromPlayer = p.ship?.isPlayer || p.byPlayer;
      if (fromPlayer) play('missile.launch', { gain: 1 });
      else if (pos) playAt('missile.launch', pos, { gain: 0.8 });

      if (src && !missileVoices.has(src)) {
        const h = playAt('missile.thrust', readPosition(src) ?? pos ?? [0, 0, 0], { follow: src, gain: 0.7 });
        if (!h.silent) missileVoices.set(src, { handle: h, until: (ctx?.currentTime ?? 0) + 25 });
      }
      // A missile pointed at us is the single most threatening thing in the game.
      if (p.target?.isPlayer) warnIncoming(8);
    });

    on('missile:lock', (p = {}) => {
      if (p.target?.isPlayer || p.onPlayer) { warnIncoming(p.duration ?? 6); return; }
      const s = p.state ?? (p.locked ? 'locked' : p.lost ? 'lost' : 'seeking');
      setLock(s, p.progress ?? 0);
      if (s === 'locked') play('ui.lock', { gain: 0.7 });
    });

    on('explosion', (p = {}) => {
      const pos = p.position ?? p.point ?? null;
      const size = p.size ?? p.scale ?? 1;
      const id = size >= 3 ? 'explosion.capital' : 'explosion';
      if (pos) playAt(id, pos, { size, gain: 1 });
      else play(id, { size, gain: 0.9 });
    });

    on('collision', (p = {}) => {
      const pos = p.position ?? p.point ?? readPosition(p.ship ?? p.a);
      const force = clamp(p.force ?? p.impulse ?? 1, 0.2, 4);
      const onPlayer = p.ship?.isPlayer || p.a?.isPlayer || p.b?.isPlayer;
      if (onPlayer) { play('impact.collision', { force, gain: 1 }); play('cockpit.creak', { gain: 0.8 }); }
      else if (pos) playAt('impact.collision', pos, { force, gain: 0.8 });
    });

    on('comms:message', (p = {}) => {
      play('ui.squelchOpen', { gain: 0.7 });
      const line = p.voice ?? p.line ?? null;
      const delay = 0.22;
      if (line && VOICE_LINES[line]) {
        // Squelch first, voice a beat later — radio protocol, not a jump cut.
        schedule(delay, () => speak(line, { radio: true }));
        schedule(delay + 1.4, () => play('ui.squelchClose', { gain: 0.6 }));
      } else {
        schedule(0.35, () => play('ui.squelchClose', { gain: 0.6 }));
      }
      duck(1.6);
    });

    // Nice-to-haves other systems may or may not emit — all optional.
    on('debris:spawn', (p = {}) => {
      const pos = p.position ?? null;
      if (pos) playAt('impact.debris', pos, { gain: 0.5 });
    });
    on('missile:destroyed', (p = {}) => releaseMissile(p.missile ?? p.projectile));
    on('missile:expired', (p = {}) => releaseMissile(p.missile ?? p.projectile));
    on('ui:beep', (p = {}) => play(p.id ?? 'ui.beep', p));
    on('ui:mfd', () => play('ui.mfd'));
    on('target:changed', () => play('ui.targetCycle'));
  }

  function releaseMissile(m) {
    if (!m) return;
    const rec = missileVoices.get(m);
    if (rec) { rec.handle.stop(); missileVoices.delete(m); }
  }

  // Tiny scheduler so event handlers can sequence sounds without timers leaking.
  const pending = [];
  function schedule(delay, fn) { pending.push({ at: (ctx?.currentTime ?? 0) + delay, fn }); }
  function runPending(now) {
    for (let i = pending.length - 1; i >= 0; i--) {
      if (now >= pending[i].at) {
        const { fn } = pending[i];
        pending.splice(i, 1);
        try { fn(); } catch (err) { console.warn('[audio] scheduled action failed:', err); }
      }
    }
  }

  // ---------------------------------------------------------------- listener
  function updateListener(dt) {
    const cam = engine?.camera;
    if (!cam) return;
    cam.updateMatrixWorld?.(true);
    const e = cam.matrixWorld?.elements;
    let px, py, pz, fx, fy, fz, ux, uy, uz;
    if (e && e.length >= 16) {
      px = e[12]; py = e[13]; pz = e[14];
      fx = -e[8]; fy = -e[9]; fz = -e[10];
      ux = e[4]; uy = e[5]; uz = e[6];
    } else if (cam.position) {
      px = cam.position.x; py = cam.position.y; pz = cam.position.z;
      fx = 0; fy = 0; fz = -1; ux = 0; uy = 1; uz = 0;
    } else return;

    const fl = Math.hypot(fx, fy, fz) || 1;
    const ul = Math.hypot(ux, uy, uz) || 1;
    fx /= fl; fy /= fl; fz /= fl; ux /= ul; uy /= ul; uz /= ul;

    if (!lis.primed) {
      lis.prev[0] = px; lis.prev[1] = py; lis.prev[2] = pz;
      lis.primed = true;
    }
    if (dt > 1e-4) {
      // Smoothed finite difference — the camera rig can snap between modes and a
      // one-frame teleport must not blow the doppler up.
      const vx = clamp((px - lis.prev[0]) / dt, -4000, 4000);
      const vy = clamp((py - lis.prev[1]) / dt, -4000, 4000);
      const vz = clamp((pz - lis.prev[2]) / dt, -4000, 4000);
      const a = clamp(dt * 8, 0, 1);
      lis.vel[0] = lerp(lis.vel[0], vx, a);
      lis.vel[1] = lerp(lis.vel[1], vy, a);
      lis.vel[2] = lerp(lis.vel[2], vz, a);
    }
    lis.prev[0] = px; lis.prev[1] = py; lis.prev[2] = pz;
    lis.pos[0] = px; lis.pos[1] = py; lis.pos[2] = pz;
    lis.fwd[0] = fx; lis.fwd[1] = fy; lis.fwd[2] = fz;
    lis.up[0] = ux; lis.up[1] = uy; lis.up[2] = uz;
    if (ready()) mixer.setListener(lis.pos, lis.fwd, lis.up, lis.vel);
  }

  // ------------------------------------------------------------------ system
  const system = {
    name: 'audio',
    priority: 900,

    update(dt, eng) {
      if (disposed) return;
      if (eng) engine = eng;
      // Threat bookkeeping runs even with no context so the state other systems
      // read is always live (and so a silent build still exercises this code).
      updateThreat(dt);
      if (!ready()) {
        stats.state = ctx ? ctx.state : (available === false ? 'unavailable' : 'locked');
        return;
      }
      const now = ctx.currentTime;
      stats.state = ctx.state;

      updateListener(dt);
      runPending(now);
      updateEngineVoices(dt);
      updateAmbience(dt);
      updateLock(dt, now);
      updateAlerts(dt, now);
      updateDuck(now);

      // Missile motors time out if combat never tells us they died.
      for (const [m, rec] of missileVoices) {
        if (now > rec.until) { rec.handle.stop(); missileVoices.delete(m); }
      }

      mixer.update(dt, now);
      updateMusic(dt, now);

      stats.voices = mixer.activeCount;
      stats.missiles = missileVoices.size;
    },

    // ---- required API ------------------------------------------------------
    play, playAt, stop, unlock,

    setBus(name, value) {
      if (name === 'master') { masterLevel = value; mixer?.setMaster(value); return true; }
      if (!(name in busLevels)) return false;
      busLevels[name] = value;
      return mixer ? mixer.setBus(name, value) : true;
    },

    dispose() {
      disposed = true;
      removeGestureHooks();
      for (const off of unsubs) { try { off(); } catch { /* noop */ } }
      unsubs.length = 0;
      pending.length = 0;
      for (const [, rec] of engineVoices) rec.handle.stop();
      engineVoices.clear();
      for (const [, rec] of missileVoices) rec.handle.stop();
      missileVoices.clear();
      beds.air = beds.hum = beds.servo = null;
      music?.dispose();
      mixer?.dispose();
      if (ctx?.close) { try { ctx.close(); } catch { /* noop */ } }
      ctx = null; mixer = null; music = null;
    },

    // ---- extras other systems may use --------------------------------------
    get available() { return available !== false; },
    get unlocked() { return unlocked; },
    get context() { return ctx; },
    get mixer() { return mixer; },
    get music() { return music; },
    get stats() { return stats; },
    get listener() { return lis; },
    get threat() { return threat.value; },

    speak,
    setDamage,
    setLock,
    warnIncoming,
    setMusicState,
    setThreat(v) { threat.impulse = clamp(v, 0, 1); threat.value = clamp(v, 0, 1); music?.setThreat(threat.value); },
    getBus(name) { return busLevels[name] ?? 0; },
    /** Panic button for menus / pause. */
    stopAll() { mixer?.stopAll(); engineVoices.clear(); missileVoices.clear(); beds.air = beds.hum = beds.servo = null; },
  };

  bindEvents();
  addGestureHooks();
  return system;
}

export default createAudioSystem;
