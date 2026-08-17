/**
 * selftest.js — offline render harness for the whole sound catalogue.
 *
 * Every sound is rendered through an OfflineAudioContext and measured. A synth
 * that is silent, inaudible, clipping, DC-offset or NaN-poisoned fails here
 * rather than in someone's headphones. Three phases:
 *
 *   1. catalogue — each sound id rendered solo and level-checked
 *   2. mixer     — the full bus graph incl. HRTF panner, doppler and compressor
 *   3. music     — each score stem rendered for four bars and level-checked
 *
 * Run it from Node with `node src/audio/selftest.mjs` (drives headless Chromium),
 * or open `__preview.html` and press "run self-test".
 */
import { CATALOG } from './Catalog.js';
import { createMixer } from './Mixer.js';
import { createMusicDirector } from './Music.js';
import { MUSIC_STEMS } from './Music.js';
import { makeRng } from '../core/Rand.js';

const SR = 48000;

function OfflineCtx(channels, length, sampleRate) {
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OAC) throw new Error('OfflineAudioContext unavailable in this environment');
  return new OAC(channels, length, sampleRate);
}

/** Peak / RMS / clipping / DC / NaN over every channel of a rendered buffer. */
export function analyse(buf) {
  let peak = 0, sumSq = 0, sum = 0, clipped = 0, bad = 0, n = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      if (!Number.isFinite(v)) { bad++; continue; }
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      if (a >= 0.999) clipped++;
      sumSq += v * v;
      sum += v;
      n++;
    }
  }
  return {
    peak: +peak.toFixed(4),
    rms: +Math.sqrt(sumSq / Math.max(1, n)).toFixed(5),
    dc: +(sum / Math.max(1, n)).toFixed(5),
    clipped, bad, samples: n,
  };
}

function judge(name, m, spec) {
  const errs = [];
  const minPeak = spec.minPeak ?? 0.01;
  const maxPeak = spec.maxPeak ?? 0.99;
  const minRms = spec.minRms ?? 0.0005;
  const maxRms = spec.maxRms ?? 0.5;
  if (m.bad > 0) errs.push(`${m.bad} non-finite samples`);
  if (m.peak < minPeak) errs.push(`silent/too quiet: peak ${m.peak} < ${minPeak}`);
  if (m.peak > maxPeak) errs.push(`too hot: peak ${m.peak} > ${maxPeak}`);
  if (m.clipped > 0) errs.push(`${m.clipped} clipped samples`);
  if (m.rms < minRms) errs.push(`RMS ${m.rms} < ${minRms}`);
  if (m.rms > maxRms) errs.push(`RMS ${m.rms} > ${maxRms} (wall of sound)`);
  if (Math.abs(m.dc) > 0.06) errs.push(`DC offset ${m.dc}`);
  return { name, ok: errs.length === 0, ...m, errors: errs };
}

// ------------------------------------------------------------- phase 1: sounds
async function testCatalogue() {
  const results = [];
  for (const [id, entry] of Object.entries(CATALOG)) {
    const spec = entry.test ?? {};
    const dur = spec.dur ?? 2;
    try {
      const ctx = OfflineCtx(1, Math.ceil(dur * SR), SR);
      const out = ctx.createGain();
      out.gain.value = entry.level ?? 1;
      out.connect(ctx.destination);

      // Exercise the reverb-send code path without letting it colour the levels.
      let send = null;
      if (entry.send > 0) {
        send = ctx.createGain();
        send.gain.value = entry.send;
        const mute = ctx.createGain();
        mute.gain.value = 0;
        send.connect(mute);
        mute.connect(ctx.destination);
      }

      const rng = makeRng(0x1234 + id.length);
      const t0 = 0.02;
      const node = entry.synth(ctx, out, t0, { send, ...(spec.opts ?? {}) }, rng);
      if (spec.set && node?.set) node.set(spec.set, t0 + 0.05);
      // Sustained voices have to be released inside the render window or they
      // would run to the end of the buffer and never show their decay.
      const stopAt = spec.stopAt ?? (Number.isFinite(node?.duration) ? null : dur * 0.7);
      if (stopAt != null && node?.stop) node.stop(stopAt);

      const buf = await ctx.startRendering();
      results.push(judge(id, analyse(buf), spec));
    } catch (err) {
      results.push({ name: id, ok: false, errors: [`threw: ${err?.message ?? err}`] });
    }
  }
  return results;
}

// -------------------------------------------------------------- phase 2: mixer
/**
 * Renders a small battle through the real graph: two spatial voices (one moving
 * fast for doppler), one UI voice, one explosion, all through the panners, the
 * buses and the master compressor.
 */
async function testMixer() {
  const dur = 3;
  const ctx = OfflineCtx(2, Math.ceil(dur * SR), SR);
  const mixer = createMixer(ctx, { seed: 7, maxVoices: 12 });
  mixer.setListener([0, 0, 0], [0, 0, -1], [0, 1, 0], [0, 0, -120]);

  const fire = (id, pos, o = {}) => {
    const e = CATALOG[id];
    const v = mixer.allocate({
      id, bus: e.bus, priority: e.priority, spatial: e.spatial && !!pos,
      position: pos, level: e.level, sustained: e.sustained,
    });
    if (!v) return null;
    if (o.velocity) v.vel = o.velocity;
    const node = e.synth(ctx, v.input, o.at ?? 0.02, { ...(o.opts ?? {}) }, mixer.rng);
    mixer.bind(v, node, o.at ?? 0.02);
    return v;
  };

  const engineVoice = fire('engine.loop', [40, 0, -60], { opts: { shipClass: 'fighter', throttle: 0.9, speed: 420 }, velocity: [0, 0, 300] });
  fire('weapon.massdriver', [120, 10, -300]);
  fire('missile.thrust', [-200, 0, -400], { velocity: [0, 0, -650] });
  fire('explosion', [300, -40, -900], { at: 0.6, opts: { size: 3 } });
  fire('ui.lock', null, { at: 1.2 });
  fire('voice.line', null, { at: 1.5, opts: { line: 'missile lock' } });

  // Pump the mixer's per-frame update across the render window so the doppler
  // and distance-filter automation actually get written.
  for (let t = 0; t < dur; t += 1 / 60) mixer.update(1 / 60, t);
  if (engineVoice) mixer.stop(engineVoice, dur - 0.4);

  const buf = await ctx.startRendering();
  return judge('mixer/battle', analyse(buf), { minPeak: 0.05, maxPeak: 0.995, minRms: 0.005, maxRms: 0.6 });
}

// -------------------------------------------------------------- phase 3: music
async function testMusic() {
  const results = [];
  for (const stem of MUSIC_STEMS) {
    const dur = 6;
    try {
      const ctx = OfflineCtx(2, Math.ceil(dur * SR), SR);
      const out = ctx.createGain();
      out.gain.value = 1;
      out.connect(ctx.destination);
      const music = createMusicDirector(ctx, { out, send: null, seed: 20461 });
      music.start(0);
      music.setState(stem);
      for (let t = 0; t < dur; t += 0.1) music.update(0.1, t);
      const buf = await ctx.startRendering();
      results.push(judge(`music/${stem}`, analyse(buf), { minPeak: 0.02, maxPeak: 0.99, minRms: 0.003, maxRms: 0.5 }));
    } catch (err) {
      results.push({ name: `music/${stem}`, ok: false, errors: [`threw: ${err?.message ?? err}`] });
    }
  }

  // And the auto crossfade: threat swept 0 -> 1 must stay clean.
  try {
    const dur = 8;
    const ctx = OfflineCtx(2, Math.ceil(dur * SR), SR);
    const out = ctx.createGain();
    out.connect(ctx.destination);
    const music = createMusicDirector(ctx, { out, send: null, seed: 4242 });
    music.start(0);
    for (let t = 0; t < dur; t += 0.1) {
      music.setThreat(t / dur);
      music.update(0.1, t);
    }
    const buf = await ctx.startRendering();
    results.push(judge('music/crossfade', analyse(buf), { minPeak: 0.02, maxPeak: 0.99, minRms: 0.003, maxRms: 0.5 }));
  } catch (err) {
    results.push({ name: 'music/crossfade', ok: false, errors: [`threw: ${err?.message ?? err}`] });
  }
  return results;
}

export async function runSelfTest() {
  const started = Date.now();
  const catalogue = await testCatalogue();
  const mixer = [await testMixer()];
  const music = await testMusic();
  const all = [...catalogue, ...mixer, ...music];
  const failed = all.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    total: all.length,
    passed: all.length - failed.length,
    failed: failed.length,
    ms: Date.now() - started,
    results: all,
  };
}
