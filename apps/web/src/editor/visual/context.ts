import { api, BibEntry } from '../../api';
import { withBase } from '../../basePath';
import { pokeViews } from './refresh';
import { preambleOf, stripComments } from './preamble';

/**
 * Project context for widgets that need more than the document text (cite
 * labels from the bibliography, image URLs). Set by visualExtensions() when a
 * pane mounts; decoration building itself stays pure.
 */
let ctx: { projectId: string; branch: string; rootDir: string; rootFile: string | null } | null = null;
let bib: Map<string, BibEntry> | null = null;
let bibKey = '';
/** Bumped each time the bibliography arrives, so widgets drawing citation labels draw them anew. */
let bibRev = 0;
/** Each project file's mtime (undefined when the listing has none), by path. */
let files: { key: string; paths: Map<string, number | undefined> } | null = null;
let notify: ((text: string, kind: NoticeKind) => void) | null = null;
let rootPreamble: { key: string; text: string | null; read: number; reading: boolean; load: () => void } | null = null;

/** How long the root preamble as read stands for the file: it changes in another tab or by a collaborator. */
const ROOT_STALE_MS = 30_000;

export type NoticeKind = 'info' | 'error';

export function setVisualContext(projectId: string, branch: string, rootFile?: string, onNotice?: (text: string, kind: NoticeKind) => void): void {
  const rootDir = rootFile && rootFile.includes('/') ? rootFile.slice(0, rootFile.lastIndexOf('/')) : '';
  ctx = { projectId, branch, rootDir, rootFile: rootFile ?? null };
  notify = onNotice ?? null;
  const key = `${projectId}::${branch}`;
  if (key !== bibKey) {
    bibKey = key;
    bib = null;
    api.bib(projectId, branch)
      .then((entries) => { bib = new Map(entries.map((e) => [e.key, e])); bibRev++; pokeViews(); })
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
 * Files a preamble takes definitions from (\input, \include, a package
 * the project has as a .sty of its own), by path: the text as last read and
 * the listing's mtime when it was read.
 */
const included = new Map<string, { key: string; v: number | undefined; text: string | null; reading: boolean }>();
const INCLUDE_DEPTH = 4;
const INCLUDE_FILES = 40;
const INCLUDE = /\\(input|include|usepackage|RequirePackage)(?![A-Za-z])\s*(?:\[[^\]]*\]\s*)?(?:\{([^{}]*)\}|([^\s{}\\%]+))/g;

/** The project file `\input{name}` (or, `pkg`, `\usepackage{name}`) reads, as TeX run from the root file's folder finds it; null when there is none. */
function includedPath(name: string, pkg: boolean): string | null {
  if (!ctx || !files || files.key !== `${ctx.projectId}::${ctx.branch}`) return null;
  const n = name.trim();
  if (!n) return null;
  for (const base of new Set([joinPath(ctx.rootDir, n), joinPath('', n)])) {
    for (const ext of pkg ? ['.sty'] : ['', '.tex']) if (files.paths.has(base + ext)) return base + ext;
  }
  return null;
}

function readIncluded(path: string, entry: NonNullable<ReturnType<typeof included.get>>, v: number | undefined): void {
  if (!ctx) return;
  entry.reading = true;
  api.readFile(ctx.projectId, ctx.branch, path)
    .then((text) => {
      const changed = text !== entry.text;
      entry.text = text;
      entry.v = v;
      if (changed && included.get(path) === entry) pokeViews();
    })
    .catch(() => { entry.text ??= ''; entry.v = v; })
    .finally(() => { entry.reading = false; });
}

/** An included file's text as last read. One never read, or changed since by the listing, is read again; views redraw when it arrives different. */
function includedText(path: string): string {
  const key = `${ctx!.projectId}::${ctx!.branch}`;
  const v = files?.paths.get(path);
  let entry = included.get(path);
  if (!entry || entry.key !== key) {
    entry = { key, v, text: null, reading: false };
    included.set(path, entry);
  }
  if ((entry.text === null || entry.v !== v) && !entry.reading) readIncluded(path, entry, v);
  return entry.text ?? '';
}

/**
 * `preamble` with the project files it \input's (and the packages it loads
 * that the project has itself) written in after each command, theirs in
 * turn too, so their definitions count in the order TeX reads them. A file
 * not read yet counts once it arrives.
 */
export function withIncludes(preamble: string | null): string | null {
  if (preamble === null || !ctx) return preamble;
  let budget = INCLUDE_FILES;
  const expand = (text: string, depth: number, seen: Set<string>): string => text.replace(INCLUDE, (whole, cmd: string, braced?: string, bare?: string) => {
    const pkg = cmd === 'usepackage' || cmd === 'RequirePackage';
    if (pkg && braced === undefined) return whole;
    let out = whole;
    for (const name of pkg ? braced!.split(',') : [braced ?? bare ?? '']) {
      const path = includedPath(name, pkg);
      if (!path || seen.has(path) || depth >= INCLUDE_DEPTH || budget <= 0) continue;
      budget--;
      out += `\n${expand(stripComments(includedText(path)), depth + 1, new Set([...seen, path]))}\n`;
    }
    return out;
  });
  return expand(preamble, 0, new Set());
}

/**
 * The preamble that applies to `doc`: its own when it has one, otherwise
 * the root file's as last read (a chapter \input by main.tex), or null.
 */
export function preambleFor(doc: string): string | null {
  return preambleOf(doc) ?? currentRoot();
}

let engine: string | null = null;

/** The project's typesetting engine, as the project settings name it ('pdf', 'xelatex', 'lualatex'). */
export function setVisualEngine(id: string | null): void {
  engine = id;
}

/** Whether pasted Unicode math must become commands: pdfLaTeX (the default while the engine is unknown) cannot read it. */
export function pasteNeedsSymbols(): boolean {
  return engine !== 'xelatex' && engine !== 'lualatex';
}

/** Tells the person what a widget could not do ('error') or why it opened the source ('info'), once the widget that would say so is gone. */
export function visualNotice(text: string, kind: NoticeKind = 'error'): void {
  notify?.(text, kind);
}

/** The files figure previews resolved to: a new mtime on any other file redraws nothing. */
const figurePaths = new Set<string>();

/**
 * The project's files, so figure previews only ask for files that exist, and
 * show a replaced one anew. Views redraw when a file comes or goes, or when
 * a figure's own file changed.
 */
export function setVisualFiles(projectId: string, branch: string, entries: Array<{ path: string; mtime?: number }>): void {
  const key = `${projectId}::${branch}`;
  const next = new Map(entries.map((e) => [e.path, e.mtime]));
  const prev = files;
  files = { key, paths: next };
  // a file the formulas' macros come from changed: read it again, and redraw when it differs
  for (const [path, entry] of included) {
    if (entry.key === key && entry.text !== null && !entry.reading && entry.v !== next.get(path)) readIncluded(path, entry, next.get(path));
  }
  const root = ctx?.rootFile;
  if (prev && prev.key === key && root && prev.paths.get(root) !== next.get(root)) rootPreamble?.load();
  if (prev && prev.key === key) {
    const sameFiles = prev.paths.size === next.size && entries.every((e) => prev.paths.has(e.path));
    if (sameFiles && [...figurePaths].every((p) => prev.paths.get(p) === next.get(p))) return;
  } else {
    figurePaths.clear();
  }
  pokeViews();
}

/** When the project file at `path` last changed, as the listing says; undefined when it doesn't. */
export function fileVersion(path: string): number | undefined {
  return files?.paths.get(path);
}

export function bibRevision(): number {
  return bibRev;
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
      if (files.paths.has(candidate)) {
        figurePaths.add(candidate);
        return candidate;
      }
    }
  }
  return null;
}

/** Raw file URL for a project-relative path; `v` (its mtime) makes a replaced file a new URL. */
export function fileUrl(path: string, v?: number): string | null {
  if (!ctx) return null;
  return withBase(`/api/projects/${ctx.projectId}/file?branch=${encodeURIComponent(ctx.branch)}&path=${encodeURIComponent(path)}${v != null ? `&v=${v}` : ''}`);
}
