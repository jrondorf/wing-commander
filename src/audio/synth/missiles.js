/**
 * Missiles — launch, motor, and the two iconic Wing Commander alert tones.
 *
 * The lock tone is a single short blip; the *sequence* (accelerating as the
 * seeker converges, then locking solid) is driven by the lock manager in
 * AudioSystem.js, which is what makes it read as "tracking… tracking… LOCKED".
 */
import { osc, gain, filter, noise, shaper, chain, ringMod, hit, ramp, startAll, clamp } from '../dsp.js';

/** Tube launch: mechanical clunk, pressure whoosh, receding sub. */
export function synthMissileLaunch(ctx, out, t, opts = {}, rng) {
  const dur = 0.75;
  const bus = gain(ctx, 1);
  const drive = shaper(ctx, 'soft', 0.4);
  chain(bus, drive, out);
  if (opts.send) drive.connect(opts.send);

  // Rail clunk.
  const clunk = osc(ctx, 'square', 180);
  ramp(clunk.frequency, t, [[0, 200], [0.06, 70]], 'exp');
  const cg = gain(ctx, 0);
  hit(cg.gain, t, 0.32, 0.001, 0.09);
  const cf = filter(ctx, 'lowpass', 1200, 2);
  chain(clunk, cf, cg, bus);

  // Whoosh: a band of noise sweeping up as the motor lights, then away.
  const nz = noise(ctx, { color: 'white', seed: 163, rate: 0.9 + rng() * 0.2 });
  const bp = filter(ctx, 'bandpass', 380, 1.1);
  ramp(bp.frequency, t, [[0, 340], [0.13, 3600 + rng() * 700], [dur, 700]], 'exp');
  ramp(bp.Q, t, [[0, 0.8], [dur, 2.6]], 'lin');
  const ng = gain(ctx, 0);
  ramp(ng.gain, t, [[0, 1e-4], [0.03, 0.62], [0.3, 0.34], [dur, 1e-4]], 'exp');
  chain(nz, bp, ng, bus);

  // Departing sub.
  const sub = osc(ctx, 'sine', 105);
  ramp(sub.frequency, t, [[0, 115], [dur, 38]], 'exp');
  const sg = gain(ctx, 0);
  hit(sg.gain, t, 0.6, 0.008, dur * 0.75);
  chain(sub, sg, bus);

  const sources = [clunk, nz, sub];
  startAll(sources, t, t + dur + 0.1);
  return { duration: dur + 0.1, sources, pitch: [sub.detune, clunk.detune] };
}

/**
 * Sustained rocket motor. Doppler on this one is the whole point — a missile
 * crossing the canopy should audibly swing in pitch.
 */
export function synthMissileThrust(ctx, out, t, opts = {}, rng) {
  const bus = gain(ctx, 0);
  const drive = shaper(ctx, 'soft', 0.35);
  chain(bus, drive, out);
  ramp(bus.gain, t, [[0, 1e-4], [0.12, opts.gain ?? 0.75]], 'exp');

  // Exhaust: brown noise through a resonant lowpass.
  const nz = noise(ctx, { color: 'brown', seed: 167 });
  const lp = filter(ctx, 'lowpass', 1100, 3.5);
  const ng = gain(ctx, 0.7);
  chain(nz, lp, ng, bus);

  // Combustion rumble.
  const rum = osc(ctx, 'sawtooth', 58);
  const rlp = filter(ctx, 'lowpass', 260, 4);
  const rg = gain(ctx, 0.24);
  chain(rum, rlp, rg, bus);

  // Nozzle hiss.
  const hz = noise(ctx, { color: 'white', seed: 173 });
  const hbp = filter(ctx, 'bandpass', 3400, 1.2);
  const hg = gain(ctx, 0.12);
  chain(hz, hbp, hg, bus);

  // Flutter — combustion instability keeps it from sounding like flat noise.
  const flut = osc(ctx, 'sine', 17 + rng() * 9);
  const flutG = gain(ctx, 210);
  flut.connect(flutG).connect(lp.frequency);

  const sources = [nz, rum, hz, flut];
  startAll(sources, t);

  const pitch = [rum.detune];
  if (nz.detune) pitch.push(nz.detune, hz.detune);

  return {
    duration: Infinity,
    sources,
    pitch,
    set(p, when = ctx.currentTime) {
      if (p.thrust != null) {
        const th = clamp(p.thrust, 0, 1);
        ng.gain.setTargetAtTime(0.25 + th * 0.6, when, 0.1);
        lp.frequency.setTargetAtTime(600 + th * 900, when, 0.1);
      }
    },
    stop(when = ctx.currentTime) {
      const r = 0.18;
      bus.gain.cancelScheduledValues(when);
      bus.gain.setValueAtTime(Math.max(1e-4, bus.gain.value), when);
      bus.gain.exponentialRampToValueAtTime(1e-4, when + r);
      for (const s of sources) { try { s.stop(when + r + 0.03); } catch { /* noop */ } }
      return r + 0.05;
    },
  };
}

/**
 * Seeker blip. `progress` (0..1) walks the pitch up a fixed scale so the
 * accelerating sequence also *rises* — the classic ascending lock.
 */
export function synthLockBlip(ctx, out, t, opts = {}, rng) {
  const progress = clamp(opts.progress ?? 0, 0, 1);
  // Quantised to semitones of a minor triad so the sequence sounds intentional.
  const steps = [0, 3, 7, 10, 12, 15, 19, 24];
  const step = steps[Math.min(steps.length - 1, Math.floor(progress * (steps.length - 1) + 0.001))];
  const f = 660 * Math.pow(2, step / 12);
  const dur = 0.075;

  const bus = gain(ctx, 0);
  hit(bus.gain, t, 0.5, 0.0015, dur);
  const bp = filter(ctx, 'bandpass', f, 3);
  chain(bus, bp, out);

  const sq = osc(ctx, 'square', f);
  const sg = gain(ctx, 0.35);
  chain(sq, sg, bus);
  const si = osc(ctx, 'sine', f * 2);
  const sig = gain(ctx, 0.25);
  chain(si, sig, bus);

  const sources = [sq, si];
  startAll(sources, t, t + dur + 0.04);
  return { duration: dur + 0.04, sources, pitch: [sq.detune, si.detune] };
}

/** Solid lock: a steady, slightly gated dual tone that means "release it". */
export function synthLockTone(ctx, out, t, opts = {}, rng) {
  const f = opts.freq ?? 1245;
  const bus = gain(ctx, 0);
  ramp(bus.gain, t, [[0, 1e-4], [0.02, 0.3]], 'exp');
  const bp = filter(ctx, 'bandpass', f, 2.5);
  chain(bus, bp, out);

  const a = osc(ctx, 'square', f);
  const ag = gain(ctx, 0.3);
  chain(a, ag, bus);
  const b = osc(ctx, 'square', f * 1.005);   // slow beating: urgency
  const bg = gain(ctx, 0.22);
  chain(b, bg, bus);

  // 14 Hz gate so it pulses rather than drones.
  const gateOsc = osc(ctx, 'square', 14);
  const gate = ringMod(ctx, gateOsc, 0.4);
  const dryG = gain(ctx, 0.6);
  bus.disconnect();
  bus.connect(gate); gate.connect(bp);
  bus.connect(dryG); dryG.connect(bp);

  const sources = [a, b, gateOsc];
  startAll(sources, t);
  return {
    duration: Infinity,
    sources,
    pitch: [a.detune, b.detune],
    stop(when = ctx.currentTime) {
      const r = 0.06;
      bus.gain.cancelScheduledValues(when);
      bus.gain.setValueAtTime(Math.max(1e-4, bus.gain.value), when);
      bus.gain.exponentialRampToValueAtTime(1e-4, when + r);
      for (const s of sources) { try { s.stop(when + r + 0.02); } catch { /* noop */ } }
      return r + 0.05;
    },
  };
}

/**
 * INCOMING MISSILE. Deliberately unpleasant: a hard two-tone alternation with a
 * distorted edge and a pulsing sub, so it cuts through an explosion.
 */
export function synthMissileWarning(ctx, out, t, opts = {}, rng) {
  const cycles = opts.cycles ?? 6;
  const rate = opts.rate ?? 6.2;            // alternations per second
  const half = 0.5 / rate;
  const dur = cycles * 2 * half;

  const bus = gain(ctx, 0.9);
  const drive = shaper(ctx, 'hard', 0.35);
  const bp = filter(ctx, 'bandpass', 1000, 1.1);
  chain(bus, drive, bp, out);

  const hi = osc(ctx, 'square', 988);
  const lo = osc(ctx, 'square', 740);
  const hg = gain(ctx, 0);
  const lg = gain(ctx, 0);
  chain(hi, hg, bus);
  chain(lo, lg, bus);

  // Hard-gate the two tones in alternation with a 6 ms edge each side.
  hg.gain.setValueAtTime(0, t);
  lg.gain.setValueAtTime(0, t);
  for (let i = 0; i < cycles * 2; i++) {
    const g = i % 2 === 0 ? hg.gain : lg.gain;
    const t0 = t + i * half;
    g.setValueAtTime(0, t0);
    g.linearRampToValueAtTime(0.3, t0 + 0.006);
    g.setValueAtTime(0.3, t0 + half - 0.012);
    g.linearRampToValueAtTime(0, t0 + half - 0.004);
  }

  // Sub pulse under every alternation.
  const sub = osc(ctx, 'sine', 92);
  const sg = gain(ctx, 0);
  chain(sub, sg, bus);
  sg.gain.setValueAtTime(1e-4, t);
  for (let i = 0; i < cycles * 2; i++) {
    const t0 = t + i * half;
    sg.gain.setValueAtTime(1e-4, t0);
    sg.gain.linearRampToValueAtTime(0.28, t0 + 0.008);
    sg.gain.exponentialRampToValueAtTime(1e-4, t0 + half * 0.9);
  }

  const sources = [hi, lo, sub];
  startAll(sources, t, t + dur + 0.05);
  return { duration: dur + 0.05, sources, pitch: [hi.detune, lo.detune, sub.detune] };
}

/** Countermeasure / decoy dispense. */
export function synthDecoy(ctx, out, t, opts = {}, rng) {
  const dur = 0.4;
  const bus = gain(ctx, 0.8);
  bus.connect(out);
  const nz = noise(ctx, { color: 'white', seed: 179 });
  const bp = filter(ctx, 'bandpass', 2200, 1.6);
  ramp(bp.frequency, t, [[0, 900], [0.1, 4200], [dur, 1600]], 'exp');
  const ng = gain(ctx, 0);
  ramp(ng.gain, t, [[0, 1e-4], [0.015, 0.5], [dur, 1e-4]], 'exp');
  chain(nz, bp, ng, bus);
  const pop = osc(ctx, 'square', 320);
  ramp(pop.frequency, t, [[0, 340], [0.05, 120]], 'exp');
  const pg = gain(ctx, 0);
  hit(pg.gain, t, 0.28, 0.001, 0.07);
  chain(pop, pg, bus);
  const sources = [nz, pop];
  startAll(sources, t, t + dur + 0.05);
  return { duration: dur + 0.05, sources, pitch: [pop.detune] };
}
