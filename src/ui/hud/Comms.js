/**
 * src/ui/hud/Comms.js — the radio, on screen.
 *
 * `src/ai/chatter.js` already rate-limits transmissions at the *source* (a
 * per-pilot cooldown and a squadron-wide channel budget). This is the second
 * gate, at the *sink*: even a well-behaved radio will land two lines inside one
 * another during a furball, and a subtitle that gets overwritten mid-sentence
 * is worse than one that never played.
 *
 * ## The queue
 * - Every message gets a display duration derived from its length, floored at
 *   1.7 s so a two-word line is still readable.
 * - Arriving lines join a queue ordered by `priority` (chatter.js emits 0..3),
 *   stable within a priority so a conversation stays in order.
 * - The queue is capped. When it overflows, the lowest-priority *waiting* line
 *   is dropped — banter is expendable, "I'm hit" is not.
 * - A priority-3 line (help / eject / missile inbound) preempts a priority ≤1
 *   line that has already had 0.4 s on screen. The interrupted line is requeued
 *   only if it was itself important; banter that got cut off stays cut off,
 *   which is exactly how a real net behaves.
 * - Identical text from the same speaker inside 1.5 s is dropped outright.
 *
 * ## Why a portrait
 * A callsign and a line of text is information. A face that is *talking* is a
 * character. The plate redraws every frame with a mouth driven by the character
 * currently being revealed, so the speaker is visibly saying the words.
 */
import { el, clear, fitCanvas } from './../dom.js';
import { drawPortrait, portraitSpec } from './../portrait.js';

const MAX_QUEUE = 4;
const GAP = 0.12;
const DEDUPE_WINDOW = 1.5;

const TONE_CLASS = {
  panic: 'wc-comms--panic',
  urgent: 'wc-comms--urgent',
  pain: 'wc-comms--urgent',
  angry: 'wc-comms--urgent',
};

export function createComms(engine, ui) {
  const plateCanvas = el('canvas');
  const nameEl = el('span', { text: '' });
  const chanEl = el('span.wc-comms__chan', { text: 'TAC 1' });
  const vuEl = el('div.wc-comms__vu', {}, [el('i'), el('i'), el('i'), el('i'), el('i')]);
  const textEl = el('div.wc-comms__text');
  const logEl = el('div.wc-comms__log');
  const queuePips = el('div.wc-comms__queue');

  const root = el('div.wc-comms', {}, [
    el('div.wc-comms__row', {}, [
      el('div.wc-comms__plate', {}, [plateCanvas]),
      el('div.wc-comms__body', {}, [
        el('div.wc-comms__head', {}, [nameEl, vuEl, chanEl, queuePips]),
        textEl,
      ]),
    ]),
    logEl,
  ]);

  /** @type {Array<object>} */
  let queue = [];
  let current = null;
  let gap = 0;
  let t = 0;
  let level = 0;
  let enabled = true;
  let seq = 0;
  const recent = [];
  const history = [];

  function durationFor(text, priority) {
    const base = 1.05 + text.length * 0.048;
    return Math.max(1.7, Math.min(6.2, base)) + (priority >= 3 ? 0.5 : 0);
  }

  function channelFor(m) {
    if (m.priority >= 3) return 'EMERG';
    if (m.kind === 'order' || m.kind === 'broadcast') return 'CMD';
    return `TAC ${1 + (Math.abs(hash(m.from)) % 3)}`;
  }

  function hash(s) {
    let h = 0;
    for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0;
    return h;
  }

  /** Public entry point — every `comms:message` lands here. */
  function push(raw) {
    if (!raw) return;
    const text = String(raw.text ?? '').trim();
    if (!text) return;
    const from = String(raw.from ?? raw.callsign ?? 'UNKNOWN');
    const key = `${from}|${text}`;
    if (recent.some((r) => r.key === key && t - r.t < DEDUPE_WINDOW)) return;
    recent.push({ key, t });
    while (recent.length > 12) recent.shift();

    const m = {
      from,
      text,
      tone: String(raw.tone ?? 'calm'),
      priority: Number.isFinite(raw.priority) ? raw.priority : 1,
      kind: String(raw.kind ?? 'chatter'),
      faction: String(raw.ship?.faction ?? raw.faction ?? 'confed'),
      age: 0,
      seq: seq++,
    };
    m.dur = durationFor(text, m.priority);

    if (!current) { begin(m); return; }

    // Preempt: an emergency cuts across banter that has had its moment.
    if (m.priority >= 3 && current.priority <= 1 && current.age > 0.4) {
      if (current.priority >= 2) queue.unshift(current);
      begin(m);
      return;
    }

    // Insert by priority, stable within a priority band.
    let i = queue.length;
    while (i > 0 && queue[i - 1].priority < m.priority) i--;
    queue.splice(i, 0, m);

    if (queue.length > MAX_QUEUE) {
      // Drop the least important *waiting* line, newest first among equals.
      let worst = 0;
      for (let k = 1; k < queue.length; k++) {
        if (queue[k].priority < queue[worst].priority
          || (queue[k].priority === queue[worst].priority && queue[k].seq > queue[worst].seq)) worst = k;
      }
      queue.splice(worst, 1);
    }
    paintPips();
  }

  function begin(m) {
    if (current) pushHistory(current);
    current = m;
    current.age = 0;
    current.spec = portraitSpec(m.from, m.faction);
    nameEl.textContent = m.from.toUpperCase();
    chanEl.textContent = channelFor(m);
    textEl.textContent = '';
    root.className = `wc-comms ${TONE_CLASS[m.tone] ?? (m.kind === 'order' ? 'wc-comms--order' : '')}`.trim();
    root.classList.add('is-live');
    paintPips();
  }

  function pushHistory(m) {
    history.unshift({ from: m.from, text: m.text });
    while (history.length > 2) history.pop();
    clear(logEl);
    for (const h of history) {
      logEl.append(el('div', {}, [el('b', { text: `${h.from.toUpperCase()}: ` }), h.text]));
    }
  }

  function paintPips() {
    clear(queuePips);
    for (let i = 0; i < Math.min(queue.length, MAX_QUEUE); i++) queuePips.append(el('i'));
  }

  function end() {
    if (current) pushHistory(current);
    current = null;
    root.classList.remove('is-live');
    gap = GAP;
    paintPips();
  }

  function update(dt) {
    t += dt;
    if (!enabled) return;

    if (gap > 0) {
      gap -= dt;
      if (gap <= 0 && queue.length) begin(queue.shift());
    } else if (!current && queue.length) {
      begin(queue.shift());
    }

    if (!current) {
      // The log stays up after the channel goes quiet: a pilot who looked away
      // during a furball can still read the last two calls.
      level += (0 - level) * Math.min(1, dt * 10);
      drawPlate();
      return;
    }

    current.age += dt;

    // Text reveal: fast enough to be read, slow enough to look transmitted.
    const typeTime = Math.min(current.dur * 0.55, current.text.length / 72);
    const revealed = typeTime <= 0 ? current.text.length
      : Math.min(current.text.length, (current.age / typeTime) * current.text.length);
    const shown = current.text.slice(0, Math.floor(revealed));
    if (textEl.textContent !== shown) textEl.textContent = shown;

    // Mouth envelope from the character being spoken.
    const speaking = revealed < current.text.length;
    const ch = current.text[Math.floor(revealed)] ?? '';
    const vowel = /[aeiouyAEIOUY]/.test(ch);
    const target = speaking
      ? (vowel ? 0.85 : 0.35) * (0.62 + 0.38 * Math.sin(t * 23 + current.seq))
      : 0;
    level += (target - level) * Math.min(1, dt * 16);

    for (let i = 0; i < vuEl.children.length; i++) {
      const bar = vuEl.children[i];
      const a = level * (0.55 + 0.45 * Math.sin(t * (11 + i * 3.1) + i));
      bar.style.height = `${Math.round(20 + Math.max(0, a) * 80)}%`;
      bar.style.opacity = String(0.35 + Math.max(0, a) * 0.65);
    }

    if (current.age >= current.dur) end();
    drawPlate();
  }

  function drawPlate() {
    const fit = fitCanvas(plateCanvas, { maxDpr: 2 });
    if (!fit) return;
    const spec = current?.spec ?? null;
    if (!spec) { fit.ctx.clearRect(0, 0, fit.w, fit.h); return; }
    drawPortrait(fit.ctx, fit.w, fit.h, spec, t, level);
  }

  return {
    root,
    push,
    update,
    setEnabled(v) {
      enabled = !!v;
      if (!enabled) { queue.length = 0; current = null; root.classList.remove('is-live'); }
    },
    reset() {
      queue.length = 0; current = null; history.length = 0; recent.length = 0;
      clear(logEl); root.classList.remove('is-live');
    },
    get busy() { return !!current; },
    get depth() { return queue.length; },
  };
}
