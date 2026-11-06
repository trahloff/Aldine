import { WidgetType } from '@codemirror/view';
import { yUndoManagerKeymap } from 'y-codemirror.next';
import type { EditorView } from '@codemirror/view';
import type { Text } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { nodeAt, trackRange, untrack, widgetPos } from '../positions';
import type { TrackedRange } from '../positions';
import { bibRevision, visualNotice } from '../context';
import { SOURCE_BUTTON } from '../mathPopover';
import { katexReady } from '../katex';
import { NO_MACROS, macrosUsedBy } from '../preamble';
import type { MacroSet } from '../preamble';
import { undoBoundary } from '../history';
import { cellLatex, pastedCells } from '../cellText';
import { cellPadding, cellStarts, spreadEdit, tableEdit, unavailable } from '../tableEdit';
import type { TableEdit, TableOp } from '../tableEdit';
import { renderCell } from './cell';
import type { MenuEntry } from '../../../components/Menu';

/**
 * A cell's source span. `slot` runs from the separator before the cell to
 * the one after it (spacing, rules and comments included): an open editor
 * finds its cell again by it after edits around the cell. `raw` says why the
 * cell is edited as source: a %-comment inside it (one string written back
 * would rewrite the comment) or a line break (a one-line field joins the lines).
 */
export interface CellSpan { from: number; to: number; text: string; slot: [number, number]; raw?: 'comment' | 'lines'; multi?: Multicolumn }

/**
 * A cell that is one `\multicolumn{n}{spec}{body}`: it spans `span` grid
 * columns. `spanAt` is where `n` is written; `body` is what its editor edits.
 */
export interface Multicolumn { span: number; spanAt: [number, number]; spec: string; body: { from: number; to: number; text: string } }

/** A column of the column spec: its source (`>{…}p{3cm}` included) and its type letter. */
export interface SpecColumn { from: number; to: number; text: string; letter: string }

/** Every offset is relative to the start of the tabular environment. */
export interface TableModel {
  rows: CellSpan[][];
  /** what "+ row" writes: an empty row after the last one */
  addRow: Array<{ from: number; insert: string }>;
  cols: number;
  /** column-spec interior range, for add-column */
  colSpec: { from: number; to: number } | null;
  /** what add-column writes into the spec (offset relative like the rest) */
  colInsert: { at: number; insert: string } | null;
  /** end offset of each row's last cell — where ` & ` lands for add-column */
  rowEnds: number[];
  /** each row's `\\` (with its `*` and `[len]`), null for a last row written without one */
  breaks: Array<[number, number] | null>;
  /** the spec's columns, or null where the editor can't map them (a `*{n}{…}` repeat) */
  specColumns: SpecColumn[] | null;
  /** the body between \\begin{tabular}{…} and \\end{tabular}, and where its last row ends (as newRow takes them) */
  body: { from: number; to: number; end: number; unbroken: boolean };
}

/** The grid columns a cell covers. */
export function cellSpan(cell: CellSpan): number {
  return cell.multi?.span ?? 1;
}

/** The balanced `{…}` group opening at `i`: its interior and the index after it. */
function braced(text: string, i: number): { inner: string; from: number; end: number } | null {
  if (text[i] !== '{') return null;
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\\') { j++; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return { inner: text.slice(i + 1, j), from: i + 1, end: j + 1 };
  }
  return null;
}

const skipWs = (text: string, i: number) => { while (i < text.length && /\s/.test(text[i])) i++; return i; };

/** A cell written as one `\multicolumn{n}{spec}{body}`, offsets relative to `at` (where the cell's text starts). */
export function multicolumnOf(text: string, at: number): Multicolumn | null {
  const m = /^\\multicolumn(?![A-Za-z])\s*/.exec(text);
  if (!m) return null;
  const n = braced(text, m[0].length);
  const spec = n && braced(text, skipWs(text, n.end));
  const body = spec && braced(text, skipWs(text, spec.end));
  if (!n || !spec || !body || skipWs(text, body.end) !== text.length || !/^\s*\d+\s*$/.test(n.inner)) return null;
  return {
    span: Number(n.inner),
    spanAt: [at + n.from, at + n.end - 1],
    spec: spec.inner,
    body: { from: at + body.from, to: at + body.end - 1, text: body.inner },
  };
}

/**
 * A column spec as its columns, `base` the offset of its interior. Rules
 * (`|`) and `@{…}`/`!{…}` stand between columns and belong to none; a
 * column's `>{…}`/`<{…}` and its width are its own. A `*{n}{…}` repeat
 * has no one place per column: null.
 */
export function specColumns(spec: string, base: number): SpecColumn[] | null {
  const cols: SpecColumn[] = [];
  let i = 0;
  const group = (at: number) => braced(spec, skipWs(spec, at));
  while (i < spec.length) {
    const ch = spec[i];
    if (/\s/.test(ch) || ch === '|') { i++; continue; }
    if (ch === '@' || ch === '!') {
      const g = group(i + 1);
      if (!g) return null;
      i = g.end;
      continue;
    }
    const start = i;
    while (spec[i] === '>') {
      const g = group(i + 1);
      if (!g) return null;
      i = skipWs(spec, g.end);
    }
    const letter = spec[i];
    if (!letter || !/[A-Za-z]/.test(letter)) return null;
    i++;
    if (spec[i] === '[') {
      const close = spec.indexOf(']', i);
      if (close < 0) return null;
      i = close + 1;
    }
    while (spec[i] === '{') i = braced(spec, i)?.end ?? spec.length + 1;
    if (i > spec.length) return null;
    for (let j = skipWs(spec, i); spec[j] === '<'; j = skipWs(spec, i)) {
      const g = group(j + 1);
      if (!g) return null;
      i = g.end;
    }
    cols.push({ from: base + start, to: base + i, text: spec.slice(start, i), letter });
  }
  return cols;
}

const RULE_RE = /^\\(?:hline|toprule|midrule|bottomrule|cline\{[^}]*\}|cmidrule(?:\([^)]*\))?\{[^}]*\}|addlinespace(?:\[[^\]]*\])?)\s*/;

/**
 * Scan a tabular body into cells with exact source offsets. Braces guard
 * nested `&`/`\\`; %-comments are never cells and never separate them; the
 * optional `[len]` after `\\` belongs to the row break; rule commands are
 * display-stripped. A row ended by `\\` counts even when empty; what follows
 * the last `\\` is a row only when it holds text. Anything the scanner can't
 * confidently map keeps the construct raw (caller falls back to a chip).
 */
export function parseTabular(body: string, base: number): { rows: CellSpan[][]; rowEnds: number[]; addRow: TableModel['addRow']; breaks: TableModel['breaks']; tail: { end: number; unbroken: boolean } } | null {
  const rows: CellSpan[][] = [];
  const rowEnds: number[] = [];
  const breaks: TableModel['breaks'] = [];
  const comments: Array<[number, number]> = [];
  let cells: CellSpan[] = [];
  let cellStart = 0;
  let depth = 0;
  let lastBreak = -1;
  let i = 0;
  const pushCell = (end: number) => {
    let s = cellStart;
    let e = end;
    for (;;) {
      while (s < e && /\s/.test(body[s])) s++;
      const c = comments.find(([f, t]) => f === s && t <= e);
      if (c) { s = c[1]; continue; }
      const m = RULE_RE.exec(body.slice(s, e));
      if (m) { s += m[0].length; continue; }
      break;
    }
    for (;;) {
      while (e > s && /\s/.test(body[e - 1])) e--;
      const c = comments.find(([f, t]) => t === e && f >= s);
      if (c) { e = c[0]; continue; }
      break;
    }
    const text = body.slice(s, e);
    const raw = comments.some(([f, t]) => f >= s && t <= e) ? 'comment' : /[\r\n]/.test(text) ? 'lines' : undefined;
    const multi = raw ? null : multicolumnOf(text, base + s);
    cells.push({ from: base + s, to: base + e, text, slot: [base + cellStart, base + end], ...(raw ? { raw } : {}), ...(multi ? { multi } : {}) });
  };
  const pushRow = (end: number, broken: boolean): boolean => {
    pushCell(end);
    const row = cells;
    cells = [];
    if (!broken && row.length === 1 && row[0].text === '') return false;
    rows.push(row);
    rowEnds.push(row[row.length - 1].to);
    breaks.push(null);
    return true;
  };
  while (i < body.length) {
    const ch = body[i];
    if (ch === '%') {
      const nl = body.indexOf('\n', i);
      const end = nl < 0 ? body.length : nl;
      comments.push([i, end]);
      i = end;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === '\\' && body[i + 1] === '\\' && depth === 0) {
      pushRow(i, true);
      const breakAt = i;
      i += 2;
      if (body[i] === '*') i++;
      // LaTeX looks past spaces and one line break for the [len] of \\[len]
      let j = i;
      while (body[j] === ' ' || body[j] === '\t') j++;
      if (body[j] === '\n') { j++; while (body[j] === ' ' || body[j] === '\t') j++; }
      if (body[j] === '[') {
        const close = body.indexOf(']', j);
        if (close > 0) i = close + 1;
      }
      breaks[breaks.length - 1] = [base + breakAt, base + i];
      lastBreak = i;
      cellStart = i;
      continue;
    } else if (ch === '&' && depth === 0) {
      pushCell(i);
      i += 1;
      cellStart = i;
      continue;
    } else if (ch === '\\') {
      i += 2; // skip escaped char / command intro conservatively
      continue;
    }
    i += 1;
  }
  const unbroken = pushRow(body.length, false);
  if (!rows.length) return null;
  const end = unbroken ? rowEnds[rowEnds.length - 1] - base : lastBreak;
  return { rows, rowEnds, breaks, tail: { end, unbroken }, addRow: newRow(body, base, end, unbroken, emptyRow(gridColumns(rows))) };
}

/** How many grid columns the widest row covers. */
export function gridColumns(rows: CellSpan[][]): number {
  return Math.max(...rows.map((r) => r.reduce((n, c) => n + cellSpan(c), 0)));
}

/** A row of `cols` empty cells, as "+ row" writes it: `&  \\`. */
export function emptyRow(cols: number): string {
  return `${' &'.repeat(cols - 1).replace(/&/g, ' & ').trimStart()} \\\\`;
}

/**
 * "+ row": an empty row right after the last one, so it lands inside the
 * table and above a closing rule, on a line of its own unless the table is
 * written on one line. A last row without `\\` gets one; a comment ending the
 * last row's line stays on that line. `end` is where the last row ends (after
 * its `\\` and `[len]`, or after its last cell).
 */
export function newRow(body: string, base: number, end: number, unbroken: boolean, cells: string): TableModel['addRow'] {
  const oneLine = !body.includes('\n');
  const row = oneLine ? ` ${cells.trimStart()}` : `\n${cells}`;
  const nl = body.indexOf('\n', end);
  const at = !oneLine && nl >= 0 && /^[ \t]*(?:%.*)?$/.test(body.slice(end, nl)) ? nl : end;
  if (!unbroken) return [{ from: base + at, insert: row }];
  if (at === end) return [{ from: base + end, insert: ` \\\\${row}` }];
  return [{ from: base + end, insert: ' \\\\' }, { from: base + at, insert: row }];
}

/** Start of the braced group that ends at `close` (the index of its `}`), or -1. */
function groupStart(spec: string, close: number): number {
  let depth = 0;
  for (let j = close; j >= 0; j--) {
    if (spec[j] === '}') depth++;
    else if (spec[j] === '{' && --depth === 0) return j;
  }
  return -1;
}

function skipSpaceBack(spec: string, i: number): number {
  while (i > 0 && /\s/.test(spec[i - 1])) i--;
  return i;
}

/**
 * What add-column writes into a column spec, and where: after the last
 * column, before the outer rule and padding that close the table (trailing
 * `|`, `@{…}`, `!{…}`). A braced group after anything else (`p{3cm}`) is a
 * column and ends the scan. When the last column is ruled off from the one
 * before it, the new one is too.
 */
export function specAddColumn(spec: string): { at: number; insert: string } {
  let end = spec.length;
  for (;;) {
    const i = skipSpaceBack(spec, end);
    if (i > 0 && spec[i - 1] === '|') { end = i - 1; continue; }
    if (i > 0 && spec[i - 1] === '}') {
      const open = groupStart(spec, i - 1);
      const k = skipSpaceBack(spec, open);
      if (open > 0 && (spec[k - 1] === '@' || spec[k - 1] === '!')) { end = k - 1; continue; }
    }
    end = i;
    break;
  }
  // the last column's type letter, past a p{…}/m{…}/b{…} width
  let col = end;
  if (col > 0 && spec[col - 1] === '}') {
    const open = groupStart(spec, col - 1);
    col = open > 0 ? open - 1 : 0;
  } else if (col > 0) col--;
  const before = skipSpaceBack(spec, col);
  const ruled = before > 0 && spec[before - 1] === '|';
  return { at: end, insert: ruled ? '|l' : 'l' };
}

/** A tabular node's grid model, or null when the body can't be mapped to cells. */
export function tableModel(doc: Text, node: SyntaxNode): TableModel | null {
  const begin = node.getChild('BeginEnv');
  const end = node.getChild('EndEnv');
  if (!begin || !end) return null;
  const base = node.from;
  const parsed = parseTabular(doc.sliceString(begin.to, end.from), begin.to - base);
  if (!parsed) return null;
  // The column spec is \begin{tabular}'s last braced argument (tabular*'s
  // first one is the width). Its range comes from the argument node's own
  // bounds: brace children of @{}-style specs are the inner braces.
  const spec = begin.getChildren('TextArgument').pop();
  const specOk = spec
    && doc.sliceString(spec.from, spec.from + 1) === '{'
    && doc.sliceString(spec.to - 1, spec.to) === '}';
  return {
    rows: parsed.rows,
    rowEnds: parsed.rowEnds,
    breaks: parsed.breaks,
    body: { from: begin.to - base, to: end.from - base, ...parsed.tail },
    cols: gridColumns(parsed.rows),
    addRow: parsed.addRow,
    colSpec: specOk ? { from: spec!.from + 1 - base, to: spec!.to - 1 - base } : null,
    specColumns: specOk ? specColumns(doc.sliceString(spec!.from + 1, spec!.to - 1), spec!.from + 1 - base) : null,
    colInsert: specOk ? (() => {
      const c = specAddColumn(doc.sliceString(spec!.from + 1, spec!.to - 1));
      return { at: spec!.from + 1 - base + c.at, insert: c.insert };
    })() : null,
  };
}


/** What a cell's editor edits: a merged cell's content, any other cell whole. */
export function editable(cell: CellSpan): { from: number; to: number; text: string } {
  return cell.multi?.body ?? cell;
}

/** Cell elements → their editor, so focus can move to a cell drawn by a newer
 *  widget. A cell edited as source has none: Tab passes it without opening it. */
const openers = new WeakMap<HTMLElement, (initial?: string) => void>();

/** Each grid's cell the row and column operations act on: the one focused or edited last. */
const current = new WeakMap<HTMLElement, { r: number; c: number }>();

/** A cell and where it stands in its grid: row, column, place in the Tab order. */
interface CellAt { cell: CellSpan; r: number; c: number; index: number }

type Move = 'up' | 'down' | 'left' | 'right';

/**
 * Where focus goes once an editor has written its cell: the text, the
 * next or previous cell in the Tab order, a neighbour by the arrows, or the
 * first cell of a new row (Tab in the last cell).
 */
type Then = 'view' | 'next' | 'prev' | Move | 'newRow' | null;

/**
 * The open cell editor. It knows its cell by the cell's slot, which follows
 * every edit, never by row and column: a collaborator's edit elsewhere in the
 * table redraws the grid, and the editor moves into the redrawn cell, typing
 * and all, wherever rows or cells added before it have put that cell.
 */
interface CellEditor {
  view: EditorView;
  /** the table's start, following every edit */
  anchor: TrackedRange;
  /** the cell's slot, following every edit */
  slot: TrackedRange;
  /** the slot had text when the editor opened, so an empty one now means the cell was deleted */
  slotHadText: boolean;
  pos: CellAt;
  /** the cell's text when the editor opened, or when it took a collaborator's change */
  original: string;
  /** what the field held then; any other value is an edit */
  baseline: string;
  /** what the cell showed then, put back when the editor closes */
  shown: Node[];
  /** someone else changed the cell under the person's edit: they were told, then said to replace it */
  conflict: 'none' | 'told' | 'confirmed';
  input: HTMLInputElement;
  td: HTMLElement;
  settle(write: boolean, then: Then): void;
}
let active: CellEditor | null = null;

const CONFLICT = 'Someone else changed this cell while you were editing it. Press Enter to replace their text with yours, or Escape to keep theirs.';
const BUSY = 'Someone else is changing the table around this cell. Your text stays here: press Enter once they are done, or Escape to drop it.';
const NOT_WRITTEN = {
  changed: 'was not written: someone else changed the cell while you were editing it.',
  gone: 'was not written: someone else removed the cell while you were editing it.',
};

function notWritten(outcome: keyof typeof NOT_WRITTEN, value: string): string {
  const text = value.length > 60 ? `${value.slice(0, 60)}…` : value;
  return `Your text "${text}" ${NOT_WRITTEN[outcome]}`;
}

/** The editor's cell in `model` (the table at `at`), or null when it was deleted, split or merged. */
function findCell(model: TableModel, at: number, ed: CellEditor): CellAt | null {
  const { slot } = ed;
  if (ed.slotHadText && slot.from === slot.to) return null;
  let index = 0;
  for (let r = 0; r < model.rows.length; r++) {
    for (let c = 0; c < model.rows[r].length; c++, index++) {
      const cell = model.rows[r][c];
      if (at + cell.slot[0] <= slot.from && slot.to <= at + cell.slot[1]) return { cell, r, c, index };
    }
  }
  return null;
}

/** The table at `at` as it is now: its node and model, or null when there is none there. */
function tableNow(view: EditorView, at: number): { node: SyntaxNode; model: TableModel; src: string } | null {
  const node = nodeAt(view.state, at, 'TabularEnvironment');
  const model = node && tableModel(view.state.doc, node);
  return node && model ? { node, model, src: view.state.doc.sliceString(node.from, node.to) } : null;
}

function currentCell(ed: CellEditor): CellAt | null {
  const now = tableNow(ed.view, ed.anchor.from);
  return now ? findCell(now.model, ed.anchor.from, ed) : null;
}

/**
 * Writes `value` over the editor's cell, if the cell still holds what the
 * editor opened with or the person said to replace it. What was typed is
 * escaped where it would break the table (cellLatex).
 */
function writeCell(ed: CellEditor, value: string): 'written' | 'changed' | 'gone' {
  const hit = currentCell(ed);
  if (!hit) return 'gone';
  const span = editable(hit.cell);
  if (hit.cell.raw || (span.text !== ed.original && ed.conflict !== 'confirmed')) return 'changed';
  const at = ed.anchor.from;
  const text = cellLatex(ed.original, value);
  if (span.text !== text) {
    const { doc } = ed.view.state;
    const from = at + span.from;
    const to = at + span.to;
    const pad = from === to && text ? cellPadding(doc.sliceString(from - 1, from), doc.sliceString(to, to + 1)) : { lead: '', trail: '' };
    ed.view.dispatch({ changes: { from, to, insert: `${pad.lead}${text}${pad.trail}` }, userEvent: 'input.visual' });
  }
  return 'written';
}

/**
 * Enter, Tab or an arrow out of the field. A cell someone else changed
 * meanwhile is replaced only once the person has been told; one that someone
 * is still rewriting (their new row runs into it until its `\\`) keeps the
 * editor open.
 */
function commit(ed: CellEditor, then: Exclude<Then, null>) {
  const hit = ed.input.value !== ed.baseline ? currentCell(ed) : null;
  const wrap = ed.td.closest<HTMLElement>('.cm-vis-table');
  if (hit?.cell.raw) return say(wrap, BUSY);
  if (hit && editable(hit.cell).text !== ed.original) {
    if (ed.conflict !== 'told') {
      ed.conflict = 'told';
      return say(wrap, CONFLICT);
    }
    ed.conflict = 'confirmed';
  }
  ed.settle(true, then);
}

/** Shows `text` under a grid, or as a notice of the page when the grid is gone. */
function say(wrap: HTMLElement | null, text: string) {
  const note = wrap?.isConnected ? wrap.querySelector<HTMLElement>('.cm-vis-table__notice') : null;
  if (note) note.textContent = text;
  else visualNotice(text);
}

function nameField(ed: CellEditor) {
  ed.input.setAttribute('aria-label', `Row ${ed.pos.r + 1}, column ${Number(ed.td.dataset.g ?? ed.pos.c) + 1}`);
}

function enter(td: HTMLElement, open: boolean) {
  td.focus();
  if (open) openers.get(td)?.();
}

function focusCell(view: EditorView, at: number, index: number) {
  const wrap = tableDomAt(view, at);
  const cells = wrap ? [...wrap.querySelectorAll<HTMLElement>('td')] : [];
  const target = cells[index];
  if (target) {
    enter(target, true);
  } else if (wrap && index >= cells.length) {
    wrap.querySelector<HTMLElement>('[data-testid="vis-table-addrow"]')?.focus();
  } else {
    view.focus();
  }
}

/** The cell of a grid row covering grid column `g`, or the row's last one when it is shorter. */
function cellAtColumn(tr: Element, g: number): HTMLElement {
  const tds = [...tr.children] as HTMLElement[];
  return tds.find((t) => Number(t.dataset.g) <= g && g < Number(t.dataset.g) + Number(t.dataset.span)) ?? tds[tds.length - 1];
}

/**
 * Focus (or, `open`, edit) the cell at row `r`, grid column `g` of the grid
 * drawn for the table at `at`, once it is drawn: a grid redrawn after an
 * edit can wait for the parse.
 */
function focusGrid(view: EditorView, at: number, r: number, g: number, open: boolean, tries = 0) {
  const rows = tableDomAt(view, at)?.querySelectorAll('tr');
  if (rows?.length) return enter(cellAtColumn(rows[Math.min(r, rows.length - 1)], g), open);
  if (tries < 10) requestAnimationFrame(() => focusGrid(view, at, r, g, open, tries + 1));
  else view.focus();
}

/** Out of the grid by an arrow: the caret goes before the table (with its float) or after it. */
function leaveTable(view: EditorView, at: number, above: boolean) {
  let node = nodeAt(view.state, at, 'TabularEnvironment');
  for (let n = node?.parent; n; n = n.parent) if (n.name === 'TableEnvironment') { node = n; break; }
  const anchor = !node ? at : above ? node.from : node.to;
  view.dispatch({ selection: { anchor }, scrollIntoView: true });
  view.focus();
}

/** The arrows between cells: left and right in the row, up and down in the column, and out of the grid at its top and bottom. */
function move(view: EditorView, at: number, r: number, c: number, dir: Move, open: boolean) {
  const rows = [...(tableDomAt(view, at)?.querySelectorAll('tr') ?? [])];
  const here = rows[r]?.children[c] as HTMLElement | undefined;
  if (!here) return view.focus();
  if (dir === 'left' || dir === 'right') {
    const next = rows[r].children[c + (dir === 'left' ? -1 : 1)] as HTMLElement | undefined;
    if (next) enter(next, open);
    else if (open) enter(here, true);
    return;
  }
  const r2 = r + (dir === 'up' ? -1 : 1);
  if (r2 < 0 || r2 >= rows.length) return leaveTable(view, at, dir === 'up');
  enter(cellAtColumn(rows[r2], Number(here.dataset.g)), open);
}

/** Applies a table operation's changes as one undo step of its own, then puts focus on the cell it names. */
function applyEdit(view: EditorView, at: number, edit: TableEdit, open = false) {
  const boundary = view.state.facet(undoBoundary);
  boundary();
  view.dispatch({ changes: edit.changes.map((c) => ({ from: at + c.from, to: at + c.to, insert: c.insert })), userEvent: 'input.visual' });
  boundary();
  focusGrid(view, at, edit.focus.r, edit.focus.g, open);
}

function runOp(view: EditorView, anchor: TrackedRange, r: number, c: number, op: TableOp) {
  const now = anchor.live ? tableNow(view, anchor.from) : null;
  const edit = now && tableEdit(now.model, now.src, op, r, c);
  if (edit) applyEdit(view, anchor.from, edit);
}

/** A row of empty cells after the last one: what "+ row" and Tab in the last cell write. */
function addRowEdit(model: TableModel): TableEdit {
  return { changes: model.addRow.map((c) => ({ from: c.from, to: c.from, insert: c.insert })), focus: { r: model.rows.length, g: 0 } };
}

function tableDomAt(view: EditorView, at: number): HTMLElement | null {
  for (const el of view.contentDOM.querySelectorAll<HTMLElement>('.cm-vis-table')) {
    if (widgetPos(view, el) === at) return el;
  }
  return null;
}

function stripComments(text: string): string {
  return text.replace(/(^|[^\\])%[^\n]*/g, '$1').replace(/\s+/g, ' ').trim();
}

const CELL_TITLE = {
  edit: 'Edit cell (Enter)',
  comment: 'Edit in the source (Enter): this cell has a comment',
  lines: 'Edit in the source (Enter): this cell spans several lines',
};

/** Said when such a cell opens its source: the grid it would show in goes away with it. */
const RAW_NOTICE = {
  comment: 'This cell has a comment, so it opens in the source.',
  lines: 'This cell is written on several lines, so it opens in the source.',
};

const ARROWS: Record<string, Move> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

/** The row and column operations, in the menu's order; a separator stands before each group but the first. */
const OPS: Array<Array<{ op: TableOp; label: string }>> = [
  [
    { op: 'rowAbove', label: 'Insert row above' },
    { op: 'rowBelow', label: 'Insert row below' },
    { op: 'colLeft', label: 'Insert column left' },
    { op: 'colRight', label: 'Insert column right' },
  ],
  [
    { op: 'mergeRight', label: 'Merge with the cell on the right' },
    { op: 'split', label: 'Split the merged cell' },
  ],
  [
    { op: 'deleteRow', label: 'Delete row' },
    { op: 'deleteColumn', label: 'Delete column' },
  ],
];

let noteIds = 0;

/**
 * Editable grid replacing a tabular environment. Cell commits and the row
 * and column operations are precise source edits at the table's position
 * when the event fires; nothing else about the source is touched.
 */
export class TableWidget extends WidgetType {
  /** Whether KaTeX was there when this widget was made, for a table with formulas in it. */
  readonly ready: boolean;
  /** The macros the table's formulas use. */
  readonly macros: MacroSet;
  /** The bibliography as last read, for a table that cites. */
  readonly bib: number;

  constructor(readonly model: TableModel, readonly source: string, macros: MacroSet = NO_MACROS) {
    super();
    this.ready = /\$|\\\(/.test(source) ? katexReady() : true;
    this.macros = macrosUsedBy(source, macros);
    this.bib = /cite/i.test(source) ? bibRevision() : 0;
  }

  eq(other: TableWidget): boolean {
    return other.source === this.source && other.ready === this.ready && other.macros.key === this.macros.key && other.bib === this.bib;
  }

  /** The table's start now, or null when the DOM no longer shows this source. */
  private locate(view: EditorView, wrap: HTMLElement): number | null {
    const at = widgetPos(view, wrap);
    return at != null && view.state.doc.sliceString(at, at + this.source.length) === this.source ? at : null;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-vis-table';
    wrap.setAttribute('data-testid', 'vis-table');
    const table = document.createElement('table');
    table.className = 'cm-vis-table__grid';
    let flat = 0;
    this.model.rows.forEach((row, r) => {
      const tr = document.createElement('tr');
      const starts = cellStarts(row);
      row.forEach((cell, c) => {
        const td = document.createElement('td');
        const index = flat++;
        const span = cellSpan(cell);
        if (span > 1) td.colSpan = span;
        td.dataset.r = String(r);
        td.dataset.g = String(starts[c]);
        td.dataset.span = String(span);
        td.append(...renderCell(cell.raw ? stripComments(cell.text) : cell.text, this.macros));
        td.tabIndex = 0;
        td.title = CELL_TITLE[cell.raw ?? 'edit'];
        const { raw } = cell;
        const open = raw
          ? () => { visualNotice(RAW_NOTICE[raw], 'info'); this.gotoSource(view, wrap, cell.from); }
          : (initial?: string) => this.editCell(view, wrap, td, { cell, r, c, index }, initial);
        if (!cell.raw) openers.set(td, open);
        td.onfocus = () => { current.set(wrap, { r, c }); };
        td.onmousedown = (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.button === 0) open();
        };
        td.oncontextmenu = (e) => {
          e.preventDefault();
          e.stopPropagation();
          current.set(wrap, { r, c });
          this.menu(view, wrap, { r, c }, { type: 'point', x: e.clientX, y: e.clientY }, false, td);
        };
        td.onkeydown = (e) => {
          if (e.target !== td) return;
          const mods = e.metaKey || e.ctrlKey || e.altKey;
          if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); open(); }
          else if (e.key === 'Escape') { e.preventDefault(); view.focus(); }
          else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); this.menu(view, wrap, { r, c }, null, true, td); }
          else if ((e.metaKey || e.ctrlKey) && !e.altKey && /^[zy]$/i.test(e.key)) {
            // the grid's events never reach the editor's keymap: undo and redo from a cell here
            const binding = yUndoManagerKeymap.find((b) => b.key === (e.key.toLowerCase() === 'y' ? 'Mod-y' : e.shiftKey ? 'Mod-Shift-z' : 'Mod-z'));
            const at = widgetPos(view, wrap);
            if (!binding?.run || at == null) return;
            e.preventDefault();
            binding.run(view);
            focusGrid(view, at, r, starts[c], false);
          } else if (ARROWS[e.key] && !mods && !e.shiftKey) {
            e.preventDefault();
            const at = widgetPos(view, wrap);
            if (at != null) move(view, at, r, c, ARROWS[e.key], false);
          } else if (!cell.raw && e.key.length === 1 && !mods) open('');
        };
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
    wrap.appendChild(table);

    const bar = document.createElement('span');
    bar.className = 'cm-vis-table__bar';
    const btn = (label: string, title: string, onClick: (b: HTMLButtonElement, keyboard: boolean) => void, testid: string, unavailable?: string) => {
      const b = document.createElement('button');
      b.className = 'cm-vis-table__btn';
      b.textContent = label;
      b.title = unavailable ?? title;
      b.setAttribute('data-testid', testid);
      // mousedown keeps the editor's focus and selection; click (also fired by
      // Enter and Space on a focused button) does the work
      b.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
      b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); if (!unavailable) onClick(b, e.detail === 0); };
      bar.appendChild(b);
      if (unavailable) {
        // stays focusable and says why, where a disabled button would drop out of the Tab order
        const note = document.createElement('span');
        note.className = 'cm-vis-table__note';
        note.id = `vis-table-note-${++noteIds}`;
        note.textContent = unavailable;
        b.setAttribute('aria-disabled', 'true');
        b.setAttribute('aria-describedby', note.id);
        bar.appendChild(note);
      }
      return b;
    };
    const { model } = this;
    btn('+ row', 'Add a row', () => {
      const at = this.locate(view, wrap);
      if (at != null) applyEdit(view, at, addRowEdit(model));
    }, 'vis-table-addrow');
    // Spec and rows move together in one change: rows without the spec break
    // every row at the next compile.
    btn('+ col', 'Add a column', () => {
      const at = this.locate(view, wrap);
      if (at == null || model.colInsert == null) return;
      applyEdit(view, at, {
        changes: [
          { from: model.colInsert.at, to: model.colInsert.at, insert: model.colInsert.insert },
          ...model.rowEnds.map((end) => ({ from: end, to: end, insert: ' & ' })),
        ],
        focus: { r: 0, g: model.cols },
      });
    }, 'vis-table-addcol', model.colSpec ? undefined : 'No column spec found: add columns in the source');
    const menuBtn = btn('Rows and columns', 'Insert, delete or merge the rows and columns of the selected cell (Shift+F10 in a cell)', (b, keyboard) => {
      this.menu(view, wrap, current.get(wrap) ?? null, null, keyboard, b);
    }, 'vis-table-menu-button');
    menuBtn.setAttribute('aria-haspopup', 'menu');
    btn(SOURCE_BUTTON.label, SOURCE_BUTTON.title, () => this.gotoSource(view, wrap, model.rows[0][0].from), 'vis-table-source');
    wrap.appendChild(bar);
    const notice = document.createElement('span');
    notice.className = 'cm-vis-table__notice';
    notice.setAttribute('role', 'status');
    notice.setAttribute('data-testid', 'vis-table-notice');
    wrap.appendChild(notice);
    if (active?.view === view) queueMicrotask(() => this.adopt(view, wrap));
    return wrap;
  }

  /**
   * The row and column operations for the cell at `pos` (null: none chosen
   * yet), under `from` (a cell or the bar's button) or at the pointer. The
   * menu acts on the table as it is when an item is chosen.
   */
  private menu(view: EditorView, wrap: HTMLElement, pos: { r: number; c: number } | null, point: { type: 'point'; x: number; y: number } | null, keyboard: boolean, from: HTMLElement) {
    const at = widgetPos(view, wrap);
    if (at == null) return;
    const anchor = trackRange(view, at, at);
    const { model } = this;
    const row = pos ? model.rows[pos.r] : null;
    const items: MenuEntry[] = [{
      kind: 'header',
      title: row && pos ? `Row ${pos.r + 1}, column ${cellStarts(row)[pos.c] + 1}` : 'No cell chosen',
      testId: 'vis-table-menu-cell',
    }];
    OPS.forEach((group, i) => {
      if (i) items.push({ kind: 'separator' });
      for (const { op, label } of group) {
        items.push({
          id: op, label, testId: `vis-table-op-${op}`, danger: op.startsWith('delete'),
          disabled: !pos || !!unavailable(model, op, pos.r, pos.c),
          onSelect: () => { if (pos) runOp(view, anchor, pos.r, pos.c, op); },
        });
      }
    });
    const why = pos ? unavailable(model, 'colLeft', pos.r, pos.c) : 'Click a cell first: these change its row and column.';
    if (why) items.push({ kind: 'hint', label: why, testId: 'vis-table-menu-hint' });
    void import('./tableMenu').then(({ openTableMenu }) => openTableMenu({
      items,
      anchor: point ?? { type: 'rect', rect: from.getBoundingClientRect(), placement: 'bottom-start' },
      keyboard,
      returnFocus: from,
      trigger: from.tagName === 'BUTTON' ? from : null,
      // an item's action runs after the menu closes
      onClose: () => setTimeout(() => untrack(view, anchor)),
    }));
  }

  /** Takes over the open cell editor when this grid redraws its table. */
  private adopt(view: EditorView, wrap: HTMLElement) {
    const ed = active;
    if (!ed || ed.view !== view || ed.input.isConnected || widgetPos(view, wrap) !== ed.anchor.from) return;
    const hit = findCell(this.model, ed.anchor.from, ed);
    const td = hit ? wrap.querySelectorAll<HTMLElement>('td')[hit.index] : undefined;
    if (!hit || !td) return ed.settle(true, null);
    const typed = ed.input.value !== ed.baseline;
    const text = editable(hit.cell).text;
    let notice = '';
    if (hit.cell.raw) {
      // a collaborator's half-typed row runs into the cell; it is a cell again once they type its \\
      if (typed) notice = BUSY;
    } else if (text === ed.original) {
      ed.conflict = 'none';
    } else if (!typed) {
      // nothing typed yet: the field takes the other person's text
      ed.input.value = text;
      ed.original = text;
      ed.baseline = ed.input.value;
    } else {
      ed.conflict = 'told';
      notice = CONFLICT;
    }
    const { selectionStart, selectionEnd } = ed.input;
    ed.shown = [...td.childNodes];
    td.replaceChildren(ed.input);
    ed.td = td;
    ed.pos = hit;
    current.set(wrap, { r: hit.r, c: hit.c });
    nameField(ed);
    ed.input.focus();
    ed.input.setSelectionRange(selectionStart, selectionEnd);
    if (notice) say(wrap, notice);
  }

  destroy(dom: HTMLElement): void {
    const ed = active;
    // a grid that goes away for good (table revealed or deleted) commits its open cell
    if (ed && dom.contains(ed.input)) setTimeout(() => { if (!ed.input.isConnected) ed.settle(true, null); });
  }

  private gotoSource(view: EditorView, wrap: HTMLElement, offset: number) {
    const at = this.locate(view, wrap) ?? widgetPos(view, wrap);
    if (at == null) return;
    view.dispatch({ selection: { anchor: Math.min(at + offset, view.state.doc.length) }, scrollIntoView: true });
    view.focus();
  }

  /**
   * A paste of several cells into an open cell: the editor's field takes the
   * first piece around its selection, and every cell is written in one edit.
   */
  private spread(view: EditorView, ed: CellEditor, grid: string[][]) {
    const at = ed.anchor.from;
    const { r, c } = ed.pos;
    const { value, selectionStart, selectionEnd } = ed.input;
    const cells = grid.map((row) => [...row]);
    cells[0][0] = cellLatex(ed.original, value.slice(0, selectionStart ?? 0) + cells[0][0] + value.slice(selectionEnd ?? value.length));
    ed.settle(false, null);
    const now = tableNow(view, at);
    const row = now?.model.rows[r];
    if (!now || !row?.[c]) return;
    const edit = spreadEdit(now.model, now.src, r, cellStarts(row)[c], cells);
    applyEdit(view, at, edit);
    if (edit.dropped) say(tableDomAt(view, at), `${edit.dropped} pasted column${edit.dropped === 1 ? ' was' : 's were'} left out: this table has no column spec to add columns to.`);
  }

  private editCell(view: EditorView, wrap: HTMLElement, td: HTMLElement, pos: CellAt, initial?: string) {
    const { cell } = pos;
    if (cell.raw) return this.gotoSource(view, wrap, cell.from);
    if (td.querySelector('input')) return;
    const at = this.locate(view, wrap);
    if (at == null) return;
    const text = editable(cell).text;
    const input = document.createElement('input');
    input.className = 'cm-vis-table__input';
    input.value = initial ?? text;
    input.setAttribute('data-testid', 'vis-table-cell-input');
    let settled = false;
    const ed: CellEditor = {
      view, input, td, pos,
      anchor: trackRange(view, at, at),
      slot: trackRange(view, at + cell.slot[0], at + cell.slot[1]),
      slotHadText: cell.slot[1] > cell.slot[0],
      original: text,
      // read back, not assumed: a field may not hold what it was given
      baseline: initial === undefined ? input.value : text,
      shown: [...td.childNodes],
      conflict: 'none',
      // Exactly once per open editor: restoring the cell's text removes the
      // input, and its blur then finds the editor settled. The write waits for
      // a microtask, after any CodeMirror update that is drawing a grid.
      settle(write, then) {
        if (settled) return;
        settled = true;
        if (active === ed) active = null;
        const value = input.value;
        ed.td.replaceChildren(...ed.shown);
        queueMicrotask(() => {
          untrack(view, ed.anchor);
          untrack(view, ed.slot);
          if (!ed.anchor.live) return;
          const where = ed.anchor.from;
          if (write && value !== ed.baseline) {
            const outcome = writeCell(ed, value);
            if (outcome !== 'written') say(tableDomAt(view, where), notWritten(outcome, value));
          }
          if (then === 'view') view.focus();
          else if (then === 'next' || then === 'prev') focusCell(view, where, ed.pos.index + (then === 'next' ? 1 : -1));
          else if (then === 'newRow') {
            const now = tableNow(view, where);
            if (now) applyEdit(view, where, addRowEdit(now.model), true);
          } else if (then) move(view, where, ed.pos.r, ed.pos.c, then, true);
        });
      },
    };
    nameField(ed);
    active?.settle(true, null);
    active = ed;
    current.set(wrap, { r: pos.r, c: pos.c });
    td.replaceChildren(input);
    input.focus();
    if (initial === undefined) input.select();
    input.onkeydown = (e) => {
      e.stopPropagation();
      const mods = e.metaKey || e.ctrlKey || e.altKey;
      const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
      const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
      const inRow = ed.td.parentElement?.children.length ?? 1;
      const last = !ed.td.parentElement?.nextElementSibling && ed.pos.c === inRow - 1;
      if (e.key === 'Enter') { e.preventDefault(); commit(ed, 'view'); }
      else if (e.key === 'Escape') { e.preventDefault(); ed.settle(false, 'view'); }
      else if (e.key === 'Tab') { e.preventDefault(); commit(ed, e.shiftKey ? 'prev' : last ? 'newRow' : 'next'); }
      else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); this.menu(view, wrap, { r: ed.pos.r, c: ed.pos.c }, null, true, ed.td); }
      else if (mods || e.shiftKey) return;
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); commit(ed, e.key === 'ArrowUp' ? 'up' : 'down'); }
      else if (e.key === 'ArrowLeft' && atStart && ed.pos.c > 0) { e.preventDefault(); commit(ed, 'left'); }
      else if (e.key === 'ArrowRight' && atEnd && ed.pos.c < inRow - 1) { e.preventDefault(); commit(ed, 'right'); }
    };
    // a paste converts as one in Visual does; tabs and line breaks spread it over the cells
    input.onpaste = (e) => {
      const data = e.clipboardData;
      if (!data) return;
      e.preventDefault();
      const grid = pastedCells(data.getData('text/html'), data.getData('text/plain'), view.state.doc.toString());
      if (grid.length === 1 && grid[0].length === 1) {
        input.setRangeText(grid[0][0], input.selectionStart ?? 0, input.selectionEnd ?? input.value.length, 'end');
      } else {
        this.spread(view, ed, grid);
      }
    };
    // A grid redrawn under the editor removes the input (Chrome reports that
    // blur while it is still attached); once the redraw is done an adopted
    // input is attached and focused again. A blur from the window losing
    // focus leaves it the active element too.
    input.onblur = () => {
      setTimeout(() => { if (!(input.isConnected && document.activeElement === input)) ed.settle(true, null); });
    };
    input.onmousedown = (e) => e.stopPropagation();
  }

  ignoreEvent(): boolean {
    return true; // the grid handles its own events; CM never sees them
  }
}

/** Focus the first cell of the grid drawn for the tabular at `at` (keyboard entry). */
export function focusTableAt(view: EditorView, at: number): boolean {
  const cell = tableDomAt(view, at)?.querySelector<HTMLElement>('td');
  if (!cell) return false;
  cell.focus();
  return true;
}
