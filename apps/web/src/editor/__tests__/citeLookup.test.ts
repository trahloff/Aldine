import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import type { EditorView, Tooltip } from '@codemirror/view';
import { CompletionContext } from '@codemirror/autocomplete';
import type { BibEntry } from '../../api';
import { citeCompletionSource, citeHoverSource, invalidateBibCache, warmBib } from '../latexExtras';

const bib = vi.hoisted(() => ({
  entries: [] as BibEntry[],
  calls: 0,
  /** Holds each fetch until `release` runs, to look at what shows while it is out. */
  gate: null as Promise<void> | null,
}));

vi.mock('../../api', () => ({
  api: {
    bib: async () => {
      bib.calls++;
      const answer = bib.entries.slice();
      if (bib.gate) await bib.gate;
      return answer;
    },
    labels: async () => [],
  },
}));

const turing: BibEntry = { key: 'turing1950', type: 'article', author: 'Turing, Alan', title: 'Computing Machinery and Intelligence', year: '1950', file: 'refs.bib' };
const machines: BibEntry = { key: 'machines2001', type: 'book', author: 'Doe, Jane', title: 'Thinking', year: '2001', file: 'refs.bib' };
const shannon: BibEntry = { key: 'shannon1948', type: 'article', author: 'Shannon, Claude', title: 'A Mathematical Theory of Communication', year: '1948', file: 'refs.bib' };

const settle = () => new Promise((r) => setTimeout(r, 0));

async function complete(marked: string) {
  const at = marked.indexOf('|');
  const state = EditorState.create({ doc: marked.slice(0, at) + marked.slice(at + 1), selection: { anchor: at } });
  return citeCompletionSource('p', 'main')(new CompletionContext(state, at, false));
}

/** The hover's tooltip at `|`, and whether it was there without waiting for a fetch. */
function hover(marked: string): { now: boolean; text: Promise<string | null> } {
  const at = marked.indexOf('|');
  const state = EditorState.create({ doc: marked.slice(0, at) + marked.slice(at + 1) });
  const found = citeHoverSource('p', 'main')({ state } as unknown as EditorView, at, 1);
  const text = (t: Tooltip | readonly Tooltip[] | null) => {
    if (!t || Array.isArray(t)) return null;
    return (t as Tooltip).create({} as EditorView).dom.textContent;
  };
  const isPromise = !!found && typeof (found as Promise<unknown>).then === 'function';
  return { now: !isPromise, text: Promise.resolve(found).then(text) };
}

class Dom {
  style = { cssText: '', color: '' };
  textContent = '';
  append(...kids: Dom[]) { this.textContent += kids.map((k) => k.textContent).join(''); }
}
vi.stubGlobal('document', { createElement: () => new Dom() });

beforeEach(() => {
  bib.entries = [turing, machines, shannon];
  bib.gate = null;
});

describe('\\cite completion', () => {
  it('finds a paper by its title or author, not only its key', async () => {
    const byTitle = await complete('\\cite{intelligence|}');
    expect(byTitle?.filter).toBe(false);
    expect(byTitle?.options.map((o) => o.label)).toEqual(['turing1950']);
    expect((await complete('\\cite{claude|}'))?.options.map((o) => o.label)).toEqual(['shannon1948']);
  });

  it('ranks a key match above an author or title match', async () => {
    expect((await complete('\\cite{machin|}'))?.options.map((o) => o.label)).toEqual(['machines2001', 'turing1950']);
  });

  it('shows the title next to the author and year', async () => {
    const [option] = (await complete('\\cite{turing|}'))!.options;
    expect(option.detail).toBe('Turing 1950 · Computing Machinery and Intelligence');
  });
});

describe('\\cite hover after the cache went stale', () => {
  it('shows the cached entry at once while the refetch is out', async () => {
    warmBib('p', 'main');
    await settle();
    invalidateBibCache();
    let release!: () => void;
    bib.gate = new Promise((r) => { release = r; });
    const h = hover('See \\cite{turi|ng1950}.');
    expect(h.now).toBe(true);
    expect(await h.text).toContain('Computing Machinery');
    release();
  });

  it('says a key is missing only once the server has answered', async () => {
    warmBib('p', 'main');
    await settle();
    invalidateBibCache();
    bib.entries = [...bib.entries, { key: 'knuth1984', type: 'book', author: 'Knuth, Donald', title: 'The TeXbook', year: '1984', file: 'refs.bib' }];
    const calls = bib.calls;
    const added = hover('\\cite{knu|th1984}');
    expect(added.now).toBe(false);
    expect(await added.text).toContain('The TeXbook');
    expect(bib.calls).toBe(calls + 1);
    expect(await hover('\\cite{nob|ody}').text).toBe('No bibliography entry for “nobody”');
  });
});
