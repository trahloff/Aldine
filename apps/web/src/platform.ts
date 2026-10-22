/**
 * Platform-aware keyboard labels. The handlers accept both metaKey and
 * ctrlKey everywhere, but a hardcoded ⌘ makes every non-Mac user's first
 * on-screen instruction wrong for their keyboard.
 */
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform || '');

/** "⌘B" on Mac, "Ctrl+B" elsewhere, for the editor's fixed keys; the
 *  changeable ones are labelled by util/shortcuts.ts. */
export function shortcut(key: string): string {
  return isMac ? `⌘${key}` : `Ctrl+${key}`;
}
