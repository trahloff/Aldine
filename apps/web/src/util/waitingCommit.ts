import { api } from '../api';
import type { Dialogs } from '../components/Dialogs';

/** What the person is about to do: "before branching", and the button that does both. */
export interface WaitingAction { before: string; confirmLabel: string }

/** "a.tex, b.tex and 3 more" */
function nameList(paths: string[]): string {
  if (paths.length <= 3) return paths.length === 1 ? paths[0] : `${paths.slice(0, -1).join(', ')} and ${paths[paths.length - 1]}`;
  return `${paths.slice(0, 3).join(', ')} and ${paths.length - 3} more`;
}

/**
 * A branch, a merge or an undo commits whatever waits on the branches it
 * touches first. With manual commits that is the person's commit to name:
 * ask for its message. Resolves the message; undefined when nothing waits;
 * null when the person cancelled, and the action must not run.
 */
export async function askWaitingCommit(dialogs: Dialogs, projectId: string, branches: string[], action: WaitingAction): Promise<string | null | undefined> {
  const lists = await Promise.all(branches.map((b) => api.changes(projectId, b).then((r) => r.paths, () => [] as string[])));
  const paths = [...new Set(lists.flat())];
  if (!paths.length) return undefined;
  const n = paths.length;
  const message = await dialogs.prompt({
    title: `Commit ${n} waiting ${n === 1 ? 'file' : 'files'} before ${action.before}`,
    body: `${nameList(paths)} ${n === 1 ? 'is' : 'are'} not committed yet. ${n === 1 ? 'It goes' : 'They go'} into a commit with this message first.`,
    placeholder: 'Commit message',
    confirmLabel: action.confirmLabel,
  });
  return message === null ? null : message.trim() || null;
}
