/**
 * src/flight/util.js — tiny scalar helpers shared by the flight modules.
 *
 * Everything here is pure and allocation-free so it can be called inside the
 * substep loop without producing garbage. No `Math.random()` anywhere in
 * `src/flight/**` — the integrator has to be bit-reproducible (ARCHITECTURE §1.3).
 */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const clamp11 = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);

/** Hermite smoothstep on the unit interval. */
export function smoothstep(t) {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** Remap `v` from [a,b] to [0,1], smoothed. */
export function smoothRange(v, a, b) {
  if (b === a) return v >= b ? 1 : 0;
  return smoothstep((v - a) / (b - a));
}

/**
 * Frame-rate independent exponential decay factor.
 * `x *= expDecay(rate, dt)` decays x with time-constant 1/rate regardless of dt.
 */
export function expDecay(rate, dt) {
  return Math.exp(-rate * dt);
}

/** Same thing expressed as a time constant (seconds) instead of a rate. */
export function tauDecay(tau, dt) {
  if (!(tau > 0)) return 0;
  if (tau > 1e6) return 1;
  return Math.exp(-dt / tau);
}

/** Move `cur` toward `target` by at most `maxDelta`, never overshooting. */
export function moveToward(cur, target, maxDelta) {
  const d = target - cur;
  if (d > maxDelta) return cur + maxDelta;
  if (d < -maxDelta) return cur - maxDelta;
  return target;
}

/**
 * Stick response shaping. `expo` blends a linear curve with |x|^power so small
 * deflections are gentle and the outer travel is still full-authority. This is
 * what stops mouse/gamepad flight from feeling like dragging a cursor.
 */
export function shapeAxis(x, expo, power) {
  const a = Math.abs(clamp11(x));
  if (a === 0) return 0;
  const curved = Math.pow(a, power);
  return sign(x) * (expo * curved + (1 - expo) * a);
}

/** Apply a symmetric deadzone and rescale the remaining travel to [0,1]. */
export function deadzone(x, dz) {
  const a = Math.abs(x);
  if (a <= dz) return 0;
  return sign(x) * ((a - dz) / (1 - dz));
}
