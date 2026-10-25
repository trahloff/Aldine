import { useSyncExternalStore } from 'react';
import { safeStorage } from './util/safeStorage';

/** What is drawn: `data-theme` on <html>. */
export type Theme = 'light' | 'dark';
/** What the person chose. "system" follows the operating system's setting. */
export type Appearance = 'system' | 'light' | 'dark';

export const THEME_KEY = 'aldine.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Each theme's --bg-app, for the browser's own chrome. The pre-paint script
 *  in index.html repeats these two values and the rules below. */
export const THEME_COLOR: Record<Theme, string> = { dark: '#1c1c1e', light: '#f5f5f7' };

export const APPEARANCES: readonly { id: Appearance; label: string }[] = [
  { id: 'system', label: 'Match system' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

/** Dark is Aldine's default: nothing stored, or anything unknown, is dark. */
export function parseAppearance(raw: string | null | undefined): Appearance {
  return raw === 'light' || raw === 'system' || raw === 'dark' ? raw : 'dark';
}

export function resolveTheme(appearance: Appearance, systemDark: boolean): Theme {
  if (appearance === 'system') return systemDark ? 'dark' : 'light';
  return appearance;
}

/** The explicit choice a light/dark switch makes from what is on screen. */
export function toggled(current: Theme): Theme {
  return current === 'dark' ? 'light' : 'dark';
}

function darkMedia(): MediaQueryList | null {
  try { return typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(DARK_QUERY) : null; } catch { return null; }
}

/** Without a media query to ask, "system" falls back to the default. */
function systemIsDark(): boolean {
  return darkMedia()?.matches ?? true;
}

let appearance: Appearance = parseAppearance(safeStorage.get(THEME_KEY));
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function getAppearance(): Appearance {
  return appearance;
}

export function getTheme(): Theme {
  return resolveTheme(appearance, systemIsDark());
}

function paint(t: Theme, animate: boolean): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const apply = () => {
    root.dataset.theme = t;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[t]);
  };
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  // Only an actual change cross-fades; a view transition freezes input for
  // its duration, and re-selecting the current theme should cost nothing.
  if (animate && doc.startViewTransition && root.dataset.theme !== t) doc.startViewTransition(apply);
  else apply();
}

export function setAppearance(next: Appearance): void {
  appearance = next;
  safeStorage.set(THEME_KEY, next);
  paint(getTheme(), true);
  notify();
}

/** An explicit light or dark choice. */
export function setTheme(t: Theme): void {
  setAppearance(t);
}

export function toggleTheme(): Theme {
  const next = toggled(getTheme());
  setAppearance(next);
  return next;
}

let syncing = false;

/**
 * Keeps the page on the chosen appearance after first paint: follows the
 * system while the choice is "system", and follows a choice made in another
 * tab. Called once at startup.
 */
export function startThemeSync(): void {
  if (syncing || typeof window === 'undefined') return;
  syncing = true;
  paint(getTheme(), false);
  darkMedia()?.addEventListener('change', () => {
    if (appearance === 'system') { paint(getTheme(), true); notify(); }
  });
  window.addEventListener('storage', (e) => {
    if (e.key !== THEME_KEY) return;
    appearance = parseAppearance(e.newValue);
    paint(getTheme(), false);
    notify();
  });
}

function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

/** The stored choice, live across changes from anywhere. */
export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, getAppearance, getAppearance);
}

/** What is on screen, live across a system switch while following it. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, getTheme);
}
