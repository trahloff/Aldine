import { useEffect, useRef } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';

/**
 * Live-sync coordination for review comments. Comments themselves stay behind
 * the REST API (server-side validation, caps, auth attribution); this opens an
 * ephemeral Yjs doc whose only job is a shared version counter. Any client that
 * mutates comments bumps it, and every other client re-fetches — so review
 * threads appear live without polling.
 */
export function useCommentSignal(projectId: string, branch: string, onRemoteChange: () => void) {
  return useSignalDoc(projectId, branch, '.aldine/comments-signal', onRemoteChange);
}

/**
 * The file list is a REST listing; the server bumps this doc whenever a
 * branch's files change on disk (write, upload, rename, delete, pull, merge,
 * an agent's write), so every open editor refetches instead of showing the
 * tree it loaded with the page.
 */
export function useFilesSignal(projectId: string, branch: string, onRemoteChange: () => void) {
  return useSignalDoc(projectId, branch, '.aldine/files-signal', onRemoteChange);
}

function useSignalDoc(projectId: string, branch: string, docPath: string, onRemoteChange: () => void) {
  const bumpRef = useRef<() => void>(() => {});
  const cbRef = useRef(onRemoteChange);
  cbRef.current = onRemoteChange;

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ydoc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: `${proto}//${location.host}/collab`,
      name: `${projectId}::${branch}::${docPath}`,
      document: ydoc,
      // With auth enabled the server defines onAuthenticate, so a tokenless
      // provider never completes the handshake and this signal doc never syncs.
      // The real credential is the session cookie; this is just the trigger.
      token: 'aldine-session',
    });
    const map = ydoc.getMap<number>('signal');
    let last = 0;
    const observer = () => {
      const v = map.get('v') || 0;
      if (v !== last) { last = v; cbRef.current(); }
    };
    map.observe(observer);
    bumpRef.current = () => { last = Date.now(); map.set('v', last); };

    return () => {
      map.unobserve(observer);
      provider.destroy();
      ydoc.destroy();
      bumpRef.current = () => {};
    };
  }, [projectId, branch, docPath]);

  return () => bumpRef.current();
}
