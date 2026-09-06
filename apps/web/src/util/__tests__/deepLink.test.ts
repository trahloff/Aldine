import { describe, it, expect } from 'vitest';
import { normalizeDeepLinkPath, resolveDeepLinkFile } from '../deepLink';
import type { TreeEntry } from '../../api';

const tree: TreeEntry[] = [
  { path: 'main.tex', type: 'file' },
  { path: 'notes', type: 'dir' },
  { path: 'notes/intro.tex', type: 'file' },
  { path: 'a', type: 'dir' },
  { path: 'a/intro.tex', type: 'file' },
  { path: 'b', type: 'dir' },
  { path: 'b/chapter.tex', type: 'file' },
];

describe('normalizeDeepLinkPath', () => {
  it('strips ./ prefixes and inner ./ segments', () => {
    expect(normalizeDeepLinkPath('./notes/./intro.tex')).toBe('notes/intro.tex');
    expect(normalizeDeepLinkPath('././main.tex')).toBe('main.tex');
  });
});

describe('resolveDeepLinkFile', () => {
  it('matches the exact path', () => {
    expect(resolveDeepLinkFile(tree, 'notes/intro.tex')).toEqual({ path: 'notes/intro.tex' });
  });
  it('never opens a directory as a file', () => {
    expect(resolveDeepLinkFile(tree, 'notes')).toBeNull();
    expect(resolveDeepLinkFile(tree, 'a')).toBeNull();
  });
  it('accepts a unique suffix match in either direction', () => {
    expect(resolveDeepLinkFile(tree, 'chapter.tex')).toEqual({ path: 'b/chapter.tex' });
    expect(resolveDeepLinkFile(tree, 'thesis/b/chapter.tex')).toEqual({ path: 'b/chapter.tex' });
  });
  it('reports an ambiguous suffix instead of picking the first hit', () => {
    expect(resolveDeepLinkFile(tree, 'intro.tex')).toEqual({ ambiguous: ['notes/intro.tex', 'a/intro.tex'] });
  });
  it('is null for a missing file or an empty path', () => {
    expect(resolveDeepLinkFile(tree, 'missing/chapter.tex')).toBeNull();
    expect(resolveDeepLinkFile(tree, '')).toBeNull();
  });
});
