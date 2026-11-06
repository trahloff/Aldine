import path from 'node:path';
import * as store from './store.js';
import { openDocContent, applyEditsToDoc, flushBranchDocs, refreshBranchDocsFromDisk, bumpFilesSignal, scheduleCommit, docView, withCrlf } from './collab.js';

/** A .tex file's text as an open document holds it (LF only). `editable`:
 *  writing the text back changes nothing but the edit — false for bytes that
 *  are not UTF-8, which a lossy decode would replace for good. */
export interface TexSource { path: string; text: string; editable: boolean }

export type BibLoadKind = 'addbibresource' | 'bibliography' | 'new-bibliography';

/** The one edit that makes the document read a .bib. `entry` is the name it
 *  adds (zotero.bib for biblatex, zotero for BibTeX), `command` the command as
 *  it reads afterwards, `at` an offset into the file's LF text. */
export interface BibLoadEdit { file: string; kind: BibLoadKind; entry: string; command: string; at: number; insert: string }

export type BibLoadPlan = { loaded: true } | { loaded: false; fix: BibLoadEdit | null };

/** What the Zotero panel shows. `fix`: the edit one click makes; `lines`:
 *  what to add by hand when no single edit is clearly right. */
export interface BibLoadState {
  loaded: boolean;
  bibFile: string;
  rootFile: string;
  fix?: Omit<BibLoadEdit, 'at' | 'insert'>;
  lines?: { biblatex: string; bibtex: string };
}

const RESOURCE_RE = /\\(addbibresource|addglobalbib|addsectionbib|bibliography|nobibliography)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
const ADDBIBRESOURCE_RE = /\\addbibresource\s*(?:\[[^\]]*\])?\s*\{[^}]*\}/g;
const BIBLIOGRAPHY_RE = /\\bibliography\s*\{([^}]*)\}/g;
const PACKAGE_RE = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
const STYLE_RE = /\\bibliographystyle\s*\{[^}]*\}/;
const THEBIBLIOGRAPHY_RE = /\\begin\s*\{thebibliography\}/;
const END_DOCUMENT_RE = /\\end\s*\{document\}/;

/** `text` with every comment blanked to spaces, so offsets into it are
 *  offsets into `text`. A % after an odd run of backslashes is a literal. */
export function maskComments(text: string): string {
  return text.replace(/(^|[^\\])((?:\\\\)*)%[^\n]*/g, (m: string, pre: string, bs: string) => pre + bs + ' '.repeat(m.length - pre.length - bs.length));
}

/** Text from `pos` to the end of its line, then `line` on a line of its own
 *  with the same indent. */
function lineAfter(text: string, pos: number, line: string): { at: number; insert: string } {
  const eol = text.indexOf('\n', pos);
  const at = eol === -1 ? text.length : eol;
  const start = text.lastIndexOf('\n', pos - 1) + 1;
  const indent = /^[ \t]*/.exec(text.slice(start))![0];
  return { at, insert: `\n${indent}${line}` };
}

/**
 * Whether the document loads `bibFile`, and if not, the edit that makes it.
 * Every .tex counts, not only the root: a preamble \input may hold the line.
 * Names resolve from the root file's directory (latexmk runs there) or from
 * the naming file's own, with or without .bib. Commented-out lines count for
 * nothing. The fix follows what the document already does: one more
 * \addbibresource after the last one, one more name in its \bibliography
 * list, an \addbibresource after \usepackage{biblatex}, or — when BibTeX has
 * a style and nothing else — \bibliography before \end{document}. Anything
 * else has no fix: guessing a package or a style would write a line the
 * author did not choose.
 */
export function planBibLoad(sources: TexSource[], rootFile: string, bibFile: string): BibLoadPlan {
  const rootDir = path.posix.dirname(rootFile || 'main.tex');
  const target = path.posix.normalize(bibFile);
  const resolves = (dir: string, name: string) => {
    const p = path.posix.normalize(path.posix.join(dir, name));
    return p === target || `${p}.bib` === target;
  };
  const scanned = [...sources]
    .sort((a, b) => (a.path === rootFile ? -1 : b.path === rootFile ? 1 : a.path.localeCompare(b.path)))
    .map((s) => ({ ...s, masked: maskComments(s.text) }));

  for (const s of scanned) {
    const dir = path.posix.dirname(s.path);
    for (const m of s.masked.matchAll(RESOURCE_RE)) {
      for (const raw of m[2].split(',')) {
        const name = raw.trim();
        if (name && (resolves(rootDir, name) || resolves(dir, name))) return { loaded: true };
      }
    }
  }

  const entry = path.posix.relative(rootDir, target);
  const bibtexEntry = entry.replace(/\.bib$/i, '');
  const notLoaded = (fix: BibLoadEdit | null): BibLoadPlan => ({ loaded: false, fix });
  /** The last match in the first file (root first) that has one. */
  const last = (re: RegExp) => {
    for (const s of scanned) {
      const all = [...s.masked.matchAll(re)];
      if (all.length) return { s, m: all[all.length - 1] };
    }
    return null;
  };

  const resource = last(ADDBIBRESOURCE_RE);
  if (resource) {
    if (!resource.s.editable) return notLoaded(null);
    const command = `\\addbibresource{${entry}}`;
    return notLoaded({ file: resource.s.path, kind: 'addbibresource', entry, command, ...lineAfter(resource.s.text, resource.m.index! + resource.m[0].length, command) });
  }

  const list = last(BIBLIOGRAPHY_RE);
  if (list) {
    if (!list.s.editable) return notLoaded(null);
    const inside = list.m[1];
    const close = list.m.index! + list.m[0].length - 1;
    const names = inside.split(',').map((n) => n.trim()).filter(Boolean);
    return notLoaded({
      file: list.s.path, kind: 'bibliography', entry: bibtexEntry,
      command: `\\bibliography{${[...names, bibtexEntry].join(',')}}`,
      at: close - inside.length + inside.trimEnd().length,
      insert: names.length ? `,${bibtexEntry}` : bibtexEntry,
    });
  }

  for (const s of scanned) {
    const m = [...s.masked.matchAll(PACKAGE_RE)].find((u) => u[1].split(',').some((p) => p.trim() === 'biblatex'));
    if (!m) continue;
    if (!s.editable) return notLoaded(null);
    const command = `\\addbibresource{${entry}}`;
    return notLoaded({ file: s.path, kind: 'addbibresource', entry, command, ...lineAfter(s.text, m.index! + m[0].length, command) });
  }

  const root = scanned.find((s) => s.path === rootFile);
  const styled = scanned.some((s) => STYLE_RE.test(s.masked));
  const manual = scanned.some((s) => THEBIBLIOGRAPHY_RE.test(s.masked));
  const end = root ? root.masked.search(END_DOCUMENT_RE) : -1;
  if (root?.editable && styled && !manual && end !== -1) {
    const command = `\\bibliography{${bibtexEntry}}`;
    const lineStart = end === 0 || root.text[end - 1] === '\n';
    return notLoaded({ file: root.path, kind: 'new-bibliography', entry: bibtexEntry, command, at: end, insert: `${lineStart ? '' : '\n'}${command}\n` });
  }
  return notLoaded(null);
}

function describe(plan: BibLoadPlan, rootFile: string, bibFile: string): BibLoadState {
  if (plan.loaded) return { loaded: true, bibFile, rootFile };
  const entry = path.posix.relative(path.posix.dirname(rootFile || 'main.tex'), path.posix.normalize(bibFile));
  const lines = { biblatex: `\\addbibresource{${entry}}`, bibtex: `\\bibliography{${entry.replace(/\.bib$/i, '')}}` };
  if (!plan.fix) return { loaded: false, bibFile, rootFile, lines };
  const { at: _at, insert: _insert, ...fix } = plan.fix;
  return { loaded: false, bibFile, rootFile, fix, lines };
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** A .tex past this is not read: no preamble is that long. */
const SOURCE_BYTES = 2 * 1024 * 1024;

/** The branch's .tex files as their documents hold them: an open doc's live
 *  text (disk lags it by up to 8 s), else the disk copy. */
function texSources(projectId: string, branch: string): Array<TexSource & { open: boolean; crlf: boolean }> {
  const out: Array<TexSource & { open: boolean; crlf: boolean }> = [];
  for (const f of store.listFiles(projectId, branch)) {
    if (f.type !== 'file' || !/\.tex$/i.test(f.path) || (f.size ?? 0) > SOURCE_BYTES) continue;
    const live = openDocContent(projectId, branch, f.path);
    if (live !== null) {
      // a doc is loaded with a lossy decoder; its U+FFFD may stand for bytes that are not UTF-8
      out.push({ path: f.path, text: live, editable: !live.includes('�'), open: true, crlf: false });
      continue;
    }
    let buf: Buffer;
    try { buf = store.readFile(projectId, branch, f.path); } catch { continue; }
    let raw: string;
    let editable = true;
    try { raw = utf8.decode(buf); } catch { raw = buf.toString('utf8'); editable = false; }
    const { text, crlf } = docView(raw);
    out.push({ path: f.path, text, editable, open: false, crlf });
  }
  return out;
}

export function bibLoadState(projectId: string, branch: string, rootFile: string, bibFile: string): BibLoadState {
  return describe(planBibLoad(texSources(projectId, branch), rootFile, bibFile), rootFile, bibFile);
}

/** Whether any .tex on the branch loads `bibFile` (see planBibLoad). */
export function bibLoadedBySource(projectId: string, branch: string, rootFile: string, bibFile: string): boolean {
  return planBibLoad(texSources(projectId, branch), rootFile, bibFile).loaded;
}

/**
 * Make the document load `bibFile` when one edit clearly does. An open file
 * is edited through its live doc, so the insert merges with whatever anyone
 * is typing; a closed one is written on disk. Synchronous from the flush to
 * the write: no keystroke lands between the plan and the edit, and the
 * refresh after a disk write finds every other doc equal to its file.
 * `added` is null when the document already loads it or no edit is clear.
 */
export function addBibLoad(projectId: string, branch: string, rootFile: string, bibFile: string): { added: BibLoadState['fix'] | null; state: BibLoadState } {
  flushBranchDocs(projectId, branch);
  const sources = texSources(projectId, branch);
  const plan = planBibLoad(sources, rootFile, bibFile);
  if (plan.loaded || !plan.fix) return { added: null, state: describe(plan, rootFile, bibFile) };
  const { file, at, insert } = plan.fix;
  const src = sources.find((s) => s.path === file)!;
  if (src.open && applyEditsToDoc(projectId, branch, file, [{ from: at, to: at, insert }]) === 'applied') {
    bumpFilesSignal(projectId, branch);
  } else {
    const next = src.text.slice(0, at) + insert + src.text.slice(at);
    store.writeFile(projectId, branch, file, src.crlf ? withCrlf(next) : next);
    refreshBranchDocsFromDisk(projectId, branch, [file]);
    scheduleCommit(projectId, branch);
  }
  return { added: describe(plan, rootFile, bibFile).fix!, state: { loaded: true, bibFile, rootFile } };
}

export type BibFormat = 'biblatex' | 'bibtex';

const BIBLATEX_RESOURCE_RE = /\\(?:addbibresource|addglobalbib|addsectionbib)\b/;
const BIBTEX_RE = /\\(?:bibliography|nobibliography|bibliographystyle)\s*\{/;

/**
 * Which fields the paper's bibliography reads. biblatex reads `date` and
 * `journaltitle`; BibTeX styles (natbib's too) read only `year` and
 * `journal`, so a biblatex export loses both there. biblatex wins when both
 * show; a paper with neither gets biblatex, the export it always had.
 */
export function bibFormatOf(sources: TexSource[]): BibFormat {
  const masked = sources.map((s) => maskComments(s.text));
  const biblatex = masked.some((t) => BIBLATEX_RESOURCE_RE.test(t)
    || [...t.matchAll(PACKAGE_RE)].some((m) => m[1].split(',').some((p) => p.trim() === 'biblatex')));
  if (biblatex) return 'biblatex';
  return masked.some((t) => BIBTEX_RE.test(t)) ? 'bibtex' : 'biblatex';
}

export function paperBibFormat(projectId: string, branch: string): BibFormat {
  return bibFormatOf(texSources(projectId, branch));
}

/**
 * The .bib files the paper loads, in the order its sources name them (root
 * first): each name resolved from the root file's directory, or from the
 * naming file's own where only that one exists. Names that leave the
 * project are left out.
 */
export function loadedBibFiles(sources: TexSource[], rootFile: string, existing: Set<string>): string[] {
  const rootDir = path.posix.dirname(rootFile || 'main.tex');
  const out: string[] = [];
  const ordered = [...sources].sort((a, b) => (a.path === rootFile ? -1 : b.path === rootFile ? 1 : a.path.localeCompare(b.path)));
  for (const s of ordered) {
    for (const m of maskComments(s.text).matchAll(RESOURCE_RE)) {
      const bibtex = m[1] === 'bibliography' || m[1] === 'nobibliography';
      for (const raw of m[2].split(',')) {
        const name = raw.trim();
        if (!name) continue;
        const file = bibtex && !/\.bib$/i.test(name) ? `${name}.bib` : name;
        const fromRoot = path.posix.normalize(path.posix.join(rootDir, file));
        const fromSource = path.posix.normalize(path.posix.join(path.posix.dirname(s.path), file));
        const pick = !existing.has(fromRoot) && existing.has(fromSource) ? fromSource : fromRoot;
        if (pick.startsWith('../') || pick.startsWith('/') || out.includes(pick)) continue;
        out.push(pick);
      }
    }
  }
  return out;
}

/**
 * Where a reference added without a named file goes: the first .bib the
 * paper loads that is not `avoid` (the Zotero file, rewritten at every
 * sync), one that exists before one that does not. With none, references.bib
 * beside the root file, which `loaded` then says the paper does not read.
 * `others`: the rest of what the paper loads, where the same paper may sit
 * under another key already.
 */
export function referenceTarget(projectId: string, branch: string, rootFile: string, avoid: string | null, fallback: string, usable: (p: string) => boolean): { bibFile: string; loaded: boolean; others: string[]; format: BibFormat } {
  const sources = texSources(projectId, branch);
  const existing = new Set(store.listFiles(projectId, branch).filter((f) => f.type === 'file').map((f) => f.path));
  const loaded = loadedBibFiles(sources, rootFile, existing).filter(usable);
  const candidates = loaded.filter((f) => f !== avoid && /\.bib$/i.test(f));
  const bibFile = candidates.find((f) => existing.has(f)) ?? candidates[0] ?? fallback;
  return {
    bibFile,
    loaded: loaded.includes(bibFile),
    others: loaded.filter((f) => f !== bibFile && existing.has(f)),
    format: bibFormatOf(sources),
  };
}
