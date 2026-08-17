/**
 * Music.js — the adaptive score.
 *
 * Wing Commander's soundtrack re-orchestrated itself as a fight developed, and
 * this does the same thing the way modern adaptive scores do it: *vertical
 * remixing*. There is one composition — one tempo grid, one harmonic
 * progression, one bar counter — and five stems layered on top of it:
 *
 *   calm     sustained brass pad, slow root bass, sparse bell figure
 *   tension  8th-note ostinato, low pulse, timpani on the downbeat
 *   combat   driving bass, brass stabs, snare/hat kit, tremolo high strings
 *   victory  ascending fanfare over a Picardy-third resolution
 *   defeat   detuned low strings and a slow toll, tempo dragged down
 *
 * Threat level crossfades calm -> tension -> combat continuously; victory and
 * defeat are explicit states that take over the progression. Because every stem
 * shares the bar grid and the chord of the moment, any mix of them is
 * consonant — a crossfade mid-phrase never clashes.
 *
 * Harmony: D aeolian. i–VII–VI–V (Dm–C–Bb–A) under combat is the oldest heroic
 * trick in the book and it works. Melodic material is fixed patterns with
 * seeded ornamentation, never random notes — it has to sound composed.
 */
import { makeRng } from '../core/Rand.js';
import { osc, gain, filter, noise, chain, hit, ramp, startAll, clamp, mtof, lerp } from './dsp.js';

const ROOT = 38;                            // D2

const CH = {
  Dm: [0, [0, 3, 7]], Bb: [8, [0, 4, 7]], F: [3, [0, 4, 7]], C: [10, [0, 4, 7]],
  Gm: [5, [0, 3, 7]], A: [7, [0, 4, 7]], Am: [7, [0, 3, 7]], D: [0, [0, 4, 7]],
  G: [5, [0, 4, 7]], Bbm: [8, [0, 3, 7]], Dsus: [0, [0, 5, 7]],
};

const PROGRESSIONS = {
  calm: ['Dm', 'Bb', 'F', 'C'],
  tension: ['Dm', 'Dm', 'Bb', 'A'],
  combat: ['Dm', 'C', 'Bb', 'A'],
  victory: ['Bb', 'F', 'C', 'D'],
  defeat: ['Dm', 'Bbm', 'Gm', 'Dm'],
};

const TEMPO = { calm: 74, tension: 96, combat: 138, victory: 108, defeat: 58 };

const STEMS = ['calm', 'tension', 'combat', 'victory', 'defeat'];

/** Chord tones as MIDI notes in a given octave band. */
function voicing(chordName, octave, count = 3) {
  const [root, ivs] = CH[chordName] ?? CH.Dm;
  const out = [];
  for (let i = 0; i < count; i++) {
    const iv = ivs[i % ivs.length] + 12 * Math.floor(i / ivs.length);
    out.push(ROOT + root + iv + 12 * octave);
  }
  return out;
}

function scaleNote(degree, chordName) {
  // D aeolian, with the leading tone raised when the chord is the dominant.
  const base = [0, 2, 3, 5, 7, 8, 10];
  const raised = (CH[chordName] ?? CH.Dm)[0] === 7 && (CH[chordName] ?? CH.Dm)[1][1] === 4;
  const oct = Math.floor(degree / 7);
  let s = base[((degree % 7) + 7) % 7];
  if (raised && s === 10) s = 11;
  return ROOT + s + oct * 12;
}

export function createMusicDirector(ctx, { out, send = null, seed = 20461 } = {}) {
  const rng = makeRng(seed);

  // ---- stem buses ----------------------------------------------------------
  const stems = {};
  for (const s of STEMS) {
    const g = gain(ctx, 0);
    g.connect(out);
    if (send) {
      const sg = gain(ctx, s === 'combat' ? 0.1 : 0.22);
      g.connect(sg).connect(send);
    }
    stems[s] = g;
  }

  const state = {
    mode: 'auto',            // 'auto' | one of STEMS
    threat: 0,
    tempo: TEMPO.calm,
    bar: 0,
    nextBarTime: 0,
    running: false,
    mix: { calm: 0, tension: 0, combat: 0, victory: 0, defeat: 0 },
    dominant: 'calm',
    lastTransition: -99,
  };

  const LOOKAHEAD = 1.35;

  // ------------------------------------------------------------- instruments
  const dying = [];
  function track(nodes, endTime) { dying.push({ nodes, endTime }); }

  /** Warm brass-ish pad: three detuned saws under a slow filter swell. */
  function pad(t, midi, dur, level, dest) {
    const g = gain(ctx, 0);
    const lp = filter(ctx, 'lowpass', 400, 1.1);
    ramp(lp.frequency, t, [[0, 300], [dur * 0.45, 1500], [dur, 620]], 'exp');
    chain(g, lp, dest);
    ramp(g.gain, t, [[0, 1e-4], [dur * 0.3, level], [dur * 0.75, level * 0.8], [dur, 1e-4]], 'exp');
    const f = mtof(midi);
    const src = [];
    for (const dt of [-7, 0, 6]) {
      const o = osc(ctx, 'sawtooth', f, dt);
      const og = gain(ctx, 0.3);
      chain(o, og, g);
      src.push(o);
    }
    // A quiet fifth above adds the horn-section stack without another note.
    const o5 = osc(ctx, 'triangle', f * 1.4983, 4);
    const o5g = gain(ctx, 0.12);
    chain(o5, o5g, g);
    src.push(o5);
    startAll(src, t, t + dur + 0.2);
    track(src, t + dur + 0.3);
  }

  /** Brass stab: fast attack, filter snap, short body. */
  function brass(t, midi, dur, level, dest) {
    const g = gain(ctx, 0);
    const lp = filter(ctx, 'lowpass', 500, 1.6);
    ramp(lp.frequency, t, [[0, 700], [0.05, 3200], [dur, 800]], 'exp');
    chain(g, lp, dest);
    ramp(g.gain, t, [[0, 1e-4], [0.022, level], [dur * 0.6, level * 0.55], [dur, 1e-4]], 'exp');
    const f = mtof(midi);
    const src = [];
    for (const dt of [-5, 4]) {
      const o = osc(ctx, 'sawtooth', f, dt);
      const og = gain(ctx, 0.34);
      chain(o, og, g);
      src.push(o);
    }
    const sq = osc(ctx, 'square', f * 0.5, 2);
    const sqg = gain(ctx, 0.16);
    chain(sq, sqg, g);
    src.push(sq);
    startAll(src, t, t + dur + 0.15);
    track(src, t + dur + 0.2);
  }

  /** Bass: sine weight plus a saw edge through a fixed lowpass. */
  function bass(t, midi, dur, level, dest) {
    const g = gain(ctx, 0);
    const lp = filter(ctx, 'lowpass', 380, 2.2);
    ramp(lp.frequency, t, [[0, 900], [dur * 0.5, 260]], 'exp');
    chain(g, lp, dest);
    ramp(g.gain, t, [[0, 1e-4], [0.012, level], [dur * 0.8, level * 0.4], [dur, 1e-4]], 'exp');
    const f = mtof(midi);
    const a = osc(ctx, 'sine', f);
    const ag = gain(ctx, 0.7);
    chain(a, ag, g);
    const b = osc(ctx, 'sawtooth', f, 6);
    const bg = gain(ctx, 0.22);
    chain(b, bg, g);
    startAll([a, b], t, t + dur + 0.1);
    track([a, b], t + dur + 0.15);
  }

  /** Plucked ostinato voice for the tension arpeggio. */
  function pluck(t, midi, dur, level, dest) {
    const g = gain(ctx, 0);
    const lp = filter(ctx, 'lowpass', 1200, 6);
    ramp(lp.frequency, t, [[0, 2600], [dur, 500]], 'exp');
    chain(g, lp, dest);
    hit(g.gain, t, level, 0.006, dur);
    const f = mtof(midi);
    const o = osc(ctx, 'triangle', f);
    const o2 = osc(ctx, 'square', f, 7);
    const o2g = gain(ctx, 0.22);
    o.connect(g);
    chain(o2, o2g, g);
    startAll([o, o2], t, t + dur + 0.08);
    track([o, o2], t + dur + 0.12);
  }

  /** Timpani: pitch-dropping sine with a felt-mallet noise transient. */
  function timpani(t, midi, level, dest, decay = 1.2) {
    const g = gain(ctx, 0);
    chain(g, dest);
    hit(g.gain, t, level, 0.004, decay);
    const f = mtof(midi);
    const o = osc(ctx, 'sine', f * 1.7);
    ramp(o.frequency, t, [[0, f * 1.7], [0.09, f], [decay, f * 0.94]], 'exp');
    o.connect(g);
    const nz = noise(ctx, { color: 'brown', seed: 307 });
    const lp = filter(ctx, 'lowpass', 380, 1.4);
    const ng = gain(ctx, 0);
    hit(ng.gain, t, level * 0.5, 0.002, 0.09);
    chain(nz, lp, ng, g);
    startAll([o, nz], t, t + decay + 0.1);
    track([o, nz], t + decay + 0.15);
  }

  /** Snare-ish military hit for the combat kit. */
  function snare(t, level, dest) {
    const g = gain(ctx, 0);
    hit(g.gain, t, level, 0.001, 0.16);
    const hp = filter(ctx, 'highpass', 1400, 0.8);
    chain(g, hp, dest);
    const nz = noise(ctx, { color: 'white', seed: 311 });
    nz.connect(g);
    const tone = osc(ctx, 'triangle', 220);
    const tg = gain(ctx, 0);
    hit(tg.gain, t, level * 0.35, 0.001, 0.07);
    chain(tone, tg, g);
    startAll([nz, tone], t, t + 0.24);
    track([nz, tone], t + 0.3);
  }

  function hat(t, level, dest) {
    const g = gain(ctx, 0);
    hit(g.gain, t, level, 0.0008, 0.045);
    const hp = filter(ctx, 'highpass', 6500, 0.8);
    chain(g, hp, dest);
    const nz = noise(ctx, { color: 'white', seed: 313 });
    nz.connect(g);
    startAll([nz], t, t + 0.09);
    track([nz], t + 0.12);
  }

  /** Bowed strings: slow attack, vibrato, for tension pads and defeat. */
  function strings(t, midi, dur, level, dest, detuneCents = 9) {
    const g = gain(ctx, 0);
    const lp = filter(ctx, 'lowpass', 1400, 0.9);
    chain(g, lp, dest);
    ramp(g.gain, t, [[0, 1e-4], [dur * 0.35, level], [dur * 0.8, level * 0.75], [dur, 1e-4]], 'exp');
    const f = mtof(midi);
    const src = [];
    for (const dt of [-detuneCents, detuneCents]) {
      const o = osc(ctx, 'sawtooth', f, dt);
      const og = gain(ctx, 0.28);
      chain(o, og, g);
      src.push(o);
    }
    const vib = osc(ctx, 'sine', 4.6);
    const vg = gain(ctx, 5);
    vib.connect(vg);
    for (const o of src) vg.connect(o.detune);
    src.push(vib);
    startAll(src, t, t + dur + 0.2);
    track(src, t + dur + 0.25);
  }

  /** Inharmonic bell / toll. */
  function bell(t, midi, level, dest, decay = 3.2) {
    const g = gain(ctx, 1);
    chain(g, dest);
    const f = mtof(midi);
    const src = [];
    const parts = [[1, 1], [2.01, 0.5], [2.98, 0.28], [4.21, 0.16], [5.44, 0.08]];
    for (const [m, a] of parts) {
      const fr = f * m;
      if (fr > ctx.sampleRate * 0.45) continue;
      const o = osc(ctx, 'sine', fr);
      const og = gain(ctx, 0);
      hit(og.gain, t, level * a, 0.004, decay * (1 - 0.12 * m / 5));
      chain(o, og, g);
      src.push(o);
    }
    startAll(src, t, t + decay + 0.2);
    track(src, t + decay + 0.25);
  }

  /** Noise riser used when the mix flips into combat. */
  function riser(t, dur, level, dest) {
    const g = gain(ctx, 0);
    ramp(g.gain, t, [[0, 1e-4], [dur * 0.9, level], [dur, 1e-4]], 'exp');
    const bp = filter(ctx, 'bandpass', 400, 2.2);
    ramp(bp.frequency, t, [[0, 400], [dur, 5200]], 'exp');
    chain(g, bp, dest);
    const nz = noise(ctx, { color: 'white', seed: 317 });
    nz.connect(g);
    startAll([nz], t, t + dur + 0.1);
    track([nz], t + dur + 0.15);
  }

  // --------------------------------------------------------------- arrangement
  const ARP_PATTERNS = [
    [0, 1, 2, 1, 0, 1, 2, 1],
    [0, 2, 1, 2, 0, 2, 1, 3],
    [0, 1, 2, 3, 2, 1, 0, 1],
  ];
  const STAB_PATTERNS = [
    [0, 1.5, 2.5],
    [0, 0.75, 2, 3],
    [0, 2, 3.5],
    [0, 1, 2, 3],
  ];
  const FANFARE = [
    [0, 0.75, 4], [0.75, 0.25, 6], [1.0, 1.0, 7], [2.0, 0.5, 9], [2.5, 0.5, 7], [3.0, 1.0, 11],
  ];

  function scheduleBar(t, barIndex) {
    const beat = 60 / state.tempo;
    const barDur = beat * 4;
    const prog = PROGRESSIONS[state.dominant] ?? PROGRESSIONS.calm;
    const chordName = prog[barIndex % prog.length];
    const m = state.mix;
    const cyclePos = barIndex % 4;

    // ---- calm: pad + slow bass + occasional bell ---------------------------
    if (m.calm > 0.02) {
      const notes = voicing(chordName, 2, 3);
      for (let i = 0; i < notes.length; i++) pad(t, notes[i] + 12, barDur * 0.98, 0.09, stems.calm);
      bass(t, voicing(chordName, 0, 1)[0], barDur * 0.9, 0.24, stems.calm);
      if (cyclePos === 1 || cyclePos === 3) {
        const n = voicing(chordName, 3, 3)[rng.int(0, 2)];
        bell(t + beat * 2, n + 12, 0.06, stems.calm, 2.6);
      }
    }

    // ---- tension: ostinato + pulse + timpani -------------------------------
    if (m.tension > 0.02) {
      const tones = voicing(chordName, 3, 4);
      const pat = ARP_PATTERNS[(barIndex >> 2) % ARP_PATTERNS.length];
      for (let i = 0; i < 8; i++) {
        const n = tones[pat[i] % tones.length];
        const accent = i % 4 === 0 ? 1 : 0.62;
        pluck(t + i * beat * 0.5, n, beat * 0.45, 0.085 * accent, stems.tension);
      }
      const rootN = voicing(chordName, 0, 1)[0];
      bass(t, rootN, beat * 1.7, 0.22, stems.tension);
      bass(t + beat * 2, rootN, beat * 1.7, 0.18, stems.tension);
      timpani(t, rootN - 12 + 12, 0.3, stems.tension, 1.1);
      strings(t, voicing(chordName, 3, 2)[1] + 12, barDur, 0.05, stems.tension, 12);
    }

    // ---- combat: kit + driving bass + stabs + high strings -----------------
    if (m.combat > 0.02) {
      const rootN = voicing(chordName, 0, 1)[0];
      for (let i = 0; i < 8; i++) {
        const skip = i === 5 && (barIndex % 2 === 1);
        if (skip) continue;
        bass(t + i * beat * 0.5, rootN + (i === 7 ? 7 : 0), beat * 0.44, 0.2, stems.combat);
      }
      const stab = STAB_PATTERNS[rng.int(0, STAB_PATTERNS.length - 1)];
      const chord = voicing(chordName, 2, 3);
      for (const off of stab) {
        for (let i = 0; i < chord.length; i++) {
          brass(t + off * beat, chord[i] + 12, beat * 0.5, 0.075, stems.combat);
        }
      }
      timpani(t, rootN, 0.36, stems.combat, 0.9);
      if (cyclePos % 2 === 1) timpani(t + beat * 2.5, rootN + 7, 0.24, stems.combat, 0.7);
      snare(t + beat, 0.16, stems.combat);
      snare(t + beat * 3, 0.16, stems.combat);
      if (cyclePos === 3) { snare(t + beat * 3.5, 0.12, stems.combat); snare(t + beat * 3.75, 0.14, stems.combat); }
      for (let i = 0; i < 8; i++) hat(t + i * beat * 0.5, i % 2 === 0 ? 0.05 : 0.03, stems.combat);
      // Tremolo top line — a held chord tone stabbed in 16ths.
      const top = voicing(chordName, 4, 3)[2];
      for (let i = 0; i < 16; i++) pluck(t + i * beat * 0.25, top, beat * 0.22, 0.022, stems.combat);
    }

    // ---- victory: fanfare over the progression ----------------------------
    if (m.victory > 0.02) {
      const rootN = voicing(chordName, 0, 1)[0];
      bass(t, rootN, beat * 1.9, 0.24, stems.victory);
      bass(t + beat * 2, rootN + 7, beat * 1.9, 0.2, stems.victory);
      const chord = voicing(chordName, 2, 3);
      for (const n of chord) pad(t, n + 12, barDur * 0.98, 0.07, stems.victory);
      for (const [off, len, deg] of FANFARE) {
        brass(t + off * beat, scaleNote(deg, chordName) + 24, len * beat * 0.95, 0.1, stems.victory);
      }
      timpani(t, rootN, 0.4, stems.victory, 1.1);
      timpani(t + beat * 3, rootN + 7, 0.3, stems.victory, 0.8);
      if (cyclePos === 3) for (let i = 0; i < 4; i++) timpani(t + beat * 3 + i * beat * 0.25, rootN, 0.18, stems.victory, 0.4);
    }

    // ---- defeat: low strings and a toll -----------------------------------
    if (m.defeat > 0.02) {
      const chord = voicing(chordName, 1, 3);
      for (const n of chord) strings(t, n, barDur * 1.1, 0.075, stems.defeat, 16);
      bass(t, voicing(chordName, 0, 1)[0] - 12, barDur, 0.2, stems.defeat);
      if (cyclePos % 2 === 0) bell(t, voicing(chordName, 2, 1)[0], 0.09, stems.defeat, 4.2);
      // A slow descending line over the four-bar phrase.
      const deg = [7, 6, 5, 4][cyclePos];
      strings(t + beat * 2, scaleNote(deg, chordName) + 12, beat * 2, 0.05, stems.defeat, 20);
    }
  }

  function recomputeMix(now) {
    const m = state.mix;
    let target;
    if (state.mode !== 'auto' && STEMS.includes(state.mode)) {
      target = { calm: 0, tension: 0, combat: 0, victory: 0, defeat: 0 };
      target[state.mode] = 1;
      // Victory/defeat keep a whisper of pad underneath so they are not bare.
      if (state.mode === 'victory' || state.mode === 'defeat') target.calm = 0.12;
    } else {
      const th = clamp(state.threat, 0, 1);
      target = {
        calm: clamp(1 - th / 0.42, 0, 1),
        tension: clamp(1 - Math.abs(th - 0.42) / 0.4, 0, 1),
        combat: clamp((th - 0.44) / 0.28, 0, 1),
        victory: 0,
        defeat: 0,
      };
    }
    const wasCombat = m.combat;
    for (const s of STEMS) {
      m[s] = target[s];
      stems[s].gain.setTargetAtTime(target[s], now, 1.1);
    }
    // Pick the dominant stem for the progression + tempo.
    let best = 'calm', bestV = -1;
    for (const s of STEMS) if (m[s] > bestV) { bestV = m[s]; best = s; }
    state.dominant = best;

    // A riser when the mix tips into combat, so the change lands on purpose.
    if (m.combat > 0.35 && wasCombat <= 0.35 && now - state.lastTransition > 6) {
      state.lastTransition = now;
      riser(now, 1.1, 0.16, stems.combat);
    }
  }

  function reap(now) {
    for (let i = dying.length - 1; i >= 0; i--) {
      if (dying[i].endTime < now - 0.2) {
        for (const n of dying[i].nodes) { try { n.disconnect(); } catch { /* noop */ } }
        dying.splice(i, 1);
      }
    }
  }

  return {
    stems,
    get state() { return state; },

    start(when = ctx.currentTime) {
      if (state.running) return;
      state.running = true;
      state.nextBarTime = when + 0.12;
      state.bar = 0;
      recomputeMix(when);
    },

    /** Explicit state: 'auto' | 'calm' | 'tension' | 'combat' | 'victory' | 'defeat'. */
    setState(mode) {
      state.mode = mode ?? 'auto';
      if (ctx) recomputeMix(ctx.currentTime);
    },

    setThreat(v) { state.threat = clamp(v, 0, 1); },

    update(dt, now) {
      if (!state.running) return;
      recomputeMix(now);

      // Tempo eases toward the dominant stem's tempo at bar boundaries only, so
      // the grid never stutters mid-bar.
      const targetTempo = TEMPO[state.dominant] ?? TEMPO.calm;

      // Resync if the context was suspended (tab hidden) and time jumped.
      if (state.nextBarTime < now - 1.0) state.nextBarTime = now + 0.05;

      let guard = 0;
      while (state.nextBarTime < now + LOOKAHEAD && guard++ < 4) {
        state.tempo += (targetTempo - state.tempo) * 0.4;
        scheduleBar(state.nextBarTime, state.bar);
        state.nextBarTime += (60 / state.tempo) * 4;
        state.bar++;
      }
      reap(now);
    },

    stop(when = ctx.currentTime) {
      state.running = false;
      for (const s of STEMS) {
        stems[s].gain.cancelScheduledValues(when);
        stems[s].gain.setTargetAtTime(0, when, 0.4);
      }
    },

    dispose() {
      state.running = false;
      for (const d of dying) for (const n of d.nodes) { try { n.stop?.(); } catch { /* noop */ } try { n.disconnect(); } catch { /* noop */ } }
      dying.length = 0;
      for (const s of STEMS) { try { stems[s].disconnect(); } catch { /* noop */ } }
    },
  };
}

export const MUSIC_STEMS = STEMS;
