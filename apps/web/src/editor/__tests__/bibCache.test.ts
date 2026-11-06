import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import { citeCompletionSource, refCompletionSource, invalidateBibCache, invalidateLabelCache } from '../latexExtras';

const down = new Set<string>();
vi.mock('../../api', () => ({
  api: {
    bib: async (id: string) => {
      if (down.has(id)) throw new Error('offline');
      return [{ key: `${id}-key`, type: 'article', title: `From ${id}`, file: 'refs.bib' }];
    },
    labels: async (id: string) => {
      if (down.has(id)) throw new Error('offline');
      return [{ label: `${id}-label`, file: 'main.tex' }];
    },
  },
}));

async function offered(source: CompletionSource, doc: string): Promise<string[]> {
  const state = EditorState.create({ doc, selection: { anchor: doc.length } });
  const result = (await source(new CompletionContext(state, doc.length, true))) as CompletionResult | null;
  return result ? result.options.map((o) => o.label) : [];
}

describe('the citation and label caches', () => {
  beforeEach(() => {
    down.clear();
    invalidateBibCache();
    invalidateLabelCache();
  });

  it('a failed fetch offers no entries of the project cached before', async () => {
    expect(await offered(citeCompletionSource('alpha', 'main'), '\\cite{')).toEqual(['alpha-key']);
    down.add('beta');
    expect(await offered(citeCompletionSource('beta', 'main'), '\\cite{')).toEqual([]);
  });

  it('nor those of another branch', async () => {
    expect(await offered(citeCompletionSource('alpha', 'main'), '\\cite{')).toEqual(['alpha-key']);
    down.add('alpha');
    expect(await offered(citeCompletionSource('alpha', 'draft'), '\\cite{')).toEqual([]);
  });

  it('a failed fetch keeps the same project\'s cached entries', async () => {
    expect(await offered(citeCompletionSource('alpha', 'main'), '\\cite{')).toEqual(['alpha-key']);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 60_000); // past the cache's freshness window
      down.add('alpha');
      expect(await offered(citeCompletionSource('alpha', 'main'), '\\cite{')).toEqual(['alpha-key']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('labels follow the same rule', async () => {
    expect(await offered(refCompletionSource('alpha', 'main', () => 'main.tex'), '\\ref{')).toEqual(['alpha-label']);
    down.add('beta');
    expect(await offered(refCompletionSource('beta', 'main', () => 'main.tex'), '\\ref{')).toEqual([]);
  });
});
