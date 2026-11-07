import type { TreeEntry } from '../api';

export interface TreeNode { name: string; path: string; type: 'file' | 'dir'; children: TreeNode[] }

/** Git keeps no empty directories: a new folder is this file inside it. */
export const KEEP_FILE = '.gitkeep';

/** What the Source view lists: LaTeX sources (Sweave and Asymptote ones
 *  too), a journal kit's class options, configs and language files, the
 *  images and plot data they read, notes, and latexmk's settings. */
export const SOURCE_FILE = /\.(tex|ltx|latex|rnw|rtex|bib|cls|clo|cfg|def|ldf|lbx|bbx|cbx|sty|bst|ist|mtx|asy|png|jpe?g|pdf|eps|svg|tikz|pgf|csv|tsv|dat|txt|md)$|^\.latexmkrc$/i;

const isDotName = (name: string) => name.startsWith('.');

/** chapter2 before chapter10, and case aside. */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** A nested tree from the flat listing: folders first, then files, each by name. */
export function buildTree(files: TreeEntry[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', type: 'dir', children: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let cur = root;
    parts.forEach((seg, i) => {
      const isLeaf = i === parts.length - 1;
      const p = parts.slice(0, i + 1).join('/');
      let child = cur.children.find((c) => c.name === seg);
      if (!child) {
        child = { name: seg, path: p, type: isLeaf && f.type === 'file' ? 'file' : 'dir', children: [] };
        cur.children.push(child);
      }
      cur = child;
    });
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : byName.compare(a.name, b.name)));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

const holdsFile = (n: TreeNode): boolean => n.children.some((c) => c.type === 'file' || holdsFile(c));

/**
 * The Source view: source files, the files in `keep` (the open one, the ones
 * just added) whatever they are, and every folder git can hold (one with a
 * file anywhere inside, a lone .gitkeep included) even when none of its files
 * is source. A dot-folder (.github, .vscode) and the folders inside it stay
 * only for the source and kept files they hold, and a directory with no file
 * at all is left over on disk, not in git.
 */
export function sourceTree(nodes: TreeNode[], keep: ReadonlySet<string> = new Set(), inDotFolder = false): TreeNode[] {
  const out: TreeNode[] = [];
  for (const n of nodes) {
    if (n.type === 'file') {
      if (SOURCE_FILE.test(n.name) || keep.has(n.path)) out.push(n);
      continue;
    }
    const dot = inDotFolder || isDotName(n.name);
    const kids = sourceTree(n.children, keep, dot);
    if (kids.length || (!dot && holdsFile(n))) out.push({ ...n, children: kids });
  }
  return out;
}

const filePaths = (nodes: TreeNode[]): string[] => nodes.flatMap((n) => (n.type === 'file' ? [n.path] : filePaths(n.children)));

/** How many files `shown` leaves out of `full` that someone may look for: not
 *  the .gitkeep placeholders, nor dot-files such as the .gitignore every
 *  project carries, which file browsers hide too. */
export function hiddenCount(full: TreeNode[], shown: TreeNode[]): number {
  const seen = new Set(filePaths(shown));
  return filePaths(full).filter((p) => !seen.has(p) && !p.split('/').some(isDotName)).length;
}

/** A row the tree shows, in the order it shows them, with what a screen
 *  reader announces about its place. */
export interface TreeRow {
  path: string;
  name: string;
  type: 'file' | 'dir';
  /** 1 at the top level. */
  level: number;
  /** The folder it is in; null at the top level. */
  parent: string | null;
  setSize: number;
  posInSet: number;
  open: boolean;
}

/** The rows on screen: every node of the top level, and the children of each open folder. */
export function visibleRows(nodes: TreeNode[], isOpen: (path: string) => boolean, level = 1, parent: string | null = null): TreeRow[] {
  return nodes.flatMap((n, i): TreeRow[] => {
    const open = n.type === 'dir' && isOpen(n.path);
    const row: TreeRow = { path: n.path, name: n.name, type: n.type, level, parent, setSize: nodes.length, posInSet: i + 1, open };
    return open ? [row, ...visibleRows(n.children, isOpen, level + 1, n.path)] : [row];
  });
}

/** What a key on the row `from` does, as a tree view does it: Up and Down go
 *  to the row above or below, Home and End to the first and last, Right opens
 *  a folder and then goes into it, Left closes it and then goes up to the
 *  folder a row is in. Null for a key the tree leaves alone. */
export function treeKey(rows: readonly TreeRow[], from: string, key: string): { focus?: string; open?: string; close?: string } | null {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft'].includes(key)) return null;
  const at = rows.findIndex((r) => r.path === from);
  if (at < 0) return rows.length ? { focus: rows[0].path } : {};
  const row = rows[at];
  switch (key) {
    case 'ArrowDown': return { focus: rows[Math.min(at + 1, rows.length - 1)].path };
    case 'ArrowUp': return { focus: rows[Math.max(at - 1, 0)].path };
    case 'Home': return { focus: rows[0].path };
    case 'End': return { focus: rows[rows.length - 1].path };
    case 'ArrowRight':
      if (row.type !== 'dir') return {};
      if (!row.open) return { open: row.path };
      return rows[at + 1]?.parent === row.path ? { focus: rows[at + 1].path } : {};
    default:
      if (row.type === 'dir' && row.open) return { close: row.path };
      return row.parent !== null ? { focus: row.parent } : {};
  }
}

/** The row typing `text` moves to: the next one whose name starts with it,
 *  from the row after `from` for a first letter and from `from` itself while
 *  the name is being typed on, round to the top. */
export function typeaheadRow(rows: readonly TreeRow[], from: string, text: string): string | null {
  const t = text.toLowerCase();
  const at = rows.findIndex((r) => r.path === from);
  const start = at < 0 ? 0 : t.length > 1 ? at : at + 1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[(start + i) % rows.length];
    if (r.name.toLowerCase().startsWith(t)) return r.path;
  }
  return null;
}

/** An entry a folder upload leaves behind: dot-files and dot-folders (.git,
 *  .DS_Store), except the ones the Source view lists, such as .latexmkrc. */
export function hiddenUploadName(name: string): boolean {
  return isDotName(name) && !SOURCE_FILE.test(name);
}

/** `path` is `entry` itself or lies inside it: what a delete or rename of `entry` takes along. */
export function within(path: string, entry: string): boolean {
  return path === entry || path.startsWith(`${entry}/`);
}

/** The files anywhere inside `dir`, without the .gitkeep placeholders. */
export function filesIn(files: TreeEntry[], dir: string): string[] {
  const prefix = `${dir}/`;
  return files.filter((f) => f.type === 'file' && f.path.startsWith(prefix) && f.path.split('/').pop() !== KEEP_FILE).map((f) => f.path);
}

/** True when `dir` holds no file but .gitkeep placeholders, at any depth:
 *  deleting it loses nothing anyone wrote. */
export function holdsOnlyKeep(files: TreeEntry[], dir: string): boolean {
  return filesIn(files, dir).length === 0;
}

/** Where dropping `path` on the folder `dir` ('' is the top level) moves it,
 *  or null when it would stay where it is or land inside itself. */
export function moveTarget(path: string, dir: string): string | null {
  const name = path.split('/').pop()!;
  const to = dir ? `${dir}/${name}` : name;
  return to === path || within(dir, path) ? null : to;
}

/** The path as the server's importPath spells it: no empty or "." segments,
 *  no trailing slash. */
export function normalizeEntryPath(raw: string): string {
  return raw.trim().replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.').join('/');
}

/** A new file named without an extension is a .tex file; a dot-file such as
 *  .latexmkrc keeps its name. */
export function withTexExtension(path: string): string {
  return path.split('/').pop()!.includes('.') ? path : `${path}.tex`;
}

const isReserved = (seg: string) => {
  const s = seg.toLowerCase().replace(/[. ]+$/, '');
  return s === '.git' || s.startsWith('.aldine');
};

/**
 * Why the server would refuse `raw` as a new file or folder path (PUT /file:
 * importPath, isHiddenPath, the ".." check and optionLikePath), or null when
 * it would take it. Checked before the request so the input can say so and
 * stay open; the server's own answer is still shown if it refuses anyway.
 */
export function entryPathError(raw: string): string | null {
  const p = raw.trim();
  if (!p) return 'Enter a name';
  if (/^[\\/]/.test(p) || /^[A-Za-z]:/.test(p)) return 'Use a path inside the project, without a leading slash';
  if (p.includes('\0')) return 'Names cannot contain a null character';
  if (p.includes('..')) return 'Names cannot contain ".."';
  const segs = p.split(/[\\/]/).filter((s) => s !== '' && s !== '.');
  if (!segs.length) return 'Enter a name';
  if (segs.some(isReserved)) return '".git" and names starting with ".aldine" are reserved';
  if (segs.some((s) => s.startsWith('-'))) return 'Names cannot start with "-"';
  return null;
}
