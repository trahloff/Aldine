import { useEffect, useMemo, useRef, useState } from 'react';
import { useExitGhost } from '../exitGhost';
import { matchesShortcut, useShortcutLabel } from '../util/shortcuts';
import { IconSearch } from './Icons';

export interface Command {
  id: string;
  title: string;
  hint?: string;
  group?: string;
  run(): void;
}

interface Props {
  open: boolean;
  commands: Command[];
  onClose(): void;
  placeholder?: string;
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

/** Simple subsequence fuzzy match with a score (lower = better). */
function fuzzy(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastIdx = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += lastIdx === -1 ? ti : (ti - lastIdx - 1);
      lastIdx = ti;
      qi++;
    }
  }
  return qi === q.length ? score : null;
}

export default function CommandPalette({ open, commands, onClose, placeholder = 'Type a command or file…' }: Props) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const leave = useExitGhost();

  useEffect(() => {
    if (open) {
      setQuery('');
      setSel(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const results = useMemo(() => {
    const scored = commands
      .map((c) => ({ c, score: fuzzy(query, `${c.group || ''} ${c.title}`) }))
      .filter((x) => x.score !== null)
      .sort((a, b) => (a.score! - b.score!));
    return scored.map((x) => x.c).slice(0, 40);
  }, [commands, query]);

  useEffect(() => { if (sel >= results.length) setSel(0); }, [results, sel]);

  useEffect(() => {
    listRef.current?.querySelector('[data-sel="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!open) return null;

  const choose = (i: number) => {
    const cmd = results[i];
    if (cmd) { onClose(); cmd.run(); }
  };

  return (
    <div ref={leave} className="modal-backdrop" onClick={onClose} data-testid="command-palette">
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette__input"
          placeholder={placeholder}
          value={query}
          data-testid="palette-input"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); choose(sel); }
            else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          }}
        />
        <div className="palette__list" ref={listRef}>
          {results.length === 0 && <div className="palette__empty">No matches</div>}
          {results.map((c, i) => (
            <button
              key={c.id}
              className={`palette__item ${i === sel ? 'palette__item--sel' : ''}`}
              data-sel={i === sel}
              data-testid={`palette-item-${c.id}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => choose(i)}
            >
              {c.group && <span className="palette__group">{c.group}</span>}
              <span className="palette__title">{c.title}</span>
              {c.hint && <span className="palette__hint">{c.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
