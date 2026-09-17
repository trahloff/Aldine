import * as store from './store.js';
import * as gitops from './gitops.js';
import { getProvider, resolveConnection } from './remotes.js';

/**
 * Server-side autopush: after a commit lands on `main`, push it to the
 * linked remote once the edits settle. Debounced per project, one push in
 * flight per project, exponential backoff on failure (capped) and a stop
 * after MAX_ATTEMPTS until the next commit re-arms it. In-process state:
 * with two nodes each pushes, which git tolerates (see docs/SCALING.md).
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

export function cancelAutopush(id: string): void {
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

async function pushOnce(id: string): Promise<'pushed' | 'skipped' | 'off'> {
  let meta;
  try { meta = await store.readMeta(id); } catch { return 'off'; }
  const link = store.remoteLink(meta);
  if (!link || meta.autopush !== true || meta.deletedAt) return 'off';
  const provider = getProvider(link.provider);
  if (!provider) return 'off';
  const conn = await resolveConnection(link, link.connectedBy, { allowService: true });
  if (!conn) throw new Error(`no ${provider.label} connection for autopush`);
  const head = await gitops.headCommit(id).catch(() => null);
  const s = stateOf(id);
  if (head && s.lastPushed === head) return 'skipped';
  await gitops.pushToRemote(id, link.remoteBranch, provider.tokenUrl(link.cloneUrl, conn.token));
  if (head) s.lastPushed = head;
  return 'pushed';
}

async function run(id: string): Promise<void> {
  const s = stateOf(id);
  s.running = true;
  let outcome: 'pushed' | 'skipped' | 'off' | 'failed' = 'failed';
  try {
    outcome = await pushImpl(id);
    s.attempts = 0;
  } catch (err: any) {
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
}
