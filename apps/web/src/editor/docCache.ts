import * as Y from 'yjs';
import { ChangeSet, type ChangeSpec } from '@codemirror/state';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { wsUrl } from '../basePath';
import { fileSpots, type SpotStore } from './fileSpots';

/** Files left in this tab that keep their doc, connection and undo history. */
export const PARKED_MAX = 5;

/** One file's collab doc with the connection that keeps it current. */
export interface CollabDoc {
  readonly name: string;
  readonly ydoc: Y.Doc;
  readonly ytext: Y.Text;
  readonly provider: HocuspocusProvider;
  /** Outlives the pane, so Undo reaches edits made before a switch. */
  readonly undoManager: Y.UndoManager;
  destroy(): void;
}

export function connectDoc(name: string): CollabDoc {
  const ydoc = new Y.Doc();
  // The socket is created here so it closes with the doc: a provider built
  // from a url leaves its socket open on destroy, the server then closes the
  // emptied socket and the client reconnects it with nothing on it.
  const socket = new HocuspocusProviderWebsocket({ url: wsUrl('/collab') });
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name,
    document: ydoc,
    // When auth is enabled the server defines onAuthenticate, which makes
    // Hocuspocus require a token before it loads the doc. The real credential
    // is the HttpOnly session cookie (sent with the WS handshake and validated
    // server-side); this token is just the non-empty trigger. Harmless when
    // auth is off (no hook → ignored).
    token: 'aldine-session',
  });
  const ytext = ydoc.getText('content');
  const undoManager = new Y.UndoManager(ytext);
  return {
    name, ydoc, ytext, provider, undoManager,
    destroy() {
      undoManager.destroy();
      provider.destroy();
      socket.destroy();
      ydoc.destroy();
    },
  };
}

/** A Y.Text change as the CodeMirror changes it makes, against the text before it. */
export function textChanges(delta: Y.YTextEvent['delta'], lengthAfter: number): ChangeSet {
  const specs: ChangeSpec[] = [];
  let pos = 0;
  let grew = 0;
  for (const d of delta) {
    if (d.insert != null) {
      const insert = typeof d.insert === 'string' ? d.insert : ' '; // an embed is one position
      specs.push({ from: pos, insert });
      grew += insert.length;
    } else if (d.delete) {
      specs.push({ from: pos, to: pos + d.delete });
      pos += d.delete;
      grew -= d.delete;
    } else if (d.retain) {
      pos += d.retain;
    }
  }
  return ChangeSet.of(specs, lengthAfter - grew);
}

export interface Parkable {
  readonly name: string;
  readonly ytext: Y.Text;
  readonly provider: {
    readonly isSynced: boolean;
    readonly status: string;
    readonly awareness: { setLocalState(state: Record<string, never>): void } | null;
    on(event: string, fn: (...args: any[]) => void): unknown;
    off(event: string, fn: (...args: any[]) => void): unknown;
  };
  readonly undoManager: { stopCapturing(): void };
  destroy(): void;
}

export interface DocCache<D extends Parkable> {
  /** The doc kept for `name`, else a new one. */
  open(name: string): D;
  /** Keeps a doc its pane let go of, or closes it. */
  park(doc: D): void;
  /** Closes every kept doc `keep` refuses. */
  closeParked(keep: (name: string) => boolean): void;
  parkedNames(): string[];
}

export function createDocCache<D extends Parkable>(connect: (name: string) => D, spots: SpotStore, max = PARKED_MAX): DocCache<D> {
  /** Most recently left first. */
  const parked: Array<{ doc: D; release(): void }> = [];

  const drop = (doc: D) => {
    const at = parked.findIndex((p) => p.doc === doc);
    if (at < 0) return;
    parked.splice(at, 1)[0].release();
    spots.flush();
    doc.destroy();
  };
  const trim = (n: number) => {
    while (parked.length > n) drop(parked[parked.length - 1].doc);
  };

  return {
    open(name) {
      const at = parked.findIndex((p) => p.doc.name === name);
      let doc: D;
      if (at >= 0) {
        const p = parked.splice(at, 1)[0];
        p.release();
        doc = p.doc;
      } else {
        doc = connect(name);
      }
      // Trimmed here rather than in park: the doc a switch parks would
      // otherwise push out the one it is switching to.
      trim(max);
      return doc;
    },
    park(doc) {
      const { provider } = doc;
      // A doc still loading or cut off is opened afresh next time.
      if (!provider.isSynced || provider.status !== 'connected') { doc.destroy(); return; }
      // Collaborators see this tab only in the file its pane has open. The
      // state is emptied, not removed: the server echoes its 15 s renewals,
      // and a socket that hears nothing for 30 s closes, taking the doc along.
      provider.awareness?.setLocalState({});
      // The first edit after coming back is an undo step of its own.
      doc.undoManager.stopCapturing();
      const onText = (e: Y.YTextEvent) => spots.map(doc.name, textChanges(e.delta, doc.ytext.length));
      // A kept doc never reconnects. The server cuts a deleted or renamed
      // file's connections, and a reconnect once its tombstone lapses would
      // write the file back.
      const onStatus = ({ status }: { status: string }) => { if (status !== 'connected') drop(doc); };
      const onDenied = () => drop(doc);
      doc.ytext.observe(onText);
      provider.on('status', onStatus);
      provider.on('authenticationFailed', onDenied);
      parked.unshift({
        doc,
        release() {
          doc.ytext.unobserve(onText);
          provider.off('status', onStatus);
          provider.off('authenticationFailed', onDenied);
        },
      });
      trim(max + 1);
    },
    closeParked(keep) {
      for (const p of [...parked]) if (!keep(p.doc.name)) drop(p.doc);
    },
    parkedNames: () => parked.map((p) => p.doc.name),
  };
}

const cache = createDocCache(connectDoc, fileSpots);
export const openDoc = cache.open;
export const parkDoc = cache.park;
export const closeParkedDocs = cache.closeParked;
