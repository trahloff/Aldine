/** A warning's identity across typesets: the page and line it mentions move
 *  with every edit, what it is about (a citation key, a label) does not. */
export function warningKey(message: string): string {
  return message
    .replace(/\b(pages?|lines?)\s+\d+(\s*--?\s*\d+)?/gi, (_, word: string) => `${word} #`)
    .replace(/\(\d+(\.\d+)?pt too (wide|high)\)/g, '(#pt too $2)')
    .replace(/\s+/g, ' ')
    .trim();
}

const storageKey = (projectId: string) => `aldine.ignoredWarnings.${projectId}`;

export function loadIgnored(projectId: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(storageKey(projectId)) || '[]');
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
  } catch { return []; }
}

export function saveIgnored(projectId: string, keys: string[]): void {
  try {
    if (keys.length) localStorage.setItem(storageKey(projectId), JSON.stringify(keys));
    else localStorage.removeItem(storageKey(projectId));
  } catch { /* private mode: ignoring lasts until reload */ }
}
