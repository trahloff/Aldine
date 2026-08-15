import { useState } from 'react';
import type { CodePaneHandle } from './CodePane';
import type { OutlineEntry } from '../editor/visual/outline';
import { shortcut } from '../platform';

interface Props {
  target: React.RefObject<CodePaneHandle | null>;
}

/** Formatting affordances for Visual mode; every action is a plain text edit. */
export default function FormatToolbar({ target }: Props) {
  const fmt = (action: Parameters<CodePaneHandle['format']>[0]) => () => target.current?.format(action);
  return (
    <span className="fmt" data-testid="format-toolbar">
      <button className="fmt__btn fmt__btn--b" title={`Bold (${shortcut('B')})`} aria-label="Bold" onClick={fmt('bold')}>B</button>
      <button className="fmt__btn fmt__btn--i" title={`Italic (${shortcut('I')})`} aria-label="Italic" onClick={fmt('italic')}>I</button>
      <button className="fmt__btn" title="Bullet list" aria-label="Bullet list" onClick={fmt('list')}>•≡</button>
      <select
        className="fmt__select"
        title="Heading level"
        aria-label="Heading level"
        value=""
        onChange={(e) => {
          const v = Number(e.target.value);
          if (v >= 1 && v <= 4) target.current?.format({ section: v as 1 | 2 | 3 | 4 });
          e.target.value = '';
        }}
      >
        <option value="" disabled>Heading…</option>
        <option value="1">Section</option>
        <option value="2">Subsection</option>
        <option value="3">Subsubsection</option>
        <option value="4">Paragraph</option>
      </select>
      <ContentsDropdown target={target} />
    </span>
  );
}

function ContentsDropdown({ target }: Props) {
  const [outline, setOutline] = useState<OutlineEntry[] | null>(null);
  return (
    <select
      className="fmt__select"
      title="Contents"
      aria-label="Contents"
      data-testid="outline-dropdown"
      value=""
      onFocus={() => setOutline(target.current?.getOutline() ?? [])}
      onChange={(e) => {
        const line = Number(e.target.value);
        if (line) target.current?.gotoLine(line);
        e.target.value = '';
      }}
    >
      <option value="" disabled>Contents…</option>
      {(outline ?? []).map((h, i) => (
        <option key={i} value={h.line}>{'\u2007'.repeat((h.level - 1) * 2) + h.title}</option>
      ))}
    </select>
  );
}
