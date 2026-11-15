import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db/index.js';
import { injectToken, stripCreds } from './gitops.js';
import { isBlockedAddress } from './oauth/cimd.js';
import * as remotes from './remotes.js';
import { git } from './store.js';
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
 *
 * Personal repositories: an account can add its own (Account settings), up
 * to ALDINE_PERSONAL_TEMPLATE_REPOS of them. They are kept in the account's
 * connections row, run through the same sync, size cap and previews, and
 * have ids `~<owner hash>-<id>`, which no TEMPLATE_REPOS id can take. Only
 * the owner is shown their templates or can seed a project from them
 * (`templateVisibleTo`); a private one is read with the owner's git host
 * connection for that host. The URL is the user's choice, not the
 * operator's, so a host that resolves to a private address is refused unless
 * the account connected that host, and git follows no redirect.
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
  /** Account id of a personal repository; absent for TEMPLATE_REPOS entries. */
  owner?: string;
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
  /** A personal repository of the account that asked. */
  personal?: true;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
/** `~` + 12 hex of the owner + `-` + the id the account sees. */
const PERSONAL_ID_RE = /^~[0-9a-f]{12}-[a-z0-9][a-z0-9-]{0,19}$/;
const SHORT_ID_RE = /^[a-z0-9][a-z0-9-]{0,19}$/;
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
  personal.clear();
  attempted.clear();
  states.clear();
  inflight.clear();
}

export function templateRepo(id: string): TemplateRepoEntry | undefined {
  return loadTemplateRepos().find((e) => e.id === id) ?? personal.get(id);
}

export function templateRepoDir(id: string): string {
  if (!ID_RE.test(id) && !PERSONAL_ID_RE.test(id)) throw new Error('bad template repo id');
  return path.join(config.cacheDir, 'template-repos', id);
}

/**
 * A path inside the checkout, resolved through symlinks, or null when it
 * does not exist or escapes the checkout. A checkout cloned before git ran
 * with core.symlinks=false can hold a link such as `thesis -> ../../..`;
 * every path this module reads is confirmed to still be under the checkout
 * after resolution.
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
  const out = await git(dir).raw(['ls-tree', '-r', '-l', rev]);
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
  const before = s.head;
  const dir = templateRepoDir(entry.id);
  try {
    const url = entry.owner ? await personalFetchUrl(entry) : tokenUrl(entry);
    // A redirect would take a personal URL to a host the check never saw.
    const noRedirect = entry.owner ? ['-c', 'http.followRedirects=false'] : [];
    if (!fs.existsSync(path.join(dir, '.git'))) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      const args = ['--depth', '1', '--single-branch', ...(entry.ref !== 'HEAD' ? ['--branch', entry.ref] : [])];
      await git(path.dirname(dir)).raw([...noRedirect, 'clone', ...args, '--', url, dir]);
      await git(dir).remote(['set-url', 'origin', stripCreds(entry.url)]); // never persist the token
    } else {
      const g = git(dir);
      await g.raw([...noRedirect, 'fetch', '--depth', '1', url, entry.ref]);
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
    s.head = (await git(dir).revparse(['HEAD'])).trim();
    s.ok = true;
    s.available = true;
    s.syncedAt = new Date().toISOString();
    delete s.error;
    if (failing.delete(entry.id)) console.log(`[templates] repository "${entry.id}" is reachable again`);
    for (const fn of syncListeners) {
      try { fn(entry.id, s.head !== before); } catch (err) { console.warn('[templates] sync listener failed', err); }
    }
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

const syncListeners = new Set<(repoId: string, headMoved: boolean) => void>();

/**
 * Called after every successful sync of a repository, with its id and
 * whether HEAD differs from the last sync in this process (always true on
 * the first).
 */
export function onTemplateRepoSynced(fn: (repoId: string, headMoved: boolean) => void): () => void {
  syncListeners.add(fn);
  return () => syncListeners.delete(fn);
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

/**
 * Templates in the checkouts, ids `repo:<id>/<folder>`: every TEMPLATE_REPOS
 * repository, plus the personal ones of `viewer`, or of everyone with `all`
 * (previews only, never a response). Repositories without a checkout list
 * nothing.
 */
export function listRepoTemplates(opts: { viewer?: string | null; all?: boolean } = {}): TemplateInfo[] {
  const out: TemplateInfo[] = [];
  const mine = [...personal.values()].filter((e) => opts.all || (!!opts.viewer && e.owner === opts.viewer));
  for (const entry of [...loadTemplateRepos(), ...mine]) {
    const root = templatesRoot(entry);
    if (!root) continue;
    // A folder or manifest that resolves outside the checkout (a symlink in the repository) is not a template.
    const inside = (name: string) => {
      const folder = entry.path ? `${entry.path}/${name}` : name;
      return !!insideCheckout(entry, folder) && !!insideCheckout(entry, `${folder}/template.json`);
    };
    const source = entry.owner ? { kind: 'repo' as const, label: entry.label, personal: true as const } : { kind: 'repo' as const, label: entry.label };
    out.push(...scanTemplateDir(root, { idPrefix: `${REPO_PREFIX}${entry.id}/`, source, accept: inside }));
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

// ---- personal repositories ----

/** Key of the account's list in the connections store; no git host provider has this id. */
const PERSONAL_KEY = 'template-repos';
const DEFAULT_PERSONAL_MAX = 5;
/** Loaded personal entries by repository id, for whichever accounts asked since boot. */
const personal = new Map<string, TemplateRepoEntry>();

/** How many repositories an account may add; 0 turns the feature off. */
export function personalLimit(): number {
  const raw = process.env.ALDINE_PERSONAL_TEMPLATE_REPOS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_PERSONAL_MAX;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_PERSONAL_MAX;
}

export function ownerHash(userId: string): string {
  return crypto.createHash('sha256').update(userId).digest('hex').slice(0, 12);
}

const personalId = (owner: string, shortId: string) => `~${ownerHash(owner)}-${shortId}`;
export const isPersonalRepoId = (id: string) => PERSONAL_ID_RE.test(id);

/** What the connections row holds per repository. */
interface StoredRepo { id: string; label: string; url: string; ref: string; path: string }

function storedOf(raw: unknown): StoredRepo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !SHORT_ID_RE.test(r.id) || typeof r.url !== 'string') return null;
  if (entryProblem({ id: r.id, label: r.label, url: r.url, ref: r.ref, path: r.path })) return null;
  const n = normalize({ id: r.id, label: r.label, url: r.url, ref: r.ref, path: r.path });
  return { id: n.id, label: n.label, url: n.url, ref: n.ref, path: n.path };
}

async function readStored(owner: string): Promise<StoredRepo[]> {
  const row = await db().getConnection(owner, PERSONAL_KEY);
  const list = Array.isArray(row?.repos) ? row!.repos as unknown[] : [];
  return list.map(storedOf).filter((r): r is StoredRepo => !!r);
}

async function writeStored(owner: string, list: StoredRepo[]): Promise<void> {
  if (list.length) await db().setConnection(owner, PERSONAL_KEY, { repos: list });
  else await db().deleteConnection(owner, PERSONAL_KEY);
}

function register(owner: string, r: StoredRepo): TemplateRepoEntry {
  const e: TemplateRepoEntry = { id: personalId(owner, r.id), label: r.label, url: r.url, ref: r.ref, path: r.path, user: 'oauth2', owner };
  personal.set(e.id, e);
  return e;
}

/**
 * The account's personal repositories, read from the store and registered
 * for listing, seeding and previews. Empty while the feature is off.
 */
export async function loadPersonalRepos(owner: string): Promise<TemplateRepoEntry[]> {
  for (const [id, e] of personal) if (e.owner === owner) personal.delete(id);
  if (personalLimit() === 0) return [];
  return (await readStored(owner)).map((r) => register(owner, r));
}

/** Whether `viewer` may see and seed from template `id`: anyone for every id but a personal repository's, only its owner for those. */
export function templateVisibleTo(id: string, viewer: string | null | undefined): boolean {
  if (!id.startsWith(REPO_PREFIX)) return true;
  const repoId = id.slice(REPO_PREFIX.length).split('/')[0];
  if (!isPersonalRepoId(repoId)) return true;
  return !!viewer && personalLimit() > 0 && personal.get(repoId)?.owner === viewer;
}

/** The account's git host connection on the URL's host, if it has one and may still act. */
async function hostConnection(owner: string, url: string): Promise<{ provider: remotes.RemoteProvider; conn: remotes.RemoteConnection } | null> {
  if ((await db().getUser(owner))?.disabledAt) return null;
  let origin: string;
  try { origin = new URL(url).origin; } catch { return null; }
  for (const provider of remotes.providers()) {
    const conn = await remotes.getConnection(owner, provider.id);
    if (!conn) continue;
    try { if (provider.instanceOrigin(conn) === origin) return { provider, conn }; } catch { /* a connection without a usable URL */ }
  }
  return null;
}

/**
 * The URL to fetch a personal repository from: with the owner's token for
 * that host when they connected it, else as given, after its host was
 * checked to resolve to public addresses only.
 */
async function personalFetchUrl(entry: TemplateRepoEntry): Promise<string> {
  const hit = await hostConnection(entry.owner!, entry.url);
  if (hit) return hit.provider.tokenUrl(entry.url, hit.conn.token, hit.conn.login);
  const u = new URL(entry.url);
  if (process.env.ALDINE_TEST_HOOKS === '1' && (u.protocol === 'file:' || LOOPBACK.has(u.hostname))) return entry.url;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try { addresses = (await dns.promises.lookup(host, { all: true })).map((a) => a.address); }
  catch { throw new Error(`${u.hostname} could not be resolved`); }
  if (!addresses.length || addresses.some(isBlockedAddress)) {
    throw new Error(`${u.hostname} is a private address. Connect that host under Git hosts first, or ask the operator to add the repository to TEMPLATE_REPOS`);
  }
  return entry.url;
}

/** The id an account sees for a new repository: from its label, made unique. */
function shortIdFor(label: string, taken: Set<string>): string {
  const base = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 16).replace(/-+$/, '') || 'templates';
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

export interface PersonalRepoView {
  /** The id the account sees, unique among its repositories. */
  id: string;
  /** Repository id inside template ids: `repo:<repoId>/<folder>`. */
  repoId: string;
  label: string;
  url: string;
  ref: string;
  path: string;
  ok: boolean;
  available: boolean;
  syncedAt?: string;
  error?: string;
  /** Templates the checkout lists. */
  templates: number;
}

export function personalView(e: TemplateRepoEntry): PersonalRepoView {
  const s = stateOf(e);
  const templates = listRepoTemplates({ viewer: e.owner }).filter((t) => t.id.startsWith(`${REPO_PREFIX}${e.id}/`)).length;
  return {
    id: e.id.slice(e.id.indexOf('-') + 1), repoId: e.id, label: e.label, url: stripCreds(e.url), ref: e.ref, path: e.path,
    ok: s.ok, available: s.available, ...(s.syncedAt ? { syncedAt: s.syncedAt } : {}), ...(s.error ? { error: s.error } : {}), templates,
  };
}

/** Sync states of the account's personal repositories, as the gallery reads them beside the shared ones. */
export function personalStates(owner: string): TemplateRepoState[] {
  return [...personal.values()].filter((e) => e.owner === owner).map((e) => ({ ...stateOf(e), personal: true as const }));
}

/** A user-facing reason the input cannot be added, as an Error. */
export class PersonalRepoError extends Error {}

/**
 * Add a repository to the account's list and clone it. A repository that
 * cannot be cloned, or lists no template, is not kept: the error says why.
 */
export async function addPersonalRepo(owner: string, input: { label?: unknown; url?: unknown; ref?: unknown; path?: unknown }): Promise<PersonalRepoView> {
  const max = personalLimit();
  if (max === 0) throw new PersonalRepoError('Personal template repositories are turned off on this server');
  const list = await readStored(owner);
  if (list.length >= max) throw new PersonalRepoError(`You can add up to ${max} template repositories. Remove one first`);
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  if (!fetchableRepoUrl(url)) throw new PersonalRepoError('Enter the repository\'s https:// clone URL');
  if (/\/\/[^/@]*@/.test(url)) throw new PersonalRepoError('Leave the token out of the URL. A private repository is read with your connection to its host under Git hosts');
  const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 60) : (new URL(url).pathname.split('/').filter(Boolean).pop() || 'Templates').replace(/\.git$/, '');
  const id = shortIdFor(label, new Set(list.map((r) => r.id)));
  const raw = { id, label, url, ref: typeof input.ref === 'string' && input.ref.trim() ? input.ref.trim() : undefined, path: typeof input.path === 'string' && input.path.trim() ? input.path.trim() : undefined };
  const problem = entryProblem(raw);
  if (problem) throw new PersonalRepoError(problem.replace(`"${id}": `, '').replace(/^./, (c) => c.toUpperCase()));
  const stored = storedOf(raw)!;
  const entry = register(owner, stored);
  const state = await syncTemplateRepo(entry);
  const view = personalView(entry);
  if (!state.ok || !view.templates) {
    await forget(entry);
    throw new PersonalRepoError(!state.ok
      ? `Could not clone the repository: ${state.error}`
      : `The repository has no template${stored.path ? ` in ${stored.path}` : ''}: each template is a folder with a template.json inside`);
  }
  await writeStored(owner, [...list, stored]);
  return view;
}

/** Drop a personal repository's checkout and previews, after a sync in flight settled: it could clone the checkout back. */
async function forget(entry: TemplateRepoEntry): Promise<void> {
  personal.delete(entry.id);
  await inflight.get(entry.id)?.catch(() => undefined);
  states.delete(entry.id);
  attempted.delete(entry.id);
  failing.delete(entry.id);
  fs.rmSync(templateRepoDir(entry.id), { recursive: true, force: true });
  fs.rmSync(path.join(config.cacheDir, 'template-previews', entry.id), { recursive: true, force: true });
}

/** Remove one of the account's repositories, its checkout and its previews. False when it has none by that id. */
export async function removePersonalRepo(owner: string, shortId: string): Promise<boolean> {
  const list = await readStored(owner);
  const hit = list.find((r) => r.id === shortId);
  if (!hit) return false;
  await writeStored(owner, list.filter((r) => r !== hit));
  await forget(personal.get(personalId(owner, shortId)) ?? register(owner, hit));
  return true;
}

/** An account was deleted: its checkouts and previews go too (its list went with its connections). */
export async function removeAllPersonalRepos(owner: string): Promise<void> {
  const prefix = `~${ownerHash(owner)}-`;
  for (const [id, e] of personal) if (e.owner === owner) personal.delete(id);
  await Promise.all([...inflight].filter(([id]) => id.startsWith(prefix)).map(([, p]) => p.catch(() => undefined)));
  for (const sub of ['template-repos', 'template-previews']) {
    const dir = path.join(config.cacheDir, sub);
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.startsWith(prefix)) continue;
      states.delete(n);
      fs.rmSync(path.join(dir, n), { recursive: true, force: true });
    }
  }
}

/** Sync the account's repositories not synced in this process for a refresh interval. Does not wait. */
export function refreshStalePersonal(owner: string): void {
  const now = Date.now();
  for (const e of personal.values()) {
    if (e.owner !== owner || inflight.has(e.id)) continue;
    const at = attempted.get(e.id);
    if (at !== undefined && now - at < refreshIntervalMs()) continue;
    attempted.set(e.id, now);
    void syncTemplateRepo(e);
  }
}
/** When a gallery open last started a sync of a personal repository, failed ones included. */
const attempted = new Map<string, number>();

/** Sync every repository of the account now. */
export function syncPersonalRepos(owner: string): Promise<TemplateRepoState[]> {
  return Promise.all([...personal.values()].filter((e) => e.owner === owner).map((e) => syncTemplateRepo(e).then((st) => ({ ...st, personal: true as const }))));
}
