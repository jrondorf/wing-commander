/**
 * Cockpit UI. Short, dry, high-contrast — these play dozens of times a minute
 * and must never become fatiguing, so everything is band-limited, under 200 ms,
 * and mixed well below the guns.
 */
import { osc, gain, filter, noise, chain, hit, ramp, startAll } from '../dsp.js';

/** Target lock acquired: two ascending blips plus a confirmation ping. */
export function synthTargetLock(ctx, out, t, opts = {}, rng) {
  const bus = gain(ctx, 0.6);
  bus.connect(out);
  const sources = [];
  const notes = [[0, 880], [0.055, 1320]];
  for (const [dt, f] of notes) {
    const o = osc(ctx, 'square', f);
    const g = gain(ctx, 0);
    hit(g.gain, t + dt, 0.3, 0.001, 0.05);
    const bp = filter(ctx, 'bandpass', f, 4);
    chain(o, bp, g, bus);
    sources.push(o);
  }
  const ping = osc(ctx, 'sine', 2640);
  const pg = gain(ctx, 0);
  hit(pg.gain, t + 0.055, 0.14, 0.001, 0.22);
  chain(ping, pg, bus);
  sources.push(ping);
  const total = 0.32;
  startAll(sources, t, t + total);
  return { duration: total, sources, pitch: sources.map((s) => s.detune) };
}

/** Generic button beep. */
export function synthBeep(ctx, out, t, opts = {}, rng) {
  const f = opts.freq ?? 1150;
  const dur = opts.dur ?? 0.055;
  const bus = gain(ctx, 0);
  hit(bus.gain, t, opts.level ?? 0.32, 0.001, dur);
  const bp = filter(ctx, 'bandpass', f, 3.5);
  chain(bus, bp, out);
  const o = osc(ctx, opts.type ?? 'square', f);
  o.connect(bus);
  startAll([o], t, t + dur + 0.03);
  return { duration: dur + 0.03, sources: [o], pitch: [o.detune] };
}

/** Affirmative: a quick rising chirp. */
export function synthSelect(ctx, out, t, opts = {}, rng) {
  const dur = 0.11;
  const bus = gain(ctx, 0);
  hit(bus.gain, t, 0.3, 0.002, dur);
  bus.connect(out);
  const o = osc(ctx, 'triangle', 700);
  ramp(o.frequency, t, [[0, 700], [dur, 1500]], 'exp');
  const sq = osc(ctx, 'square', 1400);
  ramp(sq.frequency, t, [[0, 1400], [dur, 3000]], 'exp');
  const sg = gain(ctx, 0.18);
  o.connect(bus);
  chain(sq, sg, bus);
  startAll([o, sq], t, t + dur + 0.03);
  return { duration: dur + 0.03, sources: [o, sq], pitch: [o.detune, sq.detune] };
}

/** Negative: a buzzing descending tone. */
export function synthDeny(ctx, out, t, opts = {}, rng) {
  const dur = 0.22;
  const bus = gain(ctx, 0);
  ramp(bus.gain, t, [[0, 1e-4], [0.008, 0.32], [dur, 1e-4]], 'exp');
  const lp = filter(ctx, 'lowpass', 1600, 1.2);
  chain(bus, lp, out);
  const o = osc(ctx, 'square', 330);
  ramp(o.frequency, t, [[0, 330], [dur, 190]], 'exp');
  // 27 Hz amplitude buzz: the universal "denied".
  const am = osc(ctx, 'square', 27);
  const amG = gain(ctx, 0.5);
  const vca = gain(ctx, 0.5);
  am.connect(amG).connect(vca.gain);
  chain(o, vca, bus);
  startAll([o, am], t, t + dur + 0.03);
  return { duration: dur + 0.03, sources: [o, am], pitch: [o.detune] };
}

/** MFD page change: a relay click plus a falling data blip. */
export function synthMfdSwitch(ctx, out, t, opts = {}, rng) {
  const dur = 0.12;
  const bus = gain(ctx, 0.55);
  bus.connect(out);
  const nz = noise(ctx, { color: 'white', seed: 191 });
  const hp = filter(ctx, 'highpass', 1400, 1.1);
  const ng = gain(ctx, 0);
  hit(ng.gain, t, 0.34, 0.0006, 0.016);
  chain(nz, hp, ng, bus);
  const o = osc(ctx, 'square', 1900);
  ramp(o.frequency, t, [[0, 1900], [0.07, 1050]], 'exp');
  const og = gain(ctx, 0);
  hit(og.gain, t + 0.006, 0.2, 0.001, 0.07);
  const bp = filter(ctx, 'bandpass', 1500, 4);
  chain(o, bp, og, bus);
  startAll([nz, o], t, t + dur + 0.03);
  return { duration: dur + 0.03, sources: [nz, o], pitch: [o.detune] };
}

/** Comms channel opening: carrier pop then a settling hiss. */
export function synthSquelchOpen(ctx, out, t, opts = {}, rng) {
  const dur = 0.24;
  const bus = gain(ctx, 0.6);
  bus.connect(out);
  const nz = noise(ctx, { color: 'white', seed: 193 });
  const bp = filter(ctx, 'bandpass', 2600, 1.1);
  ramp(bp.frequency, t, [[0, 3400], [dur, 1600]], 'exp');
  const ng = gain(ctx, 0);
  ramp(ng.gain, t, [[0, 1e-4], [0.006, 0.42], [0.05, 0.09], [dur, 0.03]], 'exp');
  chain(nz, bp, ng, bus);
  const pop = osc(ctx, 'sine', 240);
  ramp(pop.frequency, t, [[0, 260], [0.03, 120]], 'exp');
  const pg = gain(ctx, 0);
  hit(pg.gain, t, 0.22, 0.001, 0.035);
  chain(pop, pg, bus);
  startAll([nz, pop], t, t + dur + 0.03);
  return { duration: dur + 0.03, sources: [nz, pop], pitch: [pop.detune] };
}

/** Comms channel closing: the classic tail-end squelch burst. */
export function synthSquelchClose(ctx, out, t, opts = {}, rng) {
  const dur = 0.16;
  const bus = gain(ctx, 0.6);
  bus.connect(out);
  const nz = noise(ctx, { color: 'white', seed: 197 });
  const hp = filter(ctx, 'highpass', 1200, 0.9);
  const ng = gain(ctx, 0);
  ramp(ng.gain, t, [[0, 0.26], [0.02, 0.34], [dur, 1e-4]], 'exp');
  chain(nz, hp, ng, bus);
  const click = osc(ctx, 'square', 900);
  const cg = gain(ctx, 0);
  hit(cg.gain, t + dur * 0.75, 0.16, 0.0008, 0.02);
  chain(click, cg, bus);
  startAll([nz, click], t, t + dur + 0.05);
  return { duration: dur + 0.05, sources: [nz, click], pitch: [click.detune] };
}

/** Cycling through targets — quieter than a full lock. */
export function synthTargetCycle(ctx, out, t, opts = {}, rng) {
  return synthBeep(ctx, out, t, { freq: 1500, dur: 0.03, level: 0.18, type: 'square' }, rng);
}
