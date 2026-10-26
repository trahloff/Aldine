import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import type { StateCommand } from '@codemirror/state';
import { ensureSyntaxTree, indentUnit } from '@codemirror/language';
import { latex } from 'codemirror-lang-latex';
import { revealField } from '../reveal';
import { atomicField } from '../atomicField';
import { backspaceHiddenLine, deleteHiddenLine, listItemEnter, paragraphEnter } from '../commands';

/** Runs `cmd` with the caret where `|` stands; the result shows the caret as `|` too. */
function run(cmd: StateCommand, marked: string) {
  const at = marked.indexOf('|');
  const doc = marked.slice(0, at) + marked.slice(at + 1);
  let s = EditorState.create({ doc, selection: { anchor: at }, extensions: [latex(), indentUnit.of('  '), revealField, atomicField] });
  ensureSyntaxTree(s, s.doc.length, 5_000);
  s = s.update({}).state;
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

  it('Delete at the end of the line before a list goes to its first item', () => {
    expect(run(deleteHiddenLine, `Before|\n${list}After`)).toEqual({ ran: true, text: `Before\n${list.replace('\\item One', '|\\item One')}After` });
  });
});
