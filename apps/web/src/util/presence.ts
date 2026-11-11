import type { PresenceUser } from '../components/Presence';
import type { BranchPeer } from '../editor/branchSignal';

/** One person (or agent session) on the chip: in this file, or in `file`. */
export interface PresenceRow extends PresenceUser { here: boolean; file: string | null }

/**
 * The chip's people: those in the open file (its doc's awareness, carets and
 * all, agent sessions included), then everyone else on the branch with the
 * file they have open (the branch signal's roster). This person is left
 * out, in every tab of theirs; a peer the file's awareness has not reported
 * yet still counts as here.
 */
export function presenceRows(inFile: readonly PresenceUser[], peers: readonly BranchPeer[], activeFile: string | null, self: { name: string; color: string }): PresenceRow[] {
  const isSelf = (u: { name: string; color: string }) => u.name === self.name && u.color === self.color;
  const rows: PresenceRow[] = [];
  const seen = new Set<string>();
  const add = (row: PresenceRow) => {
    const key = `${row.name}\u0000${row.color}\u0000${row.here ? '' : row.file ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  };
  for (const u of inFile) if (u.isAgent || !isSelf(u)) add({ ...u, here: true, file: activeFile });
  const elsewhere: PresenceRow[] = [];
  for (const p of peers) {
    if (isSelf(p)) continue;
    const here = !!activeFile && p.file === activeFile;
    const row: PresenceRow = { name: p.name, color: p.color, ...(p.avatar ? { avatar: p.avatar } : {}), here, file: p.file };
    if (here) add(row);
    else elsewhere.push(row);
  }
  elsewhere.sort((a, b) => (a.file ?? '￿').localeCompare(b.file ?? '￿') || a.name.localeCompare(b.name));
  for (const r of elsewhere) add(r);
  return rows;
}
