import { describe, expect, it } from 'vitest';
import { filesInPatch, parseDiffGitHeader, parsePatch } from '../patch';

describe('parseDiffGitHeader', () => {
  it('parses a plain header', () => {
    expect(parseDiffGitHeader('diff --git a/main.tex b/main.tex')).toEqual(['main.tex', 'main.tex']);
  });

  it('decodes a German non-ASCII name from its octal escapes', () => {
    expect(parseDiffGitHeader('diff --git "a/Einf\\303\\274hrung.tex" "b/Einf\\303\\274hrung.tex"')).toEqual([
      'Einführung.tex',
      'Einführung.tex',
    ]);
  });

  it('decodes a Persian non-ASCII name from its octal escapes', () => {
    expect(
      parseDiffGitHeader(
        'diff --git "a/\\331\\205\\331\\202\\330\\257\\331\\205\\331\\207.tex" "b/\\331\\205\\331\\202\\330\\257\\331\\205\\331\\207.tex"',
      ),
    ).toEqual(['مقدمه.tex', 'مقدمه.tex']);
  });

  it('keeps a name with a space, quoted by git', () => {
    expect(parseDiffGitHeader('diff --git "a/my file.tex" "b/my file.tex"')).toEqual(['my file.tex', 'my file.tex']);
  });

  it('parses a rename where only the new side is quoted', () => {
    expect(parseDiffGitHeader('diff --git a/alt.tex "b/Einf\\303\\274hrung.tex"')).toEqual(['alt.tex', 'Einführung.tex']);
  });

  it('unescapes a double quote inside a quoted name', () => {
    expect(parseDiffGitHeader('diff --git "a/say \\"hi\\".tex" "b/say \\"hi\\".tex"')).toEqual(['say "hi".tex', 'say "hi".tex']);
  });

  it('unescapes a backslash inside a quoted name', () => {
    expect(parseDiffGitHeader('diff --git "a/back\\\\slash.tex" "b/back\\\\slash.tex"')).toEqual(['back\\slash.tex', 'back\\slash.tex']);
  });

  it('returns null for anything that is not a well-formed header', () => {
    expect(parseDiffGitHeader('--- a/main.tex')).toBeNull();
    expect(parseDiffGitHeader('diff --git a/only-one-side')).toBeNull();
    expect(parseDiffGitHeader('diff --git "a/x.tex b/x.tex')).toBeNull();
    expect(parseDiffGitHeader('diff --git a/main.tex b/main.tex extra')).toBeNull();
  });
});

describe('parsePatch with quoted headers', () => {
  it('shows the decoded name instead of the raw quoted line', () => {
    const patch = [
      'diff --git "a/Einf\\303\\274hrung.tex" "b/Einf\\303\\274hrung.tex"',
      'index 1111111..2222222 100644',
      '--- "a/Einf\\303\\274hrung.tex"',
      '+++ "b/Einf\\303\\274hrung.tex"',
      '@@ -1 +1 @@',
      '-alt',
      '+neu',
    ].join('\n');
    const lines = parsePatch(patch);
    expect(lines[0]).toEqual({ kind: 'file', text: 'Einführung.tex' });
    expect(lines.map((l) => l.kind)).toEqual(['file', 'hunk', 'del', 'add']);
  });

  it('names a quoted rename by both paths', () => {
    const patch = 'diff --git a/alt.tex "b/Einf\\303\\274hrung.tex"\nsimilarity index 100%\nrename from alt.tex\nrename to "b/Einf\\303\\274hrung.tex"';
    expect(parsePatch(patch)).toEqual([{ kind: 'file', text: 'alt.tex → Einführung.tex' }]);
  });
});

describe('filesInPatch with quoted headers', () => {
  it('counts a quoted non-ASCII file alongside a plain one', () => {
    const patch = [
      'diff --git "a/Einf\\303\\274hrung.tex" "b/Einf\\303\\274hrung.tex"',
      '@@ -1 +1 @@',
      '-alt',
      '+neu',
      'diff --git a/main.tex b/main.tex',
    ].join('\n');
    expect(filesInPatch(patch).sort()).toEqual(['Einführung.tex', 'main.tex']);
  });

  it('counts the new side of a quoted rename', () => {
    expect(filesInPatch('diff --git a/alt.tex "b/\\331\\205\\331\\202\\330\\257\\331\\205\\331\\207.tex"')).toEqual(['مقدمه.tex']);
  });
});
