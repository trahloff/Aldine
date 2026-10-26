import { WidgetType } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';
import type { Text } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { nodeAt, trackRange, untrack, widgetPos } from '../positions';
import type { TrackedRange } from '../positions';
import { visualNotice } from '../context';
import { SOURCE_BUTTON } from '../mathPopover';

/**
 * A cell's source span. `slot` runs from the separator before the cell to
 * the one after it (spacing, rules and comments included): an open editor
 * finds its cell again by it after edits around the cell. `raw` says why the
 * cell is edited as source: a %-comment inside it (one string written back
 * would rewrite the comment) or a line break (a one-line field joins the lines).
 */
export interface CellSpan { from: number; to: number; text: string; slot: [number, number]; raw?: 'comment' | 'lines' }

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
export function parseTabular(body: string, base: number): { rows: CellSpan[][]; rowEnds: number[]; addRow: TableModel['addRow'] } | null {
  const rows: CellSpan[][] = [];
  const rowEnds: number[] = [];
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
    cells.push({ from: base + s, to: base + e, text, slot: [base + cellStart, base + end], ...(raw ? { raw } : {}) });
  };
  const pushRow = (end: number, broken: boolean): boolean => {
    pushCell(end);
    const row = cells;
    cells = [];
    if (!broken && row.length === 1 && row[0].text === '') return false;
    rows.push(row);
    rowEnds.push(row[row.length - 1].to);
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
  const cols = Math.max(...rows.map((r) => r.length));
  const end = unbroken ? rowEnds[rowEnds.length - 1] - base : lastBreak;
  return { rows, rowEnds, addRow: newRow(body, base, end, unbroken, cols) };
}

/**
 * "+ row": an empty row right after the last one, so it lands inside the
 * table and above a closing rule, on a line of its own unless the table is
 * written on one line. A last row without `\\` gets one; a comment ending the
 * last row's line stays on that line. `end` is where the last row ends (after
 * its `\\` and `[len]`, or after its last cell).
 */
function newRow(body: string, base: number, end: number, unbroken: boolean, cols: number): TableModel['addRow'] {
  const oneLine = !body.includes('\n');
  const cells = `${' &'.repeat(cols - 1).replace(/&/g, ' & ').trimStart()} \\\\`;
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
    cols: Math.max(...parsed.rows.map((r) => r.length)),
    addRow: parsed.addRow,
    colSpec: specOk ? { from: spec!.from + 1 - base, to: spec!.to - 1 - base } : null,
    colInsert: specOk ? (() => {
      const c = specAddColumn(doc.sliceString(spec!.from + 1, spec!.to - 1));
      return { at: spec!.from + 1 - base + c.at, insert: c.insert };
    })() : null,
  };
}

/** Cell elements → their editor, so focus can move to a cell drawn by a newer
 *  widget. A cell edited as source has none: Tab passes it without opening it. */
const openers = new WeakMap<HTMLElement, (initial?: string) => void>();

/** A cell and where it stands in its grid: row, column, place in the Tab order. */
interface CellAt { cell: CellSpan; r: number; c: number; index: number }

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
  shown: string;
  /** someone else changed the cell under the person's edit: they were told, then said to replace it */
  conflict: 'none' | 'told' | 'confirmed';
  input: HTMLInputElement;
  td: HTMLElement;
  settle(write: boolean, then: 'view' | 'next' | 'prev' | null): void;
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

function currentCell(ed: CellEditor): CellAt | null {
  const node = nodeAt(ed.view.state, ed.anchor.from, 'TabularEnvironment');
  const model = node && tableModel(ed.view.state.doc, node);
  return model ? findCell(model, ed.anchor.from, ed) : null;
}

/** Writes `value` over the editor's cell, if the cell still holds what the editor opened with or the person said to replace it. */
function writeCell(ed: CellEditor, value: string): 'written' | 'changed' | 'gone' {
  const hit = currentCell(ed);
  if (!hit) return 'gone';
  if (hit.cell.raw || (hit.cell.text !== ed.original && ed.conflict !== 'confirmed')) return 'changed';
  const at = ed.anchor.from;
  if (hit.cell.text !== value) {
    ed.view.dispatch({ changes: { from: at + hit.cell.from, to: at + hit.cell.to, insert: value }, userEvent: 'input.visual' });
  }
  return 'written';
}

/**
 * Enter or Tab. A cell someone else changed meanwhile is replaced only once
 * the person has been told; one that someone is still rewriting (their new
 * row runs into it until its `\\`) keeps the editor open.
 */
function commit(ed: CellEditor, then: 'view' | 'next' | 'prev') {
  const hit = ed.input.value !== ed.baseline ? currentCell(ed) : null;
  const wrap = ed.td.closest<HTMLElement>('.cm-vis-table');
  if (hit?.cell.raw) return say(wrap, BUSY);
  if (hit && hit.cell.text !== ed.original) {
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
  ed.input.setAttribute('aria-label', `Row ${ed.pos.r + 1}, column ${ed.pos.c + 1}`);
}

function focusCell(view: EditorView, at: number, index: number) {
  const wrap = tableDomAt(view, at);
  const cells = wrap ? [...wrap.querySelectorAll<HTMLElement>('td')] : [];
  const target = cells[index];
  if (target) {
    target.focus();
    openers.get(target)?.();
  } else if (wrap && index >= cells.length) {
    wrap.querySelector<HTMLElement>('[data-testid="vis-table-addrow"]')?.focus();
  } else {
    view.focus();
  }
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

let noteIds = 0;

/**
 * Editable grid replacing a tabular environment. Cell commits, add-row and
 * add-column are precise source edits at the table's position when the event
 * fires; nothing else about the source is touched.
 */
export class TableWidget extends WidgetType {
  constructor(readonly model: TableModel, readonly source: string) {
    super();
  }

  eq(other: TableWidget): boolean {
    return other.source === this.source;
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
      row.forEach((cell, c) => {
        const td = document.createElement('td');
        const index = flat++;
        td.textContent = cell.raw ? stripComments(cell.text) : cell.text;
        td.tabIndex = 0;
        td.title = CELL_TITLE[cell.raw ?? 'edit'];
        const open = cell.raw
          ? () => this.gotoSource(view, wrap, cell.from)
          : (initial?: string) => this.editCell(view, wrap, td, { cell, r, c, index }, initial);
        if (!cell.raw) openers.set(td, open);
        td.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); open(); };
        td.onkeydown = (e) => {
          if (e.target !== td) return;
          if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); open(); }
          else if (e.key === 'Escape') { e.preventDefault(); view.focus(); }
          else if (!cell.raw && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) open('');
        };
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
    wrap.appendChild(table);

    const bar = document.createElement('span');
    bar.className = 'cm-vis-table__bar';
    const btn = (label: string, title: string, onClick: () => void, testid: string, unavailable?: string) => {
      const b = document.createElement('button');
      b.className = 'cm-vis-table__btn';
      b.textContent = label;
      b.title = unavailable ?? title;
      b.setAttribute('data-testid', testid);
      // mousedown keeps the editor's focus and selection; click (also fired by
      // Enter and Space on a focused button) does the work
      b.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
      b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); if (!unavailable) onClick(); };
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
    };
    const { model } = this;
    btn('+ row', 'Add a row', () => {
      const at = this.locate(view, wrap);
      if (at == null) return;
      view.dispatch({ changes: model.addRow.map((c) => ({ from: at + c.from, insert: c.insert })), userEvent: 'input.visual' });
    }, 'vis-table-addrow');
    // Spec and rows move together in one change: rows without the spec break
    // every row at the next compile.
    btn('+ col', 'Add a column', () => {
      const at = this.locate(view, wrap);
      if (at == null || model.colInsert == null) return;
      view.dispatch({
        changes: [
          { from: at + model.colInsert.at, insert: model.colInsert.insert },
          ...model.rowEnds.map((end) => ({ from: at + end, insert: ' & ' })),
        ],
        userEvent: 'input.visual',
      });
    }, 'vis-table-addcol', model.colSpec ? undefined : 'No column spec found: add columns in the source');
    btn(SOURCE_BUTTON.label, SOURCE_BUTTON.title, () => this.gotoSource(view, wrap, 1), 'vis-table-source');
    wrap.appendChild(bar);
    const notice = document.createElement('span');
    notice.className = 'cm-vis-table__notice';
    notice.setAttribute('role', 'status');
    notice.setAttribute('data-testid', 'vis-table-notice');
    wrap.appendChild(notice);
    if (active?.view === view) queueMicrotask(() => this.adopt(view, wrap));
    return wrap;
  }

  /** Takes over the open cell editor when this grid redraws its table. */
  private adopt(view: EditorView, wrap: HTMLElement) {
    const ed = active;
    if (!ed || ed.view !== view || ed.input.isConnected || widgetPos(view, wrap) !== ed.anchor.from) return;
    const hit = findCell(this.model, ed.anchor.from, ed);
    const td = hit ? wrap.querySelectorAll<HTMLElement>('td')[hit.index] : undefined;
    if (!hit || !td) return ed.settle(true, null);
    const typed = ed.input.value !== ed.baseline;
    let notice = '';
    if (hit.cell.raw) {
      // a collaborator's half-typed row runs into the cell; it is a cell again once they type its \\
      if (typed) notice = BUSY;
    } else if (hit.cell.text === ed.original) {
      ed.conflict = 'none';
    } else if (!typed) {
      // nothing typed yet: the field takes the other person's text
      ed.input.value = hit.cell.text;
      ed.original = hit.cell.text;
      ed.baseline = ed.input.value;
    } else {
      ed.conflict = 'told';
      notice = CONFLICT;
    }
    const { selectionStart, selectionEnd } = ed.input;
    ed.shown = td.textContent ?? '';
    td.textContent = '';
    td.appendChild(ed.input);
    ed.td = td;
    ed.pos = hit;
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

  private editCell(view: EditorView, wrap: HTMLElement, td: HTMLElement, pos: CellAt, initial?: string) {
    const { cell } = pos;
    if (cell.raw) return this.gotoSource(view, wrap, cell.from);
    if (td.querySelector('input')) return;
    const at = this.locate(view, wrap);
    if (at == null) return;
    const input = document.createElement('input');
    input.className = 'cm-vis-table__input';
    input.value = initial ?? cell.text;
    input.setAttribute('data-testid', 'vis-table-cell-input');
    let settled = false;
    const ed: CellEditor = {
      view, input, td, pos,
      anchor: trackRange(view, at, at),
      slot: trackRange(view, at + cell.slot[0], at + cell.slot[1]),
      slotHadText: cell.slot[1] > cell.slot[0],
      original: cell.text,
      // read back, not assumed: a field may not hold what it was given
      baseline: initial === undefined ? input.value : cell.text,
      shown: td.textContent ?? '',
      conflict: 'none',
      // Exactly once per open editor: restoring the cell's text removes the
      // input, and its blur then finds the editor settled. The write waits for
      // a microtask, after any CodeMirror update that is drawing a grid.
      settle(write, then) {
        if (settled) return;
        settled = true;
        if (active === ed) active = null;
        const value = input.value;
        ed.td.textContent = ed.shown;
        queueMicrotask(() => {
          untrack(view, ed.anchor);
          untrack(view, ed.slot);
          if (!ed.anchor.live) return;
          if (write && value !== ed.baseline) {
            const outcome = writeCell(ed, value);
            if (outcome !== 'written') say(tableDomAt(view, ed.anchor.from), notWritten(outcome, value));
          }
          if (then === 'view') view.focus();
          else if (then) focusCell(view, ed.anchor.from, ed.pos.index + (then === 'next' ? 1 : -1));
        });
      },
    };
    nameField(ed);
    active?.settle(true, null);
    active = ed;
    td.textContent = '';
    td.appendChild(input);
    input.focus();
    if (initial === undefined) input.select();
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(ed, 'view'); }
      else if (e.key === 'Escape') { e.preventDefault(); ed.settle(false, 'view'); }
      else if (e.key === 'Tab') { e.preventDefault(); commit(ed, e.shiftKey ? 'prev' : 'next'); }
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
