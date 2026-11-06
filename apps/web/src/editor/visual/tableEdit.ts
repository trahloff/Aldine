import { cellSpan, emptyRow, newRow } from './widgets/table';
import type { CellSpan, TableModel } from './widgets/table';

/**
 * The grid's row and column operations as source edits. Each is the fewest
 * changes that make the new table: cells the operation does not touch keep
 * every byte, and one operation is one transaction, so Undo takes it back in
 * one step. Offsets are relative to the table's start, like the model's.
 */

export type TableOp = 'rowAbove' | 'rowBelow' | 'colLeft' | 'colRight' | 'deleteRow' | 'deleteColumn' | 'mergeRight' | 'split';

export interface Change { from: number; to: number; insert: string }

/** An operation's changes, and the cell (row, first grid column) to focus once the grid is redrawn. */
export interface TableEdit { changes: Change[]; focus: { r: number; g: number } }

/** The first grid column of each cell of a row. */
export function cellStarts(row: CellSpan[]): number[] {
  const out: number[] = [];
  let g = 0;
  for (const cell of row) {
    out.push(g);
    g += cellSpan(cell);
  }
  return out;
}

/** The index in `row` of the cell covering grid column `g`, or -1 past the row's end. */
export function cellCovering(row: CellSpan[], g: number): number {
  const starts = cellStarts(row);
  return starts.findIndex((s, i) => s <= g && g < s + cellSpan(row[i]));
}

const lineStart = (src: string, i: number) => src.lastIndexOf('\n', i - 1) + 1;
const blankBefore = (src: string, i: number) => /^[ \t]*$/.test(src.slice(lineStart(src, i), i));
const indentOf = (src: string, i: number) => (blankBefore(src, i) ? src.slice(lineStart(src, i), i) : '');

/** The line break ending the line at `i` when only spaces (or, `comment`, a comment) follow on it; -1 otherwise. */
function lineEndAfter(src: string, i: number, comment: boolean): number {
  const nl = src.indexOf('\n', i);
  return nl >= 0 && (comment ? /^[ \t]*(?:%.*)?$/ : /^[ \t]*$/).test(src.slice(i, nl)) ? nl : -1;
}

/**
 * The spaces an empty cell's new text gets from the separators beside it
 * (`&  \\` reads `a & b \\`, not `a&  b\\`): `before` and `after` are the
 * characters around the empty cell.
 */
export function cellPadding(before: string | undefined, after: string | undefined): { lead: string; trail: string } {
  return { lead: before === '&' ? ' ' : '', trail: after === '&' || after === '\\' ? ' ' : '' };
}

/** Writing a merged cell's `n` again: it spans `delta` more columns. */
function respan(cell: CellSpan, delta: number): Change {
  const m = cell.multi!;
  return { from: m.spanAt[0], to: m.spanAt[1], insert: String(m.span + delta) };
}

/** Whether the column operations can find each grid column in the spec. */
function specMapped(model: TableModel): boolean {
  return !!model.specColumns && model.specColumns.length === model.cols && model.colSpec !== null;
}

/**
 * Why `op` cannot be done at row `r`, cell `c`, in words for the person, or
 * null when it can.
 */
export function unavailable(model: TableModel, op: TableOp, r: number, c: number): string | null {
  const row = model.rows[r];
  const cell = row?.[c];
  if (!cell) return 'Choose a cell first.';
  switch (op) {
    case 'deleteRow': return model.rows.length < 2 ? 'This is the table\'s only row.' : null;
    case 'colLeft': case 'colRight': case 'deleteColumn':
      if (!specMapped(model)) return 'Change this table\'s columns in the source: its column spec does not list each column once.';
      return op === 'deleteColumn' && model.cols < 2 ? 'This is the table\'s only column.' : null;
    case 'mergeRight': {
      const next = row[c + 1];
      if (!next) return 'There is no cell on the right in this row.';
      return cell.raw || next.raw ? 'One of these cells has a comment or a line break: merge them in the source.' : null;
    }
    case 'split': return cellSpan(cell) > 1 ? null : 'This cell is not merged.';
    default: return null;
  }
}

/** A new row of empty cells above row `r`, on a line of its own where row `r` starts one. */
function rowAbove(model: TableModel, src: string, r: number): Change[] {
  const at = model.rows[r][0].from;
  const cells = emptyRow(model.cols);
  if (blankBefore(src, at)) {
    const ls = lineStart(src, at);
    return [{ from: ls, to: ls, insert: `${indentOf(src, at)}${cells}\n` }];
  }
  return [{ from: at, to: at, insert: `${cells} ` }];
}

/** A new row of empty cells below row `r`: after its `\\`, on the next line where its line ends there. */
function rowBelow(model: TableModel, src: string, r: number): Change[] {
  const brk = model.breaks[r];
  if (r === model.rows.length - 1 || !brk) return model.addRow.map((c) => ({ from: c.from, to: c.from, insert: c.insert }));
  const cells = emptyRow(model.cols);
  const nl = lineEndAfter(src, brk[1], true);
  if (nl >= 0) return [{ from: nl, to: nl, insert: `\n${indentOf(src, model.rows[r][0].from)}${cells}` }];
  return [{ from: brk[1], to: brk[1], insert: ` ${cells}` }];
}

/** Row `r` with its `\\`, and its line when it has one to itself. Rules and comments around it stay. */
function deleteRow(model: TableModel, src: string, r: number): Change[] {
  const row = model.rows[r];
  let from = row[0].from;
  const brk = model.breaks[r];
  if (brk) {
    let to = brk[1];
    const nl = lineEndAfter(src, to, false);
    if (blankBefore(src, from) && nl >= 0) {
      from = lineStart(src, from);
      to = nl + 1;
    } else {
      while (src[to] === ' ' || src[to] === '\t') to++;
    }
    return [{ from, to, insert: '' }];
  }
  // the last row, written without \\: the line break before it goes with it
  if (blankBefore(src, from) && lineStart(src, from) > model.body.from) from = lineStart(src, from) - 1;
  else while (from > model.body.from && /[ \t]/.test(src[from - 1])) from--;
  return [{ from, to: row[row.length - 1].to, insert: '' }];
}

/**
 * A new empty column at grid column `at`, typed like column `like` (its
 * width and `>{…}` included) and set off from its neighbours the way they
 * are from each other. A merged cell the new column falls inside widens.
 */
function insertColumn(model: TableModel, src: string, at: number, like: number): Change[] {
  const sc = model.specColumns!;
  const n = sc.length;
  const type = sc[like].text;
  const sep = (a: number, b: number) => (n >= 2 ? src.slice(sc[a].to, sc[b].from) : '');
  const changes: Change[] = [];
  if (at === 0) changes.push({ from: sc[0].from, to: sc[0].from, insert: `${type}${sep(0, 1)}` });
  else if (at === n) changes.push({ from: sc[n - 1].to, to: sc[n - 1].to, insert: `${sep(n - 2, n - 1)}${type}` });
  else changes.push({ from: sc[at - 1].to, to: sc[at - 1].to, insert: `${sep(at - 1, at)}${type}` });
  for (const row of model.rows) {
    const total = cellStarts(row).reduce((_, s, i) => s + cellSpan(row[i]), 0);
    if (at > total) continue; // a short row: the new column is past its end
    if (at === total) {
      const last = row[row.length - 1];
      changes.push({ from: last.to, to: last.to, insert: ' &' });
      continue;
    }
    const k = cellCovering(row, at);
    if (cellStarts(row)[k] === at) changes.push({ from: row[k].from, to: row[k].from, insert: '& ' });
    else changes.push(respan(row[k], 1));
  }
  return changes;
}

/** Grid column `g`: its spec column, and in each row its cell (with the `&` before it) or one column of a merged cell. */
function deleteColumn(model: TableModel, src: string, g: number): Change[] {
  const sc = model.specColumns!;
  const changes: Change[] = [g < sc.length - 1
    ? { from: sc[g].from, to: sc[g + 1].from, insert: '' }
    : { from: sc[g - 1].to, to: sc[g].to, insert: '' }];
  for (const row of model.rows) {
    const k = cellCovering(row, g);
    if (k < 0) continue;
    const cell = row[k];
    if (cellSpan(cell) > 1) {
      changes.push(respan(cell, -1));
    } else if (k > 0 && k < row.length - 1) {
      // from its own & to the next one
      changes.push({ from: cell.slot[0] - 1, to: row[k + 1].slot[0] - 1, insert: '' });
    } else if (k > 0) {
      let from = cell.slot[0] - 1;
      while (from > 0 && /[ \t]/.test(src[from - 1])) from--;
      changes.push({ from, to: cell.to, insert: '' });
    } else if (row.length > 1) {
      let to = row[1].slot[0];
      while (src[to] === ' ' || src[to] === '\t') to++;
      changes.push({ from: cell.from, to, insert: '' });
    } else {
      changes.push({ from: cell.from, to: cell.to, insert: '' });
    }
  }
  return changes;
}

/**
 * The \multicolumn spec for grid columns `gs`…`ge`: the first one's
 * alignment (l, c or r; a paragraph column centres) with the rules and
 * padding that stand right of the last one, and left of the first one when
 * it is the table's first, as LaTeX reads a \multicolumn's spec.
 */
function mergedSpec(model: TableModel, src: string, gs: number, ge: number): string {
  const sc = model.specColumns;
  if (!sc || !model.colSpec || !sc[gs] || !sc[ge]) return 'c';
  const letter = /^[lcr]$/.test(sc[gs].letter) ? sc[gs].letter : 'c';
  const left = gs === 0 ? src.slice(model.colSpec.from, sc[0].from).trim() : '';
  const right = src.slice(sc[ge].to, sc[ge + 1]?.from ?? model.colSpec.to).trim();
  return `${left}${letter}${right}`;
}

const contentOf = (cell: CellSpan) => (cell.multi ? cell.multi.body.text : cell.text).trim();

/** Cell `c` and the one right of it as one \multicolumn holding both texts. */
function mergeRight(model: TableModel, src: string, r: number, c: number): Change[] {
  const row = model.rows[r];
  const a = row[c];
  const b = row[c + 1];
  const gs = cellStarts(row)[c];
  const span = cellSpan(a) + cellSpan(b);
  const spec = a.multi ? a.multi.spec : mergedSpec(model, src, gs, gs + span - 1);
  const text = [a, b].map(contentOf).filter(Boolean).join(' ');
  return [{ from: a.from, to: b.to, insert: `\\multicolumn{${span}}{${spec}}{${text}}` }];
}

/** A merged cell back to its columns: its text in the first, the others empty. */
function split(model: TableModel, r: number, c: number): Change[] {
  const cell = model.rows[r][c];
  return [{ from: cell.from, to: cell.to, insert: `${contentOf(cell)}${' &'.repeat(cellSpan(cell) - 1)}` }];
}

/** `op` at row `r`, cell `c` of `model` (whose source is `src`), or null when it is unavailable. */
export function tableEdit(model: TableModel, src: string, op: TableOp, r: number, c: number): TableEdit | null {
  if (unavailable(model, op, r, c)) return null;
  const row = model.rows[r];
  const gs = cellStarts(row)[c];
  const ge = gs + cellSpan(row[c]) - 1;
  switch (op) {
    case 'rowAbove': return { changes: rowAbove(model, src, r), focus: { r, g: gs } };
    case 'rowBelow': return { changes: rowBelow(model, src, r), focus: { r: r + 1, g: gs } };
    case 'deleteRow': return { changes: deleteRow(model, src, r), focus: { r: Math.min(r, model.rows.length - 2), g: gs } };
    case 'colLeft': return { changes: insertColumn(model, src, gs, gs), focus: { r, g: gs } };
    case 'colRight': return { changes: insertColumn(model, src, ge + 1, ge), focus: { r, g: ge + 1 } };
    case 'deleteColumn': return { changes: deleteColumn(model, src, gs), focus: { r, g: Math.min(gs, model.cols - 2) } };
    case 'mergeRight': return { changes: mergeRight(model, src, r, c), focus: { r, g: gs } };
    case 'split': return { changes: split(model, r, c), focus: { r, g: gs } };
  }
}

/**
 * Pasted cells written from row `r0`, grid column `g0` on: into the cells
 * there, onto the ends of rows that are too short, into new rows after the
 * last one and, when the paste is wider than the table, new columns (with
 * the spec). A cell inside a merged cell other than its first, or one edited
 * as source, is left as it is. `dropped`: columns that found no place,
 * because the table's column spec could not be extended.
 */
export function spreadEdit(model: TableModel, src: string, r0: number, g0: number, grid: string[][]): TableEdit & { dropped: number } {
  let width = Math.max(...grid.map((row) => row.length));
  let dropped = 0;
  let extra = Math.max(0, g0 + width - model.cols);
  if (extra && !model.colInsert) {
    dropped = extra;
    width -= extra;
    extra = 0;
  }
  const changes: Change[] = [];
  if (extra) changes.push({ from: model.colInsert!.at, to: model.colInsert!.at, insert: model.colInsert!.insert.repeat(extra) });
  model.rows.forEach((row, ri) => {
    const values = grid[ri - r0];
    if (ri < r0 || !values) return;
    const starts = cellStarts(row);
    const total = starts.reduce((_, s, i) => s + cellSpan(row[i]), 0);
    const tail: string[] = [];
    let lastWritten: { change: Change; value: string; lead: string; trail: string } | null = null;
    values.slice(0, width).forEach((value, j) => {
      const g = g0 + j;
      if (g >= total) { tail[g - total] = value; return; }
      const k = starts.indexOf(g);
      const cell = row[k];
      if (k < 0 || cell.raw) return;
      const target = cell.multi?.body ?? cell;
      const pad = target.from === target.to && value ? cellPadding(src[target.from - 1], src[target.to]) : { lead: '', trail: '' };
      const change = { from: target.from, to: target.to, insert: `${pad.lead}${value}${pad.trail}` };
      changes.push(change);
      if (k === row.length - 1 && !cell.multi) lastWritten = { change, value, ...pad };
    });
    if (!tail.length) return;
    const text = Array.from(tail, (v) => ` & ${v ?? ''}`).join('').replace(/ +$/, '');
    const last = row[row.length - 1];
    const written = lastWritten as { change: Change; value: string; lead: string; trail: string } | null;
    if (written) written.change.insert = `${written.lead}${written.value}${text}${written.trail}`;
    else changes.push({ from: last.to, to: last.to, insert: text });
  });
  const fresh = grid.slice(Math.max(0, model.rows.length - r0)).map((values) =>
    `${[...Array<string>(g0).fill(''), ...values.slice(0, width)].join(' & ').trim()} \\\\`);
  if (fresh.length) {
    const body = src.slice(model.body.from, model.body.to);
    const joined = fresh.join(body.includes('\n') ? '\n' : ' ');
    for (const c of newRow(body, model.body.from, model.body.end, model.body.unbroken, joined)) changes.push({ from: c.from, to: c.from, insert: c.insert });
  }
  return { changes, focus: { r: r0, g: g0 }, dropped };
}
