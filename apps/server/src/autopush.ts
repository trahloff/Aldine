import * as store from './store.js';
import * as gitops from './gitops.js';
import { getProvider, linkInstance, resolveConnectionSource, tokenRefused, type ConnectionSource, type RemoteConnection, type RemoteProvider } from './remotes.js';
import { explainGitFailure } from './sync-errors.js';
import type { RemoteLink } from './db/types.js';

/**
 * Server-side autopush: after a commit lands on `main`, push it to the
 * linked remote once the edits settle. Debounced per project, one push in
 * flight per project, exponential backoff on failure (capped) and a stop
 * after MAX_ATTEMPTS until the next commit re-arms it. In-process state:
 * with two nodes each pushes, which git tolerates (see docs/SCALING.md).
 * Why pushes fail is kept on the project (`autopushFailure`) until one
 * lands, so the branch menu can say autopush is paused and why.
 */

export const MAX_ATTEMPTS = 8;
const MAX_BACKOFF_MS = 15 * 60_000;

export function debounceMs(): number {
  const n = Number(process.env.AUTOPUSH_DEBOUNCE_MS || 30_000);
  return Number.isFinite(n) && n >= 0 ? n : 30_000;
}

interface State { timer: NodeJS.Timeout | null; running: boolean; attempts: number; rearm: boolean; lastPushed?: string }
const states = new Map<string, State>();

function stateOf(id: string): State {
  let s = states.get(id);
  if (!s) { s = { timer: null, running: false, attempts: 0, rearm: false }; states.set(id, s); }
  return s;
}

/** Ask for a push after the debounce. Cheap to call on every commit. */
export function scheduleAutopush(id: string, delay = debounceMs()): void {
  const s = stateOf(id);
  if (s.running) { s.rearm = true; return; }
  if (s.timer) clearTimeout(s.timer);
  s.attempts = 0;
  s.timer = setTimeout(() => { s.timer = null; void run(id); }, delay);
  s.timer.unref();
}

/** Head last pushed by the browser's auto-push (`POST …/remote/push` with
 *  `auto`), so an unchanged head is not pushed again. Cleared with the project. */
export const lastPushedHead = new Map<string, string>();

export function cancelAutopush(id: string): void {
  lastPushedHead.delete(id);
  const s = states.get(id);
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  states.delete(id);
}

/** For tests and the status route. */
export function autopushStats(id: string): { pending: boolean; running: boolean; attempts: number } {
  const s = states.get(id);
  return { pending: !!s?.timer, running: !!s?.running, attempts: s?.attempts ?? 0 };
}

let pushImpl: (id: string) => Promise<'pushed' | 'skipped' | 'off'> = pushOnce;
/** Tests swap the push for a stub. */
export function _setPushImpl(fn: typeof pushImpl | null): void { pushImpl = fn ?? pushOnce; }

/** A failed autopush whose message is already the sentence the branch menu shows. */
class AutopushError extends Error {}

async function pushOnce(id: string): Promise<'pushed' | 'skipped' | 'off'> {
  let meta;
  try { meta = await store.readMeta(id); } catch { return 'off'; }
  const link = store.remoteLink(meta);
  if (!link || meta.autopush !== true || meta.deletedAt) return 'off';
  const provider = getProvider(link.provider);
  if (!provider) return 'off';
  const resolved = await resolveConnectionSource(link, link.connectedBy, { allowService: true, projectId: id });
  if (!resolved) throw new AutopushError(`The ${provider.label} account that linked this project can no longer push it. Add a token for this project in Git access.`);
  const { conn, source } = resolved;
  const head = await gitops.headCommit(id).catch(() => null);
  const s = stateOf(id);
  if (head && s.lastPushed === head) return 'skipped';
  try { await gitops.pushToRemote(id, link.remoteBranch, provider.tokenUrl(link.cloneUrl, conn.token, conn.login)); }
  catch (err) { throw new AutopushError(await describeFailure(provider, link, conn, source, err)); }
  if (head) s.lastPushed = head;
  return 'pushed';
}

async function describeFailure(provider: RemoteProvider, link: RemoteLink, conn: RemoteConnection, source: ConnectionSource, err: any): Promise<string> {
  if (await tokenRefused(provider, conn, err)) {
    if (source === 'service') return `${provider.label} rejected the server's service token. Ask your administrator to replace it.`;
    const whose = source === 'project' ? "this project's token" : `the token of ${conn.login || 'the account that linked this project'}`;
    return `${provider.label} rejected ${whose}. Replace it in Git access.`;
  }
  let host: string | undefined;
  try { const at = provider.selfHosted ? linkInstance(link) : null; host = at ? new URL(at).host : undefined; } catch { /* the label alone */ }
  const known = explainGitFailure(String(err?.message || err), { label: provider.label, host, fullName: link.fullName, branch: link.remoteBranch, op: 'push' });
  return known?.error ?? failedPush(err);
}

const failedPush = (err: any) => `The push failed: ${String(err?.message || err).split('\n').map((l) => l.trim()).find(Boolean) ?? 'no reason given'}`;

/** Keep the latest failure on the project, or clear it (`null`). Written
 *  only when it changes: the meta is shared with every route. */
async function noteFailure(id: string, message: string | null): Promise<void> {
  try {
    const meta = await store.readMeta(id);
    const cur = meta.autopushFailure;
    if (message === null) {
      if (!cur) return;
      delete meta.autopushFailure;
    } else {
      if (cur?.message === message || meta.autopush !== true) return;
      meta.autopushFailure = { since: cur?.since ?? new Date().toISOString(), message };
    }
    await store.writeMeta(meta);
  } catch { /* the project is gone */ }
}

async function run(id: string): Promise<void> {
  const s = stateOf(id);
  s.running = true;
  let outcome: 'pushed' | 'skipped' | 'off' | 'failed' = 'failed';
  /** undefined leaves the recorded failure as it is. */
  let failure: string | null | undefined;
  try {
    outcome = await pushImpl(id);
    s.attempts = 0;
    if (outcome !== 'off') failure = null;
  } catch (err: any) {
    failure = err instanceof AutopushError ? err.message : failedPush(err);
    s.attempts += 1;
    if (s.attempts >= MAX_ATTEMPTS) {
      console.warn(`[autopush] ${id}: giving up after ${s.attempts} attempts (${err?.message || err}); the next commit retries`);
      s.attempts = 0;
      outcome = 'off';
    } else {
      const wait = Math.min(debounceMs() * 2 ** s.attempts, MAX_BACKOFF_MS);
      s.timer = setTimeout(() => { s.timer = null; void run(id); }, wait);
      s.timer.unref();
    }
  } finally {
    s.running = false;
  }
  if (outcome === 'off') states.delete(id);
  if (s.rearm) { s.rearm = false; scheduleAutopush(id); }
  if (failure !== undefined) await noteFailure(id, failure);
}
