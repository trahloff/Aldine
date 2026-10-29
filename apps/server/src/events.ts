/**
 * Cross-node project events over Redis pub/sub. Single-node installs (no
 * REDIS_URL) never need this: the publisher always applies the effect locally
 * first, so the channel only exists to reach OTHER nodes.
 *
 * 'access-changed' makes sharing revocation and claiming effective on every
 * node: each subscriber closes its local collab sockets for the project so
 * clients reconnect and re-run onAuthenticate. 'account-ended' does the same
 * for one account's sockets when an administrator disables or deletes it.
 */
import { getSharedRedis, createDedicatedClient } from './redis.js';

export const PROJECT_EVENTS_CHANNEL = 'aldine:project-events';

export type ProjectEvent = { type: 'access-changed'; projectId: string } | { type: 'account-ended'; userId: string };

/**
 * Fire-and-forget fanout to peer nodes. Must never fail the calling route:
 * a Redis outage degrades to single-node semantics, not to a 500.
 */
export function publishProjectEvent(evt: ProjectEvent): void {
  const client = getSharedRedis();
  if (!client) return;
  client.publish(PROJECT_EVENTS_CHANNEL, JSON.stringify(evt))
    .catch((err) => console.error('[aldine] project-event publish failed:', (err as Error).message));
}

/**
 * Subscribe this node. Boot-safe: with Redis down, the subscribe waits in
 * ioredis's offline queue and completes on connect; reconnects re-subscribe
 * automatically. Malformed or unknown payloads are ignored (forward compat).
 */
export function initProjectEvents(handlers: { onAccessChanged: (projectId: string) => void; onAccountEnded: (userId: string) => void }): void {
  const sub = createDedicatedClient('events-sub');
  if (!sub) return;
  sub.subscribe(PROJECT_EVENTS_CHANNEL)
    .then(() => console.log('[aldine] project events: subscribed (cross-node revocation active)'))
    .catch((err) => console.error('[aldine] project-event subscribe failed:', (err as Error).message));
  sub.on('message', (channel: string, message: string) => {
    if (channel !== PROJECT_EVENTS_CHANNEL) return;
    try {
      const evt = JSON.parse(message) as ProjectEvent;
      if (evt.type === 'access-changed' && typeof evt.projectId === 'string') {
        handlers.onAccessChanged(evt.projectId);
      } else if (evt.type === 'account-ended' && typeof evt.userId === 'string') {
        handlers.onAccountEnded(evt.userId);
      }
    } catch { /* ignore malformed payloads */ }
  });
}
