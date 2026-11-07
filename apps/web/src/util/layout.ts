import { safeStorage } from './safeStorage';

/** What the editor page shows beside the sidebar: the code, the PDF, or both side by side. */
export type Layout = 'editor' | 'both' | 'pdf';

/** The layout last chosen with the toggle or the palette; unset, the window's width decides. */
export const LAYOUT = 'aldine.layout';

/** Narrower than this a window opens on the editor alone: side by side, the code gets about 20 characters a line. */
export const BOTH_MIN_WIDTH = 800;

export const LAYOUTS: ReadonlyArray<{ id: Layout; label: string; title: string }> = [
  { id: 'editor', label: 'Editor', title: 'Show the editor only' },
  { id: 'both', label: 'Both', title: 'Show the editor and the PDF side by side' },
  { id: 'pdf', label: 'PDF', title: 'Show the PDF only' },
];

export function readLayout(): Layout | null {
  const v = safeStorage.get(LAYOUT);
  return v === 'editor' || v === 'both' || v === 'pdf' ? v : null;
}

export function rememberLayout(layout: Layout): void {
  safeStorage.set(LAYOUT, layout);
}

/** The layout on screen: the one chosen, or the editor alone in a narrow window and both otherwise. */
export function shownLayout(chosen: Layout | null, width: number): Layout {
  return chosen ?? (width < BOTH_MIN_WIDTH ? 'editor' : 'both');
}

/**
 * The layout a jump into the hidden pane switches to (Jump to PDF from the
 * editor alone, a double-click in the PDF alone): both panes, so the place
 * jumped from stays on screen. A pane already showing needs no switch.
 */
export function revealLayout(shown: Layout, want: 'editor' | 'pdf'): Layout {
  return shown === 'both' || shown === want ? shown : 'both';
}
