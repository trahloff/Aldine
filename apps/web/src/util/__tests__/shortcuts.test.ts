import { describe, expect, it } from 'vitest';
import { chordConflict, chordFor, chordFromEvent, chordProblem, formatChord, isDefaultChord, matchesChord, setChord } from '../shortcuts';

const key = (k: string, code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}, altGraph = false) =>
  ({ key: k, code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods, getModifierState: (m: string) => m === 'AltGraph' && altGraph }) as unknown as KeyboardEvent;

describe('shortcut labels', () => {
  it('writes the Mac glyphs in Apple order and spells the chord out elsewhere', () => {
    expect(formatChord(chordFor('comment'), true)).toBe('⇧⌘M');
    expect(formatChord(chordFor('comment'), false)).toBe('Ctrl+Shift+M');
    const optionP = { mod: true, shift: true, alt: true, key: 'p', code: 'KeyP' };
    expect(formatChord(optionP, true)).toBe('⌥⇧⌘P');
    expect(formatChord(optionP, false)).toBe('Ctrl+Alt+Shift+P');
    expect(formatChord({ mod: true, shift: false, alt: false, key: 'Enter' }, true)).toBe('⌘↩');
  });

  it('searches the project on Shift+Mod+F, which nothing else takes', () => {
    const search = chordFor('search');
    expect(chordProblem(search, 'search', true)).toBeNull();
    expect(chordProblem(search, 'search', false)).toBeNull();
    expect(formatChord(search, true)).toBe('⇧⌘F');
    expect(formatChord(search, false)).toBe('Ctrl+Shift+F');
    expect(matchesChord(key('F', 'KeyF', { metaKey: true, shiftKey: true }), search)).toBe(true);
  });

  it('names the clash when a chord saved earlier is a new default too', () => {
    expect(chordConflict('jump')).toBeNull();
    setChord('jump', { mod: true, shift: true, alt: false, key: 'f', code: 'KeyF' });
    expect(chordConflict('jump')).toBe('Search the project');
    expect(chordConflict('search')).toBe('Jump the PDF to the cursor');
    setChord('jump', null);
    expect(chordConflict('search')).toBeNull();
  });
});

describe('matching a keydown', () => {
  it('takes Cmd or Ctrl as the modifier, and needs the exact extra modifiers', () => {
    const comment = chordFor('comment');
    expect(matchesChord(key('M', 'KeyM', { metaKey: true, shiftKey: true }), comment)).toBe(true);
    expect(matchesChord(key('M', 'KeyM', { ctrlKey: true, shiftKey: true }), comment)).toBe(true);
    expect(matchesChord(key('m', 'KeyM', { metaKey: true }), comment)).toBe(false);
    expect(matchesChord(key('M', 'KeyM', { metaKey: true, shiftKey: true, altKey: true }), comment)).toBe(false);
  });

  it('finds a default by the letter printed on the key, so AZERTY works', () => {
    expect(matchesChord(key('M', 'Semicolon', { ctrlKey: true, shiftKey: true }), chordFor('comment'))).toBe(true);
  });

  it('finds a recorded chord by the physical key, which Option does not change', () => {
    const recorded = chordFromEvent(key('π', 'KeyP', { metaKey: true, altKey: true }))!;
    expect(recorded.key).toBe('p');
    expect(matchesChord(key('π', 'KeyP', { metaKey: true, altKey: true }), recorded)).toBe(true);
  });

  it('ignores AltGr, which types characters', () => {
    const recorded = { mod: true, shift: false, alt: true, key: 'q', code: 'KeyQ' };
    expect(matchesChord(key('@', 'KeyQ', { ctrlKey: true, altKey: true }, true), recorded)).toBe(false);
  });

  it('waits while only modifiers are held', () => {
    expect(chordFromEvent(key('Shift', 'ShiftLeft', { shiftKey: true }))).toBeNull();
    expect(chordFromEvent(key('Meta', 'MetaLeft', { metaKey: true }))).toBeNull();
  });
});

describe('choosing a chord', () => {
  it('refuses a bare key, the browser\'s keys, the editor\'s keys and a twin', () => {
    expect(chordProblem({ mod: false, shift: true, alt: false, key: 'm' }, 'comment', true)).toMatch(/Hold ⌘/);
    expect(chordProblem({ mod: true, shift: false, alt: false, key: 'w' }, 'comment', true)).toBe('⌘W belongs to the browser');
    expect(chordProblem({ mod: true, shift: false, alt: false, key: 'b' }, 'comment', false)).toBe('Ctrl+B is Bold in the editor');
    expect(chordProblem({ mod: true, shift: false, alt: false, key: 'k' }, 'comment', true)).toBe('⌘K is already Command palette');
    expect(chordProblem({ mod: true, shift: false, alt: false, key: 'e' }, 'comment', true)).toBeNull();
    expect(chordProblem({ mod: false, shift: false, alt: false, key: 'F2', code: 'F2' }, 'comment', true)).toBeNull();
  });

  it('keeps a change until it is reset, and a reset is the default again', () => {
    setChord('comment', { mod: true, shift: false, alt: false, key: 'e', code: 'KeyE' });
    expect(isDefaultChord('comment')).toBe(false);
    expect(formatChord(chordFor('comment'), true)).toBe('⌘E');
    setChord('comment', null);
    expect(isDefaultChord('comment')).toBe(true);
    expect(formatChord(chordFor('comment'), true)).toBe('⇧⌘M');
  });
});
