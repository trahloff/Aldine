import { useEffect, useRef } from 'react';
import type { OutlineEntry } from '../editor/visual/outline';
import { IconChevronRight } from './Icons';

interface Props {
  /** null until the open file has loaded. */
  entries: OutlineEntry[] | null;
  /** The heading the caret is under, an index into `entries`; -1 above the first. */
  current: number;
  open: boolean;
  onToggle(): void;
  onPick(entry: OutlineEntry): void;
}

/** The open file's headings under the file tree, the one the caret is in marked. */
export default function Outline({ entries, current, open, onToggle, onPick }: Props) {
  const list = useRef<HTMLOListElement>(null);
  const top = (entries ?? []).reduce((m, h) => Math.min(m, h.level), 9);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('.outline__item--current')?.scrollIntoView({ block: 'nearest' });
  }, [current, open]);
  return (
    <section className="outline" aria-label="Outline" data-testid="outline">
      <button type="button" className="outline__head" onClick={onToggle} aria-expanded={open} data-testid="outline-toggle">
        <span className={`outline__chev${open ? ' outline__chev--open' : ''}`} aria-hidden="true"><IconChevronRight /></span>
        Outline
      </button>
      {open && entries && (entries.length ? (
        <ol className="outline__list" ref={list}>
          {entries.map((h, i) => (
            <li key={`${h.line}:${i}`}>
              <button
                type="button"
                className={`outline__item${i === current ? ' outline__item--current' : ''}`}
                style={{ paddingLeft: 8 + (h.level - top) * 12 }}
                aria-current={i === current ? 'location' : undefined}
                title={`${h.title} · line ${h.line}`}
                onClick={() => onPick(h)}
                data-testid="outline-item"
                data-level={h.level}
              >
                {h.title}
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="outline__empty" data-testid="outline-empty">No sections in this file yet.</p>
      ))}
    </section>
  );
}
