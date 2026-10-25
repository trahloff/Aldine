import type { ProjectSummary } from '../api';
import { timeAgo, timeSection } from './dates';

/**
 * What the project list shows and in which order, kept free of the DOM: the
 * sort, the filters, search, the time sections, and the sentence under each
 * project.
 */

export type SortKey = 'edited' | 'opened' | 'name' | 'created';
export type Show = 'all' | 'shared' | 'trash';

export const SORTS: readonly { id: SortKey; label: string }[] = [
  { id: 'edited', label: 'Last edited' },
  { id: 'opened', label: 'Last opened by me' },
  { id: 'name', label: 'Name' },
  { id: 'created', label: 'Date created' },
];

export const SORT_KEY = 'aldine.home.sort';

export function parseSort(raw: string | null | undefined): SortKey {
  return SORTS.some((s) => s.id === raw) ? (raw as SortKey) : 'edited';
}

/** `?show=` as a place; "shared" exists only with accounts. */
export function parseShow(raw: string | null | undefined, accounts: boolean): Show {
  if (raw === 'trash') return 'trash';
  if (raw === 'shared' && accounts) return 'shared';
  return 'all';
}

/** When the project's files last changed; a project from before that was recorded counts from its creation. */
export function editedAt(p: Pick<ProjectSummary, 'lastEdit' | 'createdAt'>): string {
  return p.lastEdit?.at ?? p.createdAt;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const time = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() || 0 : 0);

/** The time a date sort orders by, or null for a project never opened under "Last opened by me". */
export function sortTime(p: ProjectSummary, key: SortKey): string | null {
  if (key === 'opened') return p.opened?.at ?? null;
  if (key === 'created') return p.createdAt;
  return editedAt(p);
}

/** Newest first for the date sorts, A to Z by name; projects never opened go last under "Last opened by me". */
export function sortProjects(list: readonly ProjectSummary[], key: SortKey): ProjectSummary[] {
  const out = [...list];
  if (key === 'name') return out.sort((a, b) => collator.compare(a.name, b.name));
  return out.sort((a, b) => {
    const ta = sortTime(a, key);
    const tb = sortTime(b, key);
    if (ta === null || tb === null) {
      if (ta !== tb) return ta === null ? 1 : -1;
      return time(editedAt(b)) - time(editedAt(a)) || collator.compare(a.name, b.name);
    }
    return time(tb) - time(ta) || collator.compare(a.name, b.name);
  });
}

/** Someone else's project that the caller sees as a collaborator or through a link. */
export function isSharedWithMe(p: ProjectSummary): boolean {
  if (p.access) return p.access !== 'owner';
  return !!p.ownerId && p.isOwner === false;
}

/** Every word of the query appears in the name, the owner's name or the branch the project opens on. */
export function matchesQuery(p: ProjectSummary, query: string): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [p.name, p.ownerName, p.opened?.branch].filter(Boolean).join(' ').toLocaleLowerCase();
  return words.every((w) => hay.includes(w));
}

/** The last edit was made by a person or agent other than the caller. */
export function editedByOther(p: ProjectSummary, myId: string | null): boolean {
  const e = p.lastEdit;
  return !!e && !!e.byName && (e.byId === null || e.byId !== myId);
}

/** Changed by someone else since the caller last opened it. */
export function isUnread(p: ProjectSummary, myId: string | null): boolean {
  if (!editedByOther(p, myId)) return false;
  if (!p.opened) return true;
  return time(p.lastEdit!.at) > time(p.opened.at);
}

/** The first word of a name: "Grace" for "Grace Hopper". */
export function firstName(name: string | null | undefined): string {
  return (name || '').trim().split(/\s+/)[0] ?? '';
}

/** A recipient's sheet always names the owner on a chip. */
export function ownerChipShown(p: ProjectSummary, accounts: boolean): boolean {
  return accounts && !!p.ownerId && isSharedWithMe(p);
}

/**
 * "Edited 3 minutes ago", "Grace Hopper edited yesterday", "Created 2 days ago". The name truncates, the time does
 * not. `ownerOnChip`: the owner is named on a chip already, so their own edit reads "Edited …". `short`, for a
 * phone: "Grace · 3 hr ago", "Edited 3 min ago".
 */
export function metaLine(p: ProjectSummary, myId: string | null, now: number, opts: { ownerOnChip?: boolean; short?: boolean } = {}): { who: string | null; text: string } {
  const short = !!opts.short;
  if (!p.lastEdit) return { who: null, text: `Created ${timeAgo(p.createdAt, now, { short })}` };
  const ago = timeAgo(p.lastEdit.at, now, { short });
  if (editedByOther(p, myId) && !(opts.ownerOnChip && p.lastEdit.byId === p.ownerId)) {
    return short ? { who: firstName(p.lastEdit.byName), text: `· ${ago}` } : { who: p.lastEdit.byName, text: `edited ${ago}` };
  }
  return { who: null, text: `Edited ${ago}` };
}

/** The branch whose PDF "Download PDF" fetches: the finished typeset's, which a thumbnail fallen back to main's does not name. */
export function pdfBranch(p: Pick<ProjectSummary, 'compile' | 'thumb' | 'opened'>): string {
  if (p.compile?.status === 'ok') return p.compile.branch;
  return p.thumb?.branch ?? p.opened?.branch ?? 'main';
}

/** Time sections appear from this many projects up, and only under a date sort. */
export const SECTION_MIN = 8;

export interface ShelfSection { key: string; label: string | null; items: ProjectSummary[] }

/** A month or year with fewer projects than this does not get a heading of its own. */
export const SECTION_SPARSE = 3;
const isOld = (key: string) => /^(m\d+|y\d+|older)$/.test(key);

/** The list cut into Today / Yesterday / … sections, or one untitled section. */
export function sectionsOf(list: readonly ProjectSummary[], sort: SortKey, now: number): ShelfSection[] {
  if (sort === 'name' || list.length < SECTION_MIN) return [{ key: 'all', label: null, items: [...list] }];
  const out: ShelfSection[] = [];
  for (const p of list) {
    const at = sortTime(p, sort);
    const s = at ? timeSection(at, now) : { key: 'never', label: 'Not opened yet' };
    const last = out[out.length - 1];
    if (last && last.key === s.key) last.items.push(p);
    else out.push({ key: s.key, label: s.label, items: [p] });
  }
  // From the first sparse month or year on, the rest is one "Earlier".
  const at = out.findIndex((s) => isOld(s.key) && s.items.length < SECTION_SPARSE);
  if (at < 0) return out;
  const rest = out.slice(at);
  const old = rest.filter((s) => isOld(s.key));
  const earlier: ShelfSection = { key: 'earlier', label: 'Earlier', items: old.flatMap((s) => s.items) };
  return [...out.slice(0, at), earlier, ...rest.filter((s) => !isOld(s.key))];
}

/** The editor link: on the branch the caller last had open. */
export function projectHref(p: Pick<ProjectSummary, 'id' | 'opened'>): string {
  const b = p.opened?.branch;
  return b && b !== 'main' ? `/p/${p.id}?branch=${encodeURIComponent(b)}` : `/p/${p.id}`;
}

/** What the search's live region says. */
export function matchSentence(n: number, query: string): string {
  if (n === 0) return `No projects match “${query.trim()}”`;
  return n === 1 ? '1 project matches' : `${n} projects match`;
}

/** "4 errors", "1 error", or a failed typeset that named none. */
export function errorLabel(errors: number): string {
  if (errors <= 0) return 'Typeset failed';
  return errors === 1 ? '1 error' : `${errors} errors`;
}

/** Up to two initials for an avatar. */
export function initials(name: string | null | undefined): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = [...parts[0]][0] ?? '';
  const last = parts.length > 1 ? [...parts[parts.length - 1]][0] ?? '' : '';
  return (first + last).toLocaleUpperCase();
}

/** Where a project's PDF is served, from its root file: "paper/main.tex" → "paper/.aldine-out/main.pdf". */
export function pdfOutputPath(rootFile: string): string {
  const slash = rootFile.lastIndexOf('/');
  const dir = slash >= 0 ? rootFile.slice(0, slash + 1) : '';
  const base = rootFile.slice(slash + 1).replace(/\.tex$/i, '');
  return `${dir}.aldine-out/${base}.pdf`;
}
