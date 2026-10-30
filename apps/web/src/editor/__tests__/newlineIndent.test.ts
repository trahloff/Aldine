import { describe, it, expect } from 'vitest';
import { EditorState, type EditorStateConfig, type Extension } from '@codemirror/state';
import { ensureSyntaxTree, indentUnit } from '@codemirror/language';
import { insertNewlineAndIndent, indentSelection } from '@codemirror/commands';
import { latex } from 'codemirror-lang-latex';
import { latexNewlineIndent } from '../newlineIndent';

const editor = (withFix = true): Extension[] => [
  latex({ autoCloseTags: true, enableLinting: false, enableAutocomplete: false, enableTooltips: false }),
  indentUnit.of('  '),
  withFix ? latexNewlineIndent : [],
];

/**
 * A state the language's rules can read in full: a new one holds whatever
 * 20 ms of parsing reached, and only a later transaction adopts the rest.
 */
function parsed(config: EditorStateConfig): EditorState {
  const state = EditorState.create(config);
  if (!ensureSyntaxTree(state, state.doc.length, 5_000)) throw new Error('the parse did not finish');
  return state.update({}).state;
}

/** Presses Enter with the caret where `|` stands; the result marks the caret with `|` too. */
function enter(marked: string, withFix = true): string {
  const at = marked.indexOf('|');
  const doc = marked.slice(0, at) + marked.slice(at + 1);
  let state = parsed({ doc, selection: { anchor: at }, extensions: editor(withFix) });
  insertNewlineAndIndent({ state, dispatch: (tr) => { state = tr.state; } });
  const head = state.selection.main.head;
  const text = state.doc.toString();
  return text.slice(0, head) + '|' + text.slice(head);
}

/** The same lines inside a flush-left document body, where the bug showed. */
const inBody = (marked: string) => `\\documentclass{article}\n\\begin{document}\n${marked}\n\\end{document}\n`;

describe('Enter after a closing brace (#222)', () => {
  it('keeps the indentation of a line whose braces balance', () => {
    expect(enter('\\section{Intro}|')).toBe('\\section{Intro}\n|');
    expect(enter('\\textbf{a}|')).toBe('\\textbf{a}\n|');
    expect(enter('  \\item foo \\emph{x}|')).toBe('  \\item foo \\emph{x}\n  |');
  });

  it('keeps it in a flush-left document body, where the language indented every line', () => {
    expect(enter(inBody('\\section{Intro}|'), false)).toBe(inBody('\\section{Intro}\n  |'));
    expect(enter(inBody('\\section{Intro}|'))).toBe(inBody('\\section{Intro}\n|'));
    expect(enter(inBody('\\textbf{a}|'))).toBe(inBody('\\textbf{a}\n|'));
    expect(enter(inBody('Some text.|'))).toBe(inBody('Some text.\n|'));
    expect(enter(inBody('\\section{Intro}\nBody text|\nmore'))).toBe(inBody('\\section{Intro}\nBody text\n|\nmore'));
    expect(enter(inBody('  Indented on purpose \\cite{x}|'))).toBe(inBody('  Indented on purpose \\cite{x}\n  |'));
  });

  it('indents one unit after an unclosed brace', () => {
    expect(enter('\\newcommand{\\x}{|')).toBe('\\newcommand{\\x}{\n  |');
    expect(enter(inBody('\\newcommand{\\x}{|'))).toBe(inBody('\\newcommand{\\x}{\n  |'));
    expect(enter('  \\foo{a}{|')).toBe('  \\foo{a}{\n    |');
    // two groups opened on one line are still one unit
    expect(enter('\\foo{\\bar{|')).toBe('\\foo{\\bar{\n  |');
  });

  it('splits an empty pair onto three lines with the caret indented', () => {
    expect(enter('\\newcommand{\\x}{|}')).toBe('\\newcommand{\\x}{\n  |\n}');
  });

  it('leaves a closing brace after the caret at the line\'s indentation', () => {
    expect(enter('\\newcommand{\\x}{foo|}')).toBe('\\newcommand{\\x}{foo\n|}');
    expect(enter('\\foo{\n  bar|}')).toBe('\\foo{\n  bar\n|}');
  });

  it('goes back to the opening line after a brace that closes a group from further up', () => {
    expect(enter('\\newcommand{\\x}{\n  foo\n}|')).toBe('\\newcommand{\\x}{\n  foo\n}\n|');
    expect(enter('\\newcommand{\\x}{\n  foo}|')).toBe('\\newcommand{\\x}{\n  foo}\n|');
    expect(enter('  \\foo{\n    bar\n  }|')).toBe('  \\foo{\n    bar\n  }\n  |');
    expect(enter('\\foo{\n  \\bar{\n    x\n  }|')).toBe('\\foo{\n  \\bar{\n    x\n  }\n  |');
    expect(enter('\\foo{\n  \\bar{\n    x}}|')).toBe('\\foo{\n  \\bar{\n    x}}\n|');
    expect(enter(inBody('\\newcommand{\\x}{\n  foo\n}|'))).toBe(inBody('\\newcommand{\\x}{\n  foo\n}\n|'));
    // closes the first argument and opens the next
    expect(enter('\\ifthenelse{x}{\n  a\n}{|')).toBe('\\ifthenelse{x}{\n  a\n}{\n  |');
  });

  it('does not count escaped braces or braces in a comment', () => {
    expect(enter('\\{a|')).toBe('\\{a\n|');
    expect(enter('$\\left\\{ x \\right.$|')).toBe('$\\left\\{ x \\right.$\n|');
    expect(enter('text % a { in a comment|')).toBe('text % a { in a comment\n|');
    expect(enter('\\foo{%\n  x|')).toBe('\\foo{%\n  x\n  |');
    expect(enter('\\foo{%\n  x}|')).toBe('\\foo{%\n  x}\n|');
    expect(enter('100\\% {|')).toBe('100\\% {\n  |');
  });

  it('keeps what the language did for \\begin, \\item and \\end', () => {
    for (const marked of [
      '\\begin{itemize}|',
      '\\begin{figure}[h]|',
      '\\begin{tabular}{ll}|',
      '\\begin{itemize}\n  \\item a|\n\\end{itemize}',
      '\\begin{itemize}\n  \\item a\n  \\begin{enumerate}|',
      '\\begin{itemize}\n  \\item a\n\\end{itemize}|',
      '\\begin{itemize}\n  \\item a\n\\end{itemize}|\nmore',
      '\\begin{itemize}|\\end{itemize}',
      '\\[|',
      '\\[\n  x = y|\n\\]',
      '\\includegraphics[|',
      '\\usepackage[|]{geometry}',
    ]) expect(enter(marked), marked).toBe(enter(marked, false));
  });

  it('closes an environment back to its \\begin line, also in the document body', () => {
    expect(enter(inBody('\\begin{figure}\n  \\centering\n\\end{figure}|'), false)).toBe(inBody('\\begin{figure}\n  \\centering\n\\end{figure}\n  |'));
    expect(enter(inBody('\\begin{figure}\n  \\centering\n\\end{figure}|'))).toBe(inBody('\\begin{figure}\n  \\centering\n\\end{figure}\n|'));
    expect(enter(inBody('\\begin{itemize}\n\\item a|\n\\end{itemize}'))).toBe(inBody('\\begin{itemize}\n\\item a\n|\n\\end{itemize}'));
    expect(enter(inBody('\\begin{itemize}|'))).toBe(inBody('\\begin{itemize}\n  |'));
    expect(enter('\\[\n  x = y\n\\]|')).toBe('\\[\n  x = y\n\\]\n|');
    expect(enter('\\usepackage[\n  margin=1in\n]{geometry}|')).toBe('\\usepackage[\n  margin=1in\n]{geometry}\n|');
  });

  it('keeps the line\'s indentation for a caret at its start', () => {
    expect(enter('x\n|  foo')).toBe('x\n\n  |foo');
    expect(enter('x\n|  } foo')).toBe('x\n\n  |} foo');
  });

  it('leaves reindenting to the language', () => {
    const doc = '\\begin{itemize}\n\\item a\n\\end{itemize}';
    const run = (withFix: boolean) => {
      let state = parsed({ doc, selection: { anchor: 0, head: doc.length }, extensions: editor(withFix) });
      indentSelection({ state, dispatch: (tr) => { state = tr.state; } });
      return state.doc.toString();
    };
    expect(run(true)).toBe(run(false));
  });
});
