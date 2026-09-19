/** Auto-typeset timing and the branch-wide election that keeps N open tabs
 *  from rebuilding one PDF. Pure on purpose: the Editor owns the timers, the
 *  fetches and the awareness. */

export const LOCAL_AUTO_TYPESET_MS = 2000;
/** Longer than the local delay so an agent that typesets right after its edit
 *  (one model round trip) wins the race and no second run happens; short
 *  enough that an edit-only session still updates the preview. */
export const AGENT_AUTO_TYPESET_MS = 6000;
/** An agent typeset that never reports back (node gone, compile killed) must
 *  not leave the preview frozen; longer than the compiler's 120 s cap. */
export const AGENT_RUN_WATCHDOG_MS = 150_000;

export type TypesetSource = 'local' | 'agent';

export interface TypesetPeer {
  clientId: number;
  eligible: boolean;
  visible: boolean;
}

/** ms to wait before typesetting, or null to not arm at all. */
export function autoTypesetDelay(i: { source: TypesetSource; auto: boolean; hasTex: boolean }): number | null {
  if (!i.auto || !i.hasTex) return null;
  return i.source === 'agent' ? AGENT_AUTO_TYPESET_MS : LOCAL_AUTO_TYPESET_MS;
}

/** The one client that typesets an agent edit for the branch: the lowest
 *  collaboration id among the eligible ones, preferring a visible tab (a
 *  background tab's timers are throttled to as little as once a minute).
 *  Deterministic — every client computes the same winner from the same
 *  awareness, so no round trip is needed to agree. */
export function electTypesetter(peers: TypesetPeer[]): number | null {
  const eligible = peers.filter((p) => p.eligible);
  if (!eligible.length) return null;
  const visible = eligible.filter((p) => p.visible);
  const pool = visible.length ? visible : eligible;
  return pool.reduce((min, p) => (p.clientId < min ? p.clientId : min), pool[0].clientId);
}

/** Adopt a run the branch reports instead of compiling again: only a newer
 *  run, and never while this client's own typeset is still in flight. */
export function shouldAdoptRun(shownRunId: number | undefined, runId: number | undefined, busy: boolean): boolean {
  if (busy || runId === undefined) return false;
  return shownRunId === undefined || runId > shownRunId;
}
