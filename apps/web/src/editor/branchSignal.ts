import { useEffect, useRef } from 'react';
import { wsUrl } from '../basePath';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { electTypesetter, type TypesetPeer } from './autoTypeset';

/**
 * The branch's coordination channel: one ephemeral Yjs doc carrying stamped
 * keys the server sets — `v` (the file list changed), `a` (an agent wrote),
 * `ts`/`td` (an agent-caused typeset started / finished). The same doc's
 * awareness is the roster the auto-typeset election runs over, which is why
 * both live in one hook: a second provider on this doc name would make a tab
 * elect its own other socket and freeze the branch's auto-typeset.
 */
export interface BranchSignalHandlers {
  onFilesChanged(): void;
  onAgentWrite(): void;
  onAgentTypesetStarted(): void;
  onAgentTypesetFinished(): void;
}

export interface BranchSignalHandle {
  /** Tell the branch this client changed the file list. */
  bumpFiles(): void;
  /** Whether this client is the branch's elected typesetter right now. */
  electedTypesetter(): boolean;
}

type SignalKey = 'v' | 'a' | 'ts' | 'td';

export function useBranchSignal(
  projectId: string,
  branch: string,
  handlers: BranchSignalHandlers,
  eligible: boolean,
): BranchSignalHandle {
  const cbRef = useRef(handlers);
  cbRef.current = handlers;
  const eligibleRef = useRef(eligible);
  eligibleRef.current = eligible;
  const providerRef = useRef<HocuspocusProvider | null>(null);
  const bumpRef = useRef<() => void>(() => {});

  const handleRef = useRef<BranchSignalHandle>({
    bumpFiles: () => bumpRef.current(),
    electedTypesetter: () => {
      const awareness = providerRef.current?.awareness;
      // No awareness at all (never connected, provider gone): a lone client
      // must never freeze because coordination is unavailable.
      if (!awareness) return true;
      const peers: TypesetPeer[] = [];
      awareness.getStates().forEach((state: unknown, clientId: number) => {
        const t = (state as { typeset?: { eligible?: boolean; visible?: boolean } } | undefined)?.typeset;
        peers.push({ clientId, eligible: !!t?.eligible, visible: !!t?.visible });
      });
      // This client's own row is authoritative here and may not have reached
      // awareness yet; without it a lone tab would elect nobody and freeze.
      if (!peers.some((p) => p.clientId === awareness.clientID)) {
        peers.push({ clientId: awareness.clientID, eligible: eligibleRef.current, visible: document.visibilityState === 'visible' });
      }
      return electTypesetter(peers) === awareness.clientID;
    },
  });

  useEffect(() => {
    const ydoc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: wsUrl('/collab'),
      name: `${projectId}::${branch}::.aldine/files-signal`,
      document: ydoc,
      // With auth enabled the server defines onAuthenticate, so a tokenless
      // provider never completes the handshake and this signal doc never syncs.
      // The real credential is the session cookie; this is just the trigger.
      token: 'aldine-session',
    });
    providerRef.current = provider;
    const map = ydoc.getMap<number>('signal');
    const last: Record<SignalKey, number> = { v: 0, a: 0, ts: 0, td: 0 };
    // A client joining a branch an agent touched an hour ago must not replay
    // that stamp as a fresh edit and typeset on open: until the initial sync
    // has landed, the observer only records what it finds.
    let ready = false;
    const record = () => { for (const k of ['v', 'a', 'ts', 'td'] as SignalKey[]) last[k] = map.get(k) || 0; };

    const observer = () => {
      if (!ready) { record(); return; }
      const fire: Array<[SignalKey, () => void]> = [
        ['v', () => cbRef.current.onFilesChanged()],
        ['a', () => cbRef.current.onAgentWrite()],
        ['ts', () => cbRef.current.onAgentTypesetStarted()],
        ['td', () => cbRef.current.onAgentTypesetFinished()],
      ];
      for (const [key, run] of fire) {
        const v = map.get(key) || 0;
        if (v === last[key]) continue;
        last[key] = v;
        run();
      }
    };
    map.observe(observer);
    bumpRef.current = () => { last.v = Date.now(); map.set('v', last.v); };

    const publish = () => {
      try {
        provider.setAwarenessField('typeset', {
          eligible: eligibleRef.current,
          visible: document.visibilityState === 'visible',
        });
      } catch { /* not connected yet; the synced handler publishes again */ }
    };
    const onSynced = () => { record(); ready = true; publish(); };
    provider.on('synced', onSynced);
    const onVisibility = () => publish();
    document.addEventListener('visibilitychange', onVisibility);
    publish();

    return () => {
      map.unobserve(observer);
      provider.off('synced', onSynced);
      document.removeEventListener('visibilitychange', onVisibility);
      providerRef.current = null;
      bumpRef.current = () => {};
      provider.destroy();
      ydoc.destroy();
    };
  }, [projectId, branch]);

  // Eligibility changes (the auto toggle, the first .tex) without tearing the
  // socket down — the roster must reflect it before the next election.
  useEffect(() => {
    const provider = providerRef.current;
    if (!provider) return;
    try {
      provider.setAwarenessField('typeset', { eligible, visible: document.visibilityState === 'visible' });
    } catch { /* not connected yet */ }
  }, [eligible]);

  return handleRef.current;
}
