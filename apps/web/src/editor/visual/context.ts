import { api, BibEntry } from '../../api';
import { withBase } from '../../basePath';
import { pokeViews } from './refresh';
import { preambleOf } from './preamble';

/**
 * Project context for widgets that need more than the document text (cite
 * labels from the bibliography, image URLs). Set by visualExtensions() when a
 * pane mounts; decoration building itself stays pure.
 */
let ctx: { projectId: string; branch: string; rootDir: string } | null = null;
let bib: Map<string, BibEntry> | null = null;
let bibKey = '';
let files: { key: string; paths: Set<string> } | null = null;
let notify: ((text: string) => void) | null = null;
let rootPreamble: { key: string; text: string | null; read: number; reading: boolean; load: () => void } | null = null;

/** How long the root preamble as read stands for the file: it changes in another tab or by a collaborator. */
const ROOT_STALE_MS = 30_000;

export function setVisualContext(projectId: string, branch: string, rootFile?: string, onNotice?: (text: string) => void): void {
  const rootDir = rootFile && rootFile.includes('/') ? rootFile.slice(0, rootFile.lastIndexOf('/')) : '';
  ctx = { projectId, branch, rootDir };
  notify = onNotice ?? null;
  const key = `${projectId}::${branch}`;
  if (key !== bibKey) {
    bibKey = key;
    bib = null;
    api.bib(projectId, branch)
      .then((entries) => { bib = new Map(entries.map((e) => [e.key, e])); pokeViews(); })
      .catch(() => { bib = new Map(); });
  }
  const rootKey = `${key}::${rootFile ?? ''}`;
  if (!rootFile) rootPreamble = null;
  else if (rootPreamble?.key !== rootKey) {
    const entry: NonNullable<typeof rootPreamble> = {
      key: rootKey, text: null, read: 0, reading: false,
      load() {
        if (entry.reading) return;
        entry.reading = true;
        api.readFile(projectId, branch, rootFile)
          .then((text) => {
            entry.read = Date.now();
            const pre = preambleOf(text);
            if (rootPreamble === entry && pre !== entry.text) { entry.text = pre; pokeViews(); }
          })
          .catch(() => { entry.read = Date.now(); })
          .finally(() => { entry.reading = false; });
      },
    };
    rootPreamble = entry;
    entry.load();
  } else {
    // a pane mounts on a tab switch, often right after the root file was edited
    rootPreamble.load();
  }
}

/** The root preamble as last read; a read older than ROOT_STALE_MS starts another, and views redraw when it differs. */
function currentRoot(): string | null {
  if (rootPreamble && !rootPreamble.reading && rootPreamble.read && Date.now() - rootPreamble.read > ROOT_STALE_MS) rootPreamble.load();
  return rootPreamble?.text ?? null;
}

/** The root file's preamble as last read, or null. */
export function rootPreambleText(): string | null {
  return currentRoot();
}

/**
 * The preamble that applies to `doc`: its own when it has one, otherwise
 * the root file's as last read (a chapter \input by main.tex), or null.
 */
export function preambleFor(doc: string): string | null {
  return preambleOf(doc) ?? currentRoot();
}

/** Tells the person what a widget could not do, once the widget that would say so is gone. */
export function visualNotice(text: string): void {
  notify?.(text);
}

/** The project's file paths, so figure previews only ask for files that exist. */
export function setVisualFiles(projectId: string, branch: string, paths: string[]): void {
  const key = `${projectId}::${branch}`;
  const next = new Set(paths);
  const prev = files;
  if (prev && prev.key === key && prev.paths.size === next.size && paths.every((p) => prev.paths.has(p))) return;
  files = { key, paths: next };
  pokeViews();
}

/** "(Knuth 1984; Lamport 1994)" for a comma-separated key list, best effort. */
export function citeLabel(keys: string): string | null {
  if (!bib) return null;
  const parts = keys.split(',').map((k) => k.trim()).filter(Boolean).map((key) => {
    const e = bib!.get(key);
    if (!e) return key;
    // authorLabel keeps corporate names ({Growth Market Reports}) and compound
    // surnames whole — the last-word heuristic is only the legacy fallback.
    const surname = e.authorLabel
      || (e.author || '').split(/\s+and\s+|,/)[0].trim().split(/\s+/).pop()
      || key;
    return e.year ? `${surname} ${e.year}` : surname;
  });
  return parts.length ? parts.join('; ') : null;
}

/** Collapse ./ and ../ segments the way TeX would ("paper" + "../figs/x" → "figs/x"). */
function joinPath(dir: string, p: string): string {
  const parts = (dir ? dir + '/' + p : p).split('/');
  const out: string[] = [];
  for (const seg of parts) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/** The extensions pdfLaTeX's graphicx tries for a name written without one, in its order. */
const GRAPHIC_EXTS = ['.pdf', '.png', '.jpg', '.jpeg', '.PDF', '.PNG', '.JPG', '.JPEG'];

/**
 * The project file an \includegraphics path names, or null when none exists.
 * Paths are relative to the root file's dir (latexmk -cd); the project root is
 * the fallback for projects that write them from there.
 */
export function figureFile(path: string): string | null {
  if (!ctx || !files || files.key !== `${ctx.projectId}::${ctx.branch}`) return null;
  for (const base of new Set([joinPath(ctx.rootDir, path), joinPath('', path)])) {
    for (const candidate of [base, ...GRAPHIC_EXTS.map((ext) => base + ext)]) {
      if (files.paths.has(candidate)) return candidate;
    }
  }
  return null;
}

/** Raw file URL for a project-relative path. */
export function fileUrl(path: string): string | null {
  if (!ctx) return null;
  return withBase(`/api/projects/${ctx.projectId}/file?branch=${encodeURIComponent(ctx.branch)}&path=${encodeURIComponent(path)}`);
}
