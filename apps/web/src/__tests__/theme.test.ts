import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { APPEARANCES, parseAppearance, resolveTheme, THEME_COLOR, toggled, type Appearance, type Theme } from '../theme';

const INDEX = fileURLToPath(new URL('../../index.html', import.meta.url));

/** Run index.html's pre-paint script against a stored value and a system setting. */
function prepaint(stored: string | null | Error, systemDark: boolean | 'no-matchMedia'): { theme: string; color: string | null } {
  const html = readFileSync(INDEX, 'utf8');
  const code = /<script data-prepaint>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!code) throw new Error('index.html has no <script data-prepaint>');
  const meta = { content: null as string | null, setAttribute(_: string, v: string) { this.content = v; } };
  const document = { documentElement: { dataset: {} as Record<string, string> }, querySelector: () => meta };
  const window = {
    localStorage: { getItem: () => { if (stored instanceof Error) throw stored; return stored; } },
    matchMedia: systemDark === 'no-matchMedia' ? undefined : () => ({ matches: systemDark }),
  };
  new Function('window', 'document', code)(window, document);
  return { theme: document.documentElement.dataset.theme, color: meta.content };
}

describe('appearance', () => {
  it('is dark when nothing, or nothing it knows, is stored', () => {
    expect(parseAppearance(null)).toBe('dark');
    expect(parseAppearance(undefined)).toBe('dark');
    expect(parseAppearance('sepia')).toBe('dark');
    expect(parseAppearance('light')).toBe('light');
    expect(parseAppearance('system')).toBe('system');
  });

  it('asks the system only for "Match system"', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('a light/dark switch makes the opposite of what is on screen explicit', () => {
    expect(toggled('dark')).toBe('light');
    expect(toggled('light')).toBe('dark');
  });

  it('offers the three choices in the order the menus show them', () => {
    expect(APPEARANCES.map((a) => a.label)).toEqual(['Match system', 'Light', 'Dark']);
  });
});

describe('the pre-paint script in index.html', () => {
  const cases: [string | null, boolean][] = [
    [null, false], [null, true], ['dark', false], ['light', true], ['system', true], ['system', false], ['bogus', false],
  ];
  for (const [stored, systemDark] of cases) {
    it(`agrees with theme.ts for ${stored ?? 'nothing stored'} on a ${systemDark ? 'dark' : 'light'} system`, () => {
      const want: Theme = resolveTheme(parseAppearance(stored), systemDark);
      expect(prepaint(stored, systemDark)).toEqual({ theme: want, color: THEME_COLOR[want] });
    });
  }

  it('paints dark when storage is blocked or the system cannot be asked', () => {
    expect(prepaint(new Error('SecurityError'), false).theme).toBe('dark');
    expect(prepaint('system' as Appearance, 'no-matchMedia').theme).toBe('dark');
  });
});
