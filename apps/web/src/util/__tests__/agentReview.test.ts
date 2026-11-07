import { describe, expect, it } from 'vitest';
import { mergeAgentBatches, revertSummary, type AgentBatch } from '../agentReview';

const commit = (hash: string, minute: number, files: string[]) =>
  ({ hash: hash.repeat(40).slice(0, 40), date: `2026-11-04T10:${String(minute).padStart(2, '0')}:00+01:00`, message: `commit ${hash}`, files });

const batch = (over: Partial<AgentBatch>): AgentBatch => ({
  since: null, head: 'h'.repeat(40), commits: [], commitCount: 0, fileCount: 0, truncated: false, ...over,
});

describe('mergeAgentBatches', () => {
  it('keeps the newer answer when both were counted from the same mark', () => {
    const older = batch({ commits: [commit('a', 1, ['main.tex'])], commitCount: 1, fileCount: 1 });
    const newer = batch({ head: 'n'.repeat(40), commits: [commit('b', 5, ['intro.tex']), commit('a', 1, ['main.tex'])], commitCount: 2, fileCount: 2 });
    expect(mergeAgentBatches(older, newer, 20)).toBe(newer);
  });

  it('treats an empty mark and no mark as the same mark', () => {
    const older = batch({ since: { head: '', at: '' }, commits: [commit('a', 1, ['main.tex'])], commitCount: 1, fileCount: 1 });
    const newer = batch({ commits: [commit('a', 1, ['main.tex'])], commitCount: 1, fileCount: 1 });
    expect(mergeAgentBatches(older, newer, 20)).toBe(newer);
  });

  it('carries the batch on screen when the mark moved past it', () => {
    // a second sighting acknowledged the older batch while its prompt was still up
    const older = batch({ head: 'o'.repeat(40), commits: [commit('a', 1, ['main.tex']), commit('c', 0, ['refs.bib'])], commitCount: 2, fileCount: 2 });
    const newer = batch({ since: { head: 'o'.repeat(40), at: '2026-11-04T09:20:00.000Z' }, head: 'n'.repeat(40), commits: [commit('b', 5, ['main.tex', 'intro.tex'])], commitCount: 1, fileCount: 2 });
    const merged = mergeAgentBatches(older, newer, 20);
    expect(merged.commits.map((c) => c.hash[0])).toEqual(['b', 'a', 'c']);
    expect(merged.commitCount).toBe(3);
    expect(merged.fileCount).toBe(3);
    expect(merged.head).toBe(newer.head);
    expect(merged.since).toBe(older.since);
    expect(merged.truncated).toBe(false);
  });

  it('counts a commit both answers list once', () => {
    const older = batch({ commits: [commit('a', 1, ['main.tex'])], commitCount: 1, fileCount: 1 });
    const newer = batch({ since: { head: 'x'.repeat(40), at: '2026-11-04T09:00:00.000Z' }, commits: [commit('b', 5, ['main.tex']), commit('a', 1, ['main.tex'])], commitCount: 2, fileCount: 1 });
    const merged = mergeAgentBatches(older, newer, 20);
    expect(merged.commits.map((c) => c.hash[0])).toEqual(['b', 'a']);
    expect(merged.commitCount).toBe(2);
    expect(merged.fileCount).toBe(1);
  });

  it('caps the commits it lists but not the counts', () => {
    const many = (prefix: number, n: number) => Array.from({ length: n }, (_, i) => ({ ...commit(String(prefix), 0, [`f${prefix}-${i}.tex`]), hash: `${prefix}${String(i).padStart(39, '0')}`, date: `2026-11-04T1${prefix}:${String(i).padStart(2, '0')}:00Z` }));
    const older = batch({ commits: many(1, 20), commitCount: 30, fileCount: 30, truncated: false });
    const newer = batch({ since: { head: 'x'.repeat(40), at: '2026-11-04T09:00:00.000Z' }, commits: many(2, 5), commitCount: 5, fileCount: 5, truncated: true });
    const merged = mergeAgentBatches(older, newer, 20);
    expect(merged.commits).toHaveLength(20);
    expect(merged.commits[0].hash.startsWith('2')).toBe(true);
    expect(merged.commitCount).toBe(35);
    expect(merged.fileCount).toBe(30);
    expect(merged.truncated).toBe(true);
  });
});

describe('revertSummary', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  it('says whose commits go, when they were made, and whose name the revert carries', () => {
    expect(revertSummary({ commits: 20, files: 14, branch: 'main', dates: ['2026-08-02T09:00:00Z', '2026-09-04T09:00:00Z', '2026-08-20T09:00:00Z'], author: 'Grace Hopper' }, now))
      .toBe('This undoes 20 commits Claude made on main between Aug 2 and Sep 4, in 14 files. It adds a new commit under your name, Grace Hopper; the history keeps both, and Undo brings the changes back.');
  });
  it('names one day once, and leaves out what it does not know', () => {
    expect(revertSummary({ commits: 1, files: 1, branch: 'draft', dates: ['2026-11-05T10:00:00Z'], author: null }, now))
      .toBe('This undoes 1 commit Claude made on draft today, in 1 file. It adds a new commit under your name; the history keeps both, and Undo brings the changes back.');
    expect(revertSummary({ commits: 2, files: 3, branch: 'main', dates: [], author: 'Ada' }, now)).toMatch(/^This undoes 2 commits Claude made on main, in 3 files\./);
  });
});
