/**
 * Whether the last thing the person did was a key press or a pointer press.
 * Something opened from the keyboard appears without animation: it is
 * repeated many times a day, and motion there reads as lag.
 */
let keyboard = false;

if (typeof document !== 'undefined') {
  document.addEventListener('keydown', () => { keyboard = true; }, true);
  document.addEventListener('pointerdown', () => { keyboard = false; }, true);
}

export function lastInputWasKeyboard(): boolean {
  return keyboard;
}
