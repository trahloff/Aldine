import { describe, expect, it } from 'vitest';
import { gridMove, rowsOf, type ItemBox } from '../rovingGrid';

/** A shelf of `cols` columns, 200px apart, rows 300px apart. */
function shelf(count: number, cols: number, top = 0): ItemBox[] {
  return Array.from({ length: count }, (_, i) => ({ top: top + Math.floor(i / cols) * 300, left: (i % cols) * 200, width: 168 }));
}

describe('gridMove', () => {
  const six = shelf(10, 6); // a row of 6, then a row of 4

  it('steps through reading order with Left and Right, stopping at the ends', () => {
    expect(gridMove(six, 0, 'ArrowRight')).toBe(1);
    expect(gridMove(six, 5, 'ArrowRight')).toBe(6);
    expect(gridMove(six, 6, 'ArrowLeft')).toBe(5);
    expect(gridMove(six, 0, 'ArrowLeft')).toBe(0);
    expect(gridMove(six, 9, 'ArrowRight')).toBe(9);
  });

  it('moves by visual column with Up and Down', () => {
    expect(gridMove(six, 1, 'ArrowDown')).toBe(7);
    expect(gridMove(six, 7, 'ArrowUp')).toBe(1);
    // the short last row: the nearest column it has
    expect(gridMove(six, 5, 'ArrowDown')).toBe(9);
    expect(gridMove(six, 9, 'ArrowDown')).toBe(9);
    expect(gridMove(six, 2, 'ArrowUp')).toBe(2);
  });

  it('jumps to the ends with Home and End', () => {
    expect(gridMove(six, 4, 'Home')).toBe(0);
    expect(gridMove(six, 4, 'End')).toBe(9);
  });

  it('follows columns across section headings', () => {
    // "Today" holds 2 items, "Previous 7 days" starts lower down with 3
    const boxes = [...shelf(2, 6, 100), ...shelf(3, 6, 520)];
    expect(rowsOf(boxes)).toEqual([0, 0, 1, 1, 1]);
    expect(gridMove(boxes, 1, 'ArrowDown')).toBe(3);
    expect(gridMove(boxes, 4, 'ArrowUp')).toBe(1);
  });

  it('copes with nothing to move through', () => {
    expect(gridMove([], 0, 'ArrowDown')).toBe(-1);
    expect(gridMove(six, -1, 'ArrowDown')).toBe(0);
  });
});
