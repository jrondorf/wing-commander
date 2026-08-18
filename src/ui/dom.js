/**
 * src/ui/dom.js — the four DOM helpers this layer actually needs.
 *
 * Deliberately tiny. The UI is a few hundred nodes built once and mutated in
 * place; a framework here would cost more than it saves and would fight the
 * fact that everything below `#ui-root` must stay `pointer-events: none` except
 * where explicitly opted in.
 */

/**
 * Build an element.
 *
 * @param {string} tag        tag name, optionally `tag.class.class`
 * @param {object} [attrs]    `text`, `html`, `style` (object), `on` (handler map),
 *                            anything else becomes an attribute
 * @param {Array}  [children] child nodes / strings / nullish (skipped)
 */
export function el(tag, attrs = {}, children = []) {
  const [name, ...classes] = String(tag).split('.');
  const node = document.createElement(name || 'div');
  if (classes.length) node.className = classes.join(' ');

  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'text') node.textContent = String(v);
    else if (k === 'html') node.innerHTML = String(v);
    else if (k === 'class') node.className = `${node.className} ${v}`.trim();
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }

  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

/** Remove every child. */
export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Add/remove a class from a truthy flag. */
export function setClass(node, name, on) {
  if (!node) return;
  node.classList.toggle(name, !!on);
}

/**
 * Size a canvas to its laid-out box at a capped device pixel ratio and return
 * the 2D context pre-scaled to CSS pixels. Returns null when the box is zero —
 * which happens on the frame a screen is created but not yet laid out, and
 * silently produced 0×0 nav maps until this guard existed.
 */
export function fitCanvas(canvas, { maxDpr = 1.75 } = {}) {
  if (!canvas) return null;
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width));
  const h = Math.max(1, Math.round(r.height));
  if (r.width < 2 || r.height < 2) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h, dpr };
}

/** Roman numerals, for mission numbering. Small range is all we ever need. */
export function roman(n) {
  const table = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let v = Math.max(0, Math.round(n));
  let out = '';
  for (const [val, sym] of table) while (v >= val) { out += sym; v -= val; }
  return out || '0';
}

/** `1234` -> `1.23 km`, `840` -> `840 m`. Nav maps and briefings both want this. */
export function fmtDistance(metres) {
  const m = Math.abs(Number(metres) || 0);
  if (m >= 1e6) return `${(m / 1e6).toFixed(2)} Mm`;
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km`;
  return `${Math.round(m)} m`;
}

/** `93.4` -> `01:33`. */
export function fmtClock(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
