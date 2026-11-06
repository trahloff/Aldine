import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import type { StateCommand } from '@codemirror/state';
import { ensureSyntaxTree, indentUnit } from '@codemirror/language';
import { latex } from 'codemirror-lang-latex';
import { revealField } from '../reveal';
import { atomicChunking, atomicField } from '../atomicField';
import {
  backspaceHiddenLine, backspaceIntoConstruct, deleteHiddenLine, deleteIntoConstruct, itemBackspace, itemDelete, listItemEnter, paragraphEnter,
  selectConstructBackward, selectConstructForward,
} from '../commands';
import { parsedState } from './parsedState';

/** Runs `cmd` with the caret where `|` stands; the result shows the caret as `|` too. */
function run(cmd: StateCommand, marked: string) {
  const at = marked.indexOf('|');
  const doc = marked.slice(0, at) + marked.slice(at + 1);
  let s = parsedState({ doc, selection: { anchor: at }, extensions: [latex(), indentUnit.of('  '), revealField, atomicField] });
  const ran = cmd({ state: s, dispatch: (tr) => { s = tr.state; } });
  const head = s.selection.main.head;
  const text = s.doc.toString();
  return { ran, text: text.slice(0, head) + '|' + text.slice(head) };
}

describe('Enter in a list (#151)', () => {
  it('starts the next \\item at the end of an item, the last one included', () => {
    expect(run(listItemEnter, '\\begin{itemize}\n  \\item One|\n  \\item Two\n\\end{itemize}\n')).toEqual({
      ran: true, text: '\\begin{itemize}\n  \\item One\n  \\item |\n  \\item Two\n\\end{itemize}\n',
    });
    expect(run(listItemEnter, '\\begin{enumerate}\n\\item One\n\\item Two|\n\\end{enumerate}\nafter')).toEqual({
      ran: true, text: '\\begin{enumerate}\n\\item One\n\\item Two\n\\item |\n\\end{enumerate}\nafter',
    });
    // inside the text the line just breaks
    expect(run(listItemEnter, '\\begin{itemize}\n\\item O|ne\n\\end{itemize}\n').ran).toBe(false);
    // not in a list Visual renders
    expect(run(listItemEnter, '\\begin{tasks}\n\\item One|\n\\end{tasks}\n').ran).toBe(false);
  });

  it('leaves the list on an empty item, and takes an only-item list with it', () => {
    expect(run(listItemEnter, '\\begin{itemize}\n\\item One\n\\item |\n\\end{itemize}\nafter')).toEqual({
      ran: true, text: '\\begin{itemize}\n\\item One\n\\end{itemize}\n|\nafter',
    });
    expect(run(listItemEnter, 'before\n\\begin{itemize}\n\\item |\n\\end{itemize}\nafter')).toEqual({
      ran: true, text: 'before\n|\nafter',
    });
    // a nested list hands over to the enclosing list's next item
    expect(run(listItemEnter, '\\begin{itemize}\n  \\item Out\n  \\begin{enumerate}\n    \\item In\n    \\item |\n  \\end{enumerate}\n\\end{itemize}\n')).toEqual({
      ran: true, text: '\\begin{itemize}\n  \\item Out\n  \\begin{enumerate}\n    \\item In\n  \\end{enumerate}\n  \\item |\n\\end{itemize}\n',
    });
  });
});

describe('Enter in a construct inside a list item', () => {
  it('breaks the line in a formula or a listing instead of writing an \\item into it', () => {
    expect(run(listItemEnter, '\\begin{itemize}\n  \\item Consider\n  \\begin{align} a &= b \\\\|\n  \\end{align}\n\\end{itemize}\n').ran).toBe(false);
    expect(run(listItemEnter, '\\begin{itemize}\n  \\item Code\n  \\begin{verbatim}\nx = 1|\n  \\end{verbatim}\n\\end{itemize}\n').ran).toBe(false);
    expect(run(listItemEnter, '\\begin{itemize}\n  \\item Code\n  \\begin{center}\n  x|\n  \\end{center}\n\\end{itemize}\n').ran).toBe(false);
    // after the construct the item goes on
    expect(run(listItemEnter, '\\begin{itemize}\n\\item Then $x$|\n\\end{itemize}\n')).toEqual({
      ran: true, text: '\\begin{itemize}\n\\item Then $x$\n\\item |\n\\end{itemize}\n',
    });
  });

  it('keeps a list that holds more than its empty only item', () => {
    expect(run(listItemEnter, '\\begin{itemize}\n  % note\n  \\item |\n\\end{itemize}\n').ran).toBe(false);
    expect(run(listItemEnter, '\\begin{itemize}\n  \\setlength{\\itemsep}{0pt}\n  \\item |\n\\end{itemize}\n').ran).toBe(false);
  });

  it('leaves an empty item between others as a plain line break', () => {
    expect(run(listItemEnter, '\\begin{itemize}\n\\item A\n\\item |\n\\item B\n\\end{itemize}\n').ran).toBe(false);
  });
});

describe('Enter in body text (#151)', () => {
  it('starts the new line with the line\'s own indentation, not the section\'s', () => {
    expect(run(paragraphEnter, '\\section{A}\nBody text.|\n')).toEqual({ ran: true, text: '\\section{A}\nBody text.\n|\n' });
    expect(run(paragraphEnter, '\\section{A}\n  Indented.|\n')).toEqual({ ran: true, text: '\\section{A}\n  Indented.\n  |\n' });
    // the environment closer handles a \begin line
    expect(run(paragraphEnter, '\\begin{center}|\n').ran).toBe(false);
  });
});

describe('Backspace and Delete beside a hidden list line (#151)', () => {
  const list = '\\begin{itemize}\n\\item One\n\\item Two\n\\end{itemize}\n';
  it('Backspace at the start of the line after a list goes to the end of its last item', () => {
    expect(run(backspaceHiddenLine, `Before\n${list}|After`)).toEqual({ ran: true, text: `Before\n${list.replace('Two', 'Two|')}After` });
    // the first item's line start goes above the list
    expect(run(backspaceHiddenLine, 'Before\n\\begin{itemize}\n|\\item One\n\\end{itemize}\n')).toEqual({ ran: true, text: 'Before|\n\\begin{itemize}\n\\item One\n\\end{itemize}\n' });
    expect(run(backspaceHiddenLine, 'Before\n|After').ran).toBe(false);
  });

  it('passes a hidden line on a long paper before idle filling reaches it', () => {
    const filler = 'Filler text. '.repeat(40) + '\n';
    const marked = filler.repeat(20) + `Before\n${list}|After\n` + filler.repeat(20);
    const at = marked.indexOf('|');
    const doc = marked.slice(0, at) + marked.slice(at + 1);
    let s = EditorState.create({ doc, selection: { anchor: 0 }, extensions: [latex(), revealField, atomicChunking.of({ min: 2_000, chunk: 1_000 }), atomicField] });
    ensureSyntaxTree(s, s.doc.length, 5_000);
    s = s.update({}).state;
    s = s.update({ selection: { anchor: at } }).state;
    expect(s.field(atomicField).pending.some(([a, b]) => a < at && b > at)).toBe(true);
    const ran = backspaceHiddenLine({ state: s, dispatch: (tr) => { s = tr.state; } });
    expect(ran).toBe(true);
    expect(s.selection.main.head).toBe(doc.indexOf('Two') + 3);
  });

  it('Delete at the end of the line before a list goes to its first item, after the bullet', () => {
    expect(run(deleteHiddenLine, `Before|\n${list}After`)).toEqual({ ran: true, text: `Before\n${list.replace('\\item One', '\\item |One')}After` });
  });
});

describe('Backspace and Delete at a bullet (vis-1)', () => {
  it('Backspace at the start of an item\'s text joins it to the item above, never into \\itemWord', () => {
    expect(run(itemBackspace, '\\begin{itemize}\n\\item One\n\\item |Two\n\\end{itemize}\n')).toEqual({
      ran: true, text: '\\begin{itemize}\n\\item One|Two\n\\end{itemize}\n',
    });
    // an item above with no text keeps its \\item apart from the joined word
    expect(run(itemBackspace, '\\begin{itemize}\n  \\item\n  \\item |Two\n\\end{itemize}\n')).toEqual({
      ran: true, text: '\\begin{itemize}\n  \\item |Two\n\\end{itemize}\n',
    });
    // inside the text it is a plain Backspace
    expect(run(itemBackspace, '\\begin{itemize}\n\\item One\n\\item T|wo\n\\end{itemize}\n').ran).toBe(false);
  });

  it('Backspace on an empty item removes it, and the list with its only item', () => {
    expect(run(itemBackspace, '\\begin{itemize}\n\\item One\n\\item |\n\\item Two\n\\end{itemize}\n')).toEqual({
      ran: true, text: '\\begin{itemize}\n\\item One|\n\\item Two\n\\end{itemize}\n',
    });
    expect(run(itemBackspace, 'Before\n\\begin{itemize}\n\\item |\n\\item Two\n\\end{itemize}\n')).toEqual({
      ran: true, text: 'Before|\n\\begin{itemize}\n\\item Two\n\\end{itemize}\n',
    });
    expect(run(itemBackspace, 'before\n\\begin{itemize}\n\\item |\n\\end{itemize}\nafter')).toEqual({ ran: true, text: 'before\n|\nafter' });
  });

  it('Backspace at the first item\'s text goes above the list, deleting nothing', () => {
    expect(run(itemBackspace, 'Before\n\\begin{itemize}\n\\item |One\n\\end{itemize}\n')).toEqual({
      ran: true, text: 'Before|\n\\begin{itemize}\n\\item One\n\\end{itemize}\n',
    });
    // after a nested list, to its last item
    expect(run(itemBackspace, '\\begin{itemize}\n\\item A\n  \\begin{enumerate}\n  \\item B\n  \\end{enumerate}\n\\item |C\n\\end{itemize}\n')).toEqual({
      ran: true, text: '\\begin{itemize}\n\\item A\n  \\begin{enumerate}\n  \\item B|\n  \\end{enumerate}\n\\item C\n\\end{itemize}\n',
    });
  });

  it('Delete at the end of an item joins the next item\'s text, an empty one with its line', () => {
    expect(run(itemDelete, '\\begin{itemize}\n\\item One|\n\\item Two\n\\end{itemize}\n')).toEqual({
      ran: true, text: '\\begin{itemize}\n\\item One|Two\n\\end{itemize}\n',
    });
    expect(run(itemDelete, '\\begin{itemize}\n\\item One|\n\\item \n\\item Two\n\\end{itemize}\n')).toEqual({
      ran: true, text: '\\begin{itemize}\n\\item One|\n\\item Two\n\\end{itemize}\n',
    });
    // the line before the list is the hidden line's business
    expect(run(itemDelete, 'Before|\n\\begin{itemize}\n\\item One\n\\end{itemize}\n').ran).toBe(false);
  });
});

describe('Backspace and Delete beside a chip, a formula or a table (vis-2)', () => {
  function select(cmd: StateCommand, marked: string) {
    const at = marked.indexOf('|');
    const doc = marked.slice(0, at) + marked.slice(at + 1);
    let s = parsedState({ doc, selection: { anchor: at }, extensions: [latex(), revealField, atomicField] });
    const ran = cmd({ state: s, dispatch: (tr) => { s = tr.state; } });
    return { ran, selected: s.sliceDoc(s.selection.main.from, s.selection.main.to), doc: s.doc.toString() };
  }

  it('the first press selects the construct whole', () => {
    expect(select(selectConstructBackward, 'See \\cite{knuth1984}| now.')).toEqual({ ran: true, selected: '\\cite{knuth1984}', doc: 'See \\cite{knuth1984} now.' });
    expect(select(selectConstructBackward, 'Cost $x^2$| per step.')).toMatchObject({ ran: true, selected: '$x^2$' });
    expect(select(selectConstructForward, 'See |\\ref{fig:a} now.')).toMatchObject({ ran: true, selected: '\\ref{fig:a}' });
    expect(select(selectConstructBackward, 'Grid:\n\\begin{tabular}{l}\na \\\\\n\\end{tabular}|\nend')).toMatchObject({ ran: true, selected: '\\begin{tabular}{l}\na \\\\\n\\end{tabular}' });
  });

  it('leaves text, bold and a construct shown as source to the usual keys', () => {
    expect(select(selectConstructBackward, 'Plain text| here.').ran).toBe(false);
    expect(select(selectConstructBackward, 'a \\textbf{bold}| b').ran).toBe(false);
    expect(select(selectConstructBackward, 'See \\cite{knuth|1984} now.').ran).toBe(false);
    expect(select(selectConstructForward, 'See \\cite{knuth1984}| now.').ran).toBe(false);
  });
});

describe('Backspace and Delete beside a style\'s or a heading\'s hidden markup', () => {
  it('Backspace after the hidden } takes the last character inside, never the brace', () => {
    expect(run(backspaceIntoConstruct, 'a \\textbf{bold}| b')).toEqual({ ran: true, text: 'a \\textbf{bol}| b' });
    expect(run(backspaceIntoConstruct, 'a \\textit{it}| b')).toEqual({ ran: true, text: 'a \\textit{i}| b' });
    expect(run(backspaceIntoConstruct, 'a \\textsc{ab}| b')).toEqual({ ran: true, text: 'a \\textsc{a}| b' });
    expect(run(backspaceIntoConstruct, '\\section{Intro}|\nBody')).toEqual({ ran: true, text: '\\section{Intr}|\nBody' });
    // past a heading's hidden \label as well
    expect(run(backspaceIntoConstruct, '\\section{Intro}\\label{sec:i}|\nBody')).toEqual({ ran: true, text: '\\section{Intr}\\label{sec:i}|\nBody' });
  });

  it('Delete before the hidden \\textbf{ takes the first character inside, never the command', () => {
    expect(run(deleteIntoConstruct, 'a |\\textbf{bold} b')).toEqual({ ran: true, text: 'a |\\textbf{old} b' });
    expect(run(deleteIntoConstruct, '|\\subsection{Intro}\nBody')).toEqual({ ran: true, text: '|\\subsection{ntro}\nBody' });
  });

  it('a style or heading left without text goes with its markup', () => {
    expect(run(backspaceIntoConstruct, 'a \\emph{x}| b')).toEqual({ ran: true, text: 'a | b' });
    expect(run(deleteIntoConstruct, 'a |\\underline{u} b')).toEqual({ ran: true, text: 'a | b' });
    expect(run(backspaceIntoConstruct, 'a \\textbf{}| b')).toEqual({ ran: true, text: 'a | b' });
    expect(run(backspaceIntoConstruct, 'x \\textbf{\\emph{b}}| y')).toEqual({ ran: true, text: 'x | y' });
  });

  it('goes through nested styles to their text and takes an escape whole', () => {
    expect(run(backspaceIntoConstruct, 'x \\textbf{a \\emph{bc}}| y')).toEqual({ ran: true, text: 'x \\textbf{a \\emph{b}}| y' });
    expect(run(deleteIntoConstruct, 'x |\\textbf{\\emph{bc} a} y')).toEqual({ ran: true, text: 'x |\\textbf{\\emph{c} a} y' });
    expect(run(backspaceIntoConstruct, 'x \\textbf{50\\%}| y')).toEqual({ ran: true, text: 'x \\textbf{50}| y' });
  });

  it('selects a chip or a brace group inside instead of taking a byte of it', () => {
    const select = (marked: string) => {
      const at = marked.indexOf('|');
      const doc = marked.slice(0, at) + marked.slice(at + 1);
      let s = parsedState({ doc, selection: { anchor: at }, extensions: [latex(), revealField, atomicField] });
      const ran = backspaceIntoConstruct({ state: s, dispatch: (tr) => { s = tr.state; } });
      return { ran, doc: s.doc.toString() === doc, selected: s.sliceDoc(s.selection.main.from, s.selection.main.to) };
    };
    expect(select('x \\textbf{see \\cite{k}}| y')).toEqual({ ran: true, doc: true, selected: '\\cite{k}' });
    expect(select('x \\textbf{a {b}}| y')).toEqual({ ran: true, doc: true, selected: '{b}' });
  });

  it('leaves text and the inside of a style to the usual keys', () => {
    expect(run(backspaceIntoConstruct, 'plain| text').ran).toBe(false);
    expect(run(backspaceIntoConstruct, 'a \\textbf{bo|ld} b').ran).toBe(false);
    expect(run(deleteIntoConstruct, 'a \\textbf{bold}| b').ran).toBe(false);
  });
});
