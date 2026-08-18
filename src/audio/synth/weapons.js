/**
 * Gun synthesis. Four weapons, four genuinely different recipes:
 *
 *   mass driver  — pitch-dropping square + sub, hard-clipped: a kinetic slug gun
 *   laser        — 2-op FM with a falling modulation index through a comb tail
 *   ion cannon   — ring-modulated saw through a screaming resonant sweep
 *   particle     — wave-folded noise plus a detuned energy chord with tremolo
 *
 * Every recipe reads its randomisation from the seeded rng the mixer passes in,
 * so a held trigger produces a burst that varies shot to shot but replays
 * identically for a given seed.
 *
 * Contract: (ctx, out, t, opts, rng) -> { duration, sources[], pitch[] }
 * `pitch` lists params the mixer's doppler stage may detune.
 */
import { osc, gain, filter, noise, shaper, chain, ringMod, hit, ramp, crackle, startAll, clamp } from '../dsp.js';

export function synthMassDriver(ctx, out, t, opts = {}, rng) {
  const power = clamp(opts.power ?? 1, 0.3, 3);
  const f0 = (330 + rng() * 70) / Math.pow(power, 0.35);
  const dur = (0.17 + rng() * 0.05) * Math.pow(power, 0.3);

  const body = gain(ctx, 0);
  const drive = shaper(ctx, 'hard', 0.55);
  chain(body, drive, out);

  // Slug crack: a square whose pitch collapses in 60 ms reads as a mechanical
  // report rather than a musical note.
  const o1 = osc(ctx, 'square', f0);
  ramp(o1.frequency, t, [[0, f0], [0.012, f0 * 0.55], [dur * 0.6, f0 * 0.18]], 'exp');
  const g1 = gain(ctx, 0.5);
  chain(o1, g1, body);

  // Sub: the punch you feel in the seat.
  const o2 = osc(ctx, 'sine', f0 * 0.42);
  ramp(o2.frequency, t, [[0, f0 * 0.42], [dur * 0.8, f0 * 0.13]], 'exp');
  const g2 = gain(ctx, 0);
  hit(g2.gain, t, 0.85, 0.003, dur * 1.25);
  chain(o2, g2, body);

  // Muzzle noise, band-limited so it cuts without hissing.
  const nz = noise(ctx, { color: 'white', seed: 3 });
  const nf = filter(ctx, 'bandpass', 1500 + rng() * 900, 0.8);
  const ng = gain(ctx, 0);
  hit(ng.gain, t, 0.55, 0.001, dur * 0.55);
  chain(nz, nf, ng, body);

  hit(body.gain, t, 0.75, 0.002, dur);

  const sources = [o1, o2, nz];
  startAll(sources, t, t + dur * 1.6);
  return { duration: dur * 1.6, sources, pitch: [o1.detune, o2.detune] };
}

export function synthLaser(ctx, out, t, opts = {}, rng) {
  const power = clamp(opts.power ?? 1, 0.3, 3);
  const carrier = (1350 + rng() * 320) / Math.pow(power, 0.4);
  const ratio = 2.35 + rng() * 1.1;
  const dur = 0.26 + rng() * 0.07;

  // The layer envelopes live on the individual sources, so the body node is a
  // plain summing point at unity.
  const body = gain(ctx, 1);

  // Metallic comb tail — a 3 ms feedback delay puts a resonant ring on the decay
  // that a plain FM blip does not have.
  const dl = ctx.createDelay(0.05);
  // Kept above one render quantum (128 samples) so the feedback loop is legal.
  dl.delayTime.value = 0.0038 + rng() * 0.0022;
  const fb = gain(ctx, 0.42);
  const damp = filter(ctx, 'lowpass', 5200, 0.7);
  body.connect(dl); dl.connect(damp); damp.connect(fb); fb.connect(dl);
  const wet = gain(ctx, 0.5);
  dl.connect(wet); wet.connect(out);
  body.connect(out);

  // 2-op FM: index falls fast, carrier falls slower — the classic "pew" arc.
  const car = osc(ctx, 'sine', carrier);
  ramp(car.frequency, t, [[0, carrier], [dur * 0.85, carrier * 0.3]], 'exp');
  const mod = osc(ctx, 'sine', carrier * ratio);
  ramp(mod.frequency, t, [[0, carrier * ratio], [dur * 0.85, carrier * ratio * 0.3]], 'exp');
  const idx = gain(ctx, 0);
  ramp(idx.gain, t, [[0, carrier * (1.1 + rng() * 0.6)], [0.02, carrier * 0.55], [dur * 0.7, 8]], 'exp');
  mod.connect(idx).connect(car.frequency);
  const cg = gain(ctx, 0);
  hit(cg.gain, t, 0.6, 0.0015, dur);
  chain(car, cg, body);

  // Bright ionisation zip on the leading edge.
  const nz = noise(ctx, { color: 'white', seed: 5 });
  const nf = filter(ctx, 'bandpass', 6000, 1.4);
  ramp(nf.frequency, t, [[0, 6800], [0.09, 1400]], 'exp');
  const ng = gain(ctx, 0);
  hit(ng.gain, t, 0.3, 0.001, 0.11);
  chain(nz, nf, ng, body);

  const sources = [car, mod, nz];
  startAll(sources, t, t + dur + 0.25);
  return { duration: dur + 0.3, sources, pitch: [car.detune, mod.detune] };
}

export function synthIonCannon(ctx, out, t, opts = {}, rng) {
  const power = clamp(opts.power ?? 1, 0.3, 3);
  const dur = (0.32 + rng() * 0.08) * Math.pow(power, 0.25);
  const base = 88 * Math.pow(power, -0.3) * (0.9 + rng() * 0.2);

  const body = gain(ctx, 0);
  hit(body.gain, t, 0.62, 0.006, dur);
  body.connect(out);

  // Saw through a very resonant bandpass that sweeps up then snaps down: the
  // charged, electric "zorp" of an ion bolt.
  const saw = osc(ctx, 'sawtooth', base);
  const bp = filter(ctx, 'bandpass', 340, 13);
  ramp(bp.frequency, t, [[0, 320], [0.05, 3200 + rng() * 700], [dur, 480]], 'exp');
  ramp(bp.Q, t, [[0, 16], [dur, 5]], 'lin');

  // Ring modulation against a 63 Hz-ish tone gives the inharmonic buzz that
  // separates ion from laser.
  const rmOsc = osc(ctx, 'sine', 58 + rng() * 22);
  const rm = ringMod(ctx, rmOsc, 0.9);
  const dry = gain(ctx, 0.45);
  chain(saw, bp, rm, body);
  bp.connect(dry).connect(body);

  // Sub thump so it still lands with weight.
  const sub = osc(ctx, 'sine', 150);
  ramp(sub.frequency, t, [[0, 165], [dur * 0.7, 52]], 'exp');
  const sg = gain(ctx, 0);
  hit(sg.gain, t, 0.5, 0.004, dur * 0.6);
  chain(sub, sg, body);

  // High crackle riding the discharge.
  const nz = noise(ctx, { color: 'white', seed: 11 });
  const hp = filter(ctx, 'highpass', 2600, 0.8);
  const ng = gain(ctx, 0);
  crackle(ng.gain, t, { count: 9, window: dur * 0.8, peak: 0.32, decay: 0.012, rng });
  chain(nz, hp, ng, body);

  const sources = [saw, rmOsc, sub, nz];
  startAll(sources, t, t + dur + 0.12);
  return { duration: dur + 0.15, sources, pitch: [saw.detune, sub.detune] };
}

export function synthParticleCannon(ctx, out, t, opts = {}, rng) {
  const power = clamp(opts.power ?? 1, 0.3, 3);
  const dur = (0.38 + rng() * 0.09) * Math.pow(power, 0.25);
  const root = (196 + rng() * 40) * Math.pow(power, -0.25);

  const body = gain(ctx, 0);
  hit(body.gain, t, 0.62, 0.008, dur);
  body.connect(out);

  // Wave-folded noise: folding turns hiss into a gritty, harmonically dense
  // texture that a plain filter sweep cannot produce.
  const nz = noise(ctx, { color: 'white', seed: 17 });
  const fold = shaper(ctx, 'fold', 0.85);
  const bp = filter(ctx, 'bandpass', 3800, 3);
  ramp(bp.frequency, t, [[0, 4200], [dur, 520]], 'exp');
  const ng = gain(ctx, 0.55);
  chain(nz, fold, bp, ng, body);

  // Two detuned triangles a fifth apart, tremolo'd at 38 Hz — the "energy" core.
  const trem = osc(ctx, 'sine', 34 + rng() * 12);
  const tg = gain(ctx, 0.45);
  const tremGain = gain(ctx, 0.55);
  trem.connect(tg).connect(tremGain.gain);

  const oA = osc(ctx, 'triangle', root, -7);
  const oB = osc(ctx, 'triangle', root * 1.5, +9);
  ramp(oA.frequency, t, [[0, root * 0.8], [0.05, root * 1.15], [dur, root * 0.55]], 'exp');
  ramp(oB.frequency, t, [[0, root * 1.2], [0.05, root * 1.72], [dur, root * 0.82]], 'exp');
  const cg = gain(ctx, 0.42);
  oA.connect(cg); oB.connect(cg);
  chain(cg, tremGain, body);

  const sources = [nz, trem, oA, oB];
  startAll(sources, t, t + dur + 0.1);
  return { duration: dur + 0.12, sources, pitch: [oA.detune, oB.detune] };
}

/** Capital-ship main gun: a mass driver dropped two octaves with a mech clank. */
export function synthTurret(ctx, out, t, opts = {}, rng) {
  const dur = 0.85 + rng() * 0.2;
  const body = gain(ctx, 0);
  const drive = shaper(ctx, 'soft', 0.5);
  const trim = gain(ctx, 0.82);          // headroom under the saturator
  chain(body, drive, trim, out);
  hit(body.gain, t, 0.8, 0.004, dur);

  const sub = osc(ctx, 'sine', 96);
  ramp(sub.frequency, t, [[0, 104], [dur * 0.9, 26]], 'exp');
  const sg = gain(ctx, 0.75);
  chain(sub, sg, body);

  const sq = osc(ctx, 'square', 140);
  ramp(sq.frequency, t, [[0, 150], [0.12, 42]], 'exp');
  const qg = gain(ctx, 0);
  hit(qg.gain, t, 0.4, 0.002, 0.22);
  chain(sq, qg, body);

  const nz = noise(ctx, { color: 'brown', seed: 23 });
  const lp = filter(ctx, 'lowpass', 1400, 1.1);
  ramp(lp.frequency, t, [[0, 2200], [dur, 180]], 'exp');
  const ng = gain(ctx, 0);
  hit(ng.gain, t, 0.7, 0.003, dur * 0.8);
  chain(nz, lp, ng, body);

  // Breech clank — a short metallic tick a beat after the report.
  const clank = osc(ctx, 'square', 620);
  const cf = filter(ctx, 'bandpass', 1800, 6);
  const cgn = gain(ctx, 0);
  hit(cgn.gain, t + 0.14, 0.16, 0.001, 0.09);
  chain(clank, cf, cgn, body);

  const sources = [sub, sq, nz, clank];
  startAll(sources, t, t + dur + 0.2);
  return { duration: dur + 0.25, sources, pitch: [sub.detune, sq.detune] };
}

/** Empty gun / no ammo: a dry mechanical click. */
export function synthDryFire(ctx, out, t, opts = {}, rng) {
  const dur = 0.07;
  const body = gain(ctx, 0);
  hit(body.gain, t, 0.35, 0.001, dur);
  body.connect(out);
  const nz = noise(ctx, { color: 'white', seed: 29 });
  const hp = filter(ctx, 'highpass', 1800, 1.2);
  chain(nz, hp, body);
  const tick = osc(ctx, 'square', 240 + rng() * 60);
  const tg = gain(ctx, 0);
  hit(tg.gain, t, 0.3, 0.0008, 0.03);
  chain(tick, tg, body);
  const sources = [nz, tick];
  startAll(sources, t, t + dur + 0.05);
  return { duration: dur + 0.05, sources, pitch: [tick.detune] };
}
