import { describe, it, expect } from 'vitest';
import { syntaxTree } from '@codemirror/language';
import { latex } from 'codemirror-lang-latex';
import type { EditorState } from '@codemirror/state';
import { tableModel } from '../widgets/table';
import { spreadEdit, tableEdit, unavailable, type TableOp } from '../tableEdit';
import { parsedState } from './parsedState';

const state = (doc: string) => parsedState({ doc, extensions: [latex()] });

function table(s: EditorState) {
  let node = null as ReturnType<ReturnType<typeof syntaxTree>['resolve']> | null;
  syntaxTree(s).iterate({ enter(n) { if (!node && n.name === 'TabularEnvironment') { node = n.node; return false; } } });
  return { node: node!, model: tableModel(s.doc, node!)!, src: s.doc.sliceString(node!.from, node!.to) };
}

/** The document after `op` at row `r`, cell `c`, and the grid it then has. */
function after(doc: string, op: TableOp, r: number, c: number) {
  const s = state(doc);
  const { node, model, src } = table(s);
  const edit = tableEdit(model, src, op, r, c);
  if (!edit) return null;
  const next = s.update({ changes: edit.changes.map((ch) => ({ from: node.from + ch.from, to: node.from + ch.to, insert: ch.insert })) }).state;
  return { doc: next.doc.toString(), grid: table(next).model.rows.map((row) => row.map((cell) => cell.text)), focus: edit.focus };
}

const BOOKTABS = '\\begin{tabular}{ll}\n\\toprule\nH1 & H2 \\\\\n\\midrule\na & b \\\\\nc & d \\\\\n\\bottomrule\n\\end{tabular}\n';

describe('inserting and deleting rows (vis-14)', () => {
  it('puts a new row above or below the cell\'s row, on a line of its own, keeping the rules where they were', () => {
    expect(after(BOOKTABS, 'rowAbove', 1, 0)!.doc).toBe(BOOKTABS.replace('\\midrule\na & b', '\\midrule\n&  \\\\\na & b'));
    expect(after(BOOKTABS, 'rowBelow', 0, 1)!.doc).toBe(BOOKTABS.replace('H1 & H2 \\\\\n', 'H1 & H2 \\\\\n&  \\\\\n'));
    expect(after(BOOKTABS, 'rowBelow', 2, 0)!.doc).toBe(BOOKTABS.replace('c & d \\\\\n', 'c & d \\\\\n&  \\\\\n'));
    expect(after(BOOKTABS, 'rowBelow', 0, 1)!.focus).toEqual({ r: 1, g: 1 });
    // indentation follows the row's
    const indented = '\\begin{tabular}{ll}\n  a & b \\\\\n  c & d \\\\\n\\end{tabular}\n';
    expect(after(indented, 'rowAbove', 1, 0)!.doc).toBe(indented.replace('  c & d', '  &  \\\\\n  c & d'));
    expect(after(indented, 'rowBelow', 0, 0)!.doc).toBe(indented.replace('  a & b \\\\\n', '  a & b \\\\\n  &  \\\\\n'));
  });

  it('stays on the line of a table written on one line', () => {
    const one = 'Name: \\begin{tabular}{ll}a & b \\\\ c & d\\end{tabular} done';
    expect(after(one, 'rowBelow', 0, 0)!.doc).toBe('Name: \\begin{tabular}{ll}a & b \\\\ &  \\\\ c & d\\end{tabular} done');
    expect(after(one, 'rowAbove', 1, 0)!.doc).toBe('Name: \\begin{tabular}{ll}a & b \\\\ &  \\\\ c & d\\end{tabular} done');
    expect(after(one, 'deleteRow', 0, 1)!.doc).toBe('Name: \\begin{tabular}{ll}c & d\\end{tabular} done');
    expect(after(one, 'deleteRow', 1, 1)!.doc).toBe('Name: \\begin{tabular}{ll}a & b \\\\\\end{tabular} done');
  });

  it('deletes a row with its \\\\ and its line, and never the rules or comments around it', () => {
    expect(after(BOOKTABS, 'deleteRow', 1, 0)!.doc).toBe(BOOKTABS.replace('a & b \\\\\n', ''));
    expect(after(BOOKTABS, 'deleteRow', 0, 0)!.grid).toEqual([['a', 'b'], ['c', 'd']]);
    const commented = '\\begin{tabular}{ll}\na & b \\\\[2pt]\n% note\nc & d\n\\end{tabular}\n';
    expect(after(commented, 'deleteRow', 1, 0)!.doc).toBe('\\begin{tabular}{ll}\na & b \\\\[2pt]\n% note\n\\end{tabular}\n');
    expect(after(commented, 'deleteRow', 0, 0)!.doc).toBe('\\begin{tabular}{ll}\n% note\nc & d\n\\end{tabular}\n');
    const only = '\\begin{tabular}{ll}\na & b \\\\\n\\end{tabular}\n';
    expect(after(only, 'deleteRow', 0, 0)).toBeNull();
    const s = state(only);
    expect(unavailable(table(s).model, 'deleteRow', 0, 0)).toBe('This is the table\'s only row.');
  });
});

const RULED = '\\begin{tabular}{|l|p{3cm}|}\n\\hline\na & b \\\\\n\\multicolumn{2}{|c|}{wide} \\\\\n\\hline\n\\end{tabular}\n';

describe('inserting and deleting columns (vis-14)', () => {
  it('adds a column typed and ruled like its neighbour, and widens a merged cell it falls inside', () => {
    expect(after(RULED, 'colRight', 0, 0)!.doc).toBe(RULED.replace('{|l|p{3cm}|}', '{|l|l|p{3cm}|}').replace('a & b', 'a & & b').replace('{2}', '{3}'));
    expect(after(RULED, 'colLeft', 0, 1)!.doc).toBe(RULED.replace('{|l|p{3cm}|}', '{|l|p{3cm}|p{3cm}|}').replace('a & b', 'a & & b').replace('{2}', '{3}'));
    expect(after(RULED, 'colRight', 0, 1)!.doc).toBe(RULED.replace('{|l|p{3cm}|}', '{|l|p{3cm}|p{3cm}|}').replace('a & b \\\\', 'a & b & \\\\').replace('{wide} \\\\', '{wide} & \\\\'));
    expect(after(RULED, 'colLeft', 0, 0)!.doc).toBe(RULED.replace('{|l|p{3cm}|}', '{|l|l|p{3cm}|}').replace('a & b', '& a & b').replace('\\multicolumn', '& \\multicolumn'));
    expect(after(RULED, 'colLeft', 0, 0)!.grid).toEqual([['', 'a', 'b'], ['', '\\multicolumn{2}{|c|}{wide}']]);
  });

  it('deletes a column with its spec entry, or narrows a merged cell across it', () => {
    expect(after(RULED, 'deleteColumn', 0, 0)!.doc).toBe(RULED.replace('{|l|p{3cm}|}', '{|p{3cm}|}').replace('a & b', 'b').replace('{2}', '{1}'));
    expect(after(RULED, 'deleteColumn', 0, 1)!.doc).toBe(RULED.replace('{|l|p{3cm}|}', '{|l|}').replace('a & b', 'a').replace('{2}', '{1}'));
    const three = '\\begin{tabular}{@{}lcr@{}}\na & b & c \\\\\n1 &  & 3 \\\\\n\\end{tabular}\n';
    expect(after(three, 'deleteColumn', 1, 1)!.doc).toBe('\\begin{tabular}{@{}lr@{}}\na & c \\\\\n1 & 3 \\\\\n\\end{tabular}\n');
    expect(after(three, 'colRight', 0, 2)!.doc).toBe('\\begin{tabular}{@{}lcrr@{}}\na & b & c & \\\\\n1 &  & 3 & \\\\\n\\end{tabular}\n');
  });

  it('leaves a spec it cannot map column by column to the source', () => {
    const repeat = '\\begin{tabular}{*{2}{c}}\na & b \\\\\n\\end{tabular}\n';
    expect(after(repeat, 'colRight', 0, 0)).toBeNull();
    expect(unavailable(table(state(repeat)).model, 'deleteColumn', 0, 0)).toMatch(/^Change this table's columns in the source/);
  });
});

describe('merging and splitting cells (vis-14)', () => {
  const three = '\\begin{tabular}{|l|c|r|}\na & b & c \\\\\n\\end{tabular}\n';

  it('merges a cell with the one on its right into a \\multicolumn with both texts, ruled as LaTeX reads it', () => {
    expect(after(three, 'mergeRight', 0, 0)!.doc).toBe(three.replace('a & b', '\\multicolumn{2}{|l|}{a b}'));
    expect(after(three, 'mergeRight', 0, 1)!.doc).toBe(three.replace('b & c', '\\multicolumn{2}{c|}{b c}'));
    const merged = after(three, 'mergeRight', 0, 0)!.doc;
    expect(after(merged, 'mergeRight', 0, 0)!.doc).toBe(three.replace('a & b & c', '\\multicolumn{3}{|l|}{a b c}'));
    expect(after(three, 'mergeRight', 0, 2)).toBeNull();
  });

  it('splits a merged cell back into its columns', () => {
    const merged = three.replace('a & b', '\\multicolumn{2}{|l|}{a b}');
    expect(after(merged, 'split', 0, 0)!.doc).toBe(three.replace('a & b', 'a b &'));
    expect(after(merged, 'split', 0, 0)!.grid).toEqual([['a b', '', 'c']]);
    expect(after(three, 'split', 0, 0)).toBeNull();
  });
});

describe('a block of cells pasted into a table (vis-6)', () => {
  const doc = '\\begin{tabular}{ll}\na & b \\\\\nc & d \\\\\n\\end{tabular}\n';

  it('fills the cells from the one pasted into, adding the columns and rows it needs', () => {
    const s = state(doc);
    const { node, model, src } = table(s);
    const edit = spreadEdit(model, src, 1, 1, [['X', 'Y'], ['Z', 'W']]);
    const out = s.update({ changes: edit.changes.map((ch) => ({ from: node.from + ch.from, to: node.from + ch.to, insert: ch.insert })) }).state.doc.toString();
    expect(out).toBe('\\begin{tabular}{lll}\na & b \\\\\nc & X & Y \\\\\n& Z & W \\\\\n\\end{tabular}\n');
    expect(edit.dropped).toBe(0);
  });

  it('fits a block inside the table without touching the other cells', () => {
    const s = state(doc);
    const { node, model, src } = table(s);
    const edit = spreadEdit(model, src, 0, 0, [['1', '2']]);
    const out = s.update({ changes: edit.changes.map((ch) => ({ from: node.from + ch.from, to: node.from + ch.to, insert: ch.insert })) }).state.doc.toString();
    expect(out).toBe(doc.replace('a & b', '1 & 2'));
  });
});
