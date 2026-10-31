import { describe, it, expect } from 'vitest';
import type { TreeEntry } from '../../api';
import { buildTree, entryPathError, filesIn, holdsOnlyKeep, moveTarget, normalizeEntryPath, sourceTree, within, type TreeNode } from '../fileTree';

const file = (path: string): TreeEntry => ({ path, type: 'file' });
const dir = (path: string): TreeEntry => ({ path, type: 'dir' });

/** Every path in the tree, depth first, folders with a trailing slash. */
const paths = (nodes: TreeNode[]): string[] => nodes.flatMap((n) => (n.type === 'dir' ? [`${n.path}/`, ...paths(n.children)] : [n.path]));

describe('buildTree', () => {
  it('nests files under their folders, folders first and each level by name', () => {
    const tree = buildTree([file('main.tex'), dir('chapters'), file('chapters/intro.tex'), file('appendix.tex'), dir('figures'), file('figures/.gitkeep')]);
    expect(paths(tree)).toEqual(['chapters/', 'chapters/intro.tex', 'figures/', 'figures/.gitkeep', 'appendix.tex', 'main.tex']);
  });

  it('makes the folders a nested path implies, listed or not', () => {
    expect(paths(buildTree([file('a/b/c.tex')]))).toEqual(['a/', 'a/b/', 'a/b/c.tex']);
  });
});

describe('sourceTree', () => {
  const listing = [
    file('main.tex'), file('Makefile'),
    dir('figures'), file('figures/.gitkeep'),
    dir('tables'), dir('tables/drafts'), file('tables/drafts/.gitkeep'),
    dir('data'), file('data/results.csv'),
    dir('chapters'), file('chapters/intro.tex'), file('chapters/notes.txt'),
    dir('.github'), dir('.github/workflows'), file('.github/workflows/ci.yml'),
    dir('.vscode'), file('.vscode/.gitkeep'),
    dir('leftover'),
  ];
  const shown = paths(sourceTree(buildTree(listing)));

  it('keeps a folder that holds only .gitkeep, and hides the .gitkeep', () => {
    expect(shown).toContain('figures/');
    expect(shown).not.toContain('figures/.gitkeep');
  });

  it('keeps nested empty folders', () => {
    expect(shown).toContain('tables/');
    expect(shown).toContain('tables/drafts/');
    expect(shown).not.toContain('tables/drafts/.gitkeep');
  });

  it('keeps a folder of non-source files without listing them', () => {
    expect(shown).toContain('data/');
    expect(shown).not.toContain('data/results.csv');
  });

  it('keeps source files and drops the rest', () => {
    expect(shown).toContain('main.tex');
    expect(shown).toContain('chapters/intro.tex');
    expect(shown).not.toContain('Makefile');
    expect(shown).not.toContain('chapters/notes.txt');
  });

  it('drops dot-folders without source, and directories with no file at all', () => {
    expect(shown).not.toContain('.github/');
    expect(shown).not.toContain('.vscode/');
    expect(shown).not.toContain('leftover/');
  });

  it('keeps a dot-folder for the source inside it', () => {
    expect(paths(sourceTree(buildTree([file('.drafts/old.tex')])))).toEqual(['.drafts/', '.drafts/old.tex']);
  });
});

describe('holdsOnlyKeep', () => {
  const listing = [
    dir('figures'), file('figures/.gitkeep'),
    dir('tables'), file('tables/.gitkeep'), dir('tables/drafts'), file('tables/drafts/.gitkeep'),
    dir('chapters'), file('chapters/.gitkeep'), file('chapters/intro.tex'),
    dir('fig'), file('fig/a.png'),
    dir('leftover'),
  ];

  it('is true for a folder of .gitkeep placeholders, nested ones included', () => {
    expect(holdsOnlyKeep(listing, 'figures')).toBe(true);
    expect(holdsOnlyKeep(listing, 'tables')).toBe(true);
    expect(holdsOnlyKeep(listing, 'leftover')).toBe(true);
  });

  it('is false once any other file is inside', () => {
    expect(holdsOnlyKeep(listing, 'chapters')).toBe(false);
  });

  it('does not count a sibling whose name starts the same', () => {
    expect(holdsOnlyKeep(listing, 'fig')).toBe(false);
    expect(holdsOnlyKeep([file('figures/.gitkeep'), file('figures-old/a.png')], 'figures')).toBe(true);
  });
});

describe('filesIn', () => {
  it('lists the files at any depth, without placeholders or a sibling that starts the same', () => {
    const listing = [dir('ch'), file('ch/.gitkeep'), file('ch/a.tex'), dir('ch/fig'), file('ch/fig/p.png'), file('ch/fig/.gitkeep'), file('chx/b.tex')];
    expect(filesIn(listing, 'ch')).toEqual(['ch/a.tex', 'ch/fig/p.png']);
    expect(filesIn(listing, 'ch/fig')).toEqual(['ch/fig/p.png']);
  });
});

describe('moveTarget', () => {
  it('puts the file or folder inside the folder, under its own name', () => {
    expect(moveTarget('intro.tex', 'chapters')).toBe('chapters/intro.tex');
    expect(moveTarget('chapters/intro.tex', 'parts/one')).toBe('parts/one/intro.tex');
    expect(moveTarget('figures', 'chapters')).toBe('chapters/figures');
  });

  it('moves to the top level for an empty folder path', () => {
    expect(moveTarget('chapters/intro.tex', '')).toBe('intro.tex');
  });

  it('is null where the entry already is, or inside itself', () => {
    expect(moveTarget('chapters/intro.tex', 'chapters')).toBeNull();
    expect(moveTarget('main.tex', '')).toBeNull();
    expect(moveTarget('chapters', 'chapters')).toBeNull();
    expect(moveTarget('chapters', 'chapters/figures')).toBeNull();
  });

  it('lets a folder move into a sibling whose name starts the same', () => {
    expect(moveTarget('ch', 'chx')).toBe('chx/ch');
  });
});

describe('within', () => {
  it('matches the entry and what is inside it, not a name that only starts the same', () => {
    expect(within('figures', 'figures')).toBe(true);
    expect(within('figures/.gitkeep', 'figures')).toBe(true);
    expect(within('figures-old/a.png', 'figures')).toBe(false);
  });
});

describe('normalizeEntryPath', () => {
  it('drops empty and "." segments and the trailing slash', () => {
    expect(normalizeEntryPath(' figures/ ')).toBe('figures');
    expect(normalizeEntryPath('./chapters//intro.tex')).toBe('chapters/intro.tex');
    expect(normalizeEntryPath('figures\\plots')).toBe('figures/plots');
  });
});

describe('entryPathError', () => {
  it('takes plain and nested names', () => {
    for (const ok of ['figures', 'chapters/intro.tex', 'figures/', 'Figures and tables', '.drafts', 'v1.2']) expect(entryPathError(ok)).toBeNull();
  });

  it('refuses what the server refuses, saying why', () => {
    expect(entryPathError('')).toBe('Enter a name');
    expect(entryPathError('/figures')).toMatch(/leading slash/);
    expect(entryPathError('C:/figures')).toMatch(/leading slash/);
    expect(entryPathError('../figures')).toBe('Names cannot contain ".."');
    expect(entryPathError('a..b')).toBe('Names cannot contain ".."');
    expect(entryPathError('figures/.git')).toMatch(/reserved/);
    expect(entryPathError('.GIT.')).toMatch(/reserved/);
    expect(entryPathError('.aldine-out/x')).toMatch(/reserved/);
    expect(entryPathError('-rf')).toBe('Names cannot start with "-"');
    expect(entryPathError('figures/-x')).toBe('Names cannot start with "-"');
    expect(entryPathError('a\0b')).toMatch(/null character/);
  });
});
