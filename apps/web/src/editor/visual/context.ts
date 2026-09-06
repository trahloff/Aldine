import { api, BibEntry } from '../../api';
import { withBase } from '../../basePath';
import { pokeViews } from './refresh';

/**
 * Project context for widgets that need more than the document text (cite
 * labels from the bibliography, image URLs). Set by visualExtensions() when a
 * pane mounts; decoration building itself stays pure.
 */
let ctx: { projectId: string; branch: string; rootDir: string } | null = null;
let bib: BibEntry[] | null = null;
let bibKey = '';

export function setVisualContext(projectId: string, branch: string, rootFile?: string): void {
  const rootDir = rootFile && rootFile.includes('/') ? rootFile.slice(0, rootFile.lastIndexOf('/')) : '';
  ctx = { projectId, branch, rootDir };
  const key = `${projectId}::${branch}`;
  if (key !== bibKey) {
    bibKey = key;
    bib = null;
    api.bib(projectId, branch)
      .then((entries) => { bib = entries; pokeViews(); })
      .catch(() => { bib = []; });
  }
}

/** "(Knuth 1984; Lamport 1994)" for a comma-separated key list, best effort. */
export function citeLabel(keys: string): string | null {
  if (!bib) return null;
  const parts = keys.split(',').map((k) => k.trim()).filter(Boolean).map((key) => {
    const e = bib!.find((b) => b.key === key);
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

/**
 * Raw file URL inside the current project (for figure image previews).
 * \includegraphics paths are relative to the root file's dir (latexmk -cd),
 * so resolve against it — the bare project-relative form is offered as a
 * fallback for projects that write paths from the project root.
 */
export function fileUrl(path: string): string | null {
  if (!ctx) return null;
  return withBase(`/api/projects/${ctx.projectId}/file?branch=${encodeURIComponent(ctx.branch)}&path=${encodeURIComponent(joinPath(ctx.rootDir, path))}`);
}

/** Same file URL without root-dir resolution (fallback for fileUrl misses). */
export function projectFileUrl(path: string): string | null {
  if (!ctx || !ctx.rootDir) return null; // identical to fileUrl when the root is top-level
  return withBase(`/api/projects/${ctx.projectId}/file?branch=${encodeURIComponent(ctx.branch)}&path=${encodeURIComponent(joinPath('', path))}`);
}
