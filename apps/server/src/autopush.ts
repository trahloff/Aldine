import * as store from './store.js';
import * as gitops from './gitops.js';
import { getProvider, getConnection } from './remotes.js';
import { serviceConnection } from './gitlab.js';
import { debouncePerKey } from './util.js';

/**
 * Server-side autopush: a project with `meta.autopush` mirrors its `main` to its
 * remote once edits settle. This is what makes "projects live in GitLab" true —
 * the old client-side timer was per-browser and stopped when the tab closed.
 *
 * Failures are logged and retried with backoff, never surfaced to the editor: an
 * unreachable remote must not interrupt writing, and the sync control's
 * ahead/behind counts already tell the user they are unpushed.
 */

const DEBOUNCE = Number(process.env.AUTOPUSH_DEBOUNCE_MS || 30_000);
const MAX_BACKOFF = 15 * 60_000;
/**
 * Give up after this many consecutive push failures. Not a data risk: the next
 * autocommit schedules a fresh attempt, the ahead/behind indicator shows the
 * project is unpushed, and manual Push always works. The cap only stops one
 * project logging forever during a long outage.
 */
const MAX_ATTEMPTS = 8;

/** One push at a time per project: concurrent pushes to the same ref race. */
const inFlight = new Set<string>();
/** Projects that asked to push while one was already in flight. */
const requeued = new Set<string>();
const failures = new Map<string, number>();

/** Everything needed to push, or null when this project simply isn't pushable. */
async function resolveTarget(projectId: string) {
  let meta: store.ProjectMeta;
  try { meta = await store.readMeta(projectId); }
  catch { return null; } // deleted or never existed — permanent, don't retry
  if (!meta.autopush) return null;
  const link = store.remoteLink(meta);
  if (!link) return null;
  const prov = getProvider(link.provider);
  if (!prov) return null;
  // The token that created the link, falling back to the service account for an
  // auto-provisioned project whose creator has no personal connection.
  const conn = (link.connectedBy ? await getConnection(link.connectedBy, link.provider) : null)
    || (link.provider === 'gitlab' ? serviceConnection() : null);
  if (!conn) return null;
  return { url: prov.tokenUrl(link.cloneUrl, conn.token), remoteBranch: link.remoteBranch };
}

async function pushNow(projectId: string): Promise<void> {
  if (inFlight.has(projectId)) { requeued.add(projectId); return; }
  inFlight.add(projectId);
  try {
    // Resolution problems are permanent, so they end here rather than entering
    // the retry loop — a deleted project must not back off forever.
    const target = await resolveTarget(projectId);
    if (!target) { failures.delete(projectId); return; }
    try {
      await gitops.pushToRemote(projectId, target.remoteBranch, target.url);
      failures.delete(projectId);
    } catch (err) {
      const n = (failures.get(projectId) || 0) + 1;
      failures.set(projectId, n);
      console.warn(`[autopush] ${projectId} push failed (attempt ${n}): ${(err as Error).message}`);
      if (n < MAX_ATTEMPTS) {
        setTimeout(() => void pushNow(projectId), Math.min(DEBOUNCE * 2 ** n, MAX_BACKOFF)).unref();
      } else {
        console.warn(`[autopush] ${projectId} giving up after ${n} attempts; the next edit will retry`);
        failures.delete(projectId);
      }
    }
  } finally {
    inFlight.delete(projectId);
    if (requeued.delete(projectId)) schedule(projectId);
  }
}

const schedule = debouncePerKey(DEBOUNCE, (key: string) => { void pushNow(key); });

/**
 * Push the project's `main` to its remote once edits settle. A no-op unless the
 * project has autopush enabled and a remote link.
 */
export function scheduleAutopush(projectId: string): void {
  schedule(projectId);
}
