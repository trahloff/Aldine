/**
 * Venue kits fetched from the publisher.
 *
 * Most venues (NeurIPS, ACL, CVPR, SIAM, MDPI, Frontiers…) publish their class
 * and style files as a zip on their own site and ship nothing to TeX Live, so
 * the installed-class gallery in catalog.ts cannot reach them. This module
 * downloads such a kit when the user creates the project, unpacks it with the
 * project's own hardened ZIP reader, and seeds the paper from it.
 *
 * The rules that make this safe are not tunables:
 *  - The server fetches, never the compiler: the compiler has no egress.
 *  - templates/venues.json is the only source of URLs. Nothing in a request
 *    reaches the fetcher, so there is no SSRF surface; an entry whose URL is
 *    not https, or points somewhere other than the host the entry declares,
 *    is dropped at load time rather than fetched.
 *  - A failed fetch never fails project creation: the project is created from
 *    the generated skeleton plus README-venue.md, and the caller says so.
 *  - No publisher file is stored in this repo. The cache under
 *    CACHE_DIR/venue-kits/ is a runtime cache, not a redistribution.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { unzip } from './unzip.js';
import { importPath, isHiddenPath, overlongPath, SEED_MAX_BYTES, SEED_MAX_FILES } from './util.js';
import type { TemplateCategory, TemplateInfo } from './templates.js';
import { REFERENCES_BIB, VENUE_PREFIX } from './catalog.js';

/** 20 s per kit, redirects included. The override can only shorten it: the
 *  test suites use it to reach the timeout path without waiting 20 s. */
export const KIT_TIMEOUT_MS = Math.min(20_000, Number(process.env.VENUE_KIT_TIMEOUT_MS) || 20_000);
export const KIT_MAX_BYTES = 25 * 1024 * 1024;
export const KIT_MAX_REDIRECTS = 3;
export const KIT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const VERSION = readVersion();
const USER_AGENT = `Aldine/${VERSION} (+https://aldine.dev)`;

function readVersion(): string {
  try {
    const pkg = new URL('../package.json', import.meta.url);
    return JSON.parse(fs.readFileSync(pkg, 'utf8')).version || '0';
  } catch { return '0'; }
}

export interface VenueKitSpec {
  /** A single archive. Mutually exclusive with `urls`. */
  url?: string;
  /** Bare .tex/.sty files, for a venue that publishes no archive (USENIX). */
  urls?: string[];
  /** The only host this entry may be fetched from, redirects included. */
  host: string;
  /** Globs naming what to take out of the archive; a wildcard-free glob is required. */
  take?: string[];
  /** Kit path → project path, applied after the archive prefix is stripped. */
  rename?: Record<string, string>;
  /** Drop the directories the kit nests files in (Springer's bst/, Frontiers' subfolders). */
  flatten?: boolean;
}

export interface VenueKitEntry {
  id: string;
  name: string;
  category: TemplateCategory;
  description: string;
  icon?: string;
  homepage: string;
  termsUrl?: string;
  kit: VenueKitSpec;
  documentClass: string;
  classOptions?: string;
  preamble?: string[];
  bibStyle?: string;
  /** The class issues its own \bibliographystyle (sn-jnl); a second one is a BibTeX error. */
  classSetsBibStyle?: boolean;
  /** The kit's own starting document, which becomes the project's main.tex. */
  main?: string;
}

/** Why a kit could not be used. Carries a sentence the user is shown. */
class KitError extends Error {}

const CATEGORIES: TemplateCategory[] = ['Journals', 'Conferences', 'Theses', 'Slides', 'General'];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

// ---------- registry ----------

let registry: { mtimeMs: number; entries: VenueKitEntry[] } | null = null;

/**
 * The registry, reloaded when the file changes on disk. A malformed entry is
 * dropped with a warning rather than taking the whole gallery down with it.
 */
export function venueKits(): VenueKitEntry[] {
  const file = config.venuesFile;
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { mtimeMs = 0; }
  if (registry && registry.mtimeMs === mtimeMs) return registry.entries;
  const entries = mtimeMs ? loadRegistry(file) : [];
  registry = { mtimeMs, entries };
  return entries;
}

export function venueKit(id: string): VenueKitEntry | undefined {
  return venueKits().find((e) => e.id === id);
}

function loadRegistry(file: string): VenueKitEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err: any) {
    console.warn(`venue kits: ${file} is not valid JSON (${err.message}); no fetched venues`);
    return [];
  }
  const list = (raw as { venues?: unknown })?.venues;
  if (!Array.isArray(list)) {
    console.warn(`venue kits: ${file} has no "venues" array; no fetched venues`);
    return [];
  }
  const out: VenueKitEntry[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const problem = entryProblem(item, seen);
    if (problem) {
      console.warn(`venue kits: ignoring entry ${JSON.stringify((item as any)?.id ?? '?')} (${problem})`);
      continue;
    }
    const entry = item as VenueKitEntry;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

/** Why an entry cannot be trusted, or null when it can. */
export function entryProblem(item: unknown, seen: Set<string> = new Set()): string | null {
  const e = item as VenueKitEntry;
  const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
  if (!e || typeof e !== 'object') return 'not an object';
  if (!text(e.id) || !ID_RE.test(e.id)) return 'id must be lower-case letters, digits and dashes';
  if (seen.has(e.id)) return 'duplicate id';
  if (!text(e.name)) return 'no name';
  if (!text(e.description)) return 'no description';
  if (!CATEGORIES.includes(e.category)) return `category must be one of ${CATEGORIES.join(', ')}`;
  if (!https(e.homepage)) return 'homepage must be an https URL';
  if (e.termsUrl !== undefined && !https(e.termsUrl)) return 'termsUrl must be an https URL';
  if (!text(e.documentClass)) return 'no documentClass';
  if (!e.main && !(Array.isArray(e.preamble) && e.preamble.length)) return 'needs either a main file or a preamble';
  const k = e.kit;
  if (!k || typeof k !== 'object') return 'no kit';
  if (!text(k.host)) return 'kit.host must name the host the kit is fetched from';
  const urls = k.url ? [k.url] : k.urls;
  if (!Array.isArray(urls) || !urls.length) return 'kit needs a url or a urls list';
  if (k.url && k.urls) return 'kit has both url and urls';
  for (const u of urls) {
    if (!fetchable(u)) return `kit url ${JSON.stringify(u)} is not https`;
    if (new URL(u).host !== k.host) return `kit url ${JSON.stringify(u)} is not on ${k.host}`;
  }
  if (k.url) {
    if (!Array.isArray(k.take) || !k.take.length) return 'an archive kit needs a take list';
    if (k.take.some((g) => typeof g !== 'string' || !g.trim())) return 'take entries must be non-empty strings';
    if (!k.take.some((g) => !/[*?]/.test(g))) return 'take needs at least one exact file name';
    if (e.main && !k.take.some((g) => matches(g, e.main!))) return `main ${JSON.stringify(e.main)} is not in the take list`;
  }
  for (const [from, to] of Object.entries(k.rename || {})) {
    if (!text(to) || importPath(to) !== to || isHiddenPath(to)) return `rename target ${JSON.stringify(to)} is not a project path`;
    if (!text(from)) return 'rename source must be a path';
  }
  return null;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * https, always. The one exception is a loopback URL under ALDINE_TEST_HOOKS,
 * which is how the unit and e2e suites point a registry at a fixture server
 * that cannot present a certificate; a production server rejects http outright.
 */
function fetchable(u: unknown): boolean {
  if (typeof u !== 'string') return false;
  let url: URL;
  try { url = new URL(u); } catch { return false; }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && process.env.ALDINE_TEST_HOOKS === '1' && LOOPBACK.has(url.hostname);
}

function https(u: unknown): boolean {
  if (typeof u !== 'string') return false;
  try { return new URL(u).protocol === 'https:'; } catch { return false; }
}

// ---------- gallery ----------

/** Every fetched venue as a gallery tile, alphabetical inside its category. */
export function venueKitTemplates(): TemplateInfo[] {
  return venueKits()
    .map((e) => ({
      id: VENUE_PREFIX + e.id,
      name: e.name,
      description: e.description,
      icon: e.icon || '📄',
      category: e.category,
      documentClass: e.documentClass,
      // There is no licence Aldine can assert for a publisher kit: the terms
      // are between the author and the publisher, so link them instead.
      license: 'Publisher terms',
      licenseUrl: e.termsUrl || e.homepage,
      source: { url: e.homepage },
      kit: { host: e.kit.host, url: e.kit.url || e.kit.urls![0], homepage: e.homepage, termsUrl: e.termsUrl },
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- fetching ----------

const ZIP_TYPES = new Set([
  'application/zip', 'application/x-zip-compressed', 'application/x-zip',
  'application/zip-compressed', 'multipart/x-zip',
]);
const TEX_TYPES = new Set([
  'text/x-tex', 'application/x-tex', 'application/x-latex', 'text/tex', 'text/plain',
]);

/** The media type without its parameters: Cell Press answers `application/zip;charset=UTF-8`. */
function mediaType(header: string | null): string {
  return (header || '').split(';')[0].trim().toLowerCase();
}

const mb = (n: number) => Math.round((n / 1024 / 1024) * 10) / 10;

/**
 * One URL's bytes, within the caps. Redirects are followed by hand so that a
 * hop off the entry's host is refused rather than silently followed, which is
 * what keeps a publisher's CDN from becoming an open fetch proxy.
 */
async function getBytes(url: string, host: string, signal: AbortSignal): Promise<{ bytes: Buffer; type: string }> {
  let current = url;
  for (let hop = 0; ; hop++) {
    const u = new URL(current);
    if (!fetchable(current)) throw new KitError(`${u.protocol.replace(':', '')} is not https`);
    if (u.host !== host) throw new KitError(`the download redirected to ${u.host}, which is not ${host}`);
    const res = await fetch(current, {
      redirect: 'manual',
      signal,
      headers: { 'user-agent': USER_AGENT, accept: '*/*' },
    });
    if (res.status >= 300 && res.status < 400) {
      if (hop >= KIT_MAX_REDIRECTS) throw new KitError(`more than ${KIT_MAX_REDIRECTS} redirects`);
      const loc = res.headers.get('location');
      await res.body?.cancel().catch(() => undefined);
      if (!loc) throw new KitError(`HTTP ${res.status} without a location header`);
      current = new URL(loc, current).toString();
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new KitError(`HTTP ${res.status}`);
    }
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > KIT_MAX_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      throw new KitError(`the kit is ${mb(declared)} MB; the limit is ${mb(KIT_MAX_BYTES)} MB`);
    }
    return { bytes: await readCapped(res), type: mediaType(res.headers.get('content-type')) };
  }
}

/** Reads the body, stopping at the cap: a server may lie about content-length or omit it. */
async function readCapped(res: Response): Promise<Buffer> {
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const chunks: Buffer[] = [];
  let total = 0;
  let over = false;
  // Breaking out of the loop is what closes the connection: cancelling a
  // stream the iterator holds is a TypeError, and the download would run on.
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > KIT_MAX_BYTES) { over = true; break; }
    chunks.push(Buffer.from(chunk));
  }
  if (over) throw new KitError(`the kit is larger than the ${mb(KIT_MAX_BYTES)} MB limit`);
  return Buffer.concat(chunks);
}

// ---------- unpacking ----------

/** Archive junk that is never part of a kit. */
function isJunk(name: string): boolean {
  const segs = name.split('/');
  if (segs.includes('__MACOSX')) return true;
  const base = segs[segs.length - 1];
  return base === '.DS_Store' || base.startsWith('._') || base === 'Thumbs.db';
}

/** The directory prefix every entry shares, so a kit nested in one folder
 *  seeds the project the way a flat kit does. */
function commonDir(names: string[]): string {
  if (!names.length) return '';
  let prefix = names[0].split('/').slice(0, -1);
  for (const n of names.slice(1)) {
    const segs = n.split('/').slice(0, -1);
    let i = 0;
    while (i < prefix.length && i < segs.length && prefix[i] === segs[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix.length) break;
  }
  return prefix.length ? `${prefix.join('/')}/` : '';
}

/** `*` stops at a slash, `**` does not, and a leading `**\/` also matches depth zero. */
function globToRe(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** A glob with no slash names a file at any depth; one with a slash names a path. */
function matches(glob: string, rel: string): boolean {
  const re = globToRe(glob);
  return glob.includes('/') ? re.test(rel) : re.test(rel.split('/').pop()!);
}

/**
 * The files the entry names, keyed by their project path. Anything importPath
 * rejects never gets here, and a kit missing a file the entry names by exact
 * name is a failure: seeding half a kit produces a project that cannot
 * typeset and does not say why.
 */
export function selectKitFiles(archive: Record<string, Buffer>, spec: VenueKitSpec): Record<string, Buffer> {
  const usable: [string, Buffer][] = [];
  for (const [name, data] of Object.entries(archive)) {
    if (name.endsWith('/') || isJunk(name)) continue;
    const norm = importPath(name);
    if (norm === null || isHiddenPath(norm)) continue;
    usable.push([norm, data]);
  }
  usable.sort((a, b) => a[0].localeCompare(b[0]));
  const prefix = commonDir(usable.map(([n]) => n));
  const take = spec.take || [];
  const out: Record<string, Buffer> = {};
  const matched = new Set<string>();
  for (const [name, data] of usable) {
    const rel = name.slice(prefix.length);
    if (!rel) continue;
    const glob = take.find((g) => matches(g, rel));
    if (!glob) continue;
    matched.add(glob);
    const target = projectPath(spec, spec.flatten ? rel.split('/').pop()! : rel);
    // Sorted order makes a collision (two `bst/x.bst` flattened onto one name)
    // resolve the same way on every machine. Own-property test: `'constructor'
    // in out` is true before any file has been placed, and the kit file named
    // that would be dropped without a word.
    if (!Object.prototype.hasOwnProperty.call(out, target)) out[target] = data;
  }
  const missing = take.filter((g) => !/[*?]/.test(g) && !matched.has(g));
  if (missing.length) throw new KitError(`the archive has no ${missing.join(', ')}`);
  return out;
}

function projectPath(spec: VenueKitSpec, rel: string): string {
  // Own-property lookup: the key comes from the archive, and a bare index read
  // answers an entry named "constructor" with something off Object.prototype.
  const own = (key: string) => (spec.rename && Object.prototype.hasOwnProperty.call(spec.rename, key) ? spec.rename[key] : undefined);
  const renamed = own(rel) ?? own(rel.split('/').pop()!) ?? rel;
  const norm = importPath(renamed);
  if (norm === null || isHiddenPath(norm)) throw new KitError(`the kit names a file Aldine cannot place (${rel})`);
  return norm;
}

async function downloadKit(entry: VenueKitEntry): Promise<Record<string, Buffer>> {
  const signal = AbortSignal.timeout(KIT_TIMEOUT_MS);
  const spec = entry.kit;
  if (spec.urls) {
    const out: Record<string, Buffer> = {};
    for (const url of spec.urls) {
      const { bytes, type } = await getBytes(url, spec.host, signal);
      // A missing content type is a failure here too: a proxy that strips it
      // off an error page would otherwise seed that page as the kit.
      if (!TEX_TYPES.has(type) && !ZIP_TYPES.has(type)) {
        throw new KitError(`${url} answered ${type || 'no content type'}, which is not a LaTeX file`);
      }
      out[projectPath(spec, path.posix.basename(new URL(url).pathname))] = bytes;
    }
    return out;
  }
  const { bytes, type } = await getBytes(spec.url!, spec.host, signal);
  if (!ZIP_TYPES.has(type)) throw new KitError(`the download answered ${type || 'no content type'}, which is not a zip`);
  let archive: Record<string, Buffer>;
  try {
    archive = unzip(bytes);
  } catch (err: any) {
    throw new KitError(`the archive could not be read (${err.message})`);
  }
  return selectKitFiles(archive, spec);
}

// ---------- cache ----------

function kitCacheDir(id: string): string {
  return path.join(config.cacheDir, 'venue-kits', id);
}

interface CachedKit { files: Record<string, Buffer>; fetchedAt: number }

/** What the registry says the kit is. A cache written before the entry changed
 *  its URL, take list or renames holds last year's files, which no longer match
 *  the preamble the skeleton writes: a different fingerprint is a cache miss. */
function kitFingerprint(entry: VenueKitEntry): string {
  const k = entry.kit;
  return JSON.stringify({ url: k.url ?? null, urls: k.urls ?? null, take: k.take ?? null, rename: k.rename ?? null, flatten: !!k.flatten });
}

function readKitCache(entry: VenueKitEntry): CachedKit | null {
  const id = entry.id;
  const dir = kitCacheDir(id);
  let stamp: { fetchedAt?: number; spec?: string };
  try { stamp = JSON.parse(fs.readFileSync(path.join(dir, 'kit.json'), 'utf8')); } catch { return null; }
  if (stamp.spec !== kitFingerprint(entry)) return null;
  const root = path.join(dir, 'files');
  const files: Record<string, Buffer> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else files[r] = fs.readFileSync(path.join(root, r));
    }
  };
  try { walk(''); } catch { return null; }
  if (!Object.keys(files).length) return null;
  return { files, fetchedAt: Number(stamp.fetchedAt) || 0 };
}

function writeKitCache(entry: VenueKitEntry, files: Record<string, Buffer>): void {
  const dir = kitCacheDir(entry.id);
  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
  try {
    for (const [rel, data] of Object.entries(files)) {
      const abs = path.join(tmp, 'files', rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, data);
    }
    fs.writeFileSync(path.join(tmp, 'kit.json'), JSON.stringify({
      id: entry.id, url: entry.kit.url || entry.kit.urls, spec: kitFingerprint(entry),
      fetchedAt: Date.now(), files: Object.keys(files).sort(),
    }, null, 2));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.renameSync(tmp, dir);
  } catch (err: any) {
    // A cache that cannot be written is a slower gallery, not a failure.
    console.warn(`venue kits: could not cache ${entry.id} (${err.message})`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- seeding ----------

export interface VenueKitStatus {
  id: string;
  name: string;
  host: string;
  url: string;
  ok: boolean;
  /** Why the kit could not be downloaded; only when ok is false. */
  reason?: string;
}

export interface VenueKitSeed {
  files: Record<string, Buffer>;
  venueKit: VenueKitStatus;
}

/** One download per venue at a time, however many projects are being created. */
const inflight = new Map<string, Promise<Record<string, Buffer>>>();

/**
 * The seed files for a fetched venue. Never throws: a kit that cannot be
 * downloaded, read, or does not carry the files the registry names produces
 * the generated skeleton plus README-venue.md, and `venueKit.ok` is false so
 * the caller can say so.
 */
export async function venueKitSeed(entry: VenueKitEntry): Promise<VenueKitSeed> {
  const url = entry.kit.url || entry.kit.urls![0];
  const status = (ok: boolean, reason?: string): VenueKitStatus =>
    ({ id: entry.id, name: entry.name, host: entry.kit.host, url, ok, ...(reason ? { reason } : {}) });

  const cached = readKitCache(entry);
  if (cached && Date.now() - cached.fetchedAt < KIT_CACHE_TTL_MS) {
    // A cache that cannot seed a project is a miss, not a failed creation.
    try { return { files: kitProject(entry, cached.files), venueKit: status(true) }; } catch { /* refetch */ }
  }
  try {
    let pending = inflight.get(entry.id);
    if (!pending) {
      pending = downloadKit(entry).finally(() => inflight.delete(entry.id));
      inflight.set(entry.id, pending);
    }
    const kit = await pending;
    const files = kitProject(entry, kit);
    writeKitCache(entry, kit);
    return { files, venueKit: status(true) };
  } catch (err: any) {
    // Whatever its age: a kit that was good last week beats a skeleton that
    // does not carry the venue's class at all.
    const stale = cached ?? readKitCache(entry);
    if (stale) {
      try { return { files: kitProject(entry, stale.files), venueKit: status(true) }; } catch { /* the skeleton, then */ }
    }
    const network = err?.cause?.code || err?.code;
    const reason = safeReason(err?.name === 'TimeoutError' || err?.name === 'AbortError'
      ? `it did not answer within ${KIT_TIMEOUT_MS / 1000} seconds`
      : network === 'ENOTFOUND' || network === 'EAI_AGAIN'
        ? `${entry.kit.host} could not be resolved`
        : network === 'ECONNREFUSED' || network === 'ECONNRESET' || network === 'EHOSTUNREACH'
          ? `${entry.kit.host} could not be reached`
          : String(err?.message || err) === 'fetch failed'
            ? `${entry.kit.host} could not be reached`
            : String(err?.message || err));
    return { files: fallbackFiles(entry, reason), venueKit: status(false, reason) };
  }
}

/**
 * One line of plain text. A failure sentence quotes the publisher's own bytes
 * (a ZIP entry name reaches the ZipError message verbatim), and it is written
 * into a LaTeX comment in main.tex: a newline there would close the comment and
 * run the rest as LaTeX in a document the compiler is about to typeset.
 */
function safeReason(text: string): string {
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > 200 ? `${clean.slice(0, 197)}...` : clean;
}

/**
 * Kit files as a project seed, refused when they are not one. The ZIP reader's
 * caps (40 MB per entry, 200 MB inflated) are not a project's: every other seed
 * goes through seedError, and a kit that skipped those limits would fail inside
 * createProject, which is a 500 and no project rather than the skeleton this
 * module promises.
 */
function kitProject(entry: VenueKitEntry, kit: Record<string, Buffer>): Record<string, Buffer> {
  const files = projectFiles(entry, kit);
  const bad = kitSeedProblem(files);
  if (bad) throw new KitError(`the kit cannot seed a project (${bad})`);
  return files;
}

/** Why an assembled kit cannot be written to a fresh project, or null. */
export function kitSeedProblem(files: Record<string, Buffer>): string | null {
  const names = Object.keys(files);
  if (names.length > SEED_MAX_FILES) return `it has ${names.length} files; the limit is ${SEED_MAX_FILES}`;
  let total = 0;
  for (const name of names) total += files[name].length;
  if (total > SEED_MAX_BYTES) return `it is ${mb(total)} MB unpacked; the limit is ${mb(SEED_MAX_BYTES)} MB`;
  // The publisher's own entry names: one past NAME_MAX is ENAMETOOLONG inside
  // createProject, and this module owes the caller a skeleton, not a 500.
  for (const name of names) {
    const tooLong = overlongPath(name);
    if (tooLong) return `it has ${tooLong}`;
  }
  // createProject writes the seed and then `.gitignore`: a name that is both a
  // file and a directory fails halfway through, with the project half written.
  const taken = new Set([...names, '.gitignore']);
  for (const name of names) {
    const segs = name.split('/');
    for (let i = 1; i < segs.length; i++) {
      const dir = segs.slice(0, i).join('/');
      if (taken.has(dir)) return `"${dir}" is both a file and a directory`;
    }
  }
  return null;
}

/**
 * Kit files as a project: the kit's own starting document becomes main.tex,
 * which is the root file createProject picks and the name every other route
 * assumes.
 */
function projectFiles(entry: VenueKitEntry, kit: Record<string, Buffer>): Record<string, Buffer> {
  const out: Record<string, Buffer> = { ...kit };
  if (entry.main) {
    const key = Object.prototype.hasOwnProperty.call(out, entry.main)
      ? entry.main
      : Object.keys(out).find((k) => k.split('/').pop() === entry.main);
    if (key) {
      const doc = out[key];
      delete out[key];
      out['main.tex'] = doc;
      return out;
    }
  }
  // A kit with no starting document (or one the take list missed) still gives
  // the class; the skeleton loads it.
  out['main.tex'] = Buffer.from(skeleton(entry), 'utf8');
  if (!Object.keys(out).some((f) => f.endsWith('.bib'))) out['references.bib'] = Buffer.from(REFERENCES_BIB, 'utf8');
  return out;
}

function fallbackFiles(entry: VenueKitEntry, reason: string): Record<string, Buffer> {
  return {
    'main.tex': Buffer.from(skeleton(entry, reason), 'utf8'),
    'references.bib': Buffer.from(REFERENCES_BIB, 'utf8'),
    'README-venue.md': Buffer.from(readme(entry, reason), 'utf8'),
  };
}

/** Every line prefixed with `%`, so no text a publisher influenced can end the
 *  comment and become live LaTeX. */
function comment(text: string): string {
  return text.split(/\r\n|\r|\n/).map((line) => `% ${line}`).join('\n') + '\n';
}

/** The article preamble a failed kit leaves behind, with the venue's own lines
 *  commented out. A style-file venue already stands on article, so its
 *  \documentclass line is stock article and stays live, class options and all:
 *  only the \usepackage lines the kit would bring are waiting on it. */
function fallbackHead(entry: VenueKitEntry, classLine: string, preamble: string[]): string {
  if (entry.documentClass === 'article') {
    const waiting = preamble.length
      ? comment("Once the kit's files are in this project, uncomment the line it brings:") + comment(preamble.join('\n'))
      : '';
    return `${classLine}\n` + waiting;
  }
  return comment("Once the kit's files are in this project, swap article for the class it ships:")
    + comment([classLine, ...preamble].join('\n'))
    + '\\documentclass{article}\n';
}

/** A starting document for the venue, in the plain article shape. */
export function skeleton(entry: VenueKitEntry, failure?: string): string {
  const url = entry.kit.url || entry.kit.urls![0];
  const notice = failure
    ? comment(`${entry.name} starting point, generated by Aldine.\n`
      + `The official kit could not be downloaded from ${entry.kit.host} (${failure}),\n`
      + `so this project does not carry the venue's class yet. Get it from\n`
      + `${url} and add its .cls, .sty and .bst files here; see README-venue.md.`)
    : comment(`${entry.name} starting point, generated by Aldine from the official kit.\n`
      + `Check the venue's author guide for the options and sections it requires:\n`
      + `${entry.homepage}`);
  const classLine = `\\documentclass${entry.classOptions ? `[${entry.classOptions}]` : ''}{${entry.documentClass}}`;
  const preamble = entry.preamble || [];
  // Without the kit, the venue's class and style are exactly what this project
  // does not have: naming either is a fatal error on the first typeset of a
  // brand new project. Stand on article, which every image carries, and keep
  // the venue's real lines as a comment to swap in once the files are here.
  const head = failure ? fallbackHead(entry, classLine, preamble) : `${classLine}\n${preamble.map((line) => `${line}\n`).join('')}`;
  // The venue's bib style ships with the kit, so a failed kit has plain and
  // nothing else; classSetsBibStyle only holds for the venue's own class.
  const bib = failure
    ? '\\bibliographystyle{plain}\n\\bibliography{references}\n'
    : entry.classSetsBibStyle
      ? '\\bibliography{references}\n'
      : `\\bibliographystyle{${entry.bibStyle || 'plain'}}\n\\bibliography{references}\n`;
  return notice + head
    + '\n\\title{Your title here}\n\\author{Your Name}\n\\date{\\today}\n'
    + '\n\\begin{document}\n\\maketitle\n\n'
    + '\\begin{abstract}\nA one-paragraph summary of the problem, your approach, and the headline result.\n\\end{abstract}\n\n'
    + '\\section{Introduction}\nState the problem and why it matters. Cite prior work like this~\\cite{knuth1984}.\n\n'
    + bib
    + '\n\\end{document}\n';
}

function readme(entry: VenueKitEntry, reason: string): string {
  const url = entry.kit.url || entry.kit.urls!.join('\n  ');
  return `# ${entry.name} kit\n\n`
    + `Aldine could not download the official ${entry.name} kit while creating this\n`
    + `project, so \`main.tex\` is a skeleton and the venue's class files are missing.\n\n`
    + `- Kit: ${url}\n`
    + `- Why it failed: ${reason}\n`
    + `- Author guide: ${entry.homepage}\n`
    + (entry.termsUrl ? `- The venue's terms: ${entry.termsUrl}\n` : '')
    + `\n## What to do\n\n`
    + `1. Download the kit yourself from the link above.\n`
    + `2. Add its \`.cls\`, \`.sty\` and \`.bst\` files to this project (drag them into the\n`
    + `   file tree, or import the zip from the projects page).\n`
    + `3. Typeset. \`main.tex\` stands on \`article\` until then; the venue's own\n`
    + `   lines sit at the top of the file as a comment, ready to swap in.\n\n`
    + `Aldine does not redistribute publisher files. The kit's terms are between you\n`
    + `and the publisher.\n`;
}
