/**
 * Impacts. The three that matter are shield / armour / hull, and they must be
 * instantly distinguishable — a pilot has to know from the sound alone whether
 * the shield ate that one.
 *
 *   shield — inharmonic bell partials + a resonant energy sweep: bright, ringing
 *   armour — pitch-collapsing sine + clipped lowpassed noise: a dull, dead thud
 *   hull   — armour thud + comb-filtered tearing + a structural groan
 */
import { osc, gain, filter, noise, shaper, chain, hit, ramp, crackle, startAll, clamp } from '../dsp.js';

const BELL = [1, 2.76, 5.40, 8.93, 13.34];
const BELL_GAIN = [1, 0.55, 0.32, 0.18, 0.09];

export function synthShieldImpact(ctx, out, t, opts = {}, rng) {
  const strength = clamp(opts.strength ?? 1, 0.2, 3);
  const f0 = (560 + rng() * 220) * Math.pow(strength, -0.2);
  const dur = (0.55 + rng() * 0.25) * Math.pow(strength, 0.3);

  const bus = gain(ctx, 0.85);
  bus.connect(out);
  if (opts.send) bus.connect(opts.send);

  const sources = [];

  // Metallic bell: inharmonic partials, each with its own decay, so the ring
  // shimmers instead of sounding like a single filtered tone.
  for (let i = 0; i < BELL.length; i++) {
    const f = f0 * BELL[i] * (1 + (rng() * 2 - 1) * 0.012);
    if (f > ctx.sampleRate * 0.45) continue;
    const o = osc(ctx, 'sine', f);
    // Slight downward glide: energy bleeding out of the shield lattice.
    ramp(o.frequency, t, [[0, f * 1.008], [dur, f * 0.985]], 'exp');
    const g = gain(ctx, 0);
    hit(g.gain, t, 0.34 * BELL_GAIN[i], 0.001, dur * (1 - i * 0.13));
    chain(o, g, bus);
    sources.push(o);
  }

  // Energy sweep — a resonant band falling through the spectrum. This is the
  // part that reads as "force field" rather than "bell".
  const saw = osc(ctx, 'sawtooth', 180);
  const bp = filter(ctx, 'bandpass', 2400, 14);
  ramp(bp.frequency, t, [[0, 2600 + rng() * 600], [0.26, 620]], 'exp');
  const sg = gain(ctx, 0);
  hit(sg.gain, t, 0.5, 0.002, 0.3);
  chain(saw, bp, sg, bus);
  sources.push(saw);

  // Contact shimmer.
  const nz = noise(ctx, { color: 'white', seed: 61 });
  const hp = filter(ctx, 'highpass', 3800, 0.9);
  const ng = gain(ctx, 0);
  hit(ng.gain, t, 0.3, 0.001, 0.14);
  chain(nz, hp, ng, bus);
  sources.push(nz);

  const total = dur + 0.2;
  startAll(sources, t, t + total);
  return { duration: total, sources, pitch: sources.map((s) => s.detune).filter(Boolean) };
}

export function synthArmorImpact(ctx, out, t, opts = {}, rng) {
  const strength = clamp(opts.strength ?? 1, 0.2, 3);
  const dur = (0.2 + rng() * 0.08) * Math.pow(strength, 0.35);

  const bus = gain(ctx, 1);
  const crunch = shaper(ctx, 'hard', 0.7);
  chain(bus, crunch, out);

  const f0 = (128 + rng() * 40) * Math.pow(strength, -0.3);
  const thud = osc(ctx, 'sine', f0);
  ramp(thud.frequency, t, [[0, f0], [dur * 0.8, f0 * 0.38]], 'exp');
  const tg = gain(ctx, 0);
  hit(tg.gain, t, 0.9, 0.003, dur * 1.3);
  chain(thud, tg, bus);

  // Transient crunch: broadband but firmly lidded, so it thuds rather than ticks.
  const nz = noise(ctx, { color: 'white', seed: 67 });
  const lp = filter(ctx, 'lowpass', 900, 1.6);
  ramp(lp.frequency, t, [[0, 1600], [dur, 260]], 'exp');
  const ng = gain(ctx, 0);
  hit(ng.gain, t, 0.62, 0.001, dur * 0.7);
  chain(nz, lp, ng, bus);

  // A couple of plate rattles just after contact.
  const rz = noise(ctx, { color: 'white', seed: 71 });
  const rb = filter(ctx, 'bandpass', 2200 + rng() * 900, 3);
  const rg = gain(ctx, 0);
  crackle(rg.gain, t + 0.01, { count: 4, window: 0.16, peak: 0.16, decay: 0.012, rng });
  chain(rz, rb, rg, bus);

  const total = dur * 1.5 + 0.1;
  const sources = [thud, nz, rz];
  startAll(sources, t, t + total);
  return { duration: total, sources, pitch: [thud.detune] };
}

export function synthHullBreach(ctx, out, t, opts = {}, rng) {
  const strength = clamp(opts.strength ?? 1, 0.3, 3);
  const dur = 1.25 * Math.pow(strength, 0.25);

  const bus = gain(ctx, 1);
  const crunch = shaper(ctx, 'hard', 0.55);
  chain(bus, crunch, out);
  if (opts.send) crunch.connect(opts.send);

  // Impact thud.
  const thud = osc(ctx, 'sine', 96);
  ramp(thud.frequency, t, [[0, 110], [0.25, 34]], 'exp');
  const tg = gain(ctx, 0);
  hit(tg.gain, t, 0.95, 0.004, 0.4);
  chain(thud, tg, bus);

  // Tearing metal: noise through a short comb (resonating at ~250 Hz) then a
  // falling bandpass. The comb is what makes it read as *metal* tearing.
  const nz = noise(ctx, { color: 'white', seed: 73 });
  const dl = ctx.createDelay(0.05);
  dl.delayTime.value = 0.0041;
  const fb = gain(ctx, 0.62);
  const damp = filter(ctx, 'lowpass', 2600, 0.7);
  const pre = gain(ctx, 0.5);
  nz.connect(pre); pre.connect(dl); dl.connect(damp); damp.connect(fb); fb.connect(dl);
  const bp = filter(ctx, 'bandpass', 1400, 1.4);
  ramp(bp.frequency, t, [[0, 1700], [dur, 280]], 'exp');
  const ng = gain(ctx, 0);
  ramp(ng.gain, t, [[0, 1e-4], [0.02, 0.5], [0.35, 0.22], [dur, 1e-4]], 'exp');
  dl.connect(bp); pre.connect(bp);
  chain(bp, ng, bus);

  // Structural groan.
  const groan = osc(ctx, 'sawtooth', 68);
  ramp(groan.frequency, t, [[0, 72], [dur, 41]], 'exp');
  const glp = filter(ctx, 'lowpass', 300, 6);
  const gg = gain(ctx, 0);
  ramp(gg.gain, t, [[0, 1e-4], [0.15, 0.3], [dur, 1e-4]], 'exp');
  chain(groan, glp, gg, bus);

  // Debris skittering off the plating.
  const dz = noise(ctx, { color: 'white', seed: 79 });
  const dbp = filter(ctx, 'bandpass', 3200, 2);
  const dg = gain(ctx, 0);
  crackle(dg.gain, t + 0.05, { count: 12, window: dur * 0.8, peak: 0.22, decay: 0.02, rng });
  chain(dz, dbp, dg, bus);

  const total = dur + 0.25;
  const sources = [thud, nz, groan, dz];
  startAll(sources, t, t + total);
  return { duration: total, sources, pitch: [thud.detune, groan.detune] };
}

/** A fragment pinging off the hull. Cheap, used a lot during a debris shower. */
export function synthDebrisTick(ctx, out, t, opts = {}, rng) {
  const dur = 0.09 + rng() * 0.06;
  const bus = gain(ctx, 0.5);
  bus.connect(out);
  const base = 1500 + rng() * 1800;
  const sources = [];
  for (let i = 0; i < 3; i++) {
    const o = osc(ctx, 'sine', base * [1, 1.83, 2.71][i]);
    const g = gain(ctx, 0);
    hit(g.gain, t, 0.3 / (1 + i * 1.2), 0.0008, dur * (1 - i * 0.2));
    chain(o, g, bus);
    sources.push(o);
  }
  const nz = noise(ctx, { color: 'white', seed: 83 });
  const hp = filter(ctx, 'highpass', 2500, 1);
  const ng = gain(ctx, 0);
  hit(ng.gain, t, 0.18, 0.0006, 0.03);
  chain(nz, hp, ng, bus);
  sources.push(nz);
  startAll(sources, t, t + dur + 0.05);
  return { duration: dur + 0.05, sources, pitch: sources.map((s) => s.detune).filter(Boolean) };
}

/** Ship-on-ship or ship-on-asteroid collision: grinding scrape plus a big thud. */
export function synthCollision(ctx, out, t, opts = {}, rng) {
  const force = clamp(opts.force ?? 1, 0.2, 4);
  const dur = (0.55 + rng() * 0.2) * Math.pow(force, 0.4);

  const bus = gain(ctx, 1);
  const drive = shaper(ctx, 'hard', 0.6);
  chain(bus, drive, out);
  if (opts.send) drive.connect(opts.send);

  const thud = osc(ctx, 'sine', 74 * Math.pow(force, -0.2));
  ramp(thud.frequency, t, [[0, 88], [dur * 0.7, 28]], 'exp');
  const tg = gain(ctx, 0);
  hit(tg.gain, t, 0.95, 0.005, dur * 0.8);
  chain(thud, tg, bus);

  // Scrape: bandpassed noise wobbled by an LFO so it grinds instead of hissing.
  const nz = noise(ctx, { color: 'white', seed: 89 });
  const bp = filter(ctx, 'bandpass', 900, 2.5);
  ramp(bp.frequency, t, [[0, 1900], [dur, 420]], 'exp');
  const lfo = osc(ctx, 'sine', 23 + rng() * 14);
  const lfoG = gain(ctx, 420);
  lfo.connect(lfoG).connect(bp.frequency);
  const ng = gain(ctx, 0);
  ramp(ng.gain, t, [[0, 1e-4], [0.01, 0.55], [dur, 1e-4]], 'exp');
  chain(nz, bp, ng, bus);

  const total = dur + 0.2;
  const sources = [thud, nz, lfo];
  startAll(sources, t, t + total);
  return { duration: total, sources, pitch: [thud.detune] };
}
