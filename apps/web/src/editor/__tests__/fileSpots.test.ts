import { describe, it, expect } from 'vitest';
import { ChangeSet } from '@codemirror/state';
import { clampSpot, makeSpotStore, mapSpot } from '../fileSpots';
import { makeSafeStore } from '../../util/safeStorage';

function backing() {
  const m = new Map<string, string>();
  const storage: Storage = {
    get length() { return m.size; },
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
  };
  return { storage, raw: m };
}

describe('the spot a file was left at', () => {
  it('is there for the next visit, in this page and the next', () => {
    const { storage } = backing();
    const spot = { anchor: 120, head: 140, top: 96, margin: -7 };
    makeSpotStore(makeSafeStore(() => storage)).set('p::main::ch3.tex', spot);
    const next = makeSpotStore(makeSafeStore(() => storage));
    expect(next.get('p::main::ch3.tex')).toEqual(spot);
    expect(next.get('p::draft::ch3.tex')).toBeNull();
  });

  it('is kept for the files left last, the oldest going first', () => {
    const { storage } = backing();
    const store = makeSpotStore(makeSafeStore(() => storage), 3);
    for (const f of ['a', 'b', 'c']) store.set(f, { anchor: 1, head: 1, top: 0, margin: 0 });
    store.set('a', { anchor: 2, head: 2, top: 0, margin: 0 }); // a is the latest again
    store.set('d', { anchor: 3, head: 3, top: 0, margin: 0 });
    const next = makeSpotStore(makeSafeStore(() => storage), 3);
    expect(next.get('b')).toBeNull();
    expect(['a', 'c', 'd'].map((f) => next.get(f)?.anchor)).toEqual([2, 1, 3]);
  });

  it('reads as nothing from damaged storage, and from none', () => {
    const { storage, raw } = backing();
    raw.set('aldine.fileSpots', JSON.stringify({ ok: [1, 2, 3, 4], short: [1, 2], neg: [-1, 0, 0, 0], text: 'x' }));
    const store = makeSpotStore(makeSafeStore(() => storage));
    expect(store.get('ok')).toEqual({ anchor: 1, head: 2, top: 3, margin: 4 });
    expect([store.get('short'), store.get('neg'), store.get('text')]).toEqual([null, null, null]);
    raw.set('aldine.fileSpots', '{not json');
    expect(makeSpotStore(makeSafeStore(() => storage)).get('ok')).toBeNull();
    const blocked = makeSpotStore(makeSafeStore(() => { throw new DOMException('blocked', 'SecurityError'); }));
    blocked.set('a', { anchor: 5, head: 5, top: 0, margin: 0 });
    expect(blocked.get('a')?.anchor).toBe(5); // this page still has it
  });

  it('follows edits made while the file was not shown', () => {
    // "one two three", "two" at the top, "three" selected; someone types "zero " in front
    const spot = { anchor: 8, head: 13, top: 4, margin: -2 };
    const typed = ChangeSet.of([{ from: 0, insert: 'zero ' }], 13);
    expect(mapSpot(spot, typed)).toEqual({ anchor: 13, head: 18, top: 9, margin: -2 });
    // the text at the top is deleted: the top moves to where it was
    const cut = ChangeSet.of([{ from: 2, to: 8 }], 13);
    expect(mapSpot(spot, cut)).toEqual({ anchor: 2, head: 7, top: 2, margin: -2 });
  });

  it('is clamped into a text that got shorter', () => {
    expect(clampSpot({ anchor: 50, head: 80, top: 70, margin: 3 }, 40)).toEqual({ anchor: 40, head: 40, top: 40, margin: 3 });
  });

  it('follows memory-only mapping into storage on the next flush', () => {
    const { storage } = backing();
    const store = makeSpotStore(makeSafeStore(() => storage));
    store.set('a', { anchor: 4, head: 4, top: 0, margin: 0 });
    store.map('a', ChangeSet.of([{ from: 0, insert: 'xx' }], 10));
    expect(makeSpotStore(makeSafeStore(() => storage)).get('a')?.anchor).toBe(4);
    store.flush();
    expect(makeSpotStore(makeSafeStore(() => storage)).get('a')?.anchor).toBe(6);
  });
});
