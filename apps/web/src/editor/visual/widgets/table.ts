import { WidgetType } from '@codemirror/view';

export interface CellSpan { from: number; to: number; text: string }
export interface TableModel {
  rows: CellSpan[][];
  /** insertion point for a new row (before \end) and the row template */
  rowInsertAt: number;
  cols: number;
  /** column-spec interior range, for add-column */
  colSpec: { from: number; to: number } | null;
  /** end offset of each row's last cell — where ` & ` lands for add-column */
  rowEnds: number[];
}

const RULE_RE = /^\s*\\(hline|toprule|midrule|bottomrule|cline\{[^}]*\})\s*/;

/**
 * Scan a tabular body into cells with exact source offsets. Braces guard
 * nested `&`/`\\`; rule commands are display-stripped. Anything the scanner
 * can't confidently map keeps the construct raw (caller falls back to a chip).
 */
export function parseTabular(body: string, base: number): { rows: CellSpan[][]; rowEnds: number[] } | null {
  const rows: CellSpan[][] = [];
  const rowEnds: number[] = [];
  let cells: CellSpan[] = [];
  let cellStart = 0;
  let depth = 0;
  let i = 0;
  const pushCell = (end: number) => {
    let s = cellStart;
    let e = end;
    while (s < e && /\s/.test(body[s])) s++;
    while (e > s && /\s/.test(body[e - 1])) e--;
    // strip leading rule commands from the display cell (keep offsets honest)
    const m = RULE_RE.exec(body.slice(s, e));
    if (m) s += m[0].length;
    cells.push({ from: base + s, to: base + e, text: body.slice(s, e) });
  };
  const pushRow = (end: number) => {
    pushCell(end);
    if (cells.length && !(cells.length === 1 && cells[0].text === '')) {
      rows.push(cells);
      rowEnds.push(cells[cells.length - 1].to);
    }
    cells = [];
  };
  while (i < body.length) {
    const ch = body[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === '\\' && body[i + 1] === '\\' && depth === 0) {
      pushRow(i);
      i += 2;
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
  pushRow(body.length);
  if (!rows.length) return null;
  return { rows, rowEnds };
}

/**
 * Editable grid replacing a tabular environment. Cell commits, add-row and
 * add-column are dispatched as precise source edits through the doc-edit
 * bridge; nothing else about the source is touched.
 */
export class TableWidget extends WidgetType {
  constructor(readonly model: TableModel, readonly sourceKey: string, readonly pos: number) {
    super();
  }

  eq(other: TableWidget): boolean {
    return other.sourceKey === this.sourceKey;
  }

  private edit(from: number, to: number, insert: string) {
    window.dispatchEvent(new CustomEvent('aldine:doc-edit', { detail: { from, to, insert } }));
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-vis-table';
    wrap.setAttribute('data-testid', 'vis-table');
    const table = document.createElement('table');
    table.className = 'cm-vis-table__grid';
    for (const row of this.model.rows) {
      const tr = document.createElement('tr');
      for (const cell of row) {
        const td = document.createElement('td');
        td.textContent = cell.text;
        td.title = 'Click to edit';
        td.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); this.editCell(td, cell); };
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    wrap.appendChild(table);

    const bar = document.createElement('span');
    bar.className = 'cm-vis-table__bar';
    const btn = (label: string, title: string, onClick: () => void, testid: string) => {
      const b = document.createElement('button');
      b.className = 'cm-vis-table__btn';
      b.textContent = label;
      b.title = title;
      b.setAttribute('data-testid', testid);
      b.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); onClick(); };
      bar.appendChild(b);
    };
    btn('+ row', 'Add a row', () => {
      const cols = this.model.cols;
      this.edit(this.model.rowInsertAt, this.model.rowInsertAt, `${' &'.repeat(cols - 1).replace(/&/g, ' & ').trimStart()} \\\\\n`);
    }, 'vis-table-addrow');
    btn('+ col', 'Add a column', () => {
      // Spec and rows must move together: half an edit (rows without the spec)
      // breaks every row at the next compile, so refuse when the spec range
      // couldn't be located.
      if (!this.model.colSpec) return;
      // append a column: extend the colspec, then ` & ` at each row end (last first
      // so earlier offsets stay valid)
      const edits: Array<[number, string]> = [];
      for (const end of [...this.model.rowEnds].sort((a, b) => b - a)) edits.push([end, ' & ']);
      for (const [at, text] of edits) this.edit(at, at, text);
      this.edit(this.model.colSpec.to, this.model.colSpec.to, 'l');
    }, 'vis-table-addcol');
    btn('TeX', 'Edit LaTeX source', () => {
      window.dispatchEvent(new CustomEvent('aldine:goto', { detail: { pos: this.pos + 1 } }));
    }, 'vis-table-source');
    wrap.appendChild(bar);
    return wrap;
  }

  private editCell(td: HTMLElement, cell: CellSpan) {
    if (td.querySelector('input')) return;
    const input = document.createElement('input');
    input.className = 'cm-vis-table__input';
    input.value = cell.text;
    input.setAttribute('data-testid', 'vis-table-cell-input');
    td.textContent = '';
    td.appendChild(input);
    input.focus();
    input.select();
    const commit = () => {
      if (input.value !== cell.text) this.edit(cell.from, cell.to, input.value);
      else td.textContent = cell.text;
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); td.textContent = cell.text; }
    };
    input.onblur = () => commit();
    input.onmousedown = (e) => e.stopPropagation();
  }

  ignoreEvent(): boolean {
    return true; // the grid handles its own events; CM never sees them
  }
}
