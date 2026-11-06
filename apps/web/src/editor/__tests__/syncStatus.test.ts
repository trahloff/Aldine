import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import { syncPhase, syncLabel, watchSync, reconnectProvider, SAVE_GRACE_MS, type SyncState, type ProviderLike, type SocketLike } from '../syncStatus';

type Fn = (...a: any[]) => void;
class Emitter {
  private fns = new Map<string, Set<Fn>>();
  on(e: string, fn: Fn) { if (!this.fns.has(e)) this.fns.set(e, new Set()); this.fns.get(e)!.add(fn); }
  off(e: string, fn: Fn) { this.fns.get(e)?.delete(fn); }
  emit(e: string, ...a: unknown[]) { for (const fn of [...(this.fns.get(e) ?? [])]) fn(...a); }
  count(e: string) { return this.fns.get(e)?.size ?? 0; }
}

/** What HocuspocusProvider does with the parts watchSync reads. */
class FakeSocket extends Emitter implements SocketLike {
  status = 'disconnected';
  shouldConnect = true;
  webSocket: { close(): void } | null = null;
  connects = 0;
  closes = 0;
  connect() { this.connects++; }
  disconnect() { this.shouldConnect = false; this.closes++; }
  /** The socket's close event, after disconnect() or a drop. */
  closed() { this.webSocket = null; this.setStatus('disconnected'); }
  opened() { this.webSocket = { close: () => { this.closes++; } }; this.setStatus('connected'); }
  setStatus(status: string) { this.status = status; this.emit('status', { status }); }
}
class FakeProvider extends Emitter implements ProviderLike {
  status = 'disconnected';
  isSynced = false;
  unsyncedChanges = 0;
  connects = 0;
  configuration: { websocketProvider: FakeSocket };
  constructor(public doc: Y.Doc) {
    super();
    this.configuration = { websocketProvider: new FakeSocket() };
    doc.on('update', (_u: Uint8Array, origin: unknown) => { if (origin !== this) this.count1(+1); });
  }
  connect() { this.connects++; }
  private count1(d: number) { this.unsyncedChanges += d; this.emit('unsyncedChanges', this.unsyncedChanges); }
  /** The server confirmed one update. */
  ack() { this.count1(-1); }
  /** Socket open and handshake done, as on a (re)connect. */
  link() {
    this.status = 'connected'; this.emit('status', { status: 'connected' });
    this.unsyncedChanges = 1; this.emit('unsyncedChanges', 1); // startSync
    this.isSynced = true; this.emit('synced', { state: true });
  }
  drop() {
    this.isSynced = false; this.emit('synced', { state: false });
    this.status = 'disconnected'; this.emit('status', { status: 'disconnected' });
  }
  remote(text: string) { Y.applyUpdate(this.doc, (() => { const d = new Y.Doc(); d.getText('content').insert(0, text); return Y.encodeStateAsUpdate(d); })(), this); }
}
class FakeWindow extends Emitter {
  navigator = { onLine: true };
  addEventListener(t: string, fn: Fn) { this.on(t, fn); }
  removeEventListener(t: string, fn: Fn) { this.off(t, fn); }
  setOnline(v: boolean) { this.navigator.onLine = v; this.emit(v ? 'online' : 'offline', {}); }
  /** Whether closing the tab would ask first. */
  wouldAsk() {
    let asked = false;
    this.emit('beforeunload', { preventDefault: () => { asked = true; }, returnValue: undefined });
    return asked;
  }
}

const base: SyncState = { loaded: true, connected: true, unsynced: false, stale: false, online: true };

describe('syncPhase and syncLabel', () => {
  it('names each state for the status line', () => {
    expect(syncPhase({ ...base, loaded: false, connected: false })).toBe('connecting');
    expect(syncPhase({ ...base, loaded: false, connected: false, online: false })).toBe('offline');
    expect(syncPhase(base)).toBe('saved');
    expect(syncPhase({ ...base, unsynced: true })).toBe('saved');
    expect(syncPhase({ ...base, unsynced: true, stale: true })).toBe('saving');
    expect(syncPhase({ ...base, connected: false })).toBe('offline');
    // a socket the network dropped still looks connected
    expect(syncPhase({ ...base, online: false })).toBe('offline');
  });

  it('says when edits wait for the connection, and not for an edit already on its way', () => {
    expect(syncLabel({ ...base, connected: false, unsynced: true }).text).toBe('Not saved · reconnecting');
    expect(syncLabel({ ...base, online: false, unsynced: true, stale: true }).text).toBe('Not saved · offline');
    expect(syncLabel({ ...base, online: false, unsynced: true }).text).toBe('Offline');
    expect(syncLabel({ ...base, online: false }).text).toBe('Offline');
    expect(syncLabel({ ...base, connected: false }).text).toBe('Reconnecting…');
    expect(syncLabel(base).text).toBe('Saved');
    expect(syncLabel({ ...base, loaded: false, connected: false }).text).toBe('Connecting…');
    expect(syncLabel({ ...base, loaded: false, connected: false, online: false }).title).toMatch(/opens for editing once the connection is back/);
  });
});

describe('watchSync', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const setup = () => {
    const doc = new Y.Doc();
    const provider = new FakeProvider(doc);
    const win = new FakeWindow();
    const states: SyncState[] = [];
    const w = watchSync(provider, doc, (s) => states.push(s), win as never);
    return { doc, provider, win, states, w, text: doc.getText('content') };
  };

  it('is loaded after the first sync, and a remote update is no edit of this tab', () => {
    const { provider, w, win } = setup();
    expect(w.current()).toMatchObject({ loaded: false, connected: false, unsynced: false });
    provider.link();
    provider.remote('From the server');
    provider.ack(); // the handshake's
    expect(w.current()).toMatchObject({ loaded: true, connected: true, unsynced: false });
    expect(win.wouldAsk()).toBe(false);
  });

  it('starts loaded on a doc kept synced from an earlier visit, with its edits still unconfirmed', () => {
    const doc = new Y.Doc();
    const provider = new FakeProvider(doc);
    provider.link(); provider.ack();
    doc.getText('content').insert(0, 'typed before the switch');
    const win = new FakeWindow();
    const w = watchSync(provider, doc, () => {}, win as never);
    expect(w.current()).toMatchObject({ loaded: true, connected: true, unsynced: true });
    expect(win.wouldAsk()).toBe(true);
    provider.ack();
    expect(w.current().unsynced).toBe(false);
    w.dispose();
  });

  it('asks before the tab closes while an edit is unconfirmed, and no longer once it is', () => {
    const { provider, w, win, text } = setup();
    provider.link(); provider.ack();
    text.insert(0, 'typed');
    expect(w.current().unsynced).toBe(true);
    expect(win.wouldAsk()).toBe(true);
    provider.ack();
    expect(w.current().unsynced).toBe(false);
    expect(win.wouldAsk()).toBe(false);
    expect(win.count('beforeunload')).toBe(0);
  });

  it('marks an edit stale once it has waited longer than a round trip', () => {
    const { provider, w, text } = setup();
    provider.link(); provider.ack();
    text.insert(0, 'x');
    expect(w.current().stale).toBe(false);
    vi.advanceTimersByTime(SAVE_GRACE_MS + 1);
    expect(w.current()).toMatchObject({ unsynced: true, stale: true });
    provider.ack();
    expect(w.current()).toMatchObject({ unsynced: false, stale: false });
  });

  it('keeps edits made offline as unsynced through the reconnect, until the server confirms them', () => {
    const { provider, w, text, win } = setup();
    provider.link(); provider.ack();
    provider.drop();
    text.insert(0, 'offline one');
    text.insert(0, 'offline two');
    expect(w.current()).toMatchObject({ connected: false, unsynced: true });
    provider.link(); // the count restarts at 1 for the handshake
    expect(w.current()).toMatchObject({ connected: true, unsynced: true });
    expect(win.wouldAsk()).toBe(true);
    provider.ack();
    expect(w.current().unsynced).toBe(false);
  });

  it('does not let the confirmations of updates sent twice swallow the next edit', () => {
    const { provider, w, text } = setup();
    provider.link(); provider.ack();
    provider.drop();
    text.insert(0, 'a'); text.insert(0, 'b'); text.insert(0, 'c');
    provider.link();
    // the queued updates and the handshake are confirmed: four for one counted
    provider.ack(); provider.ack(); provider.ack(); provider.ack();
    expect(provider.unsyncedChanges).toBe(0);
    text.insert(0, 'next');
    expect(w.current().unsynced).toBe(true);
    provider.ack();
    expect(w.current().unsynced).toBe(false);
  });

  it('follows the browser going offline and tries to connect at once when it is back', () => {
    const { provider, w, win, text } = setup();
    provider.link(); provider.ack();
    const ws = provider.configuration.websocketProvider;
    win.setOnline(false);
    expect(syncPhase(w.current())).toBe('offline');
    // the socket closed meanwhile: reconnect now, not at the end of the backoff
    ws.status = 'connecting';
    win.setOnline(true);
    expect(ws.connects).toBe(1);
    // a socket that still looks up while an edit waits is replaced
    ws.opened();
    text.insert(0, 'x');
    win.setOnline(false);
    win.setOnline(true);
    expect(ws.closes).toBe(1);
    // nor for a socket a refused sign-in stopped
    ws.shouldConnect = false; ws.status = 'disconnected';
    win.setOnline(false); win.setOnline(true);
    expect(ws.connects).toBe(1);
  });

  it('lets go of everything when disposed', () => {
    const { provider, w, win, text } = setup();
    provider.link(); provider.ack();
    text.insert(0, 'x');
    w.dispose();
    expect(win.count('beforeunload') + win.count('online') + win.count('offline')).toBe(0);
    expect(provider.count('unsyncedChanges') + provider.count('status') + provider.count('synced')).toBe(0);
  });
});

describe('reconnectProvider', () => {
  it('connects right away when the socket is closed', () => {
    const provider = new FakeProvider(new Y.Doc());
    reconnectProvider(provider);
    expect(provider.connects).toBe(1);
  });

  it('closes a socket that is still open first, and connects once it has closed', () => {
    const provider = new FakeProvider(new Y.Doc());
    const ws = provider.configuration.websocketProvider;
    ws.opened();
    reconnectProvider(provider);
    expect(ws.closes).toBe(1);
    expect(provider.connects).toBe(0);
    ws.closed();
    expect(provider.connects).toBe(1);
    expect(ws.count('status')).toBe(0);
  });
});
