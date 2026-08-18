/**
 * Deterministic RNG. Every procedural generator in this project takes a seed and
 * uses these helpers — nothing calls Math.random(), so a given seed always
 * produces a byte-identical ship, texture, or asteroid field. This is what makes
 * the critic's side-by-side screenshots comparable between runs.
 */

/** Mulberry32 — small, fast, good enough distribution for art generation. */
export function makeRng(seed = 1) {
  let a = (seed >>> 0) || 1;
  const rng = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (min, max) => min + rng() * (max - min);
  rng.int = (min, max) => Math.floor(min + rng() * (max - min + 1));
  rng.sign = () => (rng() < 0.5 ? -1 : 1);
  rng.bool = (p = 0.5) => rng() < p;
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length) % arr.length];
  /** Box-Muller normal, handy for wear masks and debris velocities. */
  rng.gauss = (mean = 0, sigma = 1) => {
    let u = 0;
    while (u === 0) u = rng();
    return mean + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };
  return rng;
}

/** Hash a string into a 32-bit seed so callers can key off readable names. */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
