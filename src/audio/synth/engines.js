/**
 * Engine loops. This is the sound the player hears for 100 % of the mission, so
 * it is built as a small modular synth rather than a looped drone:
 *
 *   core     — 3–4 detuned oscillators (the fundamental "note" of the drive)
 *   rush     — band-passed noise whose centre frequency tracks airspeed
 *   whine    — a high inharmonic partial: turbo-pump / plasma injector
 *   ab       — afterburner: a second noise bed through a resonant sweep
 *
 * Throttle drives pitch and the master lowpass; speed drives the rush band;
 * afterburner opens its own layer. All of it moves with setTargetAtTime, so a
 * throttle slam glides instead of clicking.
 *
 * Every ship class gets its own partial ratios and filter ranges — a Confed
 * fighter, a Nephilim manta and a carrier are recognisably different machines.
 */
import { osc, gain, filter, noise, shaper, chain, ramp, hit, startAll, clamp, lerp } from '../dsp.js';

export const ENGINE_CLASSES = {
  // Confed fighter: tight, bright, slightly aggressive turbine.
  fighter: {
    base: 82,
    partials: [[0.5, 'sine', 0.55], [1, 'sawtooth', 0.42], [1.005, 'sawtooth', 0.3], [2.01, 'square', 0.1]],
    cutoff: [520, 3600], q: 0.9,
    rush: { color: 'pink', band: [520, 2100], q: 1.5, gain: [0.06, 0.34] },
    whine: { mult: 7.03, gain: 0.055, type: 'triangle' },
    vib: { rate: 5.6, cents: 5 },
    pitchRange: [0.72, 1.34],
    drive: 0.25,
  },
  // Bomber / heavy fighter: lower, thicker, more mechanical.
  bomber: {
    base: 54,
    partials: [[0.5, 'sine', 0.7], [1, 'sawtooth', 0.5], [1.007, 'square', 0.24], [1.99, 'sawtooth', 0.12]],
    cutoff: [340, 2400], q: 1.1,
    rush: { color: 'brown', band: [280, 1300], q: 1.2, gain: [0.08, 0.4] },
    whine: { mult: 5.02, gain: 0.04, type: 'triangle' },
    vib: { rate: 3.8, cents: 7 },
    pitchRange: [0.7, 1.26],
    drive: 0.35,
  },
  // Nephilim: organic, inharmonic, breathing. Sines and triangles with heavy
  // vibrato and a wandering formant instead of a clean harmonic stack.
  alien: {
    base: 63,
    partials: [[1, 'triangle', 0.5], [1.48, 'sine', 0.34], [2.61, 'sine', 0.2], [0.501, 'sine', 0.4]],
    cutoff: [300, 2600], q: 2.6,
    rush: { color: 'pink', band: [900, 3200], q: 3.2, gain: [0.09, 0.32] },
    whine: { mult: 9.41, gain: 0.05, type: 'sine' },
    vib: { rate: 2.3, cents: 26 },
    pitchRange: [0.78, 1.42],
    drive: 0.15,
    formant: { rate: 0.23, depth: 620 },
  },
  // Capital ship: enormous, almost sub-audible, slow to respond.
  capital: {
    base: 27,
    partials: [[0.5, 'sine', 0.9], [1, 'sawtooth', 0.5], [1.004, 'sawtooth', 0.4], [1.5, 'sine', 0.16]],
    cutoff: [110, 620], q: 1.4,
    rush: { color: 'brown', band: [70, 420], q: 0.9, gain: [0.22, 0.5] },
    whine: { mult: 13.1, gain: 0.022, type: 'sine' },
    vib: { rate: 0.7, cents: 9 },
    pitchRange: [0.85, 1.12],
    drive: 0.45,
    slew: 0.7,
  },
  // Missile / torpedo motor, used by the missile thrust voice.
  missile: {
    base: 120,
    partials: [[1, 'sawtooth', 0.28], [0.5, 'sine', 0.3]],
    cutoff: [700, 2600], q: 1.0,
    rush: { color: 'brown', band: [400, 2400], q: 1.1, gain: [0.3, 0.55] },
    whine: { mult: 6.1, gain: 0.03, type: 'triangle' },
    vib: { rate: 7.5, cents: 14 },
    pitchRange: [0.9, 1.2],
    drive: 0.3,
  },
};

export function engineClassFor(classId = '', faction = '') {
  const s = `${classId} ${faction}`.toLowerCase();
  if (/carrier|cruiser|destroyer|corvette|dreadnought|capital|station|transport|frigate/.test(s)) return 'capital';
  if (/alien|nephilim|kilrathi|manta|moray|devil|squid|wasp/.test(s)) return 'alien';
  if (/bomber|torpedo|heavy|devastator|longbow/.test(s)) return 'bomber';
  return 'fighter';
}

/**
 * A sustained engine voice.
 * Returns `set({ throttle, speed, afterburner })` for per-frame parameter drive.
 */
export function synthEngineLoop(ctx, out, t, opts = {}, rng) {
  const cfg = ENGINE_CLASSES[opts.shipClass] ?? ENGINE_CLASSES.fighter;
  const slew = cfg.slew ?? 0.14;
  const level = opts.gain ?? 1;
  const maxSpeed = opts.maxSpeed ?? 500;

  const bus = gain(ctx, 0);
  const drive = shaper(ctx, 'soft', cfg.drive);
  const lp = filter(ctx, 'lowpass', cfg.cutoff[0], cfg.q);
  chain(bus, drive, lp, out);
  ramp(bus.gain, t, [[0, 1e-4], [0.45, level]], 'exp');

  const sources = [];
  const pitch = [];
  const coreOscs = [];

  // ---- core stack -----------------------------------------------------------
  const core = gain(ctx, 0.5);
  core.connect(bus);
  for (const [mult, type, g] of cfg.partials) {
    const f = cfg.base * mult;
    const o = osc(ctx, type, f, (rng() * 2 - 1) * 6);
    const og = gain(ctx, g);
    chain(o, og, core);
    coreOscs.push({ o, f });
    sources.push(o);
    pitch.push(o.detune);
  }

  // Vibrato / flutter — engines are never perfectly steady.
  const vib = osc(ctx, 'sine', cfg.vib.rate * (0.9 + rng() * 0.2));
  const vibG = gain(ctx, cfg.vib.cents);
  vib.connect(vibG);
  for (const { o } of coreOscs) vibG.connect(o.detune);
  sources.push(vib);

  // ---- airspeed rush --------------------------------------------------------
  const rz = noise(ctx, { color: cfg.rush.color, seed: 101 + Math.floor(rng() * 40) });
  const rbp = filter(ctx, 'bandpass', cfg.rush.band[0], cfg.rush.q);
  const rg = gain(ctx, cfg.rush.gain[0]);
  chain(rz, rbp, rg, bus);
  sources.push(rz);
  if (rz.detune) pitch.push(rz.detune);

  // Alien engines get a slow wandering formant so the drone sounds alive.
  let formantLfo = null;
  if (cfg.formant) {
    formantLfo = osc(ctx, 'sine', cfg.formant.rate);
    const fg = gain(ctx, cfg.formant.depth);
    formantLfo.connect(fg).connect(rbp.frequency);
    sources.push(formantLfo);
  }

  // ---- whine ---------------------------------------------------------------
  const wo = osc(ctx, cfg.whine.type, cfg.base * cfg.whine.mult);
  const wf = filter(ctx, 'bandpass', cfg.base * cfg.whine.mult, 4);
  const wg = gain(ctx, cfg.whine.gain);
  chain(wo, wf, wg, bus);
  sources.push(wo);
  pitch.push(wo.detune);

  // ---- afterburner ---------------------------------------------------------
  const abz = noise(ctx, { color: 'white', seed: 137 });
  const abLp = filter(ctx, 'lowpass', 400, 7.5);       // resonant: the "roar"
  const abBp = filter(ctx, 'bandpass', 1600, 0.7);
  const abShape = shaper(ctx, 'soft', 0.5);
  const abG = gain(ctx, 0);
  chain(abz, abLp, abBp, abShape, abG, bus);
  sources.push(abz);
  const abSub = osc(ctx, 'sine', cfg.base * 0.5);
  const abSubG = gain(ctx, 0);
  chain(abSub, abSubG, bus);
  sources.push(abSub);

  startAll(sources, t);

  const state = { throttle: opts.throttle ?? 0.35, speed: opts.speed ?? 0, afterburner: opts.afterburner ?? 0 };

  function apply(when) {
    const th = clamp(state.throttle, 0, 1);
    const ab = clamp(state.afterburner, 0, 1);
    const spd = clamp(state.speed / maxSpeed, 0, 1.6);
    const drivePitch = lerp(cfg.pitchRange[0], cfg.pitchRange[1], clamp(th * 0.75 + spd * 0.25 + ab * 0.22, 0, 1));

    for (const { o, f } of coreOscs) o.frequency.setTargetAtTime(f * drivePitch, when, slew);
    wo.frequency.setTargetAtTime(cfg.base * cfg.whine.mult * drivePitch, when, slew);
    wf.frequency.setTargetAtTime(cfg.base * cfg.whine.mult * drivePitch, when, slew);
    wg.gain.setTargetAtTime(cfg.whine.gain * (0.4 + th * 0.9 + ab * 0.5), when, slew);

    lp.frequency.setTargetAtTime(lerp(cfg.cutoff[0], cfg.cutoff[1], Math.pow(th, 0.7) * 0.8 + ab * 0.2), when, slew);

    rbp.frequency.setTargetAtTime(lerp(cfg.rush.band[0], cfg.rush.band[1], clamp(spd, 0, 1)), when, slew);
    rg.gain.setTargetAtTime(lerp(cfg.rush.gain[0], cfg.rush.gain[1], clamp(spd * 0.7 + th * 0.3, 0, 1)), when, slew);

    // Afterburner: a resonant lowpass climbing with the burn, plus sub weight.
    abG.gain.setTargetAtTime(ab * 0.55, when, 0.09);
    abLp.frequency.setTargetAtTime(lerp(240, 2400, ab), when, 0.12);
    abSubG.gain.setTargetAtTime(ab * 0.22, when, 0.12);
  }
  apply(t);

  return {
    duration: Infinity,
    sources,
    pitch,
    set(p, when = ctx.currentTime) {
      if (p.throttle != null) state.throttle = p.throttle;
      if (p.speed != null) state.speed = p.speed;
      if (p.afterburner != null) state.afterburner = p.afterburner;
      apply(when);
    },
    stop(when = ctx.currentTime) {
      const r = 0.3;
      bus.gain.cancelScheduledValues(when);
      bus.gain.setValueAtTime(Math.max(1e-4, bus.gain.value), when);
      bus.gain.exponentialRampToValueAtTime(1e-4, when + r);
      for (const s of sources) { try { s.stop(when + r + 0.05); } catch { /* noop */ } }
      return r + 0.1;
    },
  };
}

/**
 * Afterburner ignition — a real transient, not a fade-in: a fuel-dump thump, a
 * noise flare, and a resonant sweep climbing through the spectrum.
 */
export function synthAfterburnerIgnite(ctx, out, t, opts = {}, rng) {
  const dur = 0.85;
  const bus = gain(ctx, 0.9);
  const drive = shaper(ctx, 'soft', 0.45);
  chain(bus, drive, out);

  // Ignition thump.
  const thump = osc(ctx, 'sine', 130);
  ramp(thump.frequency, t, [[0, 150], [0.28, 42]], 'exp');
  const tg = gain(ctx, 0);
  hit(tg.gain, t, 0.7, 0.006, 0.34);
  chain(thump, tg, bus);

  // Flare: broadband noise clamped by a resonant lowpass that sweeps up as the
  // burn stabilises.
  const nz = noise(ctx, { color: 'white', seed: 149 });
  const lp = filter(ctx, 'lowpass', 220, 9);
  ramp(lp.frequency, t, [[0, 200], [0.12, 2600], [dur, 1500]], 'exp');
  const ng = gain(ctx, 0);
  ramp(ng.gain, t, [[0, 1e-4], [0.02, 0.6], [0.25, 0.34], [dur, 1e-4]], 'exp');
  chain(nz, lp, ng, bus);

  // Rising whistle riding the ignition.
  const w = osc(ctx, 'sawtooth', 300);
  ramp(w.frequency, t, [[0, 280], [0.3, 900]], 'exp');
  const wf = filter(ctx, 'bandpass', 700, 8);
  ramp(wf.frequency, t, [[0, 600], [0.3, 1900]], 'exp');
  const wg = gain(ctx, 0);
  ramp(wg.gain, t, [[0, 1e-4], [0.04, 0.16], [0.5, 1e-4]], 'exp');
  chain(w, wf, wg, bus);

  const sources = [thump, nz, w];
  startAll(sources, t, t + dur + 0.1);
  return { duration: dur + 0.1, sources, pitch: [thump.detune, w.detune] };
}

/** Burner cut: the roar collapsing into a hiss. */
export function synthAfterburnerCut(ctx, out, t, opts = {}, rng) {
  const dur = 0.5;
  const bus = gain(ctx, 0.7);
  bus.connect(out);
  const nz = noise(ctx, { color: 'white', seed: 151 });
  const lp = filter(ctx, 'lowpass', 2200, 5);
  ramp(lp.frequency, t, [[0, 2400], [dur, 300]], 'exp');
  const ng = gain(ctx, 0);
  ramp(ng.gain, t, [[0, 0.45], [dur, 1e-4]], 'exp');
  chain(nz, lp, ng, bus);
  const sub = osc(ctx, 'sine', 70);
  ramp(sub.frequency, t, [[0, 80], [dur, 34]], 'exp');
  const sg = gain(ctx, 0);
  hit(sg.gain, t, 0.3, 0.01, dur * 0.8);
  chain(sub, sg, bus);
  const sources = [nz, sub];
  startAll(sources, t, t + dur + 0.06);
  return { duration: dur + 0.06, sources, pitch: [sub.detune] };
}

/** Cold start spool-up, for the launch sequence. */
export function synthEngineSpool(ctx, out, t, opts = {}, rng) {
  const dur = 2.4;
  const cfg = ENGINE_CLASSES[opts.shipClass] ?? ENGINE_CLASSES.fighter;
  const bus = gain(ctx, 0);
  ramp(bus.gain, t, [[0, 1e-4], [0.5, 0.5], [dur, 0.35]], 'exp');
  bus.connect(out);

  const o = osc(ctx, 'sawtooth', cfg.base * 0.35);
  ramp(o.frequency, t, [[0, cfg.base * 0.3], [dur, cfg.base]], 'exp');
  const lp = filter(ctx, 'lowpass', 200, 3);
  ramp(lp.frequency, t, [[0, 180], [dur, 1800]], 'exp');
  chain(o, lp, bus);

  const w = osc(ctx, 'triangle', cfg.base * 2);
  ramp(w.frequency, t, [[0, cfg.base * 1.5], [dur, cfg.base * cfg.whine.mult]], 'exp');
  const wg = gain(ctx, 0);
  ramp(wg.gain, t, [[0, 1e-4], [dur, 0.09]], 'exp');
  chain(w, wg, bus);

  const nz = noise(ctx, { color: 'pink', seed: 157 });
  const bp = filter(ctx, 'bandpass', 400, 1.5);
  ramp(bp.frequency, t, [[0, 320], [dur, 1400]], 'exp');
  const ng = gain(ctx, 0);
  ramp(ng.gain, t, [[0, 1e-4], [dur * 0.6, 0.22], [dur, 0.16]], 'exp');
  chain(nz, bp, ng, bus);

  const sources = [o, w, nz];
  startAll(sources, t, t + dur + 0.1);
  return { duration: dur + 0.1, sources, pitch: [o.detune, w.detune] };
}
