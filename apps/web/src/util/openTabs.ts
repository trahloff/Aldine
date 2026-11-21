import { safeStorage, type SafeStore } from './safeStorage';

/** The files a project's branch has open as tabs in this browser, in strip order. */
const key = (projectId: string, branch: string) => `aldine.openTabs.${projectId}.${branch}`;

/** More than this and the oldest tabs past the open file drop off the end of the list kept. */
export const MAX_TABS = 30;

export function loadTabs(projectId: string, branch: string, store: SafeStore = safeStorage): string[] {
  try {
    const v = JSON.parse(store.get(key(projectId, branch)) || '[]');
    return Array.isArray(v) ? [...new Set(v.filter((p): p is string => typeof p === 'string' && !!p))].slice(0, MAX_TABS) : [];
  } catch {
    return [];
  }
}

export function saveTabs(projectId: string, branch: string, tabs: readonly string[], store: SafeStore = safeStorage): void {
  if (tabs.length) store.set(key(projectId, branch), JSON.stringify(tabs.slice(0, MAX_TABS)));
  else store.remove(key(projectId, branch));
}

/** `path` as a tab: where it is when already open, else right after `after` (the file open before), else last. */
export function withTab(tabs: readonly string[], path: string, after: string | null): string[] {
  if (tabs.includes(path)) return tabs as string[];
  const at = after ? tabs.indexOf(after) : -1;
  const next = at < 0 ? [...tabs, path] : [...tabs.slice(0, at + 1), path, ...tabs.slice(at + 1)];
  if (next.length <= MAX_TABS) return next;
  const drop = next.findIndex((p) => p !== path);
  return next.filter((_, i) => i !== drop);
}

/** The strip without `path`, and the file to show: the open one, or for a closed open one its right neighbour, else its left, else none. */
export function closeTab(tabs: readonly string[], path: string, active: string | null): { tabs: string[]; active: string | null } {
  const i = tabs.indexOf(path);
  if (i < 0) return { tabs: tabs as string[], active };
  const rest = tabs.filter((p) => p !== path);
  if (active !== path) return { tabs: rest, active };
  return { tabs: rest, active: rest[i] ?? rest[i - 1] ?? null };
}

/** Tabs at or under `from` (a file or a folder) under `to` instead, in place. */
export function renameTabs(tabs: readonly string[], from: string, to: string): string[] {
  const moved = tabs.map((p) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p));
  return [...new Set(moved)];
}

/** What each tab shows: the file name, with as much of its folder as tells two same-named files apart. */
export function tabLabels(tabs: readonly string[]): string[] {
  const parts = tabs.map((p) => p.split('/'));
  return parts.map((segs, i) => {
    for (let n = 1; n <= segs.length; n++) {
      const tail = segs.slice(-n).join('/');
      if (!parts.some((o, j) => j !== i && o.slice(-n).join('/') === tail)) return tail;
    }
    return tabs[i];
  });
}
