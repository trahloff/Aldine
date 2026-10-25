import { safeStorage } from './safeStorage';
/**
 * Where the review mark lives without accounts: there is no user to key a
 * server row on, so it is per browser. With accounts the server owns it
 * (project_visits) and this module is not used.
 */
export interface SeenMark { head: string; at: string; promptedHead: string | null }

const key = (projectId: string, branch: string) => `aldine.agentSeen.${projectId}.${branch}`;

export function readSeen(projectId: string, branch: string): SeenMark | null {
  const v = safeStorage.getJSON<Partial<SeenMark> | null>(key(projectId, branch), null);
  // A hand-edited or half-written value must not break the editor.
  if (!v || typeof v !== 'object' || typeof v.head !== 'string') return null;
  return { head: v.head, at: typeof v.at === 'string' ? v.at : new Date(0).toISOString(), promptedHead: typeof v.promptedHead === 'string' ? v.promptedHead : null };
}

function write(projectId: string, branch: string, v: SeenMark): void {
  // A write that fails only means the prompt returns next time.
  safeStorage.setJSON(key(projectId, branch), v);
}

/** A prompt was raised for `head`; a second sighting of the same head counts
 *  as the acknowledgement, so an ignored prompt never repeats forever. */
export function markPrompted(projectId: string, branch: string, head: string): void {
  const prev = readSeen(projectId, branch);
  if (prev?.promptedHead === head) {
    write(projectId, branch, { head, at: new Date().toISOString(), promptedHead: head });
    return;
  }
  // No acknowledged head means no time either: an empty mark must not bound
  // the next answer to commits newer than the prompt it was raised by.
  write(projectId, branch, { head: prev?.head ?? '', at: prev?.at ?? '', promptedHead: head });
}

export function markAcknowledged(projectId: string, branch: string, head: string): void {
  write(projectId, branch, { head, at: new Date().toISOString(), promptedHead: head });
}
