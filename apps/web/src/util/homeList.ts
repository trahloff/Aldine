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

/** "Edited 3 minutes ago", "Grace Hopper edited yesterday", "Created 2 days ago". */
export function metaLine(p: ProjectSummary, myId: string | null, now: number): { who: string | null; text: string } {
  if (!p.lastEdit) return { who: null, text: `Created ${timeAgo(p.createdAt, now)}` };
  const ago = timeAgo(p.lastEdit.at, now);
  // The first name: "Grace edited 3 hours ago" fits under a sheet, the full name is on the owner chip.
  if (editedByOther(p, myId)) return { who: firstName(p.lastEdit.byName), text: `edited ${ago}` };
  return { who: null, text: `Edited ${ago}` };
}

/** "Grace" from "Grace Hopper"; a one-word or unusual name stays whole. */
export function firstName(name: string | null): string | null {
  if (!name) return name;
  const first = name.trim().split(/\s+/)[0];
  return first.length >= 2 ? first : name;
}

/** Time sections appear from this many projects up, and only under a date sort. */
export const SECTION_MIN = 8;

export interface ShelfSection { key: string; label: string | null; items: ProjectSummary[] }

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
  return out;
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
