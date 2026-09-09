/**
 * Where the review mark lives without accounts: there is no user to key a
 * server row on, so it is per browser. With accounts the server owns it
 * (project_visits) and this module is not used.
 */
export interface SeenMark { head: string; at: string; promptedHead: string | null }

const key = (projectId: string, branch: string) => `aldine.agentSeen.${projectId}.${branch}`;

export function readSeen(projectId: string, branch: string): SeenMark | null {
  try {
    const raw = localStorage.getItem(key(projectId, branch));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SeenMark>;
    // A hand-edited or half-written value must not break the editor.
    if (!v || typeof v.head !== 'string') return null;
    return { head: v.head, at: typeof v.at === 'string' ? v.at : new Date(0).toISOString(), promptedHead: typeof v.promptedHead === 'string' ? v.promptedHead : null };
  } catch { return null; }
}

function write(projectId: string, branch: string, v: SeenMark): void {
  // Safari private mode throws on every write.
  try { localStorage.setItem(key(projectId, branch), JSON.stringify(v)); } catch { /* the prompt returns next time */ }
}

/** A prompt was raised for `head`; a second sighting of the same head counts
 *  as the acknowledgement, so an ignored prompt never repeats forever. */
export function markPrompted(projectId: string, branch: string, head: string): void {
  const prev = readSeen(projectId, branch);
  if (prev?.promptedHead === head) {
    write(projectId, branch, { head, at: new Date().toISOString(), promptedHead: head });
    return;
  }
  write(projectId, branch, { head: prev?.head ?? '', at: prev?.at ?? new Date().toISOString(), promptedHead: head });
}

export function markAcknowledged(projectId: string, branch: string, head: string): void {
  write(projectId, branch, { head, at: new Date().toISOString(), promptedHead: head });
}
