import { describe, expect, it } from 'vitest';
import { presenceRows } from '../presence';

const me = { name: 'Ada', color: '#e8554d' };
const bob = { name: 'Bob', color: '#2e933c' };
const cy = { name: 'Cy', color: '#3366cc' };
const peer = (clientId: number, u: { name: string; color: string }, file: string | null) => ({ clientId, ...u, file });

describe('presenceRows', () => {
  it('lists the people in this file first, then everyone else on the branch with their file', () => {
    const rows = presenceRows([me, bob], [peer(1, bob, 'main.tex'), peer(2, cy, 'intro.tex')], 'main.tex', me);
    expect(rows.map((r) => [r.name, r.here, r.file])).toEqual([['Bob', true, 'main.tex'], ['Cy', false, 'intro.tex']]);
  });

  it('leaves this person out, in every tab of theirs', () => {
    expect(presenceRows([me], [peer(1, me, 'main.tex'), peer(2, me, 'notes.tex')], 'main.tex', me)).toEqual([]);
  });

  it('counts a peer in this file as here before its caret arrives, and keeps agent sessions', () => {
    const agent = { name: 'Claude', color: '#7c3aed', isAgent: true };
    const rows = presenceRows([me, agent], [peer(3, cy, 'main.tex')], 'main.tex', me);
    expect(rows.map((r) => [r.name, r.here, !!r.isAgent])).toEqual([['Claude', true, true], ['Cy', true, false]]);
  });

  it('with no file open (a preview elsewhere, or nothing), everyone is elsewhere, sorted by file', () => {
    const rows = presenceRows([], [peer(1, cy, null), peer(2, bob, 'b.tex'), peer(3, cy, 'a.tex')], null, me);
    expect(rows.map((r) => [r.name, r.file])).toEqual([['Cy', 'a.tex'], ['Bob', 'b.tex'], ['Cy', null]]);
  });
});
