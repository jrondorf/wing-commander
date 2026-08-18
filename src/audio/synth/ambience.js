/**
 * Cockpit ambience and alarms.
 *
 * Space is silent; a cockpit is not. The bed here is deliberately just below
 * conscious level — you notice it when it stops. The servo layer is the one the
 * player *feels*: it rises with control deflection, so hard manoeuvring makes
 * the airframe complain.
 */
import { osc, gain, filter, noise, shaper, chain, hit, ramp, crackle, startAll, clamp, lerp } from '../dsp.js';

/** Air handling: filtered pink noise with a slowly wandering cutoff. */
export function synthCockpitAir(ctx, out, t, opts = {}, rng) {
  const level = opts.gain ?? 0.09;
  const bus = gain(ctx, 0);
  ramp(bus.gain, t, [[0, 1e-4], [1.2, level]], 'exp');
  bus.connect(out);

  const nz = noise(ctx, { color: 'pink', seed: 211 });
  const lp = filter(ctx, 'lowpass', 620, 0.7);
  const hp = filter(ctx, 'highpass', 140, 0.6);
  chain(nz, hp, lp, bus);

  // Two very slow LFOs at incommensurate rates so the bed never audibly loops.
  const l1 = osc(ctx, 'sine', 0.063);
  const l1g = gain(ctx, 180);
  l1.connect(l1g).connect(lp.frequency);
  const l2 = osc(ctx, 'sine', 0.021);
  const l2g = gain(ctx, level * 0.35);
  l2.connect(l2g).connect(bus.gain);

  // Distant duct rattle.
  const dz = noise(ctx, { color: 'white', seed: 213 });
  const dbp = filter(ctx, 'bandpass', 1800, 3);
  const dg = gain(ctx, 0.012);
  chain(dz, dbp, dg, bus);

  const sources = [nz, l1, l2, dz];
  startAll(sources, t);
  return sustained(ctx, bus, sources, 0.8);
}

/** Electrical plant: mains-ish hum plus a faint switching whine. */
export function synthCockpitHum(ctx, out, t, opts = {}, rng) {
  const level = opts.gain ?? 0.11;
  const bus = gain(ctx, 0);
  ramp(bus.gain, t, [[0, 1e-4], [0.9, level]], 'exp');
  const lp = filter(ctx, 'lowpass', 900, 0.8);
  chain(bus, lp, out);

  const sources = [];
  const parts = [[51, 0.5, 'sine'], [102, 0.28, 'triangle'], [153, 0.1, 'sine'], [408, 0.05, 'sine']];
  for (const [f, g, type] of parts) {
    const o = osc(ctx, type, f, (rng() * 2 - 1) * 3);
    const og = gain(ctx, g);
    chain(o, og, bus);
    sources.push(o);
  }
  // Slow amplitude wander from the power plant loading up and down.
  const am = osc(ctx, 'sine', 0.14);
  const amg = gain(ctx, level * 0.3);
  am.connect(amg).connect(bus.gain);
  sources.push(am);

  // Avionics: a thin band of noise up top.
  const nz = noise(ctx, { color: 'white', seed: 217 });
  const bp = filter(ctx, 'bandpass', 2400, 6);
  const ng = gain(ctx, 0.02);
  chain(nz, bp, ng, bus);
  sources.push(nz);

  startAll(sources, t);
  return sustained(ctx, bus, sources, 0.5);
}

/**
 * Servo whine. Gain and pitch follow `load` (0..1 = control deflection), so the
 * airframe groans when you pull hard and settles when you fly straight.
 */
export function synthServo(ctx, out, t, opts = {}, rng) {
  const bus = gain(ctx, 1e-4);
  bus.connect(out);

  const o = osc(ctx, 'sawtooth', 260);
  const bp = filter(ctx, 'bandpass', 620, 7);
  const og = gain(ctx, 0.22);
  chain(o, bp, og, bus);

  const o2 = osc(ctx, 'sawtooth', 391);
  const og2 = gain(ctx, 0.09);
  chain(o2, bp, og2, bus);

  // Mechanical grain — a hydraulic actuator is not a pure tone.
  const nz = noise(ctx, { color: 'pink', seed: 223 });
  const nbp = filter(ctx, 'bandpass', 1400, 2.5);
  const ng = gain(ctx, 0.1);
  chain(nz, nbp, ng, bus);

  const sources = [o, o2, nz];
  startAll(sources, t);

  let cur = 0;
  return {
    duration: Infinity,
    sources,
    pitch: [o.detune, o2.detune],
    set(p, when = ctx.currentTime) {
      if (p.load == null) return;
      cur = clamp(p.load, 0, 1);
      const lvl = Math.pow(cur, 1.4) * (opts.gain ?? 0.5);
      bus.gain.setTargetAtTime(Math.max(1e-4, lvl), when, 0.08);
      const f = lerp(210, 520, cur);
      o.frequency.setTargetAtTime(f, when, 0.1);
      o2.frequency.setTargetAtTime(f * 1.503, when, 0.1);
      bp.frequency.setTargetAtTime(lerp(520, 1750, cur), when, 0.1);
      nbp.frequency.setTargetAtTime(lerp(900, 2600, cur), when, 0.1);
    },
    stop(when = ctx.currentTime) {
      const r = 0.2;
      bus.gain.cancelScheduledValues(when);
      bus.gain.setValueAtTime(Math.max(1e-4, bus.gain.value), when);
      bus.gain.exponentialRampToValueAtTime(1e-4, when + r);
      for (const s of sources) { try { s.stop(when + r + 0.05); } catch { /* noop */ } }
      return r + 0.1;
    },
  };
}

/** Airframe creak — plays when the hull takes stress or damage. */
export function synthCreak(ctx, out, t, opts = {}, rng) {
  const dur = 0.6 + rng() * 0.4;
  const bus = gain(ctx, 1);
  bus.connect(out);
  // The band tracks just above the fundamental so the groan keeps its weight —
  // parked an octave up it filters the creak away to nothing.
  const o = osc(ctx, 'sawtooth', 90 + rng() * 40);
  ramp(o.frequency, t, [[0, 120], [dur, 62]], 'exp');
  const bp = filter(ctx, 'bandpass', 190, 5);
  ramp(bp.frequency, t, [[0, 210], [dur, 110]], 'exp');
  const g = gain(ctx, 0);
  ramp(g.gain, t, [[0, 1e-4], [0.12, 0.6], [dur, 1e-4]], 'exp');
  chain(o, bp, g, bus);

  const nz = noise(ctx, { color: 'white', seed: 227 });
  const nbp = filter(ctx, 'bandpass', 1100, 4);
  const ng = gain(ctx, 0);
  crackle(ng.gain, t, { count: 7, window: dur, peak: 0.3, decay: 0.03, rng });
  chain(nz, nbp, ng, bus);

  const sources = [o, nz];
  startAll(sources, t, t + dur + 0.1);
  return { duration: dur + 0.1, sources, pitch: [o.detune] };
}

/**
 * Damage klaxon. A two-tone horn with a formant peak, hard-gated. `urgency`
 * (0..1) speeds it up and pushes it further into distortion.
 */
export function synthKlaxon(ctx, out, t, opts = {}, rng) {
  const urgency = clamp(opts.urgency ?? 0.5, 0, 1);
  const cycles = opts.cycles ?? 2;
  const on = lerp(0.34, 0.16, urgency);
  const off = lerp(0.26, 0.1, urgency);
  const period = on + off;
  const dur = cycles * period;

  const bus = gain(ctx, 0.9);
  const drive = shaper(ctx, 'hard', 0.25 + urgency * 0.4);
  const horn = filter(ctx, 'bandpass', lerp(560, 780, urgency), 1.6);
  const lp = filter(ctx, 'lowpass', 2200, 0.7);
  chain(bus, drive, horn, lp, out);

  const f0 = lerp(300, 372, urgency);
  const a = osc(ctx, 'square', f0);
  const b = osc(ctx, 'sawtooth', f0 * 1.5);
  const ag = gain(ctx, 0.28);
  const bg = gain(ctx, 0.14);
  const vca = gain(ctx, 0);
  chain(a, ag, vca);
  chain(b, bg, vca);
  vca.connect(bus);

  vca.gain.setValueAtTime(0, t);
  for (let i = 0; i < cycles; i++) {
    const t0 = t + i * period;
    vca.gain.setValueAtTime(0, t0);
    vca.gain.linearRampToValueAtTime(1, t0 + 0.012);
    vca.gain.setValueAtTime(1, t0 + on - 0.03);
    vca.gain.linearRampToValueAtTime(0, t0 + on);
    // Each blast sags in pitch as it ends — an air horn losing pressure.
    a.frequency.setValueAtTime(f0, t0);
    a.frequency.setValueAtTime(f0, t0 + on - 0.05);
    a.frequency.linearRampToValueAtTime(f0 * 0.94, t0 + on);
    b.frequency.setValueAtTime(f0 * 1.5, t0);
    b.frequency.setValueAtTime(f0 * 1.5, t0 + on - 0.05);
    b.frequency.linearRampToValueAtTime(f0 * 1.41, t0 + on);
  }

  const sources = [a, b];
  startAll(sources, t, t + dur + 0.05);
  return { duration: dur + 0.05, sources, pitch: [a.detune, b.detune] };
}

/** Soft caution chime — the "you should look at this" tier, below the klaxon. */
export function synthCaution(ctx, out, t, opts = {}, rng) {
  const bus = gain(ctx, 0.5);
  bus.connect(out);
  const sources = [];
  for (let i = 0; i < 2; i++) {
    const o = osc(ctx, 'sine', 784);
    const g = gain(ctx, 0);
    hit(g.gain, t + i * 0.14, 0.26, 0.004, 0.11);
    const bp = filter(ctx, 'bandpass', 784, 5);
    chain(o, bp, g, bus);
    sources.push(o);
  }
  const total = 0.35;
  startAll(sources, t, t + total);
  return { duration: total, sources, pitch: sources.map((s) => s.detune) };
}

/** Shared sustained-voice wrapper for the ambience beds. */
function sustained(ctx, bus, sources, releaseTime) {
  return {
    duration: Infinity,
    sources,
    pitch: [],
    set() {},
    stop(when = ctx.currentTime) {
      bus.gain.cancelScheduledValues(when);
      bus.gain.setValueAtTime(Math.max(1e-4, bus.gain.value), when);
      bus.gain.exponentialRampToValueAtTime(1e-4, when + releaseTime);
      for (const s of sources) { try { s.stop(when + releaseTime + 0.05); } catch { /* noop */ } }
      return releaseTime + 0.1;
    },
  };
}
