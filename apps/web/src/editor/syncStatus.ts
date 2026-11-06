/**
 * Whether the open document's edits have reached the server, from its
 * Hocuspocus provider: what the status line shows and when closing the tab
 * must ask first.
 */

export interface SyncState {
  /** The document has synced with the server once since it opened. */
  loaded: boolean;
  /** The socket is up and the document in step with the server. */
  connected: boolean;
  /** Edits made in this tab that the server has not confirmed. */
  unsynced: boolean;
  /** `unsynced` for longer than a round trip takes (SAVE_GRACE_MS). */
  stale: boolean;
  /** What the browser says about the network. */
  online: boolean;
}

export type SyncPhase = 'connecting' | 'saved' | 'saving' | 'offline';

/** How long an edit may wait for the server's confirmation before the status
 *  line says so: a confirmation takes milliseconds, and typing must not make
 *  the status flicker. */
export const SAVE_GRACE_MS = 1000;

export function syncPhase(s: SyncState): SyncPhase {
  if (!s.loaded) return s.online ? 'connecting' : 'offline';
  // A socket the network dropped can look connected for a while yet: the
  // browser saying it is offline counts as much as the socket closing.
  if (!s.connected || !s.online) return 'offline';
  if (s.unsynced && s.stale) return 'saving';
  return 'saved';
}

export function syncLabel(s: SyncState): { phase: SyncPhase; text: string; title: string } {
  const phase = syncPhase(s);
  if (phase === 'connecting') return { phase, text: 'Connecting…', title: 'Loading the file from the server. You can edit it once it has loaded.' };
  if (phase === 'saved') return { phase, text: 'Saved', title: 'Every edit made here is on the server.' };
  if (phase === 'saving') return { phase, text: 'Saving…', title: 'Sending your latest edits to the server.' };
  if (!s.loaded) return { phase, text: 'Offline', title: 'The file opens for editing once the connection is back.' };
  // An edit on its way over a socket that still works (a server on this
  // machine while the network is down) is not one waiting for the connection.
  if (s.unsynced && (s.stale || !s.connected)) {
    return { phase, text: `Not saved · ${s.online ? 'reconnecting' : 'offline'}`, title: 'Your latest edits are kept in this tab and saved once the connection is back. Keep the tab open until then.' };
  }
  return {
    phase,
    text: s.online ? 'Reconnecting…' : 'Offline',
    title: 'Every edit so far is saved. Edits you make now are saved once the connection is back.',
  };
}

type Listener = (...args: any[]) => void;
interface Emitter { on(event: string, fn: Listener): unknown; off(event: string, fn: Listener): unknown }

/** The parts of a HocuspocusProvider (and of its socket) this module reads. */
export interface ProviderLike extends Emitter {
  status: string;
  isSynced: boolean;
  unsyncedChanges: number;
  connect(): Promise<unknown> | void;
  configuration: { websocketProvider: SocketLike };
}
export interface SocketLike extends Emitter {
  status: string;
  shouldConnect: boolean;
  webSocket: { close(): void } | null;
  connect(): Promise<unknown> | void;
  disconnect(): void;
}
interface DocLike { on(event: 'update', fn: (update: Uint8Array, origin: unknown) => void): void; off(event: 'update', fn: (update: Uint8Array, origin: unknown) => void): void }
interface WindowLike {
  addEventListener(type: string, fn: (e: any) => void): void;
  removeEventListener(type: string, fn: (e: any) => void): void;
  navigator: { onLine: boolean };
}

const settle = (p: Promise<unknown> | void) => { if (p) p.catch(() => { /* the socket retries on its own */ }); };

/**
 * Follows `provider` and `doc` from now on, reporting every change of the
 * state to `onChange` (once right away). While edits are unconfirmed,
 * closing or reloading the tab asks first.
 *
 * Create it after the provider, so the provider has counted an edit by the
 * time this sees it.
 */
export function watchSync(provider: ProviderLike, doc: DocLike, onChange: (s: SyncState) => void, win: WindowLike = window): { current(): SyncState; dispose(): void } {
  // A doc kept from an earlier visit to the file (editor/docCache) is synced already.
  let loaded = provider.isSynced;
  let connected = provider.status === 'connected' && provider.isSynced;
  let unsynced = false;
  let stale = false;
  let online = win.navigator.onLine;
  let staleTimer: ReturnType<typeof setTimeout> | null = null;

  const current = (): SyncState => ({ loaded, connected, unsynced, stale, online });
  let last = '';
  const emit = () => {
    const s = current();
    const key = JSON.stringify(s);
    if (key === last) return;
    last = key;
    onChange(s);
  };

  const guard = (e: { preventDefault(): void; returnValue?: unknown }) => {
    e.preventDefault();
    // older engines ask only when returnValue is set
    e.returnValue = '';
  };
  const setUnsynced = (v: boolean) => {
    if (v === unsynced) return;
    unsynced = v;
    stale = false;
    if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
    if (v) {
      win.addEventListener('beforeunload', guard);
      staleTimer = setTimeout(() => { staleTimer = null; stale = true; emit(); }, SAVE_GRACE_MS);
    } else {
      win.removeEventListener('beforeunload', guard);
    }
    emit();
  };

  // The provider counts each local update it sends until the server confirms
  // it. A reconnect restarts the count at one, for the handshake that carries
  // every edit made meanwhile, but the updates queued while the socket was
  // down go out too and are confirmed besides. Below zero the count would
  // swallow the next edits, so it stops at zero.
  const onCount = () => {
    if (provider.unsyncedChanges < 0) provider.unsyncedChanges = 0;
    if (provider.unsyncedChanges === 0) setUnsynced(false);
  };
  const onUpdate = (_u: Uint8Array, origin: unknown) => { if (origin !== provider) setUnsynced(true); };
  const onLink = () => {
    if (provider.isSynced) loaded = true;
    connected = provider.status === 'connected' && provider.isSynced;
    emit();
  };
  const onNetwork = () => {
    const was = online;
    online = win.navigator.onLine;
    if (online && !was) {
      // Back online: try now rather than at the end of the socket's backoff,
      // which grows to 30 s. A socket that still looks up while edits wait
      // may be one the network dropped without a word; a fresh one is cheap.
      const ws = provider.configuration.websocketProvider;
      if (ws.shouldConnect) {
        if (ws.status !== 'connected') settle(ws.connect());
        else if (unsynced) ws.webSocket?.close();
      }
    }
    emit();
  };

  provider.on('unsyncedChanges', onCount);
  provider.on('status', onLink);
  provider.on('synced', onLink);
  doc.on('update', onUpdate);
  win.addEventListener('online', onNetwork);
  win.addEventListener('offline', onNetwork);
  // A kept doc may still wait for the server to confirm edits made before the switch.
  if (loaded && provider.unsyncedChanges > 0) setUnsynced(true);
  emit();

  return {
    current,
    dispose() {
      provider.off('unsyncedChanges', onCount);
      provider.off('status', onLink);
      provider.off('synced', onLink);
      doc.off('update', onUpdate);
      win.removeEventListener('online', onNetwork);
      win.removeEventListener('offline', onNetwork);
      win.removeEventListener('beforeunload', guard);
      if (staleTimer) clearTimeout(staleTimer);
    },
  };
}

/**
 * Connect `provider` again on a fresh socket, after a sign-in: the session
 * cookie is read when the socket opens, so the one the server refused would
 * be refused again.
 */
export function reconnectProvider(provider: ProviderLike): void {
  const ws = provider.configuration.websocketProvider;
  if (ws.status === 'disconnected' || !ws.webSocket) { settle(provider.connect()); return; }
  const onStatus = ({ status }: { status: string }) => {
    if (status !== 'disconnected') return;
    ws.off('status', onStatus);
    settle(provider.connect());
  };
  ws.on('status', onStatus);
  ws.disconnect();
}
