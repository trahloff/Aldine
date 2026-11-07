import { describe, expect, it } from 'vitest';
import { diffWords, tokenize } from '../wordDiff';
import { parsePatch } from '../patch';

const changed = (segs: Array<{ text: string; changed: boolean }> | undefined) => segs?.filter((s) => s.changed).map((s) => s.text);

describe('tokenize', () => {
  it('splits LaTeX into words, spaces and single marks', () => {
    expect(tokenize('\\emph{très} bien.')).toEqual(['\\', 'emph', '{', 'très', '}', ' ', 'bien', '.']);
  });
});

describe('diffWords', () => {
  it('marks only the word that changed in a long paragraph', () => {
    const before = `${'The results improve steadily across all trials and settings. '.repeat(8)}Overall the effect is small.`;
    const after = before.replace('effect is small', 'effect is large');
    const w = diffWords(before, after)!;
    expect(changed(w.del)).toEqual(['small']);
    expect(changed(w.add)).toEqual(['large']);
    expect(w.del.map((s) => s.text).join('')).toBe(before);
    expect(w.add.map((s) => s.text).join('')).toBe(after);
  });

  it('marks an inserted word on the new side only', () => {
    const w = diffWords('A quick test.', 'A very quick test.')!;
    expect(changed(w.del)).toEqual([]);
    expect(changed(w.add)).toEqual(['very ']);
  });

  it('finds the change in the middle of a command', () => {
    const w = diffWords('\\cite{smith2020} shows it', '\\cite{smith2021} shows it')!;
    expect(changed(w.del)).toEqual(['smith2020']);
    expect(changed(w.add)).toEqual(['smith2021']);
  });

  it('gives up on a rewrite: highlights would cover the whole line', () => {
    expect(diffWords('Completely different words here', 'Nothing alike at all, really')).toBeNull();
  });
});

describe('parsePatch', () => {
  const patch = [
    'diff --git a/main.tex b/main.tex',
    'index 1111111..2222222 100644',
    '--- a/main.tex',
    '+++ b/main.tex',
    '@@ -1,3 +1,3 @@',
    ' \\section{Intro}',
    '-The effect is small.',
    '--- a dash line that is content',
    '+The effect is large.',
    '+-- a dash line that is content, edited',
    '\\ No newline at end of file',
  ].join('\n');

  it('drops the header lines and only those', () => {
    const lines = parsePatch(patch);
    expect(lines.map((l) => l.kind)).toEqual(['file', 'hunk', 'ctx', 'del', 'del', 'add', 'add', 'ctx']);
    expect(lines[0].text).toBe('main.tex');
    expect(lines[4].text).toBe('--- a dash line that is content');
  });

  it('pairs removed and added lines in order for word highlights', () => {
    const lines = parsePatch(patch) as Array<{ kind: string; words?: Array<{ text: string; changed: boolean }> }>;
    expect(changed(lines[3].words)).toEqual(['small']);
    expect(changed(lines[5].words)).toEqual(['large']);
    expect(changed(lines[6].words)).toEqual([', edited']);
  });

  it('names a renamed file by both paths', () => {
    expect(parsePatch('diff --git a/old.tex b/new.tex\nsimilarity index 100%\nrename from old.tex\nrename to new.tex')).toEqual([
      { kind: 'file', text: 'old.tex → new.tex' },
    ]);
  });
});
