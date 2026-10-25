import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { BLANK_TEMPLATE, applyPlaceholders, listTemplates, templateFiles, type TemplateInfo } from './templates.js';
import { REPO_PREFIX, listRepoTemplates, onTemplateRepoSynced } from './templaterepos.js';
import { guessRoot } from './root.js';
import { detectEngine } from './detect.js';
import { readThumbMeta, thumbFiles, thumbVersion } from './thumbnail.js';
import { INSTALLED_VENUES, VENUE_PREFIX, cachedVenueClasses, installedVenueFiles, type CatalogClass } from './catalog.js';
import { venueKit, type VenueKitEntry } from './venuekits.js';

/**
 * Page-1 previews for the New project chooser.
 *
 * Shipped templates are rendered before release, not by a running server:
 * `npm run templates:previews` typesets each one through the compiler and
 * writes the image and a sidecar naming its version key to
 * TEMPLATE_PREVIEWS_DIR (apps/server/assets/template-previews in the image).
 * A unit test fails while any of them is missing or older than its sources,
 * and a sidecar whose key no longer matches is never served.
 *
 * Templates from a template repository are typeset by the compiler after a
 * sync that moved the repository's HEAD, once per version. The compiler
 * renders page 1 exactly as after a project's typeset (apps/compiler/
 * thumbnail.js); the app server copies the image out of the work directory
 * and never parses a PDF. A failed render is retried on a later sync after a
 * backoff, never in a loop.
 *
 * A version key hashes the template's raw files, before placeholders, plus its
 * id and name: {{DATE}} in a template does not make a new version every day.
 * The preview is typeset with a fixed date for the same reason.
 *
 * Venue tiles are rendered before release too, in CI (.github/workflows/
 * template-previews.yml), with the compiler image: an installed class into
 * venues/<id>, keyed by the files Aldine seeds from the image's catalog row;
 * a fetched kit into kits/<id>, keyed by its registry entry, so a new URL or
 * take list is a new version. known-failures.json names the venues that
 * have no image and why.
 *
 * The work directory sits under DATA_DIR because that is the only volume the
 * compiler reads. Repository images live in CACHE_DIR/template-previews/<repo>,
 * which the compiler never sees.
 */

export interface TemplatePreview { w: number; h: number; v: string }

const MAX_BYTES = 2 * 1024 * 1024;
const KEY_RE = /^[0-9a-f]{32}$/;
const V_RE = /^[0-9a-f]{16}$/;
const SHIPPED_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** The compiler renders after it has answered; this bounds the wait for its sidecar. */
const RENDER_WAIT_MS = Number(process.env.TEMPLATE_PREVIEW_WAIT_MS || 30_000);
const COMPILE_TIMEOUT_MS = Number(process.env.TEMPLATE_PREVIEW_COMPILE_TIMEOUT_MS || 240_000);
/** First retry after a failed render; each further failure doubles it, up to RETRY_MAX_MS. */
const RETRY_FIRST_MS = Number(process.env.TEMPLATE_PREVIEW_RETRY_MS || 10 * 60_000);
const RETRY_MAX_MS = 6 * 3600_000;
/** {{DATE}} and {{YEAR}} in a preview: a fixed day, so the image is a function of the files. */
export const PREVIEW_DATE = new Date('2026-01-01T12:00:00Z');

const repoPreviewDir = (repoId: string) => path.join(config.cacheDir, 'template-previews', repoId);
const workRoot = () => path.join(config.dataDir, 'template-previews');

/** The version of a template: its id, its name and every raw file path and its bytes. */
export function templateVersionKey(t: Pick<TemplateInfo, 'id' | 'name'>, raw: Record<string, Buffer>): string {
  const h = crypto.createHash('sha256').update(t.id).update('\0').update(t.name).update('\0');
  for (const rel of Object.keys(raw).sort()) {
    h.update(rel).update('\0').update(String(raw[rel].length)).update('\0').update(raw[rel]);
  }
  return h.digest('hex').slice(0, 32);
}

/** The files a preview typesets: the placeholders filled with the template's own name and the fixed date. */
export function previewSeed(t: Pick<TemplateInfo, 'name'>, raw: Record<string, Buffer>): Record<string, Buffer> {
  return applyPlaceholders(raw, { projectName: t.name, author: 'Author name', now: PREVIEW_DATE });
}

/** Raw files and version key of a template that has a document to typeset, else null. */
export function versionOf(t: TemplateInfo): { raw: Record<string, Buffer>; key: string } | null {
  if (t.id === BLANK_TEMPLATE.id) return null;
  let raw: Record<string, Buffer>;
  try { raw = templateFiles(t.id); } catch { return null; }
  if (!guessRoot(raw)) return null;
  return { raw, key: templateVersionKey(t, raw) };
}

function readSidecar(file: string): (TemplatePreview & { key?: string }) | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const side = (n: unknown) => Number.isInteger(n) && (n as number) > 0 && (n as number) <= 4096;
    if (!raw || !side(raw.w) || !side(raw.h) || typeof raw.v !== 'string' || !V_RE.test(raw.v)) return null;
    if (raw.key !== undefined && (typeof raw.key !== 'string' || !KEY_RE.test(raw.key))) return null;
    return { w: raw.w, h: raw.h, v: raw.v, ...(raw.key ? { key: raw.key } : {}) };
  } catch {
    return null;
  }
}

function readJpeg(file: string): Buffer | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size < 4 || st.size > MAX_BYTES) return null;
    const bytes = fs.readFileSync(file);
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? bytes : null;
  } catch {
    return null;
  }
}

/** Write image then sidecar, each by rename: a sidecar never names an image that is not there. */
export function storePreview(dir: string, base: string, bytes: Buffer, sidecar: object): void {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${base}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, path.join(dir, `${base}.jpg`));
  fs.writeFileSync(tmp, `${JSON.stringify(sidecar)}\n`);
  fs.renameSync(tmp, path.join(dir, `${base}.json`));
}

// ---- shipped templates ----

/** Shipped template id → its preview, when the image on disk is of its current version. */
let shipped: Map<string, TemplatePreview> | null = null;

/** Read TEMPLATE_PREVIEWS_DIR against the shipped templates as they are now. */
export function loadShippedPreviews(): Map<string, TemplatePreview> {
  const found = new Map<string, TemplatePreview>();
  const stale: string[] = [];
  for (const t of listTemplates()) {
    const ver = versionOf(t);
    if (!ver || !SHIPPED_ID_RE.test(t.id)) continue;
    const side = readSidecar(path.join(config.templatePreviewsDir, `${t.id}.json`));
    const bytes = side?.key === ver.key ? readJpeg(path.join(config.templatePreviewsDir, `${t.id}.jpg`)) : null;
    if (side && bytes && thumbVersion(bytes) === side.v) found.set(t.id, { w: side.w, h: side.h, v: side.v });
    else stale.push(t.id);
  }
  if (stale.length) console.warn(`[templates] no current preview for ${stale.join(', ')}: the chooser shows a title page (npm run templates:previews renders them)`);
  shipped = found;
  venueSeen.clear();
  return found;
}

const shippedPreviews = () => shipped ?? loadShippedPreviews();

// ---- repository templates ----

/** Repository template id → version key and name, as of the last sync that moved HEAD. */
const keys = new Map<string, { key: string; name: string }>();
/** Version key → the rendered image's size and version, once it is on disk. */
const ready = new Map<string, TemplatePreview>();
/** Version key → when its render last failed and how often in a row. */
const failures = new Map<string, { at: number; count: number }>();
/** Repositories whose templates have been keyed in this process. */
const keyed = new Set<string>();

function repoOf(id: string): string | null {
  if (!id.startsWith(REPO_PREFIX)) return null;
  const rest = id.slice(REPO_PREFIX.length);
  const slash = rest.indexOf('/');
  return slash > 0 ? rest.slice(0, slash) : null;
}

function repoPreview(repoId: string, key: string): TemplatePreview | null {
  const hit = ready.get(key);
  if (hit) return hit;
  const side = readSidecar(path.join(repoPreviewDir(repoId), `${key}.json`));
  if (!side || !fs.existsSync(path.join(repoPreviewDir(repoId), `${key}.jpg`))) return null;
  const p = { w: side.w, h: side.h, v: side.v };
  ready.set(key, p);
  return p;
}

/**
 * Recompute the version of every template of `repoId` from its checkout,
 * forget ids the checkout no longer has, and delete images of versions no
 * template has any more.
 */
export function rekeyRepo(repoId: string): void {
  const prefix = `${REPO_PREFIX}${repoId}/`;
  for (const id of [...keys.keys()]) if (id.startsWith(prefix)) keys.delete(id);
  const live = new Set<string>();
  for (const t of listRepoTemplates()) {
    if (!t.id.startsWith(prefix)) continue;
    const ver = versionOf(t);
    if (!ver) continue;
    keys.set(t.id, { key: ver.key, name: t.name });
    live.add(ver.key);
  }
  keyed.add(repoId);
  let names: string[];
  try { names = fs.readdirSync(repoPreviewDir(repoId)); } catch { return; }
  for (const name of names) {
    const m = /^([0-9a-f]{32})\.(jpg|json)$/.exec(name);
    if (m && live.has(m[1])) continue;
    // A render in flight writes under a dot-name; leave it to land.
    if (!m && name.startsWith('.')) continue;
    if (m) { ready.delete(m[1]); failures.delete(m[1]); }
    fs.rmSync(path.join(repoPreviewDir(repoId), name), { force: true });
  }
}

// ---- venues ----

/** Subdirectory of TEMPLATE_PREVIEWS_DIR per kind of venue tile. */
export const VENUE_PREVIEW_DIRS = { venue: 'venues', kit: 'kits' } as const;
export type VenueKind = keyof typeof VENUE_PREVIEW_DIRS;
export const KNOWN_FAILURES_FILE = 'known-failures.json';

/** The version of a fetched kit: every field of its registry entry that decides what a project is seeded with. */
export function kitVersionKey(e: VenueKitEntry): string {
  const k = e.kit;
  const def = {
    url: k.url ?? null, urls: k.urls ?? null, host: k.host, take: k.take ?? null, rename: k.rename ?? null, flatten: !!k.flatten,
    documentClass: e.documentClass, classOptions: e.classOptions ?? null, preamble: e.preamble ?? null,
    bibStyle: e.bibStyle ?? null, classSetsBibStyle: !!e.classSetsBibStyle, main: e.main ?? null,
  };
  return templateVersionKey({ id: VENUE_PREFIX + e.id, name: e.name }, { 'kit.json': Buffer.from(JSON.stringify(def)) });
}

/** Seed files and version key of an installed class, or null for one the gallery does not list. */
export function installedVersion(c: CatalogClass): { raw: Record<string, Buffer>; key: string; name: string } | null {
  const raw = installedVenueFiles(c);
  if (!raw) return null;
  const name = INSTALLED_VENUES[c.id].name;
  return { raw, key: templateVersionKey({ id: VENUE_PREFIX + c.id, name }, raw), name };
}

/** Which tile `venue:<id>` is listed as, the way listAllTemplates decides it: the installed class wins. */
function venueVersion(id: string): { dir: string; base: string; key: string } | null {
  const base = id.slice(VENUE_PREFIX.length);
  if (!SHIPPED_ID_RE.test(base)) return null;
  const cls = cachedVenueClasses().find((c) => c.id === base);
  const installed = cls ? installedVersion(cls) : null;
  if (installed) return { dir: path.join(config.templatePreviewsDir, VENUE_PREVIEW_DIRS.venue), base, key: installed.key };
  const entry = venueKit(base);
  return entry ? { dir: path.join(config.templatePreviewsDir, VENUE_PREVIEW_DIRS.kit), base, key: kitVersionKey(entry) } : null;
}

/** dir/base:key → its preview, or null when that version has no image on disk. */
const venueSeen = new Map<string, TemplatePreview | null>();

function venuePreview(id: string): { preview: TemplatePreview; file: string } | null {
  const ver = venueVersion(id);
  if (!ver) return null;
  const file = path.join(ver.dir, `${ver.base}.jpg`);
  const memo = `${file}:${ver.key}`;
  let hit = venueSeen.get(memo);
  if (hit === undefined) {
    const side = readSidecar(path.join(ver.dir, `${ver.base}.json`));
    const bytes = side?.key === ver.key ? readJpeg(file) : null;
    hit = side && bytes && thumbVersion(bytes) === side.v ? { w: side.w, h: side.h, v: side.v } : null;
    venueSeen.set(memo, hit);
  }
  return hit ? { preview: hit, file } : null;
}

/** The current preview of `id`, or null when its version has none (yet). */
export function templatePreview(id: string): TemplatePreview | null {
  if (id.startsWith(VENUE_PREFIX)) return venuePreview(id)?.preview ?? null;
  const repoId = repoOf(id);
  if (!repoId) return shippedPreviews().get(id) ?? null;
  const k = keys.get(id);
  return k ? repoPreview(repoId, k.key) : null;
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
  if (id.startsWith(VENUE_PREFIX)) {
    const hit = venuePreview(id);
    const bytes = hit ? readJpeg(hit.file) : null;
    return bytes ? { bytes, v: thumbVersion(bytes) } : null;
  }
  if (!templatePreview(id)) return null;
  const repoId = repoOf(id);
  const file = repoId
    ? path.join(repoPreviewDir(repoId), `${keys.get(id)!.key}.jpg`)
    : path.join(config.templatePreviewsDir, `${id}.jpg`);
  const bytes = readJpeg(file);
  return bytes ? { bytes, v: thumbVersion(bytes) } : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Typeset `files` in a fresh work directory and return page 1. A typeset
 * with errors is a failure, even when -f got a PDF out of it: its page 1 is
 * not what the template looks like. The work directory is removed either way.
 */
export async function typesetPage1(files: Record<string, Buffer>, label: string): Promise<{ bytes: Buffer; w: number; h: number; v: string } | { error: string }> {
  const root = guessRoot(files);
  if (!root) return { error: 'no root .tex' };
  const work = path.join(workRoot(), crypto.randomBytes(8).toString('hex'));
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
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; pdf?: string | null; pdfFresh?: boolean; errors?: { type?: string; message?: string }[] };
    const firstError = (body.errors ?? []).find((e) => e.type === 'error');
    if (body.ok !== true || firstError) return { error: `the typeset of ${label} reported errors${firstError?.message ? `: ${firstError.message}` : ''}` };
    if (!body.pdf || body.pdfFresh === false) return { error: `the typeset of ${label} wrote no PDF` };
    const deadline = Date.now() + RENDER_WAIT_MS;
    let meta: { w: number; h: number; v: string } | null = null;
    while (!(meta = await readThumbMeta(work, root)) && Date.now() < deadline) await sleep(250);
    if (!meta) return { error: `the compiler rendered no page 1 for ${label}` };
    const bytes = fs.readFileSync(path.join(work, thumbFiles(root).jpg));
    if (bytes.length > MAX_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || thumbVersion(bytes) !== meta.v) return { error: `the page-1 image of ${label} is unreadable` };
    return { bytes, ...meta };
  } catch (err: any) {
    return { error: `the typeset of ${label} did not finish (${err?.message || err})` };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function backingOff(key: string, now = Date.now()): boolean {
  const f = failures.get(key);
  if (!f) return false;
  return now - f.at < Math.min(RETRY_FIRST_MS * 2 ** (f.count - 1), RETRY_MAX_MS);
}

/** One typeset at a time: previews share the compiler with people's own typesets. */
let chain: Promise<unknown> = Promise.resolve();
const queued = new Set<string>();

type Keyed = [id: string, k: { key: string; name: string }];

function missing(repoId: string): Keyed[] {
  const prefix = `${REPO_PREFIX}${repoId}/`;
  return [...keys].filter(([id, k]) => id.startsWith(prefix) && !queued.has(k.key) && !backingOff(k.key) && !repoPreview(repoId, k.key));
}

function queueRenders(repoId: string, todo: Keyed[]): Promise<void> {
  const jobs = todo.map(([id, { key, name }]) => {
    queued.add(key);
    const job = chain.then(async () => {
      try {
        // A sync that moved HEAD while this waited queued its own job.
        if (keys.get(id)?.key !== key) return;
        let raw: Record<string, Buffer>;
        try { raw = templateFiles(id); } catch { return; }
        if (templateVersionKey({ id, name }, raw) !== key) return;
        const out = await typesetPage1(previewSeed({ name }, raw), `"${id}"`);
        if ('error' in out) {
          const prev = failures.get(key);
          failures.set(key, { at: Date.now(), count: (prev?.count ?? 0) + 1 });
          console.warn(`[templates] no preview for "${id}" yet: ${out.error}; retried on a later sync`);
          return;
        }
        if (keys.get(id)?.key !== key) return;
        const meta = { w: out.w, h: out.h, v: out.v };
        storePreview(repoPreviewDir(repoId), key, out.bytes, meta);
        ready.set(key, meta);
        failures.delete(key);
      } finally {
        queued.delete(key);
      }
    });
    chain = job.catch(() => undefined);
    return job;
  });
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

const rendering = () => process.env.ALDINE_TEMPLATE_PREVIEWS !== '0';

/**
 * After a sync of `repoId`: rekey its templates when HEAD moved (or on the
 * first sync in this process), then typeset each version that has no image
 * and is not backing off, if the compiler can render. Resolves when those
 * renders are done.
 */
export async function refreshRepoPreviews(repoId: string, headMoved: boolean): Promise<void> {
  if (headMoved || !keyed.has(repoId)) rekeyRepo(repoId);
  if (!rendering() || !missing(repoId).length || !(await compilerRenders())) return;
  await queueRenders(repoId, missing(repoId));
}

let started = false;
let pending: Promise<void> = Promise.resolve();

/** Settles when the preview work started by the syncs so far is done. */
export function previewsSettled(): Promise<void> {
  return pending;
}

/**
 * Boot: read the shipped previews, key every repository checkout already on
 * disk so its images are served before the first sync, and typeset after
 * each sync.
 */
export function startTemplatePreviews(): void {
  if (started) return;
  started = true;
  loadShippedPreviews();
  for (const t of listRepoTemplates()) {
    const repoId = repoOf(t.id);
    if (repoId && !keyed.has(repoId)) rekeyRepo(repoId);
  }
  onTemplateRepoSynced((repoId, headMoved) => {
    const run = refreshRepoPreviews(repoId, headMoved).catch((err) => { console.warn('[templates] preview refresh failed', err); });
    pending = Promise.all([pending, run]).then(() => undefined);
  });
}
