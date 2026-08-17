import * as THREE from 'three';
import { SHOT_SCENES } from './ShotScenes.js';

/**
 * Drives a deterministic capture. Called only when ?shot=<id> is present.
 *
 * The expensive part of a capture is rasterization under SwiftShader, so warm-up
 * runs with `engine.renderEnabled = false`: 20 simulated seconds of dogfight costs
 * 1200 cheap physics steps and exactly one rendered frame.
 */
export async function setupShot(game, { id, seconds = 5, seed = 1337 }) {
  const engine = game.engine;
  engine.deterministic = true;
  engine.fixedDt = 1 / 60;
  engine.stop();

  const scene = SHOT_SCENES[id];
  if (!scene) {
    window.__FATAL__ = `unknown shot scenario "${id}"`;
    window.__READY__ = true;
    return;
  }

  const ctx = { game, engine, seed, THREE };
  await scene.setup(ctx);

  const warmFrames = Math.max(1, Math.round(seconds * 60));

  // A handful of rendered frames before the shot so anything that latches on the
  // previous frame (TAA history, motion-blur velocity, MFD render targets) is warm.
  const renderedTail = 6;

  engine.renderEnabled = false;
  for (let i = 0; i < warmFrames - renderedTail; i++) {
    if (i === warmFrames - renderedTail - 1) engine.renderEnabled = true;
    engine.step(1 / 60);
    scene.tick?.(ctx, i / 60);
    // Yield periodically so the page stays responsive and Chromium does not kill us.
    if ((i & 127) === 0) await new Promise((r) => setTimeout(r, 0));
  }
  // Compose the shot BEFORE the rendered tail. A camera repositioned on the last
  // frame reads as a teleport to the velocity buffer and smears the whole image
  // through motion blur; reframing first lets TAA history and motion vectors
  // settle against a static camera.
  await scene.beforeShot?.(ctx);
  engine.post?.resetHistory?.();

  engine.renderEnabled = true;
  for (let i = 0; i < renderedTail; i++) {
    engine.step(1 / 60);
    await new Promise((r) => requestAnimationFrame(r));
  }

  engine.step(1 / 60);
  // Read the backbuffer in the SAME task as the render. The context is created
  // without preserveDrawingBuffer, so yielding to rAF first lets the compositor
  // clear it and every statistic comes back as pure black.
  const frame = readFrameStats(engine);
  await new Promise((r) => requestAnimationFrame(r));

  window.__SHOT_STATS__ = {
    ...engine.stats,
    modules: Object.keys(game.modules),
    missing: game.missing,
    ships: game.ships.length,
    frame,
  };
  window.__READY__ = true;
}

/**
 * Luminance statistics straight off the drawing buffer, read in the same task as
 * the final render so the backbuffer is still intact.
 *
 * This exists so nobody can call a scene finished while it is actually a black
 * frame, a flat grey wash, or blown out to white. The harness fails the shot on
 * these numbers, not on PNG file size.
 */
function readFrameStats(engine) {
  try {
    const gl = engine.renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    // Sample a downscaled grid rather than every pixel — cheap and just as telling.
    const step = Math.max(1, Math.floor(Math.min(w, h) / 180));
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

    let n = 0, sum = 0, sumSq = 0, dark = 0, blown = 0;
    const buckets = new Set();
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        sum += l; sumSq += l * l; n++;
        if (l < 3) dark++;
        if (l > 252) blown++;
        // Quantise to a 5-bit-per-channel bucket to count real colour variety.
        buckets.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
      }
    }
    const mean = sum / n;
    return {
      mean: +mean.toFixed(2),
      stdev: +Math.sqrt(Math.max(0, sumSq / n - mean * mean)).toFixed(2),
      darkFrac: +(dark / n).toFixed(3),
      blownFrac: +(blown / n).toFixed(3),
      distinctColors: buckets.size,
      samples: n,
    };
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
}
