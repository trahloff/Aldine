import { describe, it, expect } from 'vitest';
import type { TreeEntry } from '../../api';
import { buildTree, entryPathError, filesIn, hiddenCount, hiddenUploadName, holdsOnlyKeep, moveTarget, normalizeEntryPath, sourceTree, treeKey, typeaheadRow, visibleRows, withTexExtension, within, type TreeNode } from '../fileTree';

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

  it('puts numbered names in number order', () => {
    const tree = buildTree([file('chapter10.tex'), file('chapter2.tex'), file('chapter1.tex'), dir('fig10'), dir('fig9')]);
    expect(paths(tree)).toEqual(['fig9/', 'fig10/', 'chapter1.tex', 'chapter2.tex', 'chapter10.tex']);
  });
});

describe('sourceTree', () => {
  const listing = [
    file('main.tex'), file('Makefile'),
    dir('figures'), file('figures/.gitkeep'),
    dir('tables'), dir('tables/drafts'), file('tables/drafts/.gitkeep'),
    dir('data'), file('data/results.xlsx'),
    dir('chapters'), file('chapters/intro.tex'), file('chapters/notes.docx'),
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
    expect(shown).not.toContain('data/results.xlsx');
  });

  it('keeps source files and drops the rest', () => {
    expect(shown).toContain('main.tex');
    expect(shown).toContain('chapters/intro.tex');
    expect(shown).not.toContain('Makefile');
    expect(shown).not.toContain('chapters/notes.docx');
  });

  it('keeps other TeX sources, plot data, exported figures, kit files, notes and latexmk settings', () => {
    const kept = [
      'results.csv', 'table.tsv', 'curve.dat', 'plot.pgf', 'jour.clo', 'jour.cfg', 'macros.def', 'paper.ltx', 'paper.latex',
      'analysis.Rnw', 'chunk.rtex', 'diagram.asy', 'index.ist', 'font.mtx', 'german.ldf', 'english.lbx', '.latexmkrc', 'notes.txt', 'README.md',
    ];
    const dropped = ['Makefile', 'ci.yml', 'main.log', 'main.bbl', 'data.zip', 'template.json', '.chktexrc', 'x.latexmkrc.bak'];
    expect(paths(sourceTree(buildTree([...kept, ...dropped].map(file)))).sort()).toEqual([...kept].sort());
  });

  it('drops dot-folders without source, and directories with no file at all', () => {
    expect(shown).not.toContain('.github/');
    expect(shown).not.toContain('.vscode/');
    expect(shown).not.toContain('leftover/');
  });

  it('keeps a dot-folder for the source inside it', () => {
    expect(paths(sourceTree(buildTree([file('.drafts/old.tex')])))).toEqual(['.drafts/', '.drafts/old.tex']);
  });

  it('lists the files it is told to keep, whatever they are, a dot-folder\'s too', () => {
    const kept = paths(sourceTree(buildTree(listing), new Set(['Makefile', 'data/results.xlsx', '.github/workflows/ci.yml'])));
    expect(kept).toContain('Makefile');
    expect(kept).toContain('data/results.xlsx');
    expect(kept).toContain('.github/');
    expect(kept).toContain('.github/workflows/ci.yml');
    expect(kept).not.toContain('chapters/notes.docx');
  });
});

describe('hiddenCount', () => {
  it('counts the files the view leaves out, not .gitkeep placeholders or dot-files', () => {
    const full = buildTree([file('main.tex'), file('Makefile'), file('.gitignore'), file('figures/.gitkeep'), file('data/raw.xlsx'), file('.github/workflows/ci.yml')]);
    expect(hiddenCount(full, sourceTree(full))).toBe(2);
    expect(hiddenCount(full, sourceTree(full, new Set(['Makefile'])))).toBe(1);
    expect(hiddenCount(full, full)).toBe(0);
  });
});

describe('visibleRows and treeKey', () => {
  const tree = buildTree([file('main.tex'), file('chapters/intro.tex'), file('chapters/parts/one.tex'), file('figures/plot.png')]);
  const open = (dirs: string[]) => visibleRows(tree, (p) => dirs.includes(p));

  it('lists the top level and the inside of open folders, with each row\'s level and place', () => {
    const rows = open(['chapters']);
    expect(rows.map((r) => r.path)).toEqual(['chapters', 'chapters/parts', 'chapters/intro.tex', 'figures', 'main.tex']);
    expect(rows[1]).toMatchObject({ level: 2, parent: 'chapters', posInSet: 1, setSize: 2, open: false });
    expect(rows[4]).toMatchObject({ level: 1, parent: null, posInSet: 3, setSize: 3 });
  });

  it('moves up, down, to the ends, and stops at the edges', () => {
    const rows = open(['chapters']);
    expect(treeKey(rows, 'chapters/parts', 'ArrowDown')).toEqual({ focus: 'chapters/intro.tex' });
    expect(treeKey(rows, 'chapters/parts', 'ArrowUp')).toEqual({ focus: 'chapters' });
    expect(treeKey(rows, 'main.tex', 'ArrowDown')).toEqual({ focus: 'main.tex' });
    expect(treeKey(rows, 'chapters', 'ArrowUp')).toEqual({ focus: 'chapters' });
    expect(treeKey(rows, 'chapters/intro.tex', 'Home')).toEqual({ focus: 'chapters' });
    expect(treeKey(rows, 'chapters', 'End')).toEqual({ focus: 'main.tex' });
  });

  it('opens a folder with Right and then goes into it; Left closes it and then goes up', () => {
    const shut = open([]);
    expect(treeKey(shut, 'chapters', 'ArrowRight')).toEqual({ open: 'chapters' });
    const rows = open(['chapters']);
    expect(treeKey(rows, 'chapters', 'ArrowRight')).toEqual({ focus: 'chapters/parts' });
    expect(treeKey(rows, 'chapters', 'ArrowLeft')).toEqual({ close: 'chapters' });
    expect(treeKey(rows, 'chapters/intro.tex', 'ArrowLeft')).toEqual({ focus: 'chapters' });
    expect(treeKey(rows, 'main.tex', 'ArrowLeft')).toEqual({});
    expect(treeKey(rows, 'main.tex', 'ArrowRight')).toEqual({});
  });

  it('leaves other keys alone', () => {
    expect(treeKey(open([]), 'main.tex', 'Enter')).toBeNull();
    expect(treeKey(open([]), 'main.tex', 'a')).toBeNull();
  });
});

describe('typeaheadRow', () => {
  const rows = visibleRows(buildTree([file('main.tex'), file('macros.sty'), file('appendix.tex'), file('chapters/intro.tex')]), () => false);

  it('goes to the next name starting with a letter, round to the top', () => {
    expect(typeaheadRow(rows, 'appendix.tex', 'm')).toBe('macros.sty');
    expect(typeaheadRow(rows, 'macros.sty', 'm')).toBe('main.tex');
    expect(typeaheadRow(rows, 'main.tex', 'm')).toBe('macros.sty');
    expect(typeaheadRow(rows, 'main.tex', 'C')).toBe('chapters');
  });

  it('stays on the row while more of its name is typed', () => {
    expect(typeaheadRow(rows, 'main.tex', 'ma')).toBe('main.tex');
    expect(typeaheadRow(rows, 'macros.sty', 'mai')).toBe('main.tex');
    expect(typeaheadRow(rows, 'main.tex', 'x')).toBeNull();
  });
});

describe('hiddenUploadName', () => {
  it('leaves dot-files and dot-folders out of a folder upload, but not .latexmkrc', () => {
    for (const name of ['.git', '.DS_Store', '.gitignore', '.vscode', '.gitkeep']) expect(hiddenUploadName(name), name).toBe(true);
    for (const name of ['.latexmkrc', 'figures', 'plot.png', 'notes.txt']) expect(hiddenUploadName(name), name).toBe(false);
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

describe('withTexExtension', () => {
  it('adds .tex to a name with no extension, in a folder too', () => {
    expect(withTexExtension('introduction')).toBe('introduction.tex');
    expect(withTexExtension('chapters/intro')).toBe('chapters/intro.tex');
  });

  it('keeps an extension and a dot-file as typed', () => {
    expect(withTexExtension('notes.txt')).toBe('notes.txt');
    expect(withTexExtension('v1.2/intro.tex')).toBe('v1.2/intro.tex');
    expect(withTexExtension('.latexmkrc')).toBe('.latexmkrc');
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
