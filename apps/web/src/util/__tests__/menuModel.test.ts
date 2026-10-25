import { describe, expect, it } from 'vitest';
import { menuKey, placeMenu, step, typeahead, type MenuKeyState } from '../menuModel';

const state = (over: Partial<MenuKeyState> = {}): MenuKeyState => ({ count: 4, index: 1, isSubmenu: false, onSubmenuItem: false, typing: false, ...over });
const key = (k: string, mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) => ({ key: k, ...mods });

describe('menu keys', () => {
  it('moves with the arrows and wraps at both ends', () => {
    expect(menuKey(key('ArrowDown'), state({ index: 1 }))).toEqual({ type: 'focus', index: 2 });
    expect(menuKey(key('ArrowDown'), state({ index: 3 }))).toEqual({ type: 'focus', index: 0 });
    expect(menuKey(key('ArrowUp'), state({ index: 0 }))).toEqual({ type: 'focus', index: 3 });
  });

  it('starts at the first or last row while the menu itself has focus', () => {
    expect(menuKey(key('ArrowDown'), state({ index: -1 }))).toEqual({ type: 'focus', index: 0 });
    expect(menuKey(key('ArrowUp'), state({ index: -1 }))).toEqual({ type: 'focus', index: 3 });
  });

  it('jumps to the ends with Home and End', () => {
    expect(menuKey(key('Home'), state())).toEqual({ type: 'focus', index: 0 });
    expect(menuKey(key('End'), state())).toEqual({ type: 'focus', index: 3 });
    expect(menuKey(key('PageDown'), state())).toEqual({ type: 'focus', index: 3 });
  });

  it('activates with Enter and Space, and swallows them with no row focused', () => {
    expect(menuKey(key('Enter'), state())).toEqual({ type: 'activate' });
    expect(menuKey(key(' '), state())).toEqual({ type: 'activate' });
    expect(menuKey(key('Enter'), state({ index: -1 }))).toEqual({ type: 'none' });
    expect(menuKey(key(' '), state({ index: -1 }))).toEqual({ type: 'none' });
  });

  it('closes on Escape and on Tab', () => {
    expect(menuKey(key('Escape'), state())).toEqual({ type: 'close', reason: 'escape' });
    expect(menuKey(key('Tab'), state())).toEqual({ type: 'close', reason: 'tab' });
  });

  it('opens a submenu with ArrowRight, Enter or Space on its item', () => {
    const onSub = state({ onSubmenuItem: true });
    expect(menuKey(key('ArrowRight'), onSub)).toEqual({ type: 'open-submenu' });
    expect(menuKey(key('Enter'), onSub)).toEqual({ type: 'open-submenu' });
    expect(menuKey(key(' '), onSub)).toEqual({ type: 'open-submenu' });
    expect(menuKey(key('ArrowRight'), state())).toBeNull();
  });

  it('leaves a submenu with ArrowLeft or Escape, back to its parent, not out of the menu', () => {
    const inSub = state({ isSubmenu: true });
    expect(menuKey(key('ArrowLeft'), inSub)).toEqual({ type: 'close-submenu' });
    expect(menuKey(key('Escape'), inSub)).toEqual({ type: 'close-submenu' });
    expect(menuKey(key('ArrowLeft'), state())).toBeNull();
  });

  it('types ahead with printable keys, Space included once a search has begun', () => {
    expect(menuKey(key('r'), state())).toEqual({ type: 'typeahead', char: 'r' });
    expect(menuKey(key(' '), state({ typing: true }))).toEqual({ type: 'typeahead', char: ' ' });
  });

  it('leaves shortcuts and other keys to the page', () => {
    expect(menuKey(key('k', { metaKey: true }), state())).toBeNull();
    expect(menuKey(key('r', { ctrlKey: true }), state())).toBeNull();
    expect(menuKey(key('F5'), state())).toBeNull();
  });
});

describe('typeahead', () => {
  const labels = ['Open', 'Open in new tab', 'Rename…', 'Duplicate', 'Download PDF', 'Delete…'];

  it('moves to the next row starting with the letter, after the current one', () => {
    expect(typeahead(labels, -1, 'd')).toBe(3);
    expect(typeahead(labels, 3, 'd')).toBe(4);
    expect(typeahead(labels, 5, 'd')).toBe(3);
  });

  it('cycles through rows with the same letter when it is typed again', () => {
    expect(typeahead(labels, 3, 'dd')).toBe(4);
  });

  it('matches a longer prefix from the current row', () => {
    expect(typeahead(labels, 3, 'do')).toBe(4);
    expect(typeahead(labels, 3, 'du')).toBe(3);
    expect(typeahead(labels, 0, 'open i')).toBe(1);
  });

  it('ignores case and finds nothing for a letter no row starts with', () => {
    expect(typeahead(labels, -1, 'R')).toBe(2);
    expect(typeahead(labels, 0, 'z')).toBe(-1);
  });

  it('has nothing to find in an empty menu', () => {
    expect(step(0, -1, 1)).toBe(-1);
    expect(typeahead([], -1, 'a')).toBe(-1);
  });
});

describe('menu placement', () => {
  const VW = 1000;
  const VH = 800;

  it('opens down and to the right of a point with room', () => {
    expect(placeMenu({ type: 'point', x: 100, y: 100 }, 200, 150, VW, VH)).toEqual({ left: 100, top: 100, maxHeight: 784, origin: 'top left' });
  });

  it('flips left and up at the window edges', () => {
    const p = placeMenu({ type: 'point', x: 950, y: 750 }, 200, 150, VW, VH);
    expect(p).toMatchObject({ left: 750, top: 600, origin: 'bottom right' });
  });

  it('is clamped inside the window when neither side has room', () => {
    const p = placeMenu({ type: 'point', x: 10, y: 100 }, 200, 900, VW, 220);
    expect(p.top).toBe(8);
    expect(p.maxHeight).toBe(204);
  });

  it('hangs from a button, and opens above it near the bottom', () => {
    const rect = { top: 40, bottom: 68, left: 300, right: 400 };
    expect(placeMenu({ type: 'rect', rect, placement: 'bottom-start' }, 220, 120, VW, VH)).toMatchObject({ left: 300, top: 72, origin: 'top left' });
    expect(placeMenu({ type: 'rect', rect, placement: 'bottom-end' }, 220, 120, VW, VH)).toMatchObject({ left: 180, top: 72, origin: 'top right' });
    const low = { top: 740, bottom: 768, left: 300, right: 400 };
    expect(placeMenu({ type: 'rect', rect: low, placement: 'bottom-start' }, 220, 120, VW, VH)).toMatchObject({ top: 616, origin: 'bottom left' });
  });

  it('keeps a button menu inside the right edge', () => {
    const rect = { top: 40, bottom: 68, left: 900, right: 990 };
    expect(placeMenu({ type: 'rect', rect, placement: 'bottom-start' }, 220, 120, VW, VH)).toMatchObject({ left: 770, origin: 'top right' });
  });

  it('opens a submenu beside its item, or on the other side when there is no room', () => {
    const item = { top: 200, bottom: 228, left: 100, right: 320 };
    expect(placeMenu({ type: 'rect', rect: item, placement: 'right-start' }, 180, 100, VW, VH)).toMatchObject({ left: 318, top: 195, origin: 'top left' });
    const nearRight = { top: 200, bottom: 228, left: 700, right: 920 };
    expect(placeMenu({ type: 'rect', rect: nearRight, placement: 'right-start' }, 180, 100, VW, VH)).toMatchObject({ left: 522, origin: 'top right' });
  });
});
