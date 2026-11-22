import { forwardRef, useId, useImperativeHandle, useRef, useState, type KeyboardEvent, type TextareaHTMLAttributes } from 'react';
import type { Person } from '../api';

/** The ids of the people whose `@Name` the text carries: what a comment or a
 *  reply mentions. The server checks the same thing again. */
export function mentionsIn(text: string, people: Person[]): string[] {
  return people.filter((p) => carriesMention(text, p.name)).map((p) => p.id);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Does `text` carry `@name` as a whole name (not "@Al" inside "@Alice")? */
const carriesMention = (text: string, name: string) => new RegExp(`@${escape(name)}(?![\\p{L}\\p{N}])`, 'u').test(text);

/** The `@query` the caret is in, or null: an @ at the start or after a space,
 *  then at most three words without a line break. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([^\s@][^@\n]{0,40}|)$/.exec(text.slice(0, caret));
  if (!m || m[2].split(' ').length > 3) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

/** People whose name, or a word of it, starts with `query`. */
export function matchPeople(people: Person[], query: string, max = 6): Person[] {
  const q = query.toLowerCase();
  return people.filter((p) => {
    const n = p.name.toLowerCase();
    return n.startsWith(q) || n.split(/\s+/).some((w) => w.startsWith(q));
  }).slice(0, max);
}

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
  value: string;
  onValue(text: string): void;
  /** Who @ offers; empty turns the menu off. */
  people: Person[];
};

/** A textarea where typing @ offers the project's people. Arrow keys move,
 *  Enter or Tab inserts `@Name`, Escape closes the menu (not the dialog). */
const MentionTextarea = forwardRef<HTMLTextAreaElement, Props>(function MentionTextarea({ value, onValue, people, onKeyDown, className, ...rest }, ref) {
  const inner = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => inner.current!);
  const [at, setAt] = useState<{ start: number; query: string } | null>(null);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const listId = useId();
  const options = at && people.length && dismissed !== at.start ? matchPeople(people, at.query) : [];
  const open = options.length > 0;

  const track = (text: string, caret: number) => {
    const q = mentionQuery(text, caret);
    setAt(q);
    if (!q || q.start !== at?.start) setDismissed(null);
    setSel(0);
  };
  const insert = (p: Person) => {
    const el = inner.current;
    if (!el || !at) return;
    const caret = el.selectionStart;
    const next = `${value.slice(0, at.start)}@${p.name} ${value.slice(caret)}`;
    const pos = at.start + p.name.length + 2;
    onValue(next);
    setAt(null);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(pos, pos); });
  };
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSel((i) => (i + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
        return;
      }
      if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        insert(options[Math.min(sel, options.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(at!.start);
        return;
      }
    }
    onKeyDown?.(e);
  };

  return (
    <div className="mention-box">
      <textarea
        {...rest}
        ref={inner}
        className={className}
        value={value}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${sel}` : undefined}
        onChange={(e) => { onValue(e.target.value); track(e.target.value, e.target.selectionStart); }}
        onSelect={(e) => track(e.currentTarget.value, e.currentTarget.selectionStart)}
        onBlur={(e) => { rest.onBlur?.(e); setTimeout(() => setAt(null), 120); }}
        onKeyDown={keys}
      />
      {open && (
        <div className="mention-menu" role="listbox" id={listId} aria-label="People to mention" data-testid="mention-menu">
          {options.map((p, i) => (
            <div key={p.id} id={`${listId}-${i}`} role="option" aria-selected={i === sel}
              className={`mention-menu__item${i === sel ? ' mention-menu__item--sel' : ''}`}
              data-testid="mention-option"
              onMouseDown={(e) => { e.preventDefault(); insert(p); }}>
              {p.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
export default MentionTextarea;

/** Comment text with each `@Name` of the people it mentions marked. */
export function MentionText({ text, mentions, people }: { text: string; mentions?: string[]; people: Person[] }) {
  const names = people.filter((p) => mentions?.includes(p.id)).map((p) => `@${p.name}`).sort((a, b) => b.length - a.length);
  if (!names.length) return <>{text}</>;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${names.map(esc).join('|')})`, 'g'));
  return <>{parts.map((s, i) => (names.includes(s) ? <span key={i} className="mention" data-testid="mention">{s}</span> : s))}</>;
}
