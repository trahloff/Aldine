import type { CompileError, CompileResult, TreeEntry } from '../api';

/**
 * What asked for a typeset. `user`: Typeset, ⌘S, the palette, a plugin, Try
 * again. `open`: the run a branch opens with. `auto`: auto-typeset after
 * edits, the full run a draft owes, an agent's edits. `adopted`: a run this
 * tab did not ask for (a co-author's, an agent's, the last one on open).
 */
export type TypesetTrigger = 'user' | 'open' | 'auto' | 'adopted';

const STRENGTH: Record<TypesetTrigger, number> = { adopted: 0, auto: 1, open: 2, user: 3 };

/** Several requests queued behind a running typeset become one run: it counts
 *  as asked for by the most deliberate of them. */
export function strongerTrigger(a: TypesetTrigger | null, b: TypesetTrigger): TypesetTrigger {
  return a && STRENGTH[a] >= STRENGTH[b] ? a : b;
}

/** An error's identity across runs: its line moves as you type above it. */
export const errorKey = (e: Pick<CompileError, 'file' | 'message'>) => `${e.file ?? ''}\n${e.message}`;

/** A failed run that names no error. */
const FAILED = '\u0000failed';

/** The errors a run reports, by key; a stopped run reports none. */
export function runErrorKeys(result: CompileResult | null): string[] {
  if (!result || result.ok || result.stopped) return [];
  const keys = (result.errors || []).filter((e) => e.type === 'error').map(errorKey);
  return keys.length ? keys : [FAILED];
}

/** Whether the error list is open past its header, whether the person folded
 *  it themselves, and the errors of the run it shows. */
export interface ErrorsFold { open: boolean; folded: boolean; keys: string[] }

export const NO_ERRORS: ErrorsFold = { open: false, folded: false, keys: [] };

/**
 * The error list after a run. A run someone asked for opens it. A run that
 * auto-typeset made while they type folds it to its header, unless it was
 * already open or an error from the run before is still there, which is no
 * longer a half-typed command. A list the person folded stays folded until
 * they ask for a typeset.
 */
export function errorsFoldAfter(prev: ErrorsFold, trigger: TypesetTrigger, keys: string[]): ErrorsFold {
  if (!keys.length) return NO_ERRORS;
  if (trigger === 'user' || trigger === 'open') return { open: true, folded: false, keys };
  const persists = keys.some((k) => prev.keys.includes(k));
  return { open: prev.open || (persists && !prev.folded), folded: prev.folded, keys };
}

/** The person opened or folded the error list. */
export const toggleErrors = (f: ErrorsFold): ErrorsFold => ({ ...f, open: !f.open, folded: f.open });

/**
 * The project file a log row names, or null when it is none of them (an
 * installed .sty). Older compilers name files relative to the root file's
 * folder, so a suffix match stands in when no path matches exactly.
 */
export function projectFileFor(entries: TreeEntry[], file: string | undefined): string | null {
  const norm = (file || '').replace(/^(?:\.\/)+/, '').replace(/\/(?:\.\/)+/g, '/');
  if (!norm) return null;
  const files = entries.filter((e) => e.type === 'file');
  return (files.find((f) => f.path === norm)
    ?? files.find((f) => norm.endsWith('/' + f.path))
    ?? files.find((f) => f.path.endsWith('/' + norm)))?.path ?? null;
}

/** How a row names its file: the project path, or an installed file's name. */
export const fileLabel = (file: string) => (file.startsWith('/') ? file.slice(file.lastIndexOf('/') + 1) : file.replace(/^(?:\.\/)+/, ''));
