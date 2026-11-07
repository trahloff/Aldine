import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { addedKeys } from '../agentHighlight';
import { AGENT_EDITS_KEY } from '../agentMarks';
import { filesInPatch } from '../../util/patch';

describe('addedKeys', () => {
  it('names the side-map keys a transaction added, not the ones it pruned', () => {
    const server = new Y.Doc();
    const client = new Y.Doc();
    server.getMap(AGENT_EDITS_KEY).set('old', { k: 'del', a: null, t: 1 });
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
    const seen: string[][] = [];
    client.getMap(AGENT_EDITS_KEY).observe((e) => seen.push(addedKeys(e as never)));
    const before = Y.encodeStateVector(client);
    server.transact(() => {
      server.getMap(AGENT_EDITS_KEY).delete('old');
      server.getMap(AGENT_EDITS_KEY).set('new', { k: 'del', a: null, t: 2 });
    });
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server, before), 'provider');
    expect(seen).toEqual([['new']]);
  });

  it('a person typing adds no key, so nothing of theirs is tinted', () => {
    const server = new Y.Doc();
    const client = new Y.Doc();
    const seen: string[][] = [];
    client.getMap(AGENT_EDITS_KEY).observe((e) => seen.push(addedKeys(e as never)));
    server.getText('content').insert(0, 'typed by a co-author');
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server), 'provider');
    expect(client.getText('content').toString()).toBe('typed by a co-author');
    expect(seen).toEqual([]);
  });
});

describe('filesInPatch', () => {
  it('extracts distinct paths from diff --git headers', () => {
    const patch = [
      'diff --git a/main.tex b/main.tex',
      '--- a/main.tex',
      '+++ b/main.tex',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/chapters/ch1.tex b/chapters/ch1.tex',
      '+++ b/chapters/ch1.tex',
      'diff --git a/main.tex b/main.tex',
    ].join('\n');
    expect(filesInPatch(patch).sort()).toEqual(['chapters/ch1.tex', 'main.tex']);
  });

  it('returns an empty list for an empty patch', () => {
    expect(filesInPatch('')).toEqual([]);
  });
});
