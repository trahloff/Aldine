import fs from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { config } from './config.js';
import { injectToken, stripCreds } from './gitops.js';
import { scanTemplateDir, templateFilesIn, type TemplateInfo } from './templates.js';

/**
 * Template repositories: git repositories laid out like this repo's
 * `templates/` folder (one directory per template, a `template.json` inside),
 * listed by the operator in TEMPLATE_REPOS. Each is cloned shallowly into
 * CACHE_DIR/template-repos/<id> and refreshed on a timer or on request; the
 * gallery lists whatever the last good checkout holds, so a host that is down
 * degrades to "stale", never to "gone".
 *
 * Tokens: TEMPLATE_REPOS names an env var per repository, the token goes
 * into the URL for one git operation at a time and never into .git/config
 * (CACHE_DIR is readable by the compiler in some deployments).
 */

export const REPO_PREFIX = 'repo:';

export interface TemplateRepoEntry {
  id: string;
  label: string;
  url: string;
  /** Branch, tag or `HEAD` (the remote's default branch). */
  ref: string;
  /** Directory inside the repository holding the template folders; '' for the root. */
  path: string;
  /** Env var holding a read token for a private repository. */
  tokenEnv?: string;
  /** Basic-auth user the host expects with that token: `oauth2` (GitLab), `x-access-token` (GitHub). */
  user: string;
}

export interface TemplateRepoState {
  id: string;
  label: string;
  /** The last sync succeeded. False with `error` set once a sync failed; the previous checkout stays listed. */
  ok: boolean;
  /** A checkout exists, so templates are listed even when the last refresh failed. */
  available: boolean;
  head?: string;
  syncedAt?: string;
  error?: string;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const DEFAULT_REFRESH_MS = 600_000;
const MIN_REFRESH_MS = 60_000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

export function refreshIntervalMs(): number {
  const n = Number(process.env.TEMPLATE_REPOS_REFRESH_MS || DEFAULT_REFRESH_MS);
  return Number.isFinite(n) && n > 0 ? Math.max(n, MIN_REFRESH_MS) : DEFAULT_REFRESH_MS;
}
export function maxCheckoutBytes(): number {
  const n = Number(process.env.TEMPLATE_REPO_MAX_BYTES || DEFAULT_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

/**
 * https, always. Under ALDINE_TEST_HOOKS a loopback http URL and a file://
 * URL are accepted too, so the tests can serve a bare repo from disk.
 */
export function fetchableRepoUrl(u: unknown): boolean {
  if (typeof u !== 'string') return false;
  let url: URL;
  try { url = new URL(u); } catch { return false; }
  if (url.protocol === 'https:') return true;
  if (process.env.ALDINE_TEST_HOOKS !== '1') return false;
  if (url.protocol === 'file:') return true;
  return url.protocol === 'http:' && LOOPBACK.has(url.hostname);
}

/** Why a TEMPLATE_REPOS entry cannot be used, or null when it is fine. */
export function entryProblem(item: unknown, seen: Set<string> = new Set()): string | null {
  if (!item || typeof item !== 'object') return 'entry is not an object';
  const e = item as Record<string, unknown>;
  if (typeof e.id !== 'string' || !ID_RE.test(e.id)) return `id must match ${ID_RE} (got ${JSON.stringify(e.id)})`;
  if (seen.has(e.id)) return `duplicate id "${e.id}"`;
  if (e.label !== undefined && (typeof e.label !== 'string' || !e.label.trim())) return `"${e.id}": label must be a non-empty string`;
  if (!fetchableRepoUrl(e.url)) return `"${e.id}": url must be an https:// git URL`;
  if (e.ref !== undefined && (typeof e.ref !== 'string' || !e.ref.trim() || /[\s~^:?*[\\]|\.\./.test(e.ref) || e.ref.startsWith('-'))) return `"${e.id}": ref must be a branch or tag name`;
  if (e.path !== undefined && (typeof e.path !== 'string' || e.path.split('/').some((s) => s === '..') || path.posix.isAbsolute(e.path))) return `"${e.id}": path must be a relative directory inside the repository`;
  if (e.tokenEnv !== undefined && (typeof e.tokenEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(e.tokenEnv))) return `"${e.id}": tokenEnv must name an environment variable`;
  if (e.user !== undefined && (typeof e.user !== 'string' || !e.user.trim())) return `"${e.id}": user must be a non-empty string`;
  return null;
}

function normalize(e: Record<string, unknown>): TemplateRepoEntry {
  return {
    id: e.id as string,
    label: (e.label as string | undefined)?.trim() || (e.id as string),
    url: e.url as string,
    ref: (e.ref as string | undefined)?.trim() || 'HEAD',
    path: ((e.path as string | undefined) || '').replace(/^\.\/+/, '').replace(/^\/+|\/+$/g, ''),
    tokenEnv: e.tokenEnv as string | undefined,
    user: (e.user as string | undefined)?.trim() || 'oauth2',
  };
}

let entries: TemplateRepoEntry[] | null = null;

/** Parse TEMPLATE_REPOS (JSON array) or TEMPLATE_REPOS_FILE once; a bad entry is logged and skipped. */
export function loadTemplateRepos(): TemplateRepoEntry[] {
  if (entries) return entries;
  let raw = process.env.TEMPLATE_REPOS || '';
  if (!raw && process.env.TEMPLATE_REPOS_FILE) {
    try { raw = fs.readFileSync(process.env.TEMPLATE_REPOS_FILE, 'utf8'); }
    catch (err: any) { console.warn(`[templates] TEMPLATE_REPOS_FILE unreadable: ${err.message}`); }
  }
  entries = [];
  if (!raw.trim()) return entries;
  let list: unknown;
  try { list = JSON.parse(raw); } catch (err: any) { console.warn(`[templates] TEMPLATE_REPOS is not valid JSON: ${err.message}`); return entries; }
  if (!Array.isArray(list)) { console.warn('[templates] TEMPLATE_REPOS must be a JSON array'); return entries; }
  const seen = new Set<string>();
  for (const item of list) {
    const problem = entryProblem(item, seen);
    if (problem) { console.warn(`[templates] TEMPLATE_REPOS entry skipped: ${problem}`); continue; }
    const e = normalize(item as Record<string, unknown>);
    seen.add(e.id);
    entries.push(e);
  }
  return entries;
}

/** Tests reconfigure the list between cases. */
export function resetTemplateRepos(): void {
  entries = null;
  states.clear();
  inflight.clear();
}

export function templateRepo(id: string): TemplateRepoEntry | undefined {
  return loadTemplateRepos().find((e) => e.id === id);
}

export function templateRepoDir(id: string): string {
  if (!ID_RE.test(id)) throw new Error('bad template repo id');
  return path.join(config.cacheDir, 'template-repos', id);
}

/**
 * A directory inside the checkout, resolved through symlinks, or null when it
 * does not exist or escapes the checkout. Git preserves symlinks in a working
 * tree, so a repository can ship `thesis -> ../../..`; every path this module
 * reads is confirmed to still be under the checkout after resolution.
 */
function insideCheckout(entry: TemplateRepoEntry, rel: string): string | null {
  const checkout = templateRepoDir(entry.id);
  let root: string, target: string;
  try {
    root = fs.realpathSync(checkout);
    target = fs.realpathSync(rel ? path.join(checkout, rel) : checkout);
  } catch { return null; }
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

/** The directory the template folders live in: the checkout, or `path` inside it. Null when absent or escaping. */
function templatesRoot(entry: TemplateRepoEntry): string | null {
  return insideCheckout(entry, entry.path);
}

/** Bytes of every blob in `rev`, from the object store: known before the working tree is touched. */
async function treeBytes(dir: string, rev: string): Promise<number> {
  const out = await simpleGit({ baseDir: dir }).raw(['ls-tree', '-r', '-l', rev]);
  let total = 0;
  for (const line of out.split('\n')) {
    const m = /^\d+ blob \S+\s+(\d+)\t/.exec(line);
    if (m) total += Number(m[1]);
  }
  return total;
}

function tokenUrl(entry: TemplateRepoEntry): string {
  const token = entry.tokenEnv ? process.env[entry.tokenEnv] : undefined;
  return token ? injectToken(entry.url, entry.user, token) : entry.url;
}

/** Bytes under `dir`, .git excluded. Stops counting once `limit` is passed. */
export function checkoutBytes(dir: string, limit = Infinity): number {
  let total = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (total > limit) return;
      if (e.name === '.git') continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) total += fs.statSync(abs).size;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return total;
}

const states = new Map<string, TemplateRepoState>();
const inflight = new Map<string, Promise<TemplateRepoState>>();
/** Failure streaks log once, not once per interval. */
const failing = new Set<string>();

function stateOf(entry: TemplateRepoEntry): TemplateRepoState {
  let s = states.get(entry.id);
  if (!s) {
    s = { id: entry.id, label: entry.label, ok: false, available: fs.existsSync(path.join(templateRepoDir(entry.id), '.git')) };
    states.set(entry.id, s);
  }
  return s;
}

async function doSync(entry: TemplateRepoEntry): Promise<TemplateRepoState> {
  const s = stateOf(entry);
  const dir = templateRepoDir(entry.id);
  const url = tokenUrl(entry);
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      const args = ['--depth', '1', '--single-branch', ...(entry.ref !== 'HEAD' ? ['--branch', entry.ref] : [])];
      await simpleGit().clone(url, dir, args);
      await simpleGit({ baseDir: dir }).remote(['set-url', 'origin', stripCreds(entry.url)]); // never persist the token
    } else {
      const g = simpleGit({ baseDir: dir });
      await g.raw(['fetch', '--depth', '1', url, entry.ref]);
      // Size the incoming tree from the object store first: the previous good
      // checkout stays in place when the new revision is over the cap.
      const incoming = await treeBytes(dir, 'FETCH_HEAD');
      if (incoming > maxCheckoutBytes()) throw new Error(`the new revision exceeds TEMPLATE_REPO_MAX_BYTES (${maxCheckoutBytes()} bytes); keeping the previous checkout`);
      await g.raw(['reset', '--hard', 'FETCH_HEAD']);
      await g.raw(['clean', '-fdq']);
    }
    const limit = maxCheckoutBytes();
    if (checkoutBytes(dir, limit) > limit) {
      // Only a first clone can get here (a refresh was sized before the reset).
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error(`checkout exceeds TEMPLATE_REPO_MAX_BYTES (${limit} bytes)`);
    }
    s.head = (await simpleGit({ baseDir: dir }).revparse(['HEAD'])).trim();
    s.ok = true;
    s.available = true;
    s.syncedAt = new Date().toISOString();
    delete s.error;
    if (failing.delete(entry.id)) console.log(`[templates] repository "${entry.id}" is reachable again`);
  } catch (err: any) {
    s.ok = false;
    s.available = fs.existsSync(path.join(dir, '.git'));
    // git prints the URL it was given, token included, in its errors
    s.error = String(err?.message || err).replace(/\/\/[^@/\s]+@/g, '//').split('\n')[0].slice(0, 300);
    if (!failing.has(entry.id)) {
      failing.add(entry.id);
      console.warn(`[templates] repository "${entry.id}" could not be refreshed: ${s.error}${s.available ? ' (serving the previous checkout)' : ''}`);
    }
  }
  return { ...s };
}

/** Sync one repository; a sync already running for it is joined, not doubled. */
export function syncTemplateRepo(entry: TemplateRepoEntry): Promise<TemplateRepoState> {
  let p = inflight.get(entry.id);
  if (!p) {
    p = doSync(entry).finally(() => inflight.delete(entry.id));
    inflight.set(entry.id, p);
  }
  return p;
}

export function syncAllTemplateRepos(): Promise<TemplateRepoState[]> {
  return Promise.all(loadTemplateRepos().map(syncTemplateRepo));
}

export function templateRepoStates(): TemplateRepoState[] {
  return loadTemplateRepos().map((e) => ({ ...stateOf(e) }));
}

let timer: NodeJS.Timeout | null = null;

/** Boot: sync every repository without blocking listen, then keep refreshing. */
export function startTemplateRepoRefresh(): void {
  const list = loadTemplateRepos();
  if (!list.length || timer) return;
  void syncAllTemplateRepos();
  timer = setInterval(() => { void syncAllTemplateRepos(); }, refreshIntervalMs());
  timer.unref();
}

export function stopTemplateRepoRefresh(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Every template in every checkout, ids `repo:<id>/<folder>`. Repositories without a checkout list nothing. */
export function listRepoTemplates(): TemplateInfo[] {
  const out: TemplateInfo[] = [];
  for (const entry of loadTemplateRepos()) {
    const root = templatesRoot(entry);
    if (!root) continue;
    // A folder that resolves outside the checkout (a symlink in the repository) is not a template.
    const inside = (name: string) => !!insideCheckout(entry, entry.path ? `${entry.path}/${name}` : name);
    out.push(...scanTemplateDir(root, { idPrefix: `${REPO_PREFIX}${entry.id}/`, source: { kind: 'repo', label: entry.label }, accept: inside }));
  }
  return out;
}

/** Files of `repo:<id>/<folder>`; the folder must be a direct child of the templates root. */
export function repoTemplateFiles(id: string): Record<string, Buffer> {
  const rest = id.slice(REPO_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) throw new Error('bad template id');
  const repoId = rest.slice(0, slash);
  const folder = rest.slice(slash + 1);
  if (!folder || folder.includes('/') || folder.includes('..') || folder.startsWith('.') || folder.includes('\\')) throw new Error('bad template id');
  const entry = templateRepo(repoId);
  if (!entry) throw new Error(`unknown template repository: ${repoId}`);
  const base = insideCheckout(entry, entry.path ? `${entry.path}/${folder}` : folder);
  if (!base) throw new Error(`unknown template: ${id}`);
  return templateFilesIn(base, id);
}
