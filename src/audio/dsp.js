/**
 * dsp.js — the primitive layer every synth voice in the game is built from.
 *
 * Nothing here touches the game: give it an AudioContext (live or Offline) and it
 * hands back buffers, curves and envelope helpers. That separation is what lets
 * `selftest.js` render every sound through an OfflineAudioContext and measure it.
 *
 * Hard rules honoured here:
 *  - no external assets: every buffer is synthesised from a seeded RNG
 *  - no Math.random(): `makeRng` from core/Rand only
 *  - everything is cached: buffers are memoised per-AudioContext
 */
import { makeRng } from '../core/Rand.js';

export const TAU = Math.PI * 2;

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function dbToGain(db) { return Math.pow(10, db / 20); }
/** MIDI note -> Hz. The music director works in semitones, this converts. */
export function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }
/** Frequency ratio -> cents, for doppler detune. */
export function ratioToCents(r) { return 1200 * Math.log2(clamp(r, 0.03125, 32)); }

/** Shared fallback RNG so a synth called without one is still deterministic. */
export const defaultRng = makeRng(0x5eed17);

// ---------------------------------------------------------------- buffer cache
// Keyed by AudioContext so the live context and each OfflineAudioContext in the
// self-test keep their own (an AudioBuffer cannot cross contexts).
const BUFFER_CACHE = new WeakMap();

function cached(ctx, key, make) {
  let m = BUFFER_CACHE.get(ctx);
  if (!m) BUFFER_CACHE.set(ctx, (m = new Map()));
  let v = m.get(key);
  if (v === undefined) { v = make(); m.set(key, v); }
  return v;
}

/**
 * Noise buffer. 'white' is flat, 'pink' is -3 dB/oct (Paul Kellet's economy
 * filter), 'brown' is -6 dB/oct — pink reads as air/hiss, brown as rocket
 * exhaust and rumble.
 */
export function noiseBuffer(ctx, color = 'white', seconds = 2.5, seed = 1) {
  return cached(ctx, `noise/${color}/${seconds}/${seed}`, () => {
    const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    const rng = makeRng(seed);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    let peak = 1e-6;
    for (let i = 0; i < n; i++) {
      const w = rng() * 2 - 1;
      let v;
      if (color === 'pink') {
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        v = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
        b6 = w * 0.115926;
      } else if (color === 'brown') {
        last = (last + 0.02 * w) / 1.02;
        v = last * 3.5;
      } else {
        v = w;
      }
      d[i] = v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    // Normalise so every colour arrives at the synths at the same working level.
    const g = 0.95 / peak;
    for (let i = 0; i < n; i++) d[i] *= g;
    // Cross-fade the loop seam (4 ms) so looped noise has no periodic tick.
    const fade = Math.min(Math.floor(ctx.sampleRate * 0.004), n >> 2);
    for (let i = 0; i < fade; i++) {
      const k = i / fade;
      d[i] = d[i] * k + d[n - fade + i] * (1 - k);
    }
    return buf;
  });
}

/**
 * Reverb impulse: a decaying noise cloud with a sparse early-reflection pattern
 * and progressive HF damping. Used as a send for explosions, hull groans and the
 * music bus so big events have a tail instead of stopping dead.
 */
export function impulseResponse(ctx, { seconds = 2.4, decay = 3.0, seed = 7, damp = 0.42 } = {}) {
  return cached(ctx, `ir/${seconds}/${decay}/${seed}/${damp}`, () => {
    const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    const rng = makeRng(seed);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const env = Math.pow(1 - t, decay);
        const w = (rng() * 2 - 1) * env;
        // One-pole lowpass whose coefficient tightens over time = HF damping.
        const a = clamp(damp + t * 0.5, 0.05, 0.95);
        lp = lp * a + w * (1 - a);
        d[i] = lp;
      }
      // Early reflections: a handful of discrete taps in the first 90 ms.
      for (let k = 0; k < 9; k++) {
        const idx = Math.floor(rng() * ctx.sampleRate * 0.09) + 16;
        if (idx < n) d[idx] += (rng() * 2 - 1) * 0.55 * (1 - k / 9);
      }
    }
    return buf;
  });
}

/**
 * Waveshaper curves. 'hard' is the classic arctan-ish drive (gun crunch),
 * 'soft' is tanh saturation (explosion body glue), 'fold' wave-folds for the
 * particle cannon's electric buzz.
 */
export function shaperCurve(ctx, kind = 'soft', amount = 0.6, n = 2048) {
  return cached(ctx, `curve/${kind}/${amount}/${n}`, () => {
    const c = new Float32Array(n);
    const k = amount * 100;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      if (kind === 'hard') c[i] = ((3 + k) * x * 0.3183) / (Math.PI + k * Math.abs(x));
      else if (kind === 'fold') c[i] = Math.sin(x * (1 + amount * 5) * Math.PI * 0.5);
      else c[i] = Math.tanh(x * (1 + amount * 6)) / Math.tanh(1 + amount * 6);
    }
    return c;
  });
}

// ------------------------------------------------------------------ node sugar

export function gain(ctx, v = 1) { const g = ctx.createGain(); g.gain.value = v; return g; }

export function filter(ctx, type, freq, Q = 1, gainDb = 0) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = clamp(freq, 10, ctx.sampleRate * 0.49);
  f.Q.value = Q;
  if (gainDb) f.gain.value = gainDb;
  return f;
}

export function osc(ctx, type, freq, detune = 0) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = clamp(freq, 0.01, ctx.sampleRate * 0.49);
  if (detune) o.detune.value = detune;
  return o;
}

export function shaper(ctx, kind = 'soft', amount = 0.6) {
  const w = ctx.createWaveShaper();
  w.curve = shaperCurve(ctx, kind, amount);
  w.oversample = '2x';
  return w;
}

export function noise(ctx, { color = 'white', loop = true, rate = 1, seed = 1, seconds = 2.5 } = {}) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer(ctx, color, seconds, seed);
  s.loop = loop;
  if (rate !== 1) s.playbackRate.value = rate;
  return s;
}

/** Connect a chain of nodes left to right, returning the last one. */
export function chain(...nodes) {
  const list = nodes.filter(Boolean);
  for (let i = 0; i < list.length - 1; i++) list[i].connect(list[i + 1]);
  return list[list.length - 1];
}

/**
 * Ring modulator: `carrier` amplitude-multiplied by `modOsc`. Web Audio has no
 * multiply node, but a GainNode with its gain driven by an oscillator is exactly
 * that (the gain's own value stays at 0 so the modulation is bipolar).
 */
export function ringMod(ctx, modOsc, depth = 1) {
  const g = ctx.createGain();
  g.gain.value = 0;
  const d = gain(ctx, depth);
  modOsc.connect(d).connect(g.gain);
  return g;
}

// -------------------------------------------------------------- envelope sugar

/**
 * Schedule a breakpoint envelope. `pts` are [offsetSeconds, value] pairs relative
 * to `t0`; `mode` picks linear or exponential segments (exponential never reaches
 * zero, so values are floored).
 */
export function ramp(param, t0, pts, mode = 'lin') {
  const EPS = 1e-4;
  for (let i = 0; i < pts.length; i++) {
    const t = t0 + pts[i][0];
    const v = pts[i][1];
    if (i === 0) param.setValueAtTime(mode === 'exp' ? Math.max(EPS, v) : v, t);
    else if (mode === 'exp') param.exponentialRampToValueAtTime(Math.max(EPS, v), t);
    else param.linearRampToValueAtTime(v, t);
  }
  return param;
}

/**
 * Percussive envelope: silence -> peak over `attack` -> exponential fall to
 * nothing at `dur`. The workhorse for guns, impacts and explosion layers.
 */
export function hit(param, t0, peak = 1, attack = 0.004, dur = 0.3, floor = 1e-4) {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(floor, t0);
  param.linearRampToValueAtTime(peak, t0 + attack);
  param.exponentialRampToValueAtTime(floor, t0 + Math.max(attack + 0.01, dur));
  param.setValueAtTime(0, t0 + Math.max(attack + 0.01, dur) + 0.001);
  return param;
}

/** Sustained envelope with an explicit release, for loops and pads. */
export function adsr(param, t0, { a = 0.02, d = 0.1, s = 0.7, peak = 1 } = {}) {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(1e-4, t0);
  param.linearRampToValueAtTime(peak, t0 + a);
  param.exponentialRampToValueAtTime(Math.max(1e-4, peak * s), t0 + a + d);
  return param;
}

export function release(param, t, seconds = 0.12) {
  const v = Math.max(1e-4, safeValue(param));
  param.cancelScheduledValues(t);
  param.setValueAtTime(v, t);
  param.exponentialRampToValueAtTime(1e-4, t + seconds);
  param.setValueAtTime(0, t + seconds + 0.001);
}

function safeValue(param) {
  const v = param.value;
  return Number.isFinite(v) ? v : 0;
}

/**
 * A burst train: N short spikes scattered across a window on one gain param.
 * Explosion debris crackle and hull-tearing use this — one node chain, many
 * automation points, instead of N buffer sources.
 */
export function crackle(param, t0, { count = 16, window: win = 0.8, peak = 0.6, decay = 0.03, rng = defaultRng, bias = 1.6 } = {}) {
  param.setValueAtTime(1e-4, t0);
  let last = t0;
  const times = [];
  for (let i = 0; i < count; i++) {
    // Bias grains toward the start so the crackle thins out as it decays.
    times.push(Math.pow(rng(), bias) * win);
  }
  times.sort((a, b) => a - b);
  for (let i = 0; i < count; i++) {
    const t = t0 + times[i];
    if (t <= last + 0.002) continue;
    const amp = peak * (0.35 + 0.65 * rng()) * (1 - times[i] / (win * 1.15));
    if (amp <= 0.001) continue;
    param.setValueAtTime(1e-4, t);
    param.linearRampToValueAtTime(amp, t + 0.0015);
    const dk = decay * (0.5 + rng());
    param.exponentialRampToValueAtTime(1e-4, t + 0.0015 + dk);
    last = t + 0.0015 + dk;
  }
  param.setValueAtTime(0, Math.max(last, t0 + win) + 0.002);
}

/** Start every source in a list at `t`, and stop them at `t + dur`. */
export function startAll(sources, t, stopAt) {
  for (const s of sources) {
    try { s.start(t); } catch { /* already started */ }
    if (stopAt != null && s.stop) { try { s.stop(stopAt); } catch { /* noop */ } }
  }
}

/** Random detune in cents from a seeded rng — the anti-machine-gun helper. */
export function jitter(rng, cents = 60) { return (rng() * 2 - 1) * cents; }
