/**
 * Registry — the shared cache for procedurally generated assets.
 *
 * Every generator in the codebase goes through here so a 2048² hull texture is
 * built once and reused by every ship that asks for it. Keys are strings that
 * fully describe the asset ("hull/confed/plating/2048/seed:7").
 */
export class Registry {
  constructor() {
    this.assets = new Map();
    this.stats = { hits: 0, misses: 0, bytes: 0 };
  }

  /**
   * @param {string} key fully-qualifying cache key
   * @param {() => any} factory builds the asset on a miss
   */
  get(key, factory) {
    const hit = this.assets.get(key);
    if (hit !== undefined) {
      this.stats.hits++;
      return hit;
    }
    this.stats.misses++;
    const value = factory();
    this.assets.set(key, value);
    return value;
  }

  has(key) {
    return this.assets.has(key);
  }

  set(key, value) {
    this.assets.set(key, value);
    return value;
  }

  dispose() {
    for (const value of this.assets.values()) {
      value?.dispose?.();
      if (Array.isArray(value)) for (const v of value) v?.dispose?.();
    }
    this.assets.clear();
  }
}
