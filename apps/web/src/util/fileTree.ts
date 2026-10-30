import type { TreeEntry } from '../api';

export interface TreeNode { name: string; path: string; type: 'file' | 'dir'; children: TreeNode[] }

/** Git keeps no empty directories: a new folder is this file inside it. */
export const KEEP_FILE = '.gitkeep';

/** What the Source view lists: LaTeX sources and the images they include. */
export const SOURCE_FILE = /\.(tex|bib|cls|bbx|cbx|sty|bst|png|jpe?g|pdf|eps|svg|tikz)$/i;

const isDotName = (name: string) => name.startsWith('.');

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
    n.children.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

const holdsFile = (n: TreeNode): boolean => n.children.some((c) => c.type === 'file' || holdsFile(c));

/**
 * The Source view: source files, and every folder git can hold (one with a
 * file anywhere inside, a lone .gitkeep included) even when none of its files
 * is source. A dot-folder (.github, .vscode) and the folders inside it stay
 * only for the source they hold, and a directory with no file at all is left
 * over on disk, not in git.
 */
export function sourceTree(nodes: TreeNode[], inDotFolder = false): TreeNode[] {
  const out: TreeNode[] = [];
  for (const n of nodes) {
    if (n.type === 'file') {
      if (SOURCE_FILE.test(n.name)) out.push(n);
      continue;
    }
    const dot = inDotFolder || isDotName(n.name);
    const kids = sourceTree(n.children, dot);
    if (kids.length || (!dot && holdsFile(n))) out.push({ ...n, children: kids });
  }
  return out;
}

/** `path` is `entry` itself or lies inside it: what a delete or rename of `entry` takes along. */
export function within(path: string, entry: string): boolean {
  return path === entry || path.startsWith(`${entry}/`);
}

/** True when `dir` holds no file but .gitkeep placeholders, at any depth:
 *  deleting it loses nothing anyone wrote. */
export function holdsOnlyKeep(files: TreeEntry[], dir: string): boolean {
  const prefix = `${dir}/`;
  return files.every((f) => f.type !== 'file' || !f.path.startsWith(prefix) || f.path.split('/').pop() === KEEP_FILE);
}

/** The path as the server's importPath spells it: no empty or "." segments,
 *  no trailing slash. */
export function normalizeEntryPath(raw: string): string {
  return raw.trim().replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.').join('/');
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
