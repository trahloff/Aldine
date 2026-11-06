import { describe, expect, it } from 'vitest';
import type { CompileResult, TreeEntry } from '../../api';
import { errorsFoldAfter, fileLabel, NO_ERRORS, projectFileFor, runErrorKeys, strongerTrigger, toggleErrors } from '../problems';

const run = (over: Partial<CompileResult>): CompileResult => ({ ok: false, pdf: null, pdfUrl: null, log: '', errors: [], durationMs: 1, ...over });
const brace = { type: 'error' as const, line: 3, message: 'Runaway argument?', file: 'main.tex' };
const macro = { type: 'error' as const, line: 9, message: 'Undefined control sequence. — \\foo', file: 'main.tex' };

describe('runErrorKeys', () => {
  it('keys a run by its errors, not its warnings, bad boxes or lines', () => {
    const r = run({ errors: [brace, { type: 'warning', line: 1, message: 'Citation x undefined' }, { type: 'typesetting', line: 2, message: 'Overfull \\hbox' }] });
    expect(runErrorKeys(r)).toEqual(['main.tex\nRunaway argument?']);
    expect(runErrorKeys(run({ errors: [{ ...brace, line: 40 }] }))).toEqual(runErrorKeys(r));
  });
  it('gives a failed run without errors one key, and a clean or stopped run none', () => {
    expect(runErrorKeys(run({}))).toHaveLength(1);
    expect(runErrorKeys(run({ ok: true }))).toEqual([]);
    expect(runErrorKeys(run({ stopped: true }))).toEqual([]);
    expect(runErrorKeys(null)).toEqual([]);
  });
});

describe('errorsFoldAfter', () => {
  const keys = (...e: Array<typeof brace>) => runErrorKeys(run({ errors: e }));

  it('folds the errors of a run auto-typeset made while typing', () => {
    expect(errorsFoldAfter(NO_ERRORS, 'auto', keys(brace)).open).toBe(false);
    expect(errorsFoldAfter(NO_ERRORS, 'adopted', keys(brace)).open).toBe(false);
  });
  it('opens on a typeset someone asked for, and on the run a project opens with', () => {
    expect(errorsFoldAfter(NO_ERRORS, 'user', keys(brace)).open).toBe(true);
    expect(errorsFoldAfter(NO_ERRORS, 'open', keys(brace)).open).toBe(true);
  });
  it('opens when an error is still there on the next run', () => {
    const first = errorsFoldAfter(NO_ERRORS, 'auto', keys(brace));
    expect(errorsFoldAfter(first, 'auto', keys(brace, macro)).open).toBe(true);
    expect(errorsFoldAfter(first, 'auto', keys(macro)).open).toBe(false);
  });
  it('stays open once open, and resets on a clean run', () => {
    const open = errorsFoldAfter(NO_ERRORS, 'user', keys(brace));
    expect(errorsFoldAfter(open, 'auto', keys(macro)).open).toBe(true);
    expect(errorsFoldAfter(open, 'auto', [])).toEqual(NO_ERRORS);
  });
  it('keeps a list the person folded folded until they ask for a typeset', () => {
    const folded = toggleErrors(errorsFoldAfter(NO_ERRORS, 'user', keys(brace)));
    expect(folded).toMatchObject({ open: false, folded: true });
    expect(errorsFoldAfter(folded, 'auto', keys(brace)).open).toBe(false);
    expect(errorsFoldAfter(folded, 'user', keys(brace))).toMatchObject({ open: true, folded: false });
    expect(toggleErrors(folded)).toMatchObject({ open: true, folded: false });
  });
});

describe('strongerTrigger', () => {
  it('queues the most deliberate request', () => {
    expect(strongerTrigger(null, 'auto')).toBe('auto');
    expect(strongerTrigger('auto', 'user')).toBe('user');
    expect(strongerTrigger('user', 'auto')).toBe('user');
    expect(strongerTrigger('auto', 'open')).toBe('open');
  });
});

describe('projectFileFor', () => {
  const tree: TreeEntry[] = [
    { path: 'main.tex', type: 'file' },
    { path: 'paper', type: 'dir' },
    { path: 'paper/main.tex', type: 'file' },
    { path: 'paper/chapters/one.tex', type: 'file' },
  ];
  it('finds the project file a log row names', () => {
    expect(projectFileFor(tree, 'paper/chapters/one.tex')).toBe('paper/chapters/one.tex');
    expect(projectFileFor(tree, './paper/./chapters/one.tex')).toBe('paper/chapters/one.tex');
    expect(projectFileFor(tree, 'main.tex')).toBe('main.tex');
  });
  it('matches a path relative to the root file\'s folder by its end', () => {
    expect(projectFileFor(tree, 'chapters/one.tex')).toBe('paper/chapters/one.tex');
  });
  it('names no file for an installed one, a folder or nothing', () => {
    expect(projectFileFor(tree, '/usr/local/texlive/2026/texmf-dist/tex/latex/hyperref/hyperref.sty')).toBeNull();
    expect(projectFileFor(tree, 'paper')).toBeNull();
    expect(projectFileFor(tree, undefined)).toBeNull();
  });
});

describe('fileLabel', () => {
  it('shows an installed file by its name and a project file by its path', () => {
    expect(fileLabel('/usr/local/texlive/2026/texmf-dist/tex/latex/hyperref/hyperref.sty')).toBe('hyperref.sty');
    expect(fileLabel('./chapters/one.tex')).toBe('chapters/one.tex');
  });
});
