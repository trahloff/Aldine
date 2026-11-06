import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { readSeen } from '../util/agentSeen';

/** What Claude changed on a branch since this person's review mark: the
 *  files (the tree marks them) and the mark itself (the gutter shows the
 *  changes after it). `seenAt` is null until the first answer. */
export interface AgentUnseen { paths: Set<string>; seenAt: number | null }

/** A burst of commits (a batch, an autosave beside it) asks once. */
const REFRESH_MS = 800;
const NONE: Set<string> = new Set();

/** The review mark as epoch ms; none, or none yet acknowledged, is 0: everything is unseen. */
export function seenAtOf(since: { at: string } | null): number {
  const at = since?.at ? Date.parse(since.at) : 0;
  return Number.isNaN(at) ? 0 : at;
}

/**
 * The same question the review prompts ask (GET agent-activity from the
 * person's mark), asked on open, whenever a commit lands and after the
 * person reviews or dismisses a prompt. A failed answer keeps the last one:
 * the marks are a convenience, the prompts are the audit.
 */
export function useAgentUnseen(projectId: string, branch: string, authEnabled: boolean): AgentUnseen & { refresh(): void } {
  const key = `${projectId}::${branch}`;
  const [state, setState] = useState<{ key: string; paths: Set<string>; seenAt: number } | null>(null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const mark = authEnabled ? null : readSeen(projectId, branch);
      const res = await api.agentActivity(projectId, branch, mark && mark.head ? { head: mark.head, at: mark.at } : null);
      if (n !== seq.current) return;
      setState({ key, paths: new Set(res.paths ?? res.commits.flatMap((c) => c.files)), seenAt: seenAtOf(res.since) });
    } catch { /* keep what is shown */ }
  }, [projectId, branch, authEnabled, key]);

  useEffect(() => {
    void load();
    return () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  }, [load]);

  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; void load(); }, REFRESH_MS);
  }, [load]);

  const current = state?.key === key ? state : null;
  return { paths: current?.paths ?? NONE, seenAt: current?.seenAt ?? null, refresh };
}
