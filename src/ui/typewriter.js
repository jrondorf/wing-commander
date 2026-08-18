/**
 * src/ui/typewriter.js — terminal cadence.
 *
 * Briefing text does not appear, it *arrives*: a fixed character rate with a
 * pause on sentence ends, the way a teleprinter feeding a ready room would.
 * The pauses are what make it read as a transmission instead of a CSS effect —
 * a constant rate looks mechanical within two lines.
 *
 * Markup is deliberately minimal: `[[emphasis]]` wraps a span so a briefing can
 * flag a callsign or a threat without the UI parsing anything.
 */

const PAUSE = { '.': 0.30, '!': 0.32, '?': 0.32, ':': 0.20, ';': 0.14, ',': 0.09, '\n': 0.22 };

export function createTypewriter(node, { cps = 62 } = {}) {
  let full = '';
  let shown = 0;
  let hold = 0;
  let done = true;
  let onDone = null;

  function render() {
    const src = full.slice(0, Math.floor(shown));
    // Escape, then re-introduce only our own emphasis markers.
    const safe = src
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\[\[/g, '<span class="wc-em">').replace(/\]\]/g, '</span>');
    // An unterminated span (mid-emphasis) is fine — innerHTML closes it for us.
    node.innerHTML = safe + (done ? '' : '<span class="wc-cursor"></span>');
  }

  return {
    get done() { return done; },
    /** Start typing `text`. `cb` fires once the last glyph lands. */
    start(text, cb = null) {
      full = String(text ?? '');
      shown = 0; hold = 0; done = full.length === 0;
      onDone = cb;
      render();
      if (done) onDone?.();
    },
    update(dt) {
      if (done) return;
      if (hold > 0) { hold -= dt; return; }
      const before = Math.floor(shown);
      shown = Math.min(full.length, shown + cps * dt);
      const after = Math.floor(shown);
      if (after !== before) {
        for (let i = before; i < after; i++) {
          const ch = full[i];
          const p = PAUSE[ch];
          if (!p) continue;
          // A sentence end is punctuation followed by whitespace or nothing.
          // Without this, `FLTNET LINK .........` costs nine full stops' worth
          // of pause and a five-line self-test takes fifteen seconds to print.
          if ('.!?:;,'.includes(ch)) {
            const next = full[i + 1] ?? '';
            if (next && !/\s/.test(next)) continue;
            if (full[i - 1] === ch) continue;
          }
          hold = p;
          break;
        }
        render();
      }
      if (shown >= full.length) { done = true; render(); onDone?.(); onDone = null; }
    },
    /** Space-bar behaviour: dump the rest instantly. */
    finish() {
      if (done) return false;
      shown = full.length; hold = 0; done = true;
      render();
      onDone?.(); onDone = null;
      return true;
    },
  };
}
