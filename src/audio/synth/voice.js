/**
 * Computer voice — formant synthesis.
 *
 * No samples exist in this game, so the cockpit computer is built the way the
 * 1970s speech synths were: a glottal source (sawtooth) and a noise source,
 * gated per phoneme, pushed through a bank of three resonant bandpass filters
 * whose centre frequencies glide between vowel formant targets. Consonants are
 * the same bank retuned onto noise, with a closure gap before each stop.
 *
 * The result is deliberately robotic — which is exactly what a Confederation
 * flight computer should sound like.
 */
import { osc, gain, filter, noise, shaper, chain, ramp, startAll, clamp } from '../dsp.js';

// [F1, F2, F3, kind, amplitude]
// kind: 'v' voiced, 'n' nasal, 'f' unvoiced fricative, 'vf' voiced fricative,
//       's' stop (closure + burst), 'vs' voiced stop, 'a' aspirate
const PH = {
  aa: [730, 1090, 2440, 'v', 1.0], ae: [660, 1720, 2410, 'v', 1.0],
  ah: [640, 1190, 2390, 'v', 0.95], ao: [570, 840, 2410, 'v', 1.0],
  eh: [530, 1840, 2480, 'v', 0.95], er: [490, 1350, 1690, 'v', 0.9],
  ih: [390, 1990, 2550, 'v', 0.9], iy: [270, 2290, 3010, 'v', 0.85],
  ow: [490, 910, 2300, 'v', 0.95], uw: [300, 870, 2240, 'v', 0.85],
  uh: [440, 1020, 2240, 'v', 0.9],
  m: [250, 1100, 2200, 'n', 0.6], n: [250, 1700, 2600, 'n', 0.6],
  ng: [250, 2100, 2800, 'n', 0.55],
  l: [380, 880, 2500, 'v', 0.8], r: [310, 1060, 1380, 'v', 0.8],
  w: [300, 610, 2200, 'v', 0.75], y: [260, 2070, 3020, 'v', 0.75],
  s: [5000, 6600, 8000, 'f', 0.55], sh: [2100, 2900, 3900, 'f', 0.6],
  f: [1400, 4000, 6000, 'f', 0.35], th: [1800, 4400, 6500, 'f', 0.3],
  v: [1200, 2400, 3500, 'vf', 0.45], z: [4200, 5800, 7200, 'vf', 0.45],
  h: [500, 1500, 2500, 'a', 0.3],
  t: [3200, 5000, 6500, 's', 0.5], k: [1800, 2400, 3600, 's', 0.5],
  p: [800, 1500, 2500, 's', 0.4], d: [1800, 3000, 4000, 'vs', 0.45],
  g: [1200, 2000, 2800, 'vs', 0.45], b: [600, 1200, 2200, 'vs', 0.4],
  ch: [2400, 3200, 4200, 's', 0.55], jh: [2000, 2800, 3800, 'vs', 0.5],
};

// Diphthongs expand into two formant targets so the glide is real.
const DIPH = { ay: ['aa', 'iy'], aw: ['aa', 'uw'], oy: ['ao', 'iy'], ey: ['eh', 'iy'], uwr: ['uw', 'er'] };

const WORDS = {
  warning: ['w', 'ao', 'r', 'n', 'ih', 'ng'],
  shields: ['sh', 'iy', 'l', 'd', 'z'],
  shield: ['sh', 'iy', 'l', 'd'],
  critical: ['k', 'r', 'ih', 't', 'ih', 'k', 'ah', 'l'],
  hull: ['h', 'ah', 'l'],
  breach: ['b', 'r', 'iy', 'ch'],
  missile: ['m', 'ih', 's', 'ay', 'l'],
  lock: ['l', 'aa', 'k'],
  locked: ['l', 'aa', 'k', 't'],
  incoming: ['ih', 'n', 'k', 'ah', 'm', 'ih', 'ng'],
  eject: ['iy', 'jh', 'eh', 'k', 't'],
  target: ['t', 'aa', 'r', 'g', 'ih', 't'],
  destroyed: ['d', 'ih', 's', 't', 'r', 'oy', 'd'],
  armor: ['aa', 'r', 'm', 'er'],
  down: ['d', 'aw', 'n'],
  enemy: ['eh', 'n', 'ah', 'm', 'iy'],
  wingman: ['w', 'ih', 'ng', 'm', 'ah', 'n'],
  failure: ['f', 'ey', 'l', 'y', 'er'],
  systems: ['s', 'ih', 's', 't', 'ah', 'm', 'z'],
  nominal: ['n', 'aa', 'm', 'ah', 'n', 'ah', 'l'],
  power: ['p', 'aw', 'er'],
  core: ['k', 'ao', 'r'],
  engine: ['eh', 'n', 'jh', 'ih', 'n'],
  afterburner: ['ae', 'f', 't', 'er', 'b', 'er', 'n', 'er'],
  engaged: ['eh', 'n', 'g', 'ey', 'jh', 'd'],
  fuel: ['f', 'y', 'uw', 'l'],
  low: ['l', 'ow'],
  autopilot: ['ao', 't', 'ow', 'p', 'ay', 'l', 'ah', 't'],
  disengaged: ['d', 'ih', 's', 'eh', 'n', 'g', 'ey', 'jh', 'd'],
};

/** The lines the flight computer can actually say. */
export const VOICE_LINES = {
  warning: ['warning'],
  'shields critical': ['shields', 'critical'],
  'shields down': ['shields', 'down'],
  'hull breach': ['warning', 'hull', 'breach'],
  'armor critical': ['armor', 'critical'],
  'missile lock': ['warning', 'missile', 'lock'],
  'incoming missile': ['incoming', 'missile'],
  eject: ['eject', 'eject'],
  'target destroyed': ['target', 'destroyed'],
  'enemy destroyed': ['enemy', 'destroyed'],
  'wingman down': ['wingman', 'down'],
  'power core critical': ['power', 'core', 'critical'],
  'engine failure': ['engine', 'failure'],
  'systems nominal': ['systems', 'nominal'],
  'afterburner engaged': ['afterburner', 'engaged'],
  'fuel low': ['fuel', 'low'],
  'autopilot engaged': ['autopilot', 'engaged'],
  'autopilot disengaged': ['autopilot', 'disengaged'],
};

export const VOICE_LINE_IDS = Object.keys(VOICE_LINES);

function expand(words) {
  const segs = [];
  for (let w = 0; w < words.length; w++) {
    const phones = WORDS[words[w]];
    if (!phones) continue;
    for (const p of phones) {
      if (DIPH[p]) {
        segs.push({ p: DIPH[p][0], glide: true });
        segs.push({ p: DIPH[p][1], glide: true });
      } else {
        segs.push({ p });
      }
    }
    if (w < words.length - 1) segs.push({ p: null, gap: 0.075 });
  }
  return segs;
}

function segDuration(kind, glide) {
  if (glide) return 0.075;
  switch (kind) {
    case 'v': return 0.115;
    case 'n': return 0.075;
    case 'f': return 0.095;
    case 'vf': return 0.08;
    case 'a': return 0.06;
    case 's': case 'vs': return 0.075;
    default: return 0.09;
  }
}

/**
 * Speak a line. `opts.line` keys VOICE_LINES; `opts.f0` sets the pitch (the
 * default is a flat, sexless 132 Hz); `opts.radio` adds comms band-limiting.
 */
export function synthVoiceLine(ctx, out, t, opts = {}, rng) {
  const words = VOICE_LINES[opts.line] ?? VOICE_LINES.warning;
  const rate = clamp(opts.rate ?? 1, 0.6, 1.8);
  const f0 = opts.f0 ?? 132;
  const segs = expand(words);

  // ---- output chain: formant bank -> saturation -> comms band --------------
  const bank = gain(ctx, 1);
  const sum = gain(ctx, 0.9);
  const sat = shaper(ctx, 'soft', opts.radio ? 0.55 : 0.28);
  const hp = filter(ctx, 'highpass', opts.radio ? 420 : 220, 0.8);
  const lp = filter(ctx, 'lowpass', opts.radio ? 3100 : 4200, 0.9);
  const outGain = gain(ctx, 0);
  chain(sum, sat, hp, lp, outGain, out);

  const F = [];
  const FG = [1.0, 0.62, 0.32];
  for (let i = 0; i < 3; i++) {
    const f = filter(ctx, 'bandpass', 500, [7, 9, 11][i]);
    const g = gain(ctx, FG[i]);
    bank.connect(f); chain(f, g, sum);
    F.push(f);
  }

  // Sources: glottal saw (voiced) and noise (unvoiced), gated per segment.
  const glottal = osc(ctx, 'sawtooth', f0);
  const glottalLp = filter(ctx, 'lowpass', 2600, 0.7);   // spectral tilt
  const vGain = gain(ctx, 0);
  chain(glottal, glottalLp, vGain, bank);

  const nz = noise(ctx, { color: 'white', seed: 233 });
  const uGain = gain(ctx, 0);
  chain(nz, uGain, bank);

  // Slight mechanical buzz — the tell that this is a machine talking.
  const buzz = osc(ctx, 'sine', 31);
  const buzzG = gain(ctx, 0.09);
  const vca = gain(ctx, 0.92);
  buzz.connect(buzzG).connect(vca.gain);
  sum.disconnect();
  chain(sum, vca, sat);

  // ---- schedule ------------------------------------------------------------
  let cur = t;
  const glideT = 0.028;
  vGain.gain.setValueAtTime(0, t);
  uGain.gain.setValueAtTime(0, t);
  outGain.gain.setValueAtTime(opts.gain ?? 0.9, t);

  for (const seg of segs) {
    if (seg.p == null) {                       // inter-word gap
      vGain.gain.setTargetAtTime(0, cur, 0.012);
      uGain.gain.setTargetAtTime(0, cur, 0.012);
      cur += seg.gap * rate;
      continue;
    }
    const def = PH[seg.p];
    if (!def) continue;
    const [f1, f2, f3, kind, amp] = def;
    const d = segDuration(kind, seg.glide) * rate;

    // Stops close first, then burst.
    if (kind === 's' || kind === 'vs') {
      vGain.gain.setTargetAtTime(0, cur, 0.008);
      uGain.gain.setTargetAtTime(0, cur, 0.008);
      cur += 0.028 * rate;
    }

    for (let i = 0; i < 3; i++) {
      const target = [f1, f2, f3][i];
      F[i].frequency.cancelScheduledValues(cur);
      F[i].frequency.setTargetAtTime(clamp(target, 60, ctx.sampleRate * 0.45), cur, glideT);
      // Fricatives and stops want wide, hissy bands; vowels want sharp ones.
      const q = (kind === 'f' || kind === 's') ? [2.2, 2.6, 3][i] : [7, 9, 11][i];
      F[i].Q.setTargetAtTime(q, cur, glideT);
    }

    const voiced = kind === 'v' || kind === 'n' || kind === 'vf' || kind === 'vs';
    const noisy = kind === 'f' || kind === 'vf' || kind === 's' || kind === 'a' || kind === 'vs';
    const vAmp = voiced ? amp * 0.5 : 0;
    const uAmp = noisy ? amp * (kind === 's' || kind === 'vs' ? 0.5 : 0.32) : 0;

    if (kind === 's' || kind === 'vs') {
      // Burst: a fast spike rather than a sustained band.
      uGain.gain.setValueAtTime(0, cur);
      uGain.gain.linearRampToValueAtTime(uAmp, cur + 0.004);
      uGain.gain.exponentialRampToValueAtTime(1e-4, cur + 0.05 * rate);
      if (voiced) {
        vGain.gain.setValueAtTime(0, cur);
        vGain.gain.linearRampToValueAtTime(vAmp, cur + 0.012);
      }
    } else {
      vGain.gain.setTargetAtTime(vAmp, cur, 0.012);
      uGain.gain.setTargetAtTime(uAmp, cur, 0.012);
    }

    // Pitch: flat with a small declination and a dip on the final syllable.
    glottal.frequency.setTargetAtTime(f0 * (1 - 0.05 * ((cur - t) / 1.6)), cur, 0.08);

    cur += d;
  }

  const tail = 0.09;
  vGain.gain.setTargetAtTime(0, cur, 0.02);
  uGain.gain.setTargetAtTime(0, cur, 0.02);
  outGain.gain.setValueAtTime(opts.gain ?? 0.9, cur);
  outGain.gain.linearRampToValueAtTime(0, cur + tail);

  const total = cur - t + tail + 0.05;
  const sources = [glottal, nz, buzz];
  startAll(sources, t, t + total);
  return { duration: total, sources, pitch: [glottal.detune] };
}

/** Estimated wall-clock length of a line, for subtitle timing by other systems. */
export function voiceLineDuration(line, rate = 1) {
  const words = VOICE_LINES[line];
  if (!words) return 0;
  let d = 0;
  for (const seg of expand(words)) {
    if (seg.p == null) { d += seg.gap * rate; continue; }
    const def = PH[seg.p];
    if (!def) continue;
    if (def[3] === 's' || def[3] === 'vs') d += 0.028 * rate;
    d += segDuration(def[3], seg.glide) * rate;
  }
  return d + 0.14;
}
