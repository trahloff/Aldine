import { useSyncExternalStore } from 'react';
import { isMac } from '../platform';

/**
 * A key chord. `mod` is ⌘ on a Mac and Ctrl elsewhere; the handlers accept
 * either on every platform. A chord recorded in settings also carries `code`,
 * the physical key, because Option and AltGr change what `key` reports; the
 * defaults match `key`, so an AZERTY keyboard finds M where it prints it.
 */
export interface Chord { mod: boolean; shift: boolean; alt: boolean; key: string; code?: string }

export type ShortcutId = 'typeset' | 'comment' | 'jump' | 'palette';

export const SHORTCUTS: readonly { id: ShortcutId; label: string; chord: Chord }[] = [
  { id: 'typeset', label: 'Typeset', chord: { mod: true, shift: false, alt: false, key: 's' } },
  // Shift, not Alt: Ctrl+Alt is AltGr on German Windows keyboards.
  { id: 'comment', label: 'Comment on the selection', chord: { mod: true, shift: true, alt: false, key: 'm' } },
  { id: 'jump', label: 'Jump the PDF to the cursor', chord: { mod: true, shift: false, alt: false, key: 'j' } },
  { id: 'palette', label: 'Command palette', chord: { mod: true, shift: false, alt: false, key: 'k' } },
];

/** What the browser keeps for itself, or the editor already does, under a chord. */
const TAKEN: Record<string, string> = {
  'mod+w': 'the browser', 'mod+t': 'the browser', 'mod+n': 'the browser', 'mod+q': 'the browser', 'mod+r': 'the browser',
  'mod+shift+w': 'the browser', 'mod+shift+t': 'the browser', 'mod+shift+n': 'the browser', 'mod+shift+r': 'the browser',
  'mod+z': 'Undo', 'mod+shift+z': 'Redo', 'mod+y': 'Redo',
  'mod+c': 'Copy', 'mod+x': 'Cut', 'mod+v': 'Paste', 'mod+a': 'Select all',
  'mod+f': 'Find', 'mod+g': 'Find next', 'mod+shift+g': 'Find previous', 'mod+d': 'Select next match',
  'mod+b': 'Bold', 'mod+i': 'Italic', 'mod+/': 'Comment out lines',
  'mod+enter': 'New line below', 'mod+[': 'Outdent', 'mod+]': 'Indent', 'mod+shift+k': 'Delete line',
};

const STORE = 'aldine.shortcuts';
const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Shift', 'Alt', 'AltGraph', 'CapsLock', 'Fn', 'FnLock', 'OS', 'Hyper', 'Super']);

const defaultChord = (id: ShortcutId): Chord => SHORTCUTS.find((s) => s.id === id)!.chord;

function isChord(v: unknown): v is Chord {
  const c = v as Chord;
  return !!c && typeof c === 'object' && typeof c.mod === 'boolean' && typeof c.shift === 'boolean'
    && typeof c.alt === 'boolean' && typeof c.key === 'string' && c.key.length > 0
    && (c.code === undefined || typeof c.code === 'string');
}

function read(): Partial<Record<ShortcutId, Chord>> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || '{}');
    const out: Partial<Record<ShortcutId, Chord>> = {};
    for (const s of SHORTCUTS) if (isChord(raw?.[s.id])) out[s.id] = raw[s.id];
    return out;
  } catch {
    return {};
  }
}

let overrides = read();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => { if (e.key === STORE) { overrides = read(); notify(); } });
}

export function chordFor(id: ShortcutId): Chord {
  return overrides[id] ?? defaultChord(id);
}

export function isDefaultChord(id: ShortcutId): boolean {
  return !overrides[id];
}

/** null puts the default back. */
export function setChord(id: ShortcutId, chord: Chord | null): void {
  const next = { ...overrides };
  if (!chord || sameChord(chord, defaultChord(id))) delete next[id];
  else next[id] = chord;
  overrides = next;
  try { localStorage.setItem(STORE, JSON.stringify(next)); } catch { /* private window: this tab keeps it */ }
  notify();
}

function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

/** The chord's on-screen label, live across a change in settings. */
export function useShortcutLabel(id: ShortcutId): string {
  useSyncExternalStore(subscribe, () => overrides);
  return formatChord(chordFor(id));
}

/** The letter or digit a physical key carries on a US layout, if it is one. */
function keyFromCode(code: string | undefined): string | null {
  const m = code && /^(?:Key([A-Z])|Digit(\d)|(F\d{1,2}))$/.exec(code);
  if (!m) return null;
  return m[1] ? m[1].toLowerCase() : m[2] ?? m[3];
}

function normalKey(c: Chord): string {
  return (c.code && keyFromCode(c.code)) || c.key.toLowerCase();
}

function chordId(c: Chord): string {
  return `${c.mod ? 'mod+' : ''}${c.alt ? 'alt+' : ''}${c.shift ? 'shift+' : ''}${normalKey(c)}`;
}

export function sameChord(a: Chord, b: Chord): boolean {
  return chordId(a) === chordId(b);
}

export function matchesChord(e: KeyboardEvent, c: Chord): boolean {
  if ((e.metaKey || e.ctrlKey) !== c.mod || e.shiftKey !== c.shift || e.altKey !== c.alt) return false;
  // AltGr reports Ctrl+Alt on Windows, and it types characters.
  if (e.getModifierState?.('AltGraph')) return false;
  return c.code ? e.code === c.code : e.key.toLowerCase() === c.key;
}

export function matchesShortcut(e: KeyboardEvent, which: ShortcutId): boolean {
  return matchesChord(e, chordFor(which));
}

/** The chord a keydown spells, or null while only modifiers are held. */
export function chordFromEvent(e: KeyboardEvent): Chord | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  // Option and Shift turn M into µ and 1 into !; the label wants the key.
  const fromCode = keyFromCode(e.code);
  const key = (e.altKey || e.shiftKey) && fromCode ? fromCode : e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return { mod: e.metaKey || e.ctrlKey, shift: e.shiftKey, alt: e.altKey, key, code: e.code || undefined };
}

/** Why a chord cannot be used for `which`, or null when it can. */
export function chordProblem(c: Chord, which: ShortcutId, mac = isMac): string | null {
  const label = formatChord(c, mac);
  if (!c.mod && !/^f\d{1,2}$/i.test(normalKey(c))) return `Hold ${mac ? '⌘' : 'Ctrl'} with the key, or it would type`;
  const taken = TAKEN[chordId(c)];
  if (taken) return taken === 'the browser' ? `${label} belongs to the browser` : `${label} is ${taken} in the editor`;
  const other = SHORTCUTS.find((s) => s.id !== which && sameChord(chordFor(s.id), c));
  if (other) return `${label} is already ${other.label}`;
  return null;
}

const NAMED_KEYS: Record<string, [mac: string, other: string]> = {
  ' ': ['Space', 'Space'], Enter: ['↩', 'Enter'], Escape: ['Esc', 'Esc'], Backspace: ['⌫', 'Backspace'],
  Delete: ['⌦', 'Del'], ArrowUp: ['↑', 'Up'], ArrowDown: ['↓', 'Down'], ArrowLeft: ['←', 'Left'], ArrowRight: ['→', 'Right'],
};

export function formatChord(c: Chord, mac = isMac): string {
  const named = NAMED_KEYS[c.key];
  const key = named ? named[mac ? 0 : 1] : c.key.length === 1 ? c.key.toUpperCase() : c.key;
  if (mac) return `${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${c.mod ? '⌘' : ''}${key}`;
  return [c.mod && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift', key].filter(Boolean).join('+');
}
