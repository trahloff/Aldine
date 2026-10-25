import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { BLANK_TEMPLATE, applyPlaceholders, listTemplates, templateFiles, type TemplateInfo } from './templates.js';
import { listRepoTemplates, onTemplateRepoSynced } from './templaterepos.js';
import { guessRoot } from './root.js';
import { detectEngine } from './detect.js';
import { readThumbMeta, thumbFiles, thumbVersion } from './thumbnail.js';

/**
 * Page-1 previews for the New project chooser. A folder template, shipped or
 * from a template repository, is typeset once per version by the compiler,
 * which renders page 1 exactly as it does after a project's typeset
 * (apps/compiler/thumbnail.js). The app server copies the image out of the
 * work directory and serves it; it never parses a PDF.
 *
 * A version is the hash of the template's seed files, so an edited template
 * gets a new image and an unchanged one is never typeset again, across
 * restarts. Venue classes and fetched kits are not rendered: the chooser
 * draws a title-page placeholder for them.
 *
 * The work directory sits under DATA_DIR because that is the only volume the
 * compiler reads. The finished image lives in CACHE_DIR, which the compiler
 * never sees.
 */

export interface TemplatePreview { w: number; h: number; v: string }

const MAX_BYTES = 2 * 1024 * 1024;
const KEY_RE = /^[0-9a-f]{32}$/;
/** The compiler renders after it has answered; this bounds the wait for its sidecar. */
const RENDER_WAIT_MS = Number(process.env.TEMPLATE_PREVIEW_WAIT_MS || 30_000);
const COMPILE_TIMEOUT_MS = Number(process.env.TEMPLATE_PREVIEW_COMPILE_TIMEOUT_MS || 240_000);

const previewDir = () => path.join(config.cacheDir, 'template-previews');
const workRoot = () => path.join(config.dataDir, 'template-previews');

/** Template id → version key of the files it currently seeds. */
const keys = new Map<string, string>();
/** Version key → the rendered image's size and version, once it is on disk. */
const ready = new Map<string, TemplatePreview>();
/** Keys whose render failed in this process: retried after a restart, not in a loop. */
const failed = new Set<string>();

/** The version of a template's files: every path and its bytes, plus the id. */
export function templateVersionKey(id: string, files: Record<string, Buffer>): string {
  const h = crypto.createHash('sha256').update(id).update('\0');
  for (const rel of Object.keys(files).sort()) {
    h.update(rel).update('\0').update(String(files[rel].length)).update('\0').update(files[rel]);
  }
  return h.digest('hex').slice(0, 32);
}

function readStored(key: string): TemplatePreview | null {
  if (!KEY_RE.test(key)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(previewDir(), `${key}.json`), 'utf8'));
    const ok = (n: unknown) => Number.isInteger(n) && (n as number) > 0 && (n as number) <= 4096;
    if (!raw || !ok(raw.w) || !ok(raw.h) || typeof raw.v !== 'string' || !/^[0-9a-f]{16}$/.test(raw.v)) return null;
    if (!fs.existsSync(path.join(previewDir(), `${key}.jpg`))) return null;
    return { w: raw.w, h: raw.h, v: raw.v };
  } catch {
    return null;
  }
}

/** The current preview of `id`, or null when its version has none (yet). */
export function templatePreview(id: string): TemplatePreview | null {
  const key = keys.get(id);
  if (!key) return null;
  let p = ready.get(key);
  if (!p) {
    const stored = readStored(key);
    if (!stored) return null;
    ready.set(key, stored);
    p = stored;
  }
  return p;
}

/** The list rows with their `preview`, when one exists. */
export function withPreviews(list: TemplateInfo[]): TemplateInfo[] {
  return list.map((t) => {
    const preview = templatePreview(t.id);
    return preview ? { ...t, preview } : t;
  });
}

/** The image bytes of `id`'s current preview, or null. */
export function readTemplatePreview(id: string): { bytes: Buffer; v: string } | null {
  const key = keys.get(id);
  if (!key || !templatePreview(id)) return null;
  try {
    const file = path.join(previewDir(), `${key}.jpg`);
    const st = fs.statSync(file);
    if (!st.isFile() || st.size < 4 || st.size > MAX_BYTES) return null;
    const bytes = fs.readFileSync(file);
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
    return { bytes, v: thumbVersion(bytes) };
  } catch {
    return null;
  }
}

/** Seed files of a template as the chooser shows it: the placeholders filled with the template's own name. */
function seedFor(t: TemplateInfo): Record<string, Buffer> | null {
  try {
    return applyPlaceholders(templateFiles(t.id), { projectName: t.name, author: 'Author name' });
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Typeset `files` in a fresh work directory and keep page 1 under `key`.
 * Resolves true when the image is stored. The work directory is removed
 * either way.
 */
export async function renderPreview(key: string, files: Record<string, Buffer>): Promise<boolean> {
  const root = guessRoot(files);
  if (!root || !KEY_RE.test(key)) return false;
  const work = path.join(workRoot(), key);
  fs.rmSync(work, { recursive: true, force: true });
  try {
    for (const [rel, bytes] of Object.entries(files)) {
      const abs = path.join(work, rel);
      if (!abs.startsWith(work + path.sep)) continue;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, bytes);
    }
    const res = await fetch(`${config.compilerUrl}/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectDir: path.relative(config.dataDir, work), rootFile: root, engine: detectEngine(files, root).engine }),
      signal: AbortSignal.timeout(COMPILE_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { pdf?: string | null; pdfFresh?: boolean };
    if (!body.pdf || body.pdfFresh === false) return false;
    const deadline = Date.now() + RENDER_WAIT_MS;
    let meta: { w: number; h: number; v: string } | null = null;
    while (!(meta = await readThumbMeta(work, root)) && Date.now() < deadline) await sleep(250);
    if (!meta) return false;
    const bytes = fs.readFileSync(path.join(work, thumbFiles(root).jpg));
    if (bytes.length > MAX_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || thumbVersion(bytes) !== meta.v) return false;
    fs.mkdirSync(previewDir(), { recursive: true });
    const tmp = path.join(previewDir(), `.${key}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, path.join(previewDir(), `${key}.jpg`));
    // The image before its sidecar: a sidecar never names an image that is not there.
    fs.writeFileSync(tmp, JSON.stringify(meta));
    fs.renameSync(tmp, path.join(previewDir(), `${key}.json`));
    ready.set(key, meta);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** One typeset at a time: previews share the compiler with people's own typesets. */
let chain: Promise<unknown> = Promise.resolve();
const queued = new Set<string>();

/**
 * Record the current version of every template in `list` and queue a render
 * for each version without an image. Returns when the queued renders are done.
 */
export function refreshPreviews(list: TemplateInfo[]): Promise<void> {
  const jobs: Promise<unknown>[] = [];
  for (const t of list) {
    if (t.id === BLANK_TEMPLATE.id) continue;
    const files = seedFor(t);
    if (!files || !guessRoot(files)) { keys.delete(t.id); continue; }
    const key = templateVersionKey(t.id, files);
    keys.set(t.id, key);
    if (templatePreview(t.id) || failed.has(key) || queued.has(key)) continue;
    queued.add(key);
    const job = chain.then(async () => {
      try {
        if (!(await renderPreview(key, files))) {
          failed.add(key);
          console.warn(`[templates] no preview for "${t.id}": its typeset or page-1 render did not finish`);
        }
      } finally {
        queued.delete(key);
      }
    });
    chain = job;
    jobs.push(job);
  }
  return Promise.all(jobs).then(() => undefined);
}

/** Whether the compiler can render page 1 at all ('none' without gs or pdftoppm). */
async function compilerRenders(): Promise<boolean> {
  try {
    const res = await fetch(`${config.compilerUrl}/health`, { signal: AbortSignal.timeout(5_000) });
    const raw = (await res.json()) as { ok?: boolean; thumbnails?: string };
    return !!raw.ok && raw.thumbnails !== 'none';
  } catch {
    return false;
  }
}

let started = false;

/**
 * Boot: the shipped templates once the compiler answers, and a repository's
 * templates after each of its syncs. With ALDINE_TEMPLATE_PREVIEWS=0 nothing
 * is typeset and the chooser shows placeholders.
 */
export function startTemplatePreviews(): void {
  if (started || process.env.ALDINE_TEMPLATE_PREVIEWS === '0') return;
  started = true;
  // Ids are known before any render, so an image already on disk from an
  // earlier boot is served at once.
  const all = () => [...listTemplates(), ...listRepoTemplates()];
  onTemplateRepoSynced(() => { void compilerRenders().then((ok) => (ok ? refreshPreviews(listRepoTemplates()) : undefined)); });
  void (async () => {
    for (const t of all()) {
      const files = seedFor(t);
      if (files && guessRoot(files) && t.id !== BLANK_TEMPLATE.id) keys.set(t.id, templateVersionKey(t.id, files));
    }
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await compilerRenders()) { await refreshPreviews(all()); return; }
      await sleep(10_000);
    }
  })();
}
