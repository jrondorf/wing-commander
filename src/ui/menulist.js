/**
 * src/ui/menulist.js — a keyboard-first selectable list.
 *
 * The sim is played on a stick or a keyboard, so pointer support is the extra,
 * not the baseline: arrows move, Enter/Space commit, Escape cancels, and a
 * hover only ever *moves* the selection (it never commits) so a mouse resting
 * over the screen cannot fire an item.
 *
 * Disabled entries stay visible and stay selectable — the player needs to see
 * that "Continue" exists before there is a save to continue from — but commit
 * on one is refused and reported so the caller can play the deny blip.
 */
import { el, setClass } from './dom.js';

export function createMenuList(items, {
  className = 'wc-menu',
  itemClass = 'wc-menu__item',
  onSelect = null,
  onCommit = null,
  onCancel = null,
  wrap = true,
} = {}) {
  const root = el('ul', { class: className, role: 'menu' });
  let list = [];
  let index = 0;

  function build(next) {
    list = next.map((it) => (typeof it === 'string' ? { id: it, label: it } : { ...it }));
    root.textContent = '';
    list.forEach((it, i) => {
      const node = el('li', {
        class: itemClass,
        role: 'menuitem',
        tabindex: '-1',
        on: {
          mouseenter: () => select(i),
          click: (e) => { e.preventDefault(); select(i); commit(); },
        },
      }, [
        el('span', { text: it.label ?? it.id }),
        it.hint ? el('span.wc-menu__hint', { text: it.hint }) : null,
      ]);
      it.node = node;
      root.appendChild(node);
    });
    if (index >= list.length) index = Math.max(0, list.length - 1);
    paint();
  }

  function paint() {
    list.forEach((it, i) => {
      setClass(it.node, 'is-sel', i === index);
      setClass(it.node, 'is-disabled', it.disabled === true);
    });
  }

  function select(i, { silent = false } = {}) {
    if (!list.length) return;
    const n = list.length;
    const next = wrap ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i));
    if (next === index) { paint(); return; }
    index = next;
    paint();
    if (!silent) onSelect?.(list[index], index);
  }

  function commit() {
    const it = list[index];
    if (!it) return false;
    if (it.disabled) { onCommit?.(it, index, false); return false; }
    onCommit?.(it, index, true);
    return true;
  }

  /** Returns true when the key was consumed. */
  function handleKey(e) {
    switch (e.code) {
      case 'ArrowUp': case 'KeyW': select(index - 1); return true;
      case 'ArrowDown': case 'KeyS': select(index + 1); return true;
      case 'Home': select(0); return true;
      case 'End': select(list.length - 1); return true;
      case 'Enter': case 'NumpadEnter': case 'Space': commit(); return true;
      case 'Escape': case 'Backspace': onCancel?.(); return true;
      default: {
        const d = /^Digit([1-9])$/.exec(e.code) ?? /^Numpad([1-9])$/.exec(e.code);
        if (d) {
          const i = Number(d[1]) - 1;
          if (i < list.length) { select(i); commit(); return true; }
        }
        return false;
      }
    }
  }

  build(items);

  return {
    root,
    handleKey,
    select,
    commit,
    setItems: build,
    get items() { return list; },
    get index() { return index; },
    get current() { return list[index] ?? null; },
    /** Move to the first enabled entry — used after a rebuild changes what is live. */
    selectFirstEnabled() {
      const i = list.findIndex((it) => !it.disabled);
      if (i >= 0) select(i, { silent: true });
    },
  };
}
