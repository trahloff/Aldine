import { describe, it, expect } from 'vitest';
import { citationEdit, type CitationEdit } from '../citeInsert';

/** `text` with a | for the cursor, after the edit; the | marks where the cursor ends. */
function cite(marked: string, key: string): { text: string; kind: CitationEdit['kind'] } {
  const from = marked.indexOf('|');
  const text = marked.replace('|', '');
  const edit = citationEdit(text, from, key);
  if (edit.kind === 'present') return { kind: edit.kind, text: text.slice(0, edit.cursor) + '|' + text.slice(edit.cursor) };
  const next = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  return { kind: edit.kind, text: next.slice(0, edit.cursor) + '|' + next.slice(edit.cursor) };
}

describe('citationEdit', () => {
  it('inserts a new \\cite outside any citation', () => {
    expect(cite('As shown by | we', 'knuth1984')).toEqual({ kind: 'insert', text: 'As shown by \\cite{knuth1984}| we' });
  });

  it('adds the key inside a citation instead of nesting one', () => {
    expect(cite('see \\cite{knuth1984|} here', 'lamport1994')).toEqual({ kind: 'add', text: 'see \\cite{knuth1984,lamport1994}| here' });
    expect(cite('see \\cite{|knuth1984}', 'lamport1994')).toEqual({ kind: 'add', text: 'see \\cite{knuth1984,lamport1994}|' });
  });

  it('follows the list’s spacing, and an empty or comma-ended list', () => {
    expect(cite('\\cite{a, b|}', 'c').text).toBe('\\cite{a, b, c}|');
    expect(cite('\\cite{|}', 'c').text).toBe('\\cite{c}|');
    expect(cite('\\cite{a,|}', 'c').text).toBe('\\cite{a,c}|');
  });

  it('joins a citation the cursor sits right after, so repeated picks make one list', () => {
    expect(cite('\\cite{a}| and more', 'b')).toEqual({ kind: 'add', text: '\\cite{a,b}| and more' });
    const once = cite('x |', 'a').text;
    const twice = cite(once, 'b').text;
    expect(cite(twice, 'c').text).toBe('x \\cite{a,b,c}|');
  });

  it('knows the natbib and biblatex commands, with optional arguments', () => {
    expect(cite('\\citep[see][p.~3]{a|}', 'b').text).toBe('\\citep[see][p.~3]{a,b}|');
    expect(cite('\\parencite*{a}|', 'b').text).toBe('\\parencite*{a,b}|');
    expect(cite('\\textcite{a|}', 'b').text).toBe('\\textcite{a,b}|');
  });

  it('leaves a citation that holds the key as it is', () => {
    expect(cite('\\cite{a,b|} x', 'a')).toEqual({ kind: 'present', text: '\\cite{a,b}| x' });
  });

  it('does not join a \\nocite it only follows, nor a group that is not a citation', () => {
    expect(cite('\\nocite{a}|', 'b').text).toBe('\\nocite{a}\\cite{b}|');
    expect(cite('\\emph{a}|', 'b').text).toBe('\\emph{a}\\cite{b}|');
    expect(cite('\\emph{a|}', 'b').text).toBe('\\emph{a\\cite{b}|}');
  });

  it('closes an argument still being typed', () => {
    expect(cite('\\cite{a|\n\\end{document}', 'b').text).toBe('\\cite{a,b}|\n\\end{document}');
  });

  it('replaces a selection outside citations', () => {
    const text = 'replace THIS here';
    const edit = citationEdit(text, 8, 'k', 12);
    expect(edit).toEqual({ kind: 'insert', from: 8, to: 12, insert: '\\cite{k}', cursor: 16 });
  });
});
