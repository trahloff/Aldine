import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { latex } from 'codemirror-lang-latex';
import { documentOutline } from '../outline';

describe('Contents outline', () => {
  it('lists the headings past what the state has parsed so far', () => {
    // A new state parses at most its first 3,000 characters.
    const chapter = 'Plain prose for a long chapter. '.repeat(200) + '\n';
    const doc = `\\section{First}\n${chapter}\\section{Middle}\n${chapter}\\subsection{Last}\n`;
    const s = EditorState.create({ doc, extensions: [latex()] });
    expect(documentOutline(s).map(({ level, title }) => [level, title])).toEqual([[1, 'First'], [1, 'Middle'], [2, 'Last']]);
  });
});
