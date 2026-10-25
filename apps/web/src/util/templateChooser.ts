import type { TemplateCategory, TemplateInfo, TemplateRepoState } from '../api';
import { friendlyDate } from './dates';

/** Gallery order; a category with no template in it is not drawn. */
export const TEMPLATE_CATEGORIES: TemplateCategory[] = ['General', 'Journals', 'Conferences', 'Theses', 'Slides'];

/** The rail entry that shows every group. */
export const ALL = 'all';

export function matchesQuery(t: TemplateInfo, q: string): boolean {
  const hay = [t.name, t.description, t.category, t.documentClass, t.id, t.kit?.host, t.source?.label].join(' ').toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}

/** Template ids from a repository are `repo:<repoId>/<folder>`. */
export function repoIdOf(t: TemplateInfo): string {
  return t.id.slice('repo:'.length).split('/')[0];
}

export interface GalleryGroup {
  key: string;
  testid: string;
  heading: string;
  /** Set on a repository whose last refresh failed while its previous checkout is still listed. */
  stale?: { repoId: string; text: string };
  items: TemplateInfo[];
}

/** Built-in categories in TEMPLATE_CATEGORIES order, with one group per
 *  repository (in config order) between 'General' and the venue categories.
 *  Repository templates are never placed in a category group. */
export function galleryGroups(shown: TemplateInfo[], repos: TemplateRepoState[]): GalleryGroup[] {
  const byRepo = new Map<string, TemplateInfo[]>();
  for (const t of shown) {
    if (t.source?.kind !== 'repo') continue;
    const id = repoIdOf(t);
    byRepo.set(id, [...(byRepo.get(id) ?? []), t]);
  }
  const repoOrder = [...repos.map((r) => r.id), ...byRepo.keys()].filter((id, i, all) => all.indexOf(id) === i);
  const repoGroups: GalleryGroup[] = [];
  for (const repoId of repoOrder) {
    const items = byRepo.get(repoId);
    if (!items?.length) continue;
    const state = repos.find((r) => r.id === repoId);
    const stale = state && !state.ok && state.available
      ? { repoId, text: state.syncedAt ? `last updated ${friendlyDate(state.syncedAt)}, refresh failed` : 'refresh failed' }
      : undefined;
    repoGroups.push({
      key: `repo:${repoId}`,
      testid: `template-category-repo-${repoId}`,
      heading: state?.label ?? items[0].source?.label ?? repoId,
      stale,
      items,
    });
  }
  const out: GalleryGroup[] = [];
  for (const cat of TEMPLATE_CATEGORIES) {
    const items = shown.filter((t) => t.source?.kind !== 'repo' && (t.category || 'General') === cat);
    if (items.length) out.push({ key: cat, testid: `template-category-${cat}`, heading: cat, items });
    if (cat === 'General') out.push(...repoGroups);
  }
  return out;
}

export interface RailEntry { key: string; label: string; count: number }

/** "All templates" first, then one entry per group of the whole list. */
export function railEntries(groups: GalleryGroup[]): RailEntry[] {
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  return [{ key: ALL, label: 'All templates', count: total }, ...groups.map((g) => ({ key: g.key, label: g.heading, count: g.items.length }))];
}

/** The templates on screen: the rail's group (or all), narrowed by the search. */
export function shownTemplates(list: TemplateInfo[], repos: TemplateRepoState[], rail: string, query: string): TemplateInfo[] {
  const q = query.trim().toLowerCase();
  const inRail = rail === ALL ? list : galleryGroups(list, repos).find((g) => g.key === rail)?.items ?? list;
  return q ? inRail.filter((t) => matchesQuery(t, q)) : inRail;
}

export interface TileBox { left: number; top: number; width: number }

/**
 * The tile an arrow key moves to, by where the tiles are drawn: left and
 * right step through reading order, up and down go to the nearest tile in
 * the row above or below, across group headings. -1 when there is none.
 */
export function moveInGrid(boxes: TileBox[], from: number, key: string): number {
  if (!boxes.length) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return boxes.length - 1;
  if (key === 'ArrowLeft') return from > 0 ? from - 1 : -1;
  if (key === 'ArrowRight') return from < boxes.length - 1 ? from + 1 : -1;
  if (key !== 'ArrowUp' && key !== 'ArrowDown') return -1;
  const cur = boxes[from];
  const down = key === 'ArrowDown';
  // Tiles of one row share a top; a few px of slack absorbs rounding.
  const rowTops = boxes.map((b) => b.top).filter((t) => (down ? t > cur.top + 2 : t < cur.top - 2));
  if (!rowTops.length) return -1;
  const row = down ? Math.min(...rowTops) : Math.max(...rowTops);
  const centre = cur.left + cur.width / 2;
  let best = -1;
  let bestDist = Infinity;
  boxes.forEach((b, i) => {
    if (Math.abs(b.top - row) > 2) return;
    const d = Math.abs(b.left + b.width / 2 - centre);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}
