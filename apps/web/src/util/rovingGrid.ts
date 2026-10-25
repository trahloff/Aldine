/**
 * Arrow-key movement through a grid that wraps to the window and may be cut
 * into sections: the rows are read off the items' positions on screen, not
 * off the DOM, so Up and Down follow the visual columns across section
 * headings. Pure, so it can be tested without a layout engine.
 */

export interface ItemBox { top: number; left: number; width: number }

/** Items whose tops are this close sit on one row. */
const ROW_SLOP = 4;

/** The items' row numbers, in reading order. */
export function rowsOf(boxes: readonly ItemBox[]): number[] {
  const rows: number[] = [];
  let row = -1;
  let top = -Infinity;
  for (const b of boxes) {
    if (Math.abs(b.top - top) > ROW_SLOP) { row += 1; top = b.top; }
    rows.push(row);
  }
  return rows;
}

export type GridKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

export function isGridKey(key: string): key is GridKey {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End';
}

/**
 * The item a key moves to from `from`, or `from` itself at an edge. Left and
 * Right step through reading order (into the next or previous row), Up and
 * Down go to the item in the next row whose centre is nearest, Home and End
 * to the first and last item.
 */
export function gridMove(boxes: readonly ItemBox[], from: number, key: GridKey): number {
  const n = boxes.length;
  if (!n) return -1;
  if (from < 0 || from >= n) return 0;
  switch (key) {
    case 'Home': return 0;
    case 'End': return n - 1;
    case 'ArrowLeft': return Math.max(0, from - 1);
    case 'ArrowRight': return Math.min(n - 1, from + 1);
  }
  const rows = rowsOf(boxes);
  const target = rows[from] + (key === 'ArrowDown' ? 1 : -1);
  const centre = boxes[from].left + boxes[from].width / 2;
  let best = from;
  let bestDist = Infinity;
  for (let i = 0; i < n; i++) {
    if (rows[i] !== target) continue;
    const d = Math.abs(boxes[i].left + boxes[i].width / 2 - centre);
    if (d < bestDist) { best = i; bestDist = d; }
  }
  return best;
}
