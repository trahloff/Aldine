import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { branchDir, type ProjectMeta } from './store.js';

/**
 * Page-1 thumbnails. The compiler renders them after a successful typeset,
 * beside the PDF (apps/compiler/thumbnail.js); the app server only reads
 * them and never parses a PDF itself.
 */

/** A list row's `thumb`: `branch` is the branch whose typeset the image shows. */
export interface Thumb { branch: string; w: number; h: number; v: string }

/** Far above any image the compiler writes at its 360px width. */
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SIDE = 4096;
const V_RE = /^[0-9a-f]{16}$/;

/** Relative to the branch dir: "paper/main.tex" → paper/.aldine-out/.main.thumb.{jpg,json}. */
export function thumbFiles(rootFile: string): { jpg: string; json: string } {
  const root = rootFile || 'main.tex';
  const dir = path.posix.dirname(root);
  const base = path.posix.basename(root).replace(/\.tex$/i, '');
  const at = (name: string) => path.posix.join(dir === '.' ? '' : dir, '.aldine-out', name);
  return { jpg: at(`.${base}.thumb.jpg`), json: at(`.${base}.thumb.json`) };
}

/** The compiler's `v` for these bytes. */
export function thumbVersion(jpeg: Buffer): string {
  return crypto.createHash('sha256').update(jpeg).digest('hex').slice(0, 16);
}

const side = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0 && (n as number) <= MAX_SIDE;

/** Size and version from the sidecar under `dirAbs` (a branch checkout), or null. */
export async function readThumbMeta(dirAbs: string, rootFile: string): Promise<{ w: number; h: number; v: string } | null> {
  try {
    const raw = JSON.parse(await fs.promises.readFile(path.join(dirAbs, thumbFiles(rootFile).json), 'utf8'));
    if (!raw || !side(raw.w) || !side(raw.h) || typeof raw.v !== 'string' || !V_RE.test(raw.v)) return null;
    return { w: raw.w, h: raw.h, v: raw.v };
  } catch {
    return null;
  }
}

/** The thumbnail of `branch`, else main's, else null. */
export async function projectThumb(meta: ProjectMeta, branch = 'main'): Promise<Thumb | null> {
  for (const b of branch === 'main' ? ['main'] : [branch, 'main']) {
    let dir: string;
    try { dir = branchDir(meta.id, b); } catch { continue; }
    const t = await readThumbMeta(dir, meta.rootFile);
    if (t) return { branch: b, ...t };
  }
  return null;
}

/** The image of `branch` and the version its bytes are, or null when there is none. */
export async function readThumbImage(projectId: string, branch: string, rootFile: string): Promise<{ bytes: Buffer; v: string } | null> {
  let fh: FileHandle | undefined;
  try {
    fh = await fs.promises.open(path.join(branchDir(projectId, branch), thumbFiles(rootFile).jpg), 'r');
    const st = await fh.stat();
    if (!st.isFile() || st.size < 4 || st.size > MAX_BYTES) return null;
    const bytes = await fh.readFile();
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
    return { bytes, v: thumbVersion(bytes) };
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/** If-None-Match against a strong ETag: a list, weak forms and `*` included. */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  return (Array.isArray(header) ? header.join(',') : header).split(',').some((t) => {
    const tag = t.trim();
    return tag === '*' || tag.replace(/^W\//, '') === etag;
  });
}
