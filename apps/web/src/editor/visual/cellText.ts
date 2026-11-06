import { escapeLatex, latexRuns } from './html2latex';
import { pasteText } from './clipboard';

/**
 * What a table cell's editor writes for `value`, the cell having held
 * `original`. A bare `&` or `%` would end the cell or comment out the rest of
 * the row, so it is escaped wherever it stands outside a formula. The other
 * specials (`$5`, `a_b`, `#3`) are escaped only in the part the person
 * changed, so LaTeX already in the cell keeps its bytes. LaTeX the text
 * spells out (`$p<0.05$`, `\textbf{…}`, `\%`) stays as written.
 */
export function cellLatex(original: string, value: string): string {
  if (value === original) return value;
  let p = 0;
  while (p < original.length && p < value.length && original[p] === value[p]) p++;
  let q = 0;
  while (q < original.length - p && q < value.length - p && original[original.length - 1 - q] === value[value.length - 1 - q]) q++;
  const changedTo = value.length - q;
  const runs = latexRuns(value);
  let out = '';
  let r = 0;
  for (let i = 0; i < value.length; i++) {
    while (r < runs.length && runs[r].to <= i) r++;
    const run = r < runs.length && runs[r].from <= i ? runs[r] : null;
    const c = value[i];
    const escaped = value[i - 1] === '\\';
    if (run) {
      if (c === '%' && run.percent && !escaped) out += '\\%';
      else if (c === '&' && run.percent && !run.math && !escaped) out += '\\&';
      else out += c;
    } else if (c === '%' || c === '&') {
      out += `\\${c}`;
    } else {
      out += i >= p && i < changedTo ? escapeLatex(c) : c;
    }
  }
  return out;
}

const oneLine = (text: string) => text.replace(/\s*\n\s*/g, ' ').trim();

/** Tab-separated text as rows of cells; a field in double quotes (a spreadsheet's cell with a line break in it) is one cell. */
function tsv(text: string): string[][] {
  const t = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const rows: string[][] = [[]];
  let cell = '';
  for (let i = 0; i <= t.length; i++) {
    if (i === t.length) { rows[rows.length - 1].push(cell); break; }
    const c = t[i];
    if (c === '"' && cell === '') {
      let j = i + 1;
      let v = '';
      for (; j < t.length; j++) {
        if (t[j] !== '"') { v += t[j]; continue; }
        if (t[j + 1] !== '"') break;
        v += '"';
        j++;
      }
      if (j < t.length && (j + 1 === t.length || t[j + 1] === '\t' || t[j + 1] === '\n')) {
        cell = v;
        i = j;
        continue;
      }
    }
    if (c === '\t') { rows[rows.length - 1].push(cell); cell = ''; }
    else if (c === '\n') { rows[rows.length - 1].push(cell); rows.push([]); cell = ''; }
    else cell += c;
  }
  return rows;
}

/**
 * What a paste into a table cell writes, as rows of cells. Text with tabs
 * or line breaks (a block copied from a spreadsheet, a table from Word or
 * Docs) is one cell per tab and one row per line; anything else is one
 * cell. Each cell converts as a paste in Visual does (prose escaped, LaTeX
 * kept), on one line: a list or a paragraph break cannot stand in a cell.
 */
export function pastedCells(html: string, text: string, doc: string): string[][] {
  const plain = text.replace(/\r\n?/g, '\n');
  if (/[\t\n]/.test(plain.replace(/\n+$/, ''))) {
    return tsv(plain).map((row) => row.map((piece) => cellLatex('', oneLine(pasteText('', piece, doc) ?? piece))));
  }
  let latex = pasteText(html, text, doc) ?? text;
  if (/\\begin\s*\{|\n\s*\n/.test(latex.trim())) latex = pasteText('', plain, doc) ?? plain;
  return [[cellLatex('', oneLine(latex))]];
}
