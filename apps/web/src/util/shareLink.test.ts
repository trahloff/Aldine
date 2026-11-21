import { describe, expect, it } from 'vitest';
import { keepShareLink, pendingShareLink } from './shareLink';
import { makeSafeStore } from './safeStorage';

const T = 'A'.repeat(43);
const memory = () => {
  const m = new Map<string, string>();
  return makeSafeStore(() => ({ getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } }) as unknown as Storage);
};

describe('keepShareLink', () => {
  it('keeps the token of the fragment and drops it from the address', () => {
    const store = memory();
    expect(keepShareLink('p1', { search: '?branch=x', hash: `#link=${T}` }, store)).toEqual({ search: '?branch=x', hash: '' });
    expect(pendingShareLink('p1', store)).toBe(T);
  });
  it('leaves the rest of the fragment', () => {
    const store = memory();
    expect(keepShareLink('p1', { search: '', hash: `#a=1&link=${T}&b=2` }, store)).toEqual({ search: '', hash: '#a=1&b=2' });
    expect(pendingShareLink('p1', store)).toBe(T);
  });
  it('still takes a token from the query', () => {
    const store = memory();
    expect(keepShareLink('p1', { search: `?link=${T}&branch=x`, hash: '#top' }, store)).toEqual({ search: '?branch=x', hash: '#top' });
    expect(pendingShareLink('p1', store)).toBe(T);
  });
  it('is null without a token, and drops a malformed one unkept', () => {
    const store = memory();
    expect(keepShareLink('p1', { search: '?branch=x', hash: '#top' }, store)).toBeNull();
    expect(keepShareLink('p1', { search: '', hash: '#link=short' }, store)).toEqual({ search: '', hash: '' });
    expect(pendingShareLink('p1', store)).toBeNull();
  });
});
