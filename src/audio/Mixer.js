/**
 * Mixer.js — bus graph, voice pool, 3D placement and doppler.
 *
 * Signal flow:
 *
 *   voice ─┬─ [distance lowpass] ─ [PannerNode HRTF] ─┐
 *          └────────────────────────────────────────┬─┴─ bus (music|sfx|engine|ui|voice)
 *                                                    │
 *                            reverb send ─ convolver ─┤
 *                                                     └─ master ─ compressor ─ out
 *
 * Design notes that matter:
 *
 *  - Space is a vacuum; Wing Commander was not silent. The distance model is
 *    *stylised*: an inverse rolloff plus a lowpass that closes with range, so a
 *    dogfight 3 km away is a muffled rumble instead of nothing.
 *  - Doppler is computed here from relative velocity along the listener→source
 *    axis, because the Web Audio doppler properties are deprecated and were
 *    removed from every engine.
 *  - Voices are pooled and capped. A 40-ship battle emits hundreds of events a
 *    second; the pool steals the cheapest voice (old, quiet, distant, low
 *    priority) rather than letting the node graph grow without bound.
 */
import { makeRng } from '../core/Rand.js';
import { gain, filter, impulseResponse, clamp, ratioToCents } from './dsp.js';

export const BUS_NAMES = ['music', 'sfx', 'engine', 'ui', 'voice'];

const SPEED_OF_SOUND = 620;      // stylised: real 343 m/s makes 500 m/s fighters comical
const DOPPLER_MIN = 0.55;
const DOPPLER_MAX = 1.85;

export function createMixer(ctx, opts = {}) {
  const rng = makeRng(opts.seed ?? 91177);
  const maxVoices = opts.maxVoices ?? 30;

  // ---- master chain --------------------------------------------------------
  const master = gain(ctx, opts.masterGain ?? 0.85);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 22;
  comp.ratio.value = 6;
  comp.attack.value = 0.004;
  comp.release.value = 0.26;
  const outGain = gain(ctx, 1.0);
  master.connect(comp);
  comp.connect(outGain);
  outGain.connect(ctx.destination);

  // ---- reverb send ---------------------------------------------------------
  const reverbSend = gain(ctx, 1);
  const convolver = ctx.createConvolver();
  convolver.buffer = impulseResponse(ctx, { seconds: 2.6, decay: 3.2, seed: 17 });
  const reverbReturn = gain(ctx, opts.reverb ?? 0.3);
  const reverbTilt = filter(ctx, 'lowpass', 3200, 0.7);
  reverbSend.connect(convolver);
  convolver.connect(reverbTilt);
  reverbTilt.connect(reverbReturn);
  reverbReturn.connect(master);

  // ---- buses ---------------------------------------------------------------
  const buses = {};
  for (const name of BUS_NAMES) {
    const g = gain(ctx, 1);
    if (name === 'voice') {
      // Comms band-limiting lives on the bus so every line gets it for free.
      const hp = filter(ctx, 'highpass', 300, 0.8);
      const lp = filter(ctx, 'lowpass', 3600, 0.9);
      const pres = filter(ctx, 'peaking', 2200, 1.2, 4);
      g.connect(hp); hp.connect(pres); pres.connect(lp); lp.connect(master);
    } else if (name === 'music') {
      const tilt = filter(ctx, 'highshelf', 6000, 0.7, -2);
      g.connect(tilt); tilt.connect(master);
    } else {
      g.connect(master);
    }
    buses[name] = g;
  }
  const busGains = { music: 0.55, sfx: 1, engine: 0.8, ui: 0.75, voice: 0.9 };
  for (const n of BUS_NAMES) buses[n].gain.value = busGains[n];

  // ---- listener ------------------------------------------------------------
  const listener = {
    pos: [0, 0, 0],
    vel: [0, 0, 0],
    fwd: [0, 0, -1],
    up: [0, 1, 0],
  };

  const active = [];
  let voiceSeq = 0;
  const lastPlay = new Map();      // id -> ctx time, for retrigger throttling
  const idCounts = new Map();      // id -> live instance count

  function setPannerPos(p, x, y, z, when) {
    if (p.positionX) {
      p.positionX.setValueAtTime(x, when);
      p.positionY.setValueAtTime(y, when);
      p.positionZ.setValueAtTime(z, when);
    } else if (p.setPosition) p.setPosition(x, y, z);
  }

  function applyListener(when) {
    const L = ctx.listener;
    if (!L) return;
    if (L.positionX) {
      L.positionX.setValueAtTime(listener.pos[0], when);
      L.positionY.setValueAtTime(listener.pos[1], when);
      L.positionZ.setValueAtTime(listener.pos[2], when);
      L.forwardX.setValueAtTime(listener.fwd[0], when);
      L.forwardY.setValueAtTime(listener.fwd[1], when);
      L.forwardZ.setValueAtTime(listener.fwd[2], when);
      L.upX.setValueAtTime(listener.up[0], when);
      L.upY.setValueAtTime(listener.up[1], when);
      L.upZ.setValueAtTime(listener.up[2], when);
    } else {
      L.setPosition?.(listener.pos[0], listener.pos[1], listener.pos[2]);
      L.setOrientation?.(listener.fwd[0], listener.fwd[1], listener.fwd[2], listener.up[0], listener.up[1], listener.up[2]);
    }
  }

  /** Muffling curve: -6 dB of bandwidth per 1.4 km. Stylised, not physical. */
  function distanceCutoff(d) {
    return clamp(19000 * Math.pow(0.5, d / 1400), 300, 20000);
  }

  function dopplerRatio(v) {
    const dx = v.pos[0] - listener.pos[0];
    const dy = v.pos[1] - listener.pos[1];
    const dz = v.pos[2] - listener.pos[2];
    const d = Math.hypot(dx, dy, dz) || 1e-3;
    const ux = dx / d, uy = dy / d, uz = dz / d;
    const vSrcAway = v.vel[0] * ux + v.vel[1] * uy + v.vel[2] * uz;
    const vLisToward = listener.vel[0] * ux + listener.vel[1] * uy + listener.vel[2] * uz;
    const r = (SPEED_OF_SOUND + vLisToward) / (SPEED_OF_SOUND + vSrcAway);
    return clamp(r, DOPPLER_MIN, DOPPLER_MAX);
  }

  /**
   * Keep score for voice stealing. Higher survives. Priority dominates, then
   * recency, then proximity — so a distant old gunshot dies before a nearby
   * engine loop.
   */
  function keepScore(v, now) {
    const age = now - v.startTime;
    const dist = v.spatial ? Math.hypot(v.pos[0] - listener.pos[0], v.pos[1] - listener.pos[1], v.pos[2] - listener.pos[2]) : 0;
    return v.priority * 1000 - Math.min(age, 20) * 6 - Math.min(dist, 12000) * 0.05 + (v.sustained ? 300 : 0);
  }

  function releaseVoice(v, when = ctx.currentTime, fade = 0.02) {
    if (v.released) return;
    v.released = true;
    try {
      v.input.gain.cancelScheduledValues(when);
      v.input.gain.setValueAtTime(Math.max(1e-4, v.input.gain.value), when);
      v.input.gain.exponentialRampToValueAtTime(1e-4, when + fade);
    } catch { /* noop */ }
    const stopAt = when + fade + 0.02;
    if (v.node?.stop) { try { v.node.stop(when); } catch { /* noop */ } }
    if (v.node?.sources) {
      for (const s of v.node.sources) { try { s.stop(stopAt); } catch { /* noop */ } }
    }
    v.teardownAt = stopAt + 0.15;
    const cnt = idCounts.get(v.id) ?? 1;
    idCounts.set(v.id, Math.max(0, cnt - 1));
  }

  function teardown(v) {
    for (const n of v.chainNodes) { try { n.disconnect(); } catch { /* noop */ } }
    if (v.node?.sources) for (const s of v.node.sources) { try { s.disconnect(); } catch { /* noop */ } }
  }

  return {
    ctx, master, buses, reverbSend, listener,
    get activeCount() { return active.length; },
    get voices() { return active; },
    rng,

    setBus(name, value) {
      const b = buses[name];
      if (!b) return false;
      b.gain.setTargetAtTime(clamp(value, 0, 4), ctx.currentTime, 0.04);
      return true;
    },
    getBus(name) { return buses[name]?.gain.value ?? 0; },
    setMaster(value) { master.gain.setTargetAtTime(clamp(value, 0, 2), ctx.currentTime, 0.04); },
    setReverb(value) { reverbReturn.gain.setTargetAtTime(clamp(value, 0, 1.5), ctx.currentTime, 0.05); },

    setListener(pos, fwd, up, vel) {
      listener.pos[0] = pos[0]; listener.pos[1] = pos[1]; listener.pos[2] = pos[2];
      listener.fwd[0] = fwd[0]; listener.fwd[1] = fwd[1]; listener.fwd[2] = fwd[2];
      listener.up[0] = up[0]; listener.up[1] = up[1]; listener.up[2] = up[2];
      if (vel) { listener.vel[0] = vel[0]; listener.vel[1] = vel[1]; listener.vel[2] = vel[2]; }
      applyListener(ctx.currentTime);
    },

    /**
     * Reserve a voice. Returns null if the pool is full of more important
     * sounds — callers must handle that (it is the normal case in a big fight).
     */
    allocate(spec) {
      const now = ctx.currentTime;
      const {
        id = 'anon', bus = 'sfx', priority = 0.5, spatial = false,
        position = null, level = 1, sustained = false,
        refDistance = 120, rolloff = 0.55, maxDistance = 30000,
        minInterval = 0, maxInstances = 0,
      } = spec;

      if (minInterval > 0) {
        const last = lastPlay.get(id) ?? -1e9;
        if (now - last < minInterval) return null;
      }
      if (maxInstances > 0 && (idCounts.get(id) ?? 0) >= maxInstances) return null;

      if (active.length >= maxVoices) {
        let worst = null, worstScore = Infinity;
        for (const v of active) {
          if (v.released) continue;
          const s = keepScore(v, now);
          if (s < worstScore) { worstScore = s; worst = v; }
        }
        const incoming = priority * 1000 + (sustained ? 300 : 0);
        if (!worst || incoming <= worstScore) return null;
        releaseVoice(worst, now, 0.03);
      }

      const input = gain(ctx, level);
      const chainNodes = [input];
      let panner = null;
      let distFilter = null;
      let tail = input;

      if (spatial && position) {
        distFilter = filter(ctx, 'lowpass', 19000, 0.7);
        panner = ctx.createPanner();
        const d = Math.hypot(position[0] - listener.pos[0], position[1] - listener.pos[1], position[2] - listener.pos[2]);
        // HRTF is the expensive one; anything past 1.5 km gets equal-power,
        // where the directional cue is inaudible anyway.
        panner.panningModel = d < 1500 ? 'HRTF' : 'equalpower';
        panner.distanceModel = 'inverse';
        panner.refDistance = refDistance;
        panner.rolloffFactor = rolloff;
        panner.maxDistance = maxDistance;
        input.connect(distFilter);
        distFilter.connect(panner);
        chainNodes.push(distFilter, panner);
        tail = panner;
      }
      tail.connect(buses[bus] ?? buses.sfx);

      const v = {
        seq: voiceSeq++, id, bus, priority, spatial: !!(spatial && position), sustained,
        input, panner, distFilter, chainNodes,
        pos: position ? [position[0], position[1], position[2]] : [0, 0, 0],
        vel: [0, 0, 0],
        follow: null, followVel: null,
        startTime: now, endTime: sustained ? Infinity : now + 1,
        released: false, teardownAt: Infinity,
        node: null, pitchBase: 0, lastRatio: 1,
      };

      if (v.spatial) {
        setPannerPos(panner, v.pos[0], v.pos[1], v.pos[2], now);
        distFilter.frequency.setValueAtTime(distanceCutoff(
          Math.hypot(v.pos[0] - listener.pos[0], v.pos[1] - listener.pos[1], v.pos[2] - listener.pos[2]),
        ), now);
      }

      lastPlay.set(id, now);
      idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
      active.push(v);
      return v;
    },

    /** Attach the synth result to a voice and set its lifetime. */
    bind(v, node, when) {
      v.node = node;
      if (node?.duration != null && Number.isFinite(node.duration)) v.endTime = when + node.duration;
      else v.endTime = Infinity;
      // Apply the spawn-time doppler immediately so a fast one-shot is shifted.
      if (v.spatial && node?.pitch?.length) this.applyDoppler(v, when, true);
      return v;
    },

    applyDoppler(v, when, immediate = false) {
      if (!v.node?.pitch?.length) return;
      const r = dopplerRatio(v);
      if (!immediate && Math.abs(r - v.lastRatio) < 0.002) return;
      v.lastRatio = r;
      const cents = ratioToCents(r);
      for (const p of v.node.pitch) {
        if (!p) continue;
        if (immediate) p.setValueAtTime(cents, when);
        else p.setTargetAtTime(cents, when, 0.045);
      }
    },

    stop(v, when = ctx.currentTime) {
      if (!v) return;
      let fade = 0.02;
      if (v.node?.stop) {
        const r = v.node.stop(when);
        if (typeof r === 'number') fade = r;
        v.released = true;
        v.teardownAt = when + fade + 0.2;
        const cnt = idCounts.get(v.id) ?? 1;
        idCounts.set(v.id, Math.max(0, cnt - 1));
        return;
      }
      releaseVoice(v, when, fade);
    },

    stopAll(when = ctx.currentTime) {
      for (const v of active.slice()) this.stop(v, when);
    },

    /** Per-frame: follow moving sources, re-place, doppler, and reap. */
    update(dt, now) {
      for (let i = active.length - 1; i >= 0; i--) {
        const v = active[i];

        if (v.spatial && !v.released) {
          if (v.follow) {
            const p = readPosition(v.follow);
            if (p) {
              if (dt > 1e-4) {
                // Prefer a supplied velocity; fall back to finite difference.
                const sv = readVelocity(v.follow);
                if (sv) { v.vel[0] = sv[0]; v.vel[1] = sv[1]; v.vel[2] = sv[2]; }
                else {
                  v.vel[0] = (p[0] - v.pos[0]) / dt;
                  v.vel[1] = (p[1] - v.pos[1]) / dt;
                  v.vel[2] = (p[2] - v.pos[2]) / dt;
                }
              }
              v.pos[0] = p[0]; v.pos[1] = p[1]; v.pos[2] = p[2];
            }
          }
          setPannerPos(v.panner, v.pos[0], v.pos[1], v.pos[2], now);
          const d = Math.hypot(v.pos[0] - listener.pos[0], v.pos[1] - listener.pos[1], v.pos[2] - listener.pos[2]);
          v.distFilter.frequency.setTargetAtTime(distanceCutoff(d), now, 0.08);
          if (v.sustained || v.follow) this.applyDoppler(v, now);
        }

        if (!v.released && now >= v.endTime) releaseVoice(v, now, 0.03);
        if (v.released && now >= v.teardownAt) {
          teardown(v);
          active.splice(i, 1);
        }
      }
    },

    dispose() {
      for (const v of active) { releaseVoice(v, ctx.currentTime, 0.005); teardown(v); }
      active.length = 0;
      idCounts.clear();
      lastPlay.clear();
      for (const n of BUS_NAMES) { try { buses[n].disconnect(); } catch { /* noop */ } }
      try { reverbSend.disconnect(); convolver.disconnect(); reverbTilt.disconnect(); reverbReturn.disconnect(); } catch { /* noop */ }
      try { master.disconnect(); comp.disconnect(); outGain.disconnect(); } catch { /* noop */ }
    },
  };
}

/** Accept a THREE.Vector3, an Object3D, a ship record, or a plain array. */
export function readPosition(src) {
  if (!src) return null;
  if (Array.isArray(src)) return src;
  if (typeof src.x === 'number') return [src.x, src.y, src.z];
  if (src.position && typeof src.position.x === 'number') return [src.position.x, src.position.y, src.position.z];
  if (src.group?.position) return [src.group.position.x, src.group.position.y, src.group.position.z];
  if (src.body?.position) return [src.body.position.x, src.body.position.y, src.body.position.z];
  if (src.mesh?.position) return [src.mesh.position.x, src.mesh.position.y, src.mesh.position.z];
  return null;
}

export function readVelocity(src) {
  if (!src || Array.isArray(src)) return null;
  const v = src.velocity ?? src.body?.velocity ?? src.userData?.velocity;
  if (v && typeof v.x === 'number') return [v.x, v.y, v.z];
  if (Array.isArray(v)) return v;
  return null;
}
