/**
 * Explosions — four layers plus optional structural collapse, every parameter
 * scaled by `size` so a missile pop (0.4), a fighter dying (1.0) and a carrier
 * breaking up (6.0) are the same recipe at different scales, never the same
 * sample at different pitches.
 *
 *   sub    — sine dropping to sub-bass: the pressure wave
 *   body   — saturated noise through a collapsing lowpass: the fireball
 *   debris — a grain train of bandpassed noise spikes: crackle and shrapnel
 *   tail   — long lowpassed wash, fed to the reverb send
 *   groan  — (large only) detuned saws sliding down: hull structure failing
 */
import { osc, gain, filter, noise, shaper, chain, hit, ramp, crackle, startAll, clamp } from '../dsp.js';

export function synthExplosion(ctx, out, t, opts = {}, rng) {
  const size = clamp(opts.size ?? 1, 0.18, 8);
  const s = Math.pow(size, 0.5);            // perceptual scale
  const send = opts.send ?? null;           // reverb send node (may be null)

  const bodyDur = 0.42 * Math.pow(size, 0.45) + 0.1;
  const tailDur = 1.1 + 1.5 * s;
  const total = Math.max(bodyDur, tailDur) + 0.4;

  const bus = gain(ctx, 0.85);
  const glue = shaper(ctx, 'soft', 0.35 + 0.25 * clamp(size / 4, 0, 1));
  // The saturator hard-limits at ±1; this trim keeps the peak below digital full
  // scale so a capital ship dying is enormous without ever clipping the bus.
  const trim = gain(ctx, 0.8);
  chain(bus, glue, trim, out);
  if (send) trim.connect(send);

  // ---- sub: 120 Hz for a fighter, 40 Hz for a capital ship ------------------
  const subF = clamp(125 * Math.pow(size, -0.62), 17, 190);
  const sub = osc(ctx, 'sine', subF);
  ramp(sub.frequency, t, [[0, subF * 1.5], [0.03, subF], [bodyDur * 1.6, subF * 0.34]], 'exp');
  const sg = gain(ctx, 0);
  hit(sg.gain, t, 0.82, 0.006 + 0.01 * s, 0.55 * Math.pow(size, 0.55) + 0.2);
  chain(sub, sg, bus);

  // ---- body: the fireball itself -------------------------------------------
  const nz = noise(ctx, { color: 'white', seed: 41, rate: 0.85 + rng() * 0.3 });
  const lp = filter(ctx, 'lowpass', 4000, 1.3);
  ramp(lp.frequency, t, [
    [0, clamp(5200 * Math.pow(size, -0.25), 900, 9000)],
    [0.02, clamp(3200 * Math.pow(size, -0.3), 500, 6000)],
    [bodyDur, clamp(210 * Math.pow(size, -0.3), 60, 400)],
  ], 'exp');
  const ng = gain(ctx, 0);
  hit(ng.gain, t, 0.8, 0.004, bodyDur);
  chain(nz, lp, ng, bus);

  // ---- debris crackle -------------------------------------------------------
  const dz = noise(ctx, { color: 'white', seed: 43, rate: 1.1 });
  const bp = filter(ctx, 'bandpass', 3600, 1.1);
  ramp(bp.frequency, t, [[0, 5200], [1.0 + s, 1500]], 'exp');
  const dg = gain(ctx, 0);
  crackle(dg.gain, t + 0.02, {
    count: Math.round(clamp(10 + 9 * size, 8, 46)),
    window: 0.35 + 0.75 * s,
    peak: 0.34,
    decay: 0.022 + 0.012 * s,
    rng,
  });
  chain(dz, bp, dg, bus);

  // ---- long tail ------------------------------------------------------------
  const tz = noise(ctx, { color: 'brown', seed: 47, rate: 0.6 });
  const tlp = filter(ctx, 'lowpass', 700, 0.9);
  ramp(tlp.frequency, t, [[0, clamp(900 * Math.pow(size, -0.2), 180, 1400)], [tailDur, 90]], 'exp');
  const tg = gain(ctx, 0);
  ramp(tg.gain, t, [[0, 1e-4], [0.05, 0.3 * clamp(0.5 + s * 0.4, 0.4, 1.2)], [tailDur, 1e-4]], 'exp');
  chain(tz, tlp, tg, bus);
  if (send) tg.connect(send);

  const sources = [sub, nz, dz, tz];

  // ---- structural collapse: only big things groan as they die ---------------
  if (size >= 2.2) {
    const groanDur = 1.4 + 0.8 * s;
    const gbus = gain(ctx, 0);
    ramp(gbus.gain, t + 0.15, [[0, 1e-4], [0.25, 0.42], [groanDur, 1e-4]], 'exp');
    const glp = filter(ctx, 'lowpass', 380, 7);
    ramp(glp.frequency, t + 0.15, [[0, 520], [groanDur, 130]], 'exp');
    chain(gbus, glp, bus);
    for (let i = 0; i < 3; i++) {
      const f = 44 * (1 + i * 0.51) * (0.94 + rng() * 0.12);
      const o = osc(ctx, 'sawtooth', f, (rng() * 2 - 1) * 25);
      ramp(o.frequency, t + 0.15, [[0, f], [groanDur, f * 0.62]], 'exp');
      const og = gain(ctx, 0.3 / (1 + i));
      chain(o, og, gbus);
      sources.push(o);
    }
    // Secondary detonations rolling through the wreck.
    const secondaries = Math.round(clamp(size * 0.9, 2, 6));
    for (let i = 0; i < secondaries; i++) {
      const dt = 0.25 + rng() * (0.6 + 0.35 * s) * (i + 1) * 0.55;
      const f = subF * (1.3 + rng() * 1.1);
      const o = osc(ctx, 'sine', f);
      ramp(o.frequency, t + dt, [[0, f], [0.4, f * 0.4]], 'exp');
      const og = gain(ctx, 0);
      hit(og.gain, t + dt, 0.34 * (0.6 + rng() * 0.6), 0.005, 0.42);
      chain(o, og, bus);
      const sn = noise(ctx, { color: 'white', seed: 53 + i });
      const slp = filter(ctx, 'lowpass', 1200, 1.2);
      ramp(slp.frequency, t + dt, [[0, 1800], [0.3, 240]], 'exp');
      const sng = gain(ctx, 0);
      hit(sng.gain, t + dt, 0.3, 0.004, 0.3);
      chain(sn, slp, sng, bus);
      sources.push(o, sn);
    }
  }

  startAll(sources, t, t + total);
  return { duration: total, sources, pitch: [sub.detune] };
}

/** Convenience preset: an entire capital ship going up. */
export function synthCapitalExplosion(ctx, out, t, opts = {}, rng) {
  return synthExplosion(ctx, out, t, { ...opts, size: opts.size ?? 6 }, rng);
}
