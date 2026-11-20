import { describe, it, expect } from 'vitest';
import { plainWords, titleBlockJump } from '../titleBlock';

// acmart: the title block is set down before \maketitle and typeset by it.
const ACM = [
  '\\documentclass[acmlarge,review,anonymous]{acmart}', // 1
  '\\begin{document}', // 2
  '\\title{Sharper Jumps for Long Papers}', // 3
  '\\author{Ada Lovelace}', // 4
  '\\affiliation{\\institution{Analytical Engines}\\country{UK}}', // 5
  '\\begin{abstract}', // 6
  'Double-clicking a \\emph{typeset} abstract should open', // 7
  'the line it was written on, % not the maketitle line', // 8
  'even though the class typesets it later.', // 9
  '\\end{abstract}', // 10
  '\\keywords{synctex, source editors, LaTeX}', // 11
  '\\maketitle', // 12
  '\\section{Introduction}', // 13
  'The body is where SyncTeX is exact.', // 14
  '\\end{document}', // 15
];

describe('titleBlockJump', () => {
  it('finds the abstract line a double-clicked span came from', () => {
    expect(titleBlockJump(ACM, 12, 'Double-clicking a typeset abstract should open')).toEqual({ kind: 'found', line: 7 });
    expect(titleBlockJump(ACM, 12, 'even though the class typesets')).toEqual({ kind: 'found', line: 9 });
  });

  it('finds the title and the keywords too', () => {
    expect(titleBlockJump(ACM, 12, 'Sharper Jumps for Long Papers')).toEqual({ kind: 'found', line: 3 });
    expect(titleBlockJump(ACM, 12, 'Additional Key Words and Phrases: synctex, source editors, LaTeX')).toEqual({ kind: 'found', line: 11 });
  });

  it('matches a span that runs across two source lines by its longer part', () => {
    expect(titleBlockJump(ACM, 12, 'abstract should open the line it was written on')).toEqual({ kind: 'found', line: 8 });
  });

  it('ignores text that only a comment holds', () => {
    expect(titleBlockJump(ACM, 12, 'not the maketitle line')).toEqual({ kind: 'maketitle' });
  });

  it('says so when nothing above \\maketitle holds the text', () => {
    // The class's own words, such as the ACM reference format line.
    expect(titleBlockJump(ACM, 12, 'ACM Reference Format')).toEqual({ kind: 'maketitle' });
    expect(titleBlockJump(ACM, 12, '')).toEqual({ kind: 'maketitle' });
    expect(titleBlockJump(ACM, 12, 'of')).toEqual({ kind: 'maketitle' });
  });

  it('leaves every other line alone', () => {
    expect(titleBlockJump(ACM, 14, 'The body is where SyncTeX is exact.')).toEqual({ kind: 'plain' });
    expect(titleBlockJump(ACM, 99, 'anything')).toEqual({ kind: 'plain' });
    expect(titleBlockJump(['\\maketitlebox'], 1, 'anything at all here')).toEqual({ kind: 'plain' });
    expect(titleBlockJump(['% \\maketitle'], 1, 'anything at all here')).toEqual({ kind: 'plain' });
  });
});

describe('plainWords', () => {
  it('drops command names and punctuation, keeps letters in any script', () => {
    expect(plainWords('\\emph{Größe} und  Ölpreis, 2026!')).toEqual(['größe', 'und', 'ölpreis', '2026']);
  });
});
