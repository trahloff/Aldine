import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useExitGhost } from '../exitGhost';
import { matchesShortcut, useShortcutLabel } from '../util/shortcuts';
import { rankCommands } from '../util/paletteRank';
import { lastInputWasKeyboard } from '../util/modality';
import { IconSearch } from './Icons';

export interface Command {
  id: string;
  title: string;
  hint?: string;
  /** The section it is listed under, a sentence-case heading ("Projects"). */
  group?: string;
  /** Other words it answers to; the title is always searched. */
  keywords?: string;
  run(): void;
}

interface Props {
  open: boolean;
  commands: Command[];
  onClose(): void;
  placeholder?: string;
  /** Section order before anything is typed. Sections not named follow in the order they first appear. */
  groupOrder?: string[];
}

/** The palette's visible door: a search field in the toolbar that names its shortcut. */
export function PaletteTrigger({ onOpen, label }: { onOpen(): void; label: string }) {
  const keys = useShortcutLabel('palette');
  return (
    <button type="button" className="palette-trigger" onClick={onOpen} data-testid="palette-open" aria-label={`${label} (${keys})`} aria-haspopup="dialog">
      <IconSearch />
      <span className="palette-trigger__label">{label}</span>
      <kbd className="kbd palette-trigger__kbd">{keys}</kbd>
    </button>
  );
}

/** The palette's shortcut (Mod+K unless changed in settings) toggles it from anywhere on the page. */
export function usePaletteHotkey(toggle: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchesShortcut(e, 'palette')) { e.preventDefault(); toggle(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);
}

/**
 * The command palette, in the ARIA 1.2 combobox pattern: focus stays in the
 * field and the highlighted result is its active descendant. Opened from the
 * keyboard it appears without animation; it is opened many times a day.
 */
export default function CommandPalette({ open, commands, onClose, placeholder = 'Type a command or file…', groupOrder }: Props) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const leave = useExitGhost();
  const listId = useId();
  const optionId = (i: number) => `${listId}-option-${i}`;

  const [wasOpen, setWasOpen] = useState(open);
  const [instant, setInstant] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setInstant(lastInputWasKeyboard());
  }

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement as HTMLElement | null;
    setQuery('');
    setSel(0);
    inputRef.current?.focus();
    return () => {
      // Dismissed: back to where the palette was opened from. A command has
      // had focus put back before it ran (choose), and may have moved it since.
      const back = returnTo.current;
      returnTo.current = null;
      const active = document.activeElement;
      if (back?.isConnected && (!active || active === document.body)) back.focus({ preventScroll: true });
    };
  }, [open]);

  const sections = useMemo(() => rankCommands(commands, query, groupOrder), [commands, query, groupOrder]);
  const results = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  useEffect(() => { if (sel >= results.length) setSel(0); }, [results, sel]);

  useEffect(() => {
    listRef.current?.querySelector('[data-sel="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!open) return null;

  const choose = (i: number) => {
    const cmd = results[i];
    if (!cmd) return;
    // Focus goes back first, so a command that opens something of its own
    // (a dialog, the formula editor) keeps the focus it moves there.
    const back = returnTo.current;
    returnTo.current = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
    onClose();
    cmd.run();
  };

  let row = -1;
  return (
    <div
      ref={instant ? undefined : leave}
      className={`modal-backdrop${instant ? ' modal-backdrop--instant' : ''}`}
      onClick={onClose}
      data-testid="command-palette"
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette__input"
          placeholder={placeholder}
          value={query}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={results[sel] ? optionId(sel) : undefined}
          aria-label="Search commands"
          autoComplete="off"
          spellCheck={false}
          data-testid="palette-input"
          onChange={(e) => { setQuery(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            else if (e.key === 'Home' && e.ctrlKey) { e.preventDefault(); setSel(0); }
            else if (e.key === 'End' && e.ctrlKey) { e.preventDefault(); setSel(Math.max(results.length - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); choose(sel); }
            else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            // the field is the palette's only stop; Tab must not reach the page behind the scrim
            else if (e.key === 'Tab') e.preventDefault();
          }}
        />
        {results.length === 0 && <div className="palette__empty" role="status">No matches</div>}
        <div className="palette__list" ref={listRef} role="listbox" id={listId} aria-label="Results" hidden={results.length === 0}>
          {sections.map((s, n) => {
            const headingId = `${listId}-group-${n}`;
            const rows = s.items.map((c) => {
              row += 1;
              const i = row;
              return (
                <div
                  key={c.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === sel}
                  className={`palette__item${i === sel ? ' palette__item--sel' : ''}`}
                  data-sel={i === sel}
                  data-testid={`palette-item-${c.id}`}
                  // Only a pointer that moves picks a row: the list scrolling
                  // under a resting pointer must not steal the highlight.
                  onPointerMove={() => { if (i !== sel) setSel(i); }}
                  onClick={() => choose(i)}
                >
                  <span className="palette__title">{c.title}</span>
                  {c.hint && <span className="palette__hint">{c.hint}</span>}
                </div>
              );
            });
            return s.group ? (
              <div key={s.group} role="group" aria-labelledby={headingId} className="palette__group">
                <div id={headingId} className="menu__label palette__label" aria-hidden="true">{s.group}</div>
                {rows}
              </div>
            ) : <Fragment key="">{rows}</Fragment>;
          })}
        </div>
      </div>
    </div>
  );
}
