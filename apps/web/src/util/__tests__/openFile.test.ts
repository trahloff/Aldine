import { describe, expect, it } from 'vitest';
import { makeSafeStore } from '../safeStorage';
import { lastOpenFile, rememberOpenFile } from '../openFile';

describe('the file open last', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return makeSafeStore(() => ({
      get length() { return m.size; },
      clear: () => m.clear(),
      key: (i: number) => [...m.keys()][i] ?? null,
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => { m.set(k, String(v)); },
      removeItem: (k: string) => { m.delete(k); },
    }));
  };

  it('is kept per project and per branch', () => {
    const store = memory();
    rememberOpenFile('p1', 'main', 'chapters/intro.tex', store);
    rememberOpenFile('p1', 'draft', 'appendix.tex', store);
    expect(lastOpenFile('p1', 'main', store)).toBe('chapters/intro.tex');
    expect(lastOpenFile('p1', 'draft', store)).toBe('appendix.tex');
    expect(lastOpenFile('p2', 'main', store)).toBeNull();
  });

  it('is nothing when the browser keeps no storage', () => {
    const store = makeSafeStore(() => { throw new Error('blocked'); });
    rememberOpenFile('p1', 'main', 'intro.tex', store);
    expect(lastOpenFile('p1', 'main', store)).toBeNull();
  });
});
