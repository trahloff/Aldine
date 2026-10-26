import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { macrosUsedBy, preambleMacros } from '../preamble';
import { macroField, macrosOf } from '../macros';

describe('preamble macros for formulas (#153)', () => {
  it('reads the definitions MathLive and KaTeX can take', () => {
    const { defs } = preambleMacros([
      '\\newcommand{\\R}{\\mathbb{R}}',
      '\\renewcommand*\\vec[1]{\\mathbf{#1}}',
      '\\newcommand{\\pair}[2]{(#1, #2)}',
      '\\providecommand{\\R}{\\mathbb{Q}}',
      '\\DeclareMathOperator{\\Tr}{Tr}',
      '\\DeclareMathOperator*{\\argmax}{arg\\,max}',
      '\\newcommand{\\opt}[2][x]{#1 #2}',
      '\\newcommand{\\bad}{#1}',
      '\\newcommand{\\nested}{\\frac{\\pi}{2}}',
    ].join('\n'));
    expect(defs).toEqual({
      R: { def: '\\mathbb{R}', args: 0 },
      vec: { def: '\\mathbf{#1}', args: 1 },
      pair: { def: '(#1, #2)', args: 2 },
      Tr: { def: '\\operatorname{Tr}', args: 0 },
      argmax: { def: '\\operatorname*{arg\\,max}', args: 0 },
      nested: { def: '\\frac{\\pi}{2}', args: 0 },
    });
  });

  it('follow edits to the preamble and ignore edits in the body', () => {
    const doc = '\\documentclass{article}\n\\newcommand{\\R}{\\mathbb{R}}\n\\begin{document}\n$x \\in \\R$\n\\end{document}\n';
    let s = EditorState.create({ doc, extensions: [macroField] });
    const first = macrosOf(s);
    expect(Object.keys(first.defs)).toEqual(['R']);
    s = s.update({ changes: { from: doc.indexOf('$x'), insert: 'Body ' } }).state;
    expect(macrosOf(s)).toBe(first);
    s = s.update({ changes: { from: doc.indexOf('\\begin{document}'), insert: '\\newcommand{\\N}{\\mathbb{N}}\n' } }).state;
    expect(Object.keys(macrosOf(s).defs).sort()).toEqual(['N', 'R']);
    // commented out: gone
    s = s.update({ changes: { from: 0, to: 0, insert: '' } }).state;
    const at = s.doc.toString().indexOf('\\newcommand{\\R}');
    s = s.update({ changes: { from: at, insert: '% ' } }).state;
    expect(Object.keys(macrosOf(s).defs)).toEqual(['N']);
  });
});

describe('the macros a formula uses', () => {
  it('follows definitions into the macros they use, and nothing else', () => {
    const set = preambleMacros('\\newcommand{\\R}{\\mathbb{R}}\n\\newcommand{\\Rn}{\\R^n}\n\\newcommand{\\eps}{\\varepsilon}');
    expect(Object.keys(macrosUsedBy('x \\in \\Rn', set).defs)).toEqual(['R', 'Rn']);
    expect(macrosUsedBy('x^2', set).key).toBe('');
    // editing a macro a formula does not use leaves its key as it was
    const edited = preambleMacros('\\newcommand{\\R}{\\mathbb{R}}\n\\newcommand{\\Rn}{\\R^n}\n\\newcommand{\\eps}{\\epsilon}');
    expect(macrosUsedBy('x \\in \\Rn', edited).key).toBe(macrosUsedBy('x \\in \\Rn', set).key);
  });
});
