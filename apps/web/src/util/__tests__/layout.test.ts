import { describe, expect, it, vi } from 'vitest';

const stored = new Map<string, string>();
vi.mock('../safeStorage', () => ({
  safeStorage: { get: (k: string) => stored.get(k) ?? null, set: (k: string, v: string) => { stored.set(k, v); return true; } },
}));

import { LAYOUT, readLayout, rememberLayout, revealLayout, shownLayout } from '../layout';

describe('editor layout', () => {
  it('opens a narrow window on the editor alone until a layout is chosen', () => {
    expect(shownLayout(null, 1440)).toBe('both');
    expect(shownLayout(null, 800)).toBe('both');
    expect(shownLayout(null, 799)).toBe('editor');
    expect(shownLayout(null, 683)).toBe('editor');
    expect(shownLayout('both', 683)).toBe('both');
    expect(shownLayout('pdf', 1440)).toBe('pdf');
  });

  it('remembers the choice and ignores anything else stored under its key', () => {
    expect(readLayout()).toBeNull();
    rememberLayout('pdf');
    expect(readLayout()).toBe('pdf');
    stored.set(LAYOUT, 'sideways');
    expect(readLayout()).toBeNull();
  });

  it('shows both panes for a jump into the hidden one, and switches nothing when it shows', () => {
    expect(revealLayout('editor', 'pdf')).toBe('both');
    expect(revealLayout('pdf', 'editor')).toBe('both');
    expect(revealLayout('editor', 'editor')).toBe('editor');
    expect(revealLayout('both', 'pdf')).toBe('both');
    expect(revealLayout('pdf', 'pdf')).toBe('pdf');
  });
});
