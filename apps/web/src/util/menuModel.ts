/**
 * The keyboard and placement rules of components/Menu.tsx, kept free of the
 * DOM. Indices count the rows that take focus: items, submenu items and hint
 * rows. Disabled rows take focus too, as the ARIA menu pattern recommends, so
 * a screen reader reaches them; activating one does nothing. Separators and
 * group labels are not counted.
 */

export type MenuKeyAction =
  | { type: 'focus'; index: number }
  | { type: 'activate' }
  | { type: 'open-submenu' }
  | { type: 'close-submenu' }
  | { type: 'close'; reason: 'escape' | 'tab' }
  | { type: 'typeahead'; char: string };

export interface MenuKeyState {
  /** Focusable rows in this menu. */
  count: number;
  /** The focused row, or -1 while the menu itself has focus. */
  index: number;
  /** This menu hangs from an item of another menu. */
  isSubmenu: boolean;
  /** The focused row opens a submenu. */
  onSubmenuItem: boolean;
  /** A typeahead search is in progress, so Space is part of it. */
  typing: boolean;
}

export interface KeyLike { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }

/** The next row in `dir`, wrapping at both ends; from -1 the first or the last. */
export function step(count: number, from: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (from < 0) return dir === 1 ? 0 : count - 1;
  return (from + dir + count) % count;
}

/**
 * The row a typeahead search lands on, or -1. A single letter, or the same
 * letter typed again, moves on to the next row starting with it; a longer
 * prefix may stay on the current row while it still matches.
 */
export function typeahead(labels: readonly string[], from: number, query: string): number {
  const n = labels.length;
  const q = query.toLocaleLowerCase();
  if (!n || !q) return -1;
  const repeated = q.length > 1 && [...q].every((c) => c === q[0]);
  const needle = repeated ? q[0] : q;
  const start = needle.length === 1 ? from + 1 : Math.max(from, 0);
  for (let i = 0; i < n; i++) {
    const j = (((start + i) % n) + n) % n;
    if (labels[j].trim().toLocaleLowerCase().startsWith(needle)) return j;
  }
  return -1;
}

/** What a key does in an open menu, or null to leave it to the page. */
export function menuKey(e: KeyLike, s: MenuKeyState): MenuKeyAction | null {
  switch (e.key) {
    case 'ArrowDown': return { type: 'focus', index: step(s.count, s.index, 1) };
    case 'ArrowUp': return { type: 'focus', index: step(s.count, s.index, -1) };
    case 'Home': case 'PageUp': return s.count ? { type: 'focus', index: 0 } : null;
    case 'End': case 'PageDown': return s.count ? { type: 'focus', index: s.count - 1 } : null;
    case 'ArrowRight': return s.onSubmenuItem ? { type: 'open-submenu' } : null;
    case 'ArrowLeft': return s.isSubmenu ? { type: 'close-submenu' } : null;
    case 'Escape': return s.isSubmenu ? { type: 'close-submenu' } : { type: 'close', reason: 'escape' };
    case 'Tab': return { type: 'close', reason: 'tab' };
    case 'Enter':
      if (s.index < 0) return null;
      return s.onSubmenuItem ? { type: 'open-submenu' } : { type: 'activate' };
    case ' ':
      if (s.typing) return { type: 'typeahead', char: ' ' };
      if (s.index < 0) return null;
      return s.onSubmenuItem ? { type: 'open-submenu' } : { type: 'activate' };
  }
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) return { type: 'typeahead', char: e.key };
  return null;
}

export type MenuAnchor =
  | { type: 'point'; x: number; y: number }
  | { type: 'rect'; rect: { top: number; right: number; bottom: number; left: number }; placement: 'bottom-start' | 'bottom-end' | 'right-start' };

export interface MenuPlacement { left: number; top: number; maxHeight: number; origin: string }

/** Gap between a trigger and its menu, and the menu's own padding (app.css .menu). */
const GAP = 4;
const PAD = 5;

/**
 * Where a menu of `w`×`h` goes so that it stays `margin` inside the viewport:
 * it opens down and to the right of its anchor, flips up or left when that
 * side has no room, and is clamped (and scrolls) when neither side has.
 * `origin` is the corner it grows out of.
 */
export function placeMenu(anchor: MenuAnchor, w: number, h: number, vw: number, vh: number, margin = 8): MenuPlacement {
  const maxHeight = Math.max(0, vh - 2 * margin);
  const ht = Math.min(h, maxHeight);
  let left: number;
  let top: number;
  let ox: 'left' | 'right' = 'left';
  let oy: 'top' | 'bottom' = 'top';

  if (anchor.type === 'point') {
    left = anchor.x;
    top = anchor.y;
    if (left + w > vw - margin && anchor.x - w >= margin) { left = anchor.x - w; ox = 'right'; }
    if (top + ht > vh - margin && anchor.y - ht >= margin) { top = anchor.y - ht; oy = 'bottom'; }
  } else if (anchor.placement === 'right-start') {
    const r = anchor.rect;
    left = r.right - 2;
    top = r.top - PAD;
    if (left + w > vw - margin) { left = r.left - w + 2; ox = 'right'; }
  } else {
    const r = anchor.rect;
    top = r.bottom + GAP;
    if (top + ht > vh - margin && r.top - GAP - ht >= margin) { top = r.top - GAP - ht; oy = 'bottom'; }
    if (anchor.placement === 'bottom-end') { left = r.right - w; ox = 'right'; } else left = r.left;
    if (ox === 'left' && left + w > vw - margin) { left = r.right - w; ox = 'right'; }
    if (ox === 'right' && left < margin) { left = r.left; ox = 'left'; }
  }

  left = Math.max(margin, Math.min(left, vw - margin - w));
  top = Math.max(margin, Math.min(top, vh - margin - ht));
  return { left: Math.round(left), top: Math.round(top), maxHeight, origin: `${oy} ${ox}` };
}
