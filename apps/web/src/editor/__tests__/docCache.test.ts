import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { Text } from '@codemirror/state';
import { createDocCache, textChanges, type Parkable } from '../docCache';
import { makeSpotStore } from '../fileSpots';
import { makeSafeStore } from '../../util/safeStorage';

function memory() {
  const m = new Map<string, string>();
  return makeSafeStore(() => ({
    get length() { return m.size; },
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
  }));
}

type Fake = Parkable & {
  destroyed: boolean;
  stops: number;
  local: unknown;
  emit(event: string, ...args: unknown[]): void;
  listening(): number;
  provider: Parkable['provider'] & { isSynced: boolean; status: string };
};

function fakeDoc(name: string, text = ''): Fake {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('content');
  if (text) ytext.insert(0, text);
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const doc: Fake = {
    name,
    ytext,
    destroyed: false,
    stops: 0,
    local: {},
    provider: {
      isSynced: true,
      status: 'connected',
      awareness: { setLocalState: (s: Record<string, never>) => { doc.local = s; } },
      on(event, fn) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(fn);
      },
      off(event, fn) { listeners.get(event)?.delete(fn); },
    },
    undoManager: { stopCapturing: () => { doc.stops++; } },
    destroy() { doc.destroyed = true; },
    emit(event, ...args) { for (const fn of [...(listeners.get(event) ?? [])]) fn(...args); },
    listening: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
  return doc;
}

function setup(max = 5) {
  const made: Fake[] = [];
  const spots = makeSpotStore(memory());
  const cache = createDocCache((name) => {
    const d = fakeDoc(name, 'one two three four five');
    made.push(d);
    return d;
  }, spots, max);
  const doc = (name: string) => made.find((d) => d.name === name)!;
  return { cache, made, spots, doc };
}

/** Opens each name in turn, the way switching files parks the one before. */
function visit(cache: ReturnType<typeof setup>['cache'], names: string[], open?: Fake): Fake {
  let current = open;
  for (const n of names) {
    if (current) cache.park(current);
    current = cache.open(n) as Fake;
  }
  return current!;
}

describe('the docs kept for files left earlier', () => {
  it('are the five files left last; the ones it drops are closed', () => {
    const { cache, made, doc } = setup();
    visit(cache, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(cache.parkedNames()).toEqual(['f', 'e', 'd', 'c', 'b']);
    expect(doc('a').destroyed).toBe(true);
    expect(made.filter((d) => d.destroyed)).toHaveLength(1);
  });

  it('give back the same doc on a switch back, the oldest of them included', () => {
    const { cache, made } = setup();
    const f = visit(cache, ['a', 'b', 'c', 'd', 'e', 'f']);
    expect(cache.parkedNames()).toEqual(['e', 'd', 'c', 'b', 'a']);
    cache.park(f);
    const a = cache.open('a');
    expect(made).toHaveLength(6); // nothing connected anew
    expect(a).toBe(made[0]);
    expect(made[0].destroyed).toBe(false);
    expect(cache.parkedNames()).toEqual(['f', 'e', 'd', 'c', 'b']);
  });

  it('leave presence but keep an empty state, and the next edit is an undo step of its own', () => {
    const { cache } = setup();
    const a = cache.open('a') as Fake;
    a.local = { user: { name: 'Ada' }, cursor: {} };
    cache.park(a);
    expect(a.local).toEqual({}); // renewed and echoed: what keeps an idle socket open
    expect(a.stops).toBe(1);
  });

  it('are not kept while still loading or cut off', () => {
    const { cache } = setup();
    const a = cache.open('a') as Fake;
    a.provider.isSynced = false;
    cache.park(a);
    expect(a.destroyed).toBe(true);
    const b = cache.open('b') as Fake;
    b.provider.status = 'connecting';
    cache.park(b);
    expect(b.destroyed).toBe(true);
    expect(cache.parkedNames()).toEqual([]);
  });

  it('are closed when their connection drops or is refused, never reconnected', () => {
    const { cache } = setup();
    const a = cache.open('a') as Fake;
    const b = visit(cache, ['b'], a);
    visit(cache, ['c'], b);
    expect(cache.parkedNames()).toEqual(['b', 'a']);
    a.emit('status', { status: 'disconnected' });
    expect(a.destroyed).toBe(true);
    b.emit('authenticationFailed', { reason: 'denied' });
    expect(b.destroyed).toBe(true);
    expect(cache.parkedNames()).toEqual([]);
  });

  it('belong to the pane again once reopened: its connection is no longer theirs to watch', () => {
    const { cache } = setup();
    const a = cache.open('a') as Fake;
    visit(cache, ['b'], a);
    expect(a.listening()).toBe(2);
    const again = cache.open('a') as Fake;
    expect(again).toBe(a);
    expect(a.listening()).toBe(0);
    a.emit('status', { status: 'disconnected' });
    expect(a.destroyed).toBe(false);
  });

  it('close the ones a file listing no longer has', () => {
    const { cache, doc } = setup();
    visit(cache, ['p::main::a.tex', 'p::main::b.tex', 'p::draft::a.tex', 'p::main::c.tex']);
    cache.closeParked((name) => name.startsWith('p::main::') && name !== 'p::main::b.tex');
    expect(cache.parkedNames()).toEqual(['p::main::a.tex']);
    expect(doc('p::main::b.tex').destroyed).toBe(true);
    expect(doc('p::draft::a.tex').destroyed).toBe(true);
    expect(doc('p::main::c.tex').destroyed).toBe(false); // open: not the cache's to close
  });

  it('carry the spot a pane left through edits that arrive meanwhile', () => {
    const { cache, spots, doc } = setup();
    const a = cache.open('a') as Fake;
    spots.set('a', { anchor: 8, head: 13, top: 4, margin: -3 }); // "three" selected, "two" at the top
    visit(cache, ['b'], a);
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc('a').ytext.doc!));
    remote.getText('content').insert(0, 'zero ');
    remote.getText('content').delete(5 + 4, 4); // "two "
    Y.applyUpdate(doc('a').ytext.doc!, Y.encodeStateAsUpdate(remote));
    expect(doc('a').ytext.toString()).toBe('zero one three four five');
    expect(spots.get('a')).toEqual({ anchor: 9, head: 14, top: 9, margin: -3 });
  });
});

describe('textChanges', () => {
  it('replays a Y.Text change on the text before it', () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('content');
    ytext.insert(0, 'alpha\nbeta\ngamma\n');
    let before = Text.of(ytext.toString().split('\n'));
    const seen: string[] = [];
    ytext.observe((e) => {
      const after = textChanges(e.delta, ytext.length).apply(before);
      seen.push(after.toString());
      before = after;
    });
    ydoc.transact(() => {
      ytext.insert(17, 'delta\n');
      ytext.delete(6, 5);
      ytext.insert(0, '% head\n');
    });
    ytext.delete(0, ytext.length);
    expect(seen).toEqual(['% head\nalpha\ngamma\ndelta\n', '']);
  });
});
