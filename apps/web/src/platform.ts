/**
 * Platform-aware keyboard labels. The handlers accept both metaKey and
 * ctrlKey everywhere, but a hardcoded ⌘ makes every non-Mac user's first
 * on-screen instruction wrong for their keyboard.
 */
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform || '');

/** "⌘S" on Mac, "Ctrl+S" elsewhere; with `shift`, "⇧⌘M" and "Ctrl+Shift+M". */
export function shortcut(key: string, opts?: { shift?: boolean }): string {
  if (isMac) return `${opts?.shift ? '⇧' : ''}⌘${key}`;
  return `Ctrl+${opts?.shift ? 'Shift+' : ''}${key}`;
}
