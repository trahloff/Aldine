import { describe, expect, it } from 'vitest';
import { makeSafeStore } from '../safeStorage';

/** An in-memory Storage that can be told to fail the way browsers do. */
function memory(fail: { get?: boolean; set?: boolean } = {}): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => { if (fail.get) throw new DOMException('denied', 'SecurityError'); return m.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (fail.set) throw new DOMException('full', 'QuotaExceededError'); m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

describe('safeStorage', () => {
  it('reads back what it wrote and removes it', () => {
    const backing = memory();
    const s = makeSafeStore(() => backing);
    expect(s.get('a')).toBeNull();
    expect(s.set('a', '1')).toBe(true);
    expect(s.get('a')).toBe('1');
    s.remove('a');
    expect(s.get('a')).toBeNull();
  });

  it('acts as empty when the browser refuses access to storage at all', () => {
    const s = makeSafeStore(() => { throw new DOMException('blocked', 'SecurityError'); });
    expect(s.get('a')).toBeNull();
    expect(s.set('a', '1')).toBe(false);
    expect(() => s.remove('a')).not.toThrow();
    expect(s.getJSON('a', { x: 1 })).toEqual({ x: 1 });
  });

  it('acts as empty without a window (server render, worker, test runner)', () => {
    const s = makeSafeStore(() => undefined);
    expect(s.get('a')).toBeNull();
    expect(s.set('a', '1')).toBe(false);
  });

  it('survives a read that throws and a full quota', () => {
    expect(makeSafeStore(() => memory({ get: true })).get('a')).toBeNull();
    expect(makeSafeStore(() => memory({ set: true })).set('a', '1')).toBe(false);
  });

  it('falls back for JSON that is missing, broken or of the wrong shape', () => {
    const backing = memory();
    const s = makeSafeStore(() => backing);
    const isList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
    expect(s.getJSON('k', [] as string[], isList)).toEqual([]);
    backing.setItem('k', '{not json');
    expect(s.getJSON('k', [] as string[], isList)).toEqual([]);
    backing.setItem('k', '{"a":1}');
    expect(s.getJSON('k', [] as string[], isList)).toEqual([]);
    expect(s.setJSON('k', ['x', 'y'])).toBe(true);
    expect(s.getJSON('k', [] as string[], isList)).toEqual(['x', 'y']);
  });
});
