import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../../api';
import { describeCommit, filesSummary, historyRows } from '../history';

let n = 0;
const entry = (message: string, minute: number, over: Partial<LogEntry> = {}): LogEntry => ({
  hash: String(++n).padStart(40, '0'),
  date: new Date(Date.UTC(2026, 10, 5, 9, 0) + minute * 60_000).toISOString(),
  message,
  author: 'Aldine',
  files: ['main.tex'],
  fileCount: 1,
  parents: 1,
  ...over,
});

describe('describeCommit', () => {
  it('puts Aldine’s own subjects in words', () => {
    expect(describeCommit(entry('aldine: autosave', 0))).toMatchObject({ kind: 'autosave', title: 'Autosave' });
    expect(describeCommit(entry('aldine: autosave on shutdown', 0))).toMatchObject({ kind: 'autosave', title: 'Autosave' });
    expect(describeCommit(entry('aldine: checkpoint before branching', 0))).toMatchObject({ kind: 'system', title: 'Saved before starting a branch' });
    expect(describeCommit(entry('aldine: sync Zotero library into refs.bib', 0))).toMatchObject({ kind: 'system', title: 'Synced the Zotero library into refs.bib' });
    expect(describeCommit(entry('aldine: something new', 0))).toMatchObject({ kind: 'system', title: 'Something new' });
  });

  it('marks a commit a person named as a checkpoint', () => {
    expect(describeCommit(entry('Submitted to the journal', 0, { author: 'Ada' })).kind).toBe('checkpoint');
    expect(describeCommit(entry('aldine: manual commit', 0, { author: 'Ada' }))).toMatchObject({ kind: 'checkpoint', title: 'Checkpoint' });
  });

  it('tells Claude’s commits and Aldine’s titles for a person’s action apart', () => {
    expect(describeCommit(entry('Tighten the abstract', 0, { author: 'Claude' })).kind).toBe('agent');
    for (const m of ['Initial commit', 'Undo the deletion of chapters', 'Merge draft into main', 'Replace "colour" with "color" in 3 files', 'Delete "TODO" in main.tex', 'Undo “Autosave”', 'Revert Claude’s edits']) {
      expect(describeCommit(entry(m, 0, { author: 'Ada' })).kind).toBe('system');
    }
  });

  it('knows the file route’s deletion by what it holds', () => {
    expect(describeCommit(entry('Delete main.tex', 0, { author: 'Ada', files: ['main.tex'] })).kind).toBe('system');
    expect(describeCommit(entry('Delete folder chapters', 0, { author: 'Ada', files: ['chapters/a.tex', 'chapters/b.tex'] })).kind).toBe('system');
    expect(describeCommit(entry('Delete the old intro', 0, { author: 'Ada', files: ['intro.tex'] })).kind).toBe('checkpoint');
  });
});

describe('historyRows', () => {
  it('folds autosaves in a row into one row with every file they changed', () => {
    const rows = historyRows([
      entry('aldine: autosave', 30, { files: ['refs.bib'] }),
      entry('aldine: autosave', 20),
      entry('aldine: autosave', 10),
      entry('Submitted', 5, { author: 'Ada' }),
      entry('aldine: autosave', 2),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['autosaves', 'commit', 'commit']);
    const group = rows[0] as Extract<(typeof rows)[number], { kind: 'autosaves' }>;
    expect(group.views).toHaveLength(3);
    expect(group.files).toEqual(['refs.bib', 'main.tex']);
  });

  it('starts a new fold after a long pause', () => {
    const rows = historyRows([
      entry('aldine: autosave', 200),
      entry('aldine: autosave', 190),
      entry('aldine: autosave', 60),
      entry('aldine: autosave', 50),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['autosaves', 'autosaves']);
  });
});

describe('filesSummary', () => {
  it('names two files and counts the rest', () => {
    expect(filesSummary(['a.tex'])).toBe('a.tex');
    expect(filesSummary(['a.tex', 'b.tex'])).toBe('a.tex, b.tex');
    expect(filesSummary(['a.tex', 'b.tex', 'c.tex'], 25)).toBe('a.tex, b.tex and 23 more');
  });
});
