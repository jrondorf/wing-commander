/**
 * Minimal synchronous event bus. Cross-module signalling only — never use it for
 * per-frame data flow (that goes through systems and shared component arrays).
 *
 * Handlers fire in registration order. Emitting during a handler is safe: the
 * listener list is snapshotted before dispatch.
 */
export class Events {
  constructor() {
    this.handlers = new Map();
    this.debug = false;
  }

  on(type, fn) {
    let list = this.handlers.get(type);
    if (!list) this.handlers.set(type, (list = []));
    list.push(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (payload) => { off(); fn(payload); });
    return off;
  }

  off(type, fn) {
    const list = this.handlers.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit(type, payload) {
    if (this.debug) console.debug('[event]', type, payload);
    const list = this.handlers.get(type);
    if (!list || list.length === 0) return;
    for (const fn of list.slice()) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[events] handler for "${type}" threw:`, err);
      }
    }
  }

  clear() { this.handlers.clear(); }
}
