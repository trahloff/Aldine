export type Theme = 'light' | 'dark';

/** Dark is Aldine's default; an explicit user choice is stored and wins. */
export function getTheme(): Theme {
  return localStorage.getItem('aldine.theme') === 'light' ? 'light' : 'dark';
}

export function setTheme(t: Theme): void {
  localStorage.setItem('aldine.theme', t);
  const apply = () => { document.documentElement.dataset.theme = t; };
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  // Only an actual change cross-fades; a view transition freezes input for
  // its duration, and re-selecting the current theme should cost nothing.
  if (doc.startViewTransition && document.documentElement.dataset.theme !== t) doc.startViewTransition(apply);
  else apply();
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}
