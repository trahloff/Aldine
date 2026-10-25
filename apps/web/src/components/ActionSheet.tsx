import type { ReactNode } from 'react';
import Modal from './Modal';
import type { MenuEntry } from './Menu';

/**
 * A menu as a phone shows it: a sheet from the bottom edge with a title,
 * rows a thumb can hit and a Cancel button. Takes the same entries as Menu;
 * shortcuts are left out (there is no keyboard to press them with) unless
 * they are `details`, and a submenu's items are listed in its place.
 */
export default function ActionSheet({ label, title, items, onClose, testId, primaryId, details }: {
  label: string;
  title?: string | null;
  items: MenuEntry[];
  onClose(): void;
  testId?: string;
  /** The row drawn as the sheet's main action. */
  primaryId?: string;
  /** The `shortcut` field holds a detail to show ("from Overleaf"), not keys. */
  details?: boolean;
}) {
  const rows: ReactNode[] = [];
  const flat = items.flatMap((e) => (e.kind === 'submenu' ? e.items : [e]));
  const hasIcon = flat.some((e) => 'icon' in e && !!e.icon);
  let pendingSep = false;
  flat.forEach((e, i) => {
    if (e.kind === 'separator') { pendingSep = rows.length > 0; return; }
    if (e.kind === 'label') return;
    const sep = pendingSep ? <div key={`sep-${i}`} className="action-sheet__sep" role="separator" /> : null;
    pendingSep = false;
    if (e.kind === 'header') {
      rows.push(<div key={e.id ?? `h-${i}`} className="action-sheet__header" data-testid={e.testId}>{e.title}</div>);
      return;
    }
    if (e.kind === 'hint') {
      if (sep) rows.push(sep);
      rows.push(<p key={e.id ?? `hint-${i}`} className="action-sheet__hint" data-testid={e.testId}>{e.label}</p>);
      return;
    }
    if (e.kind === 'submenu') return;
    if (sep) rows.push(sep);
    rows.push(
      <button
        key={e.id}
        type="button"
        className={`action-sheet__item${e.id === primaryId ? ' action-sheet__item--primary' : ''}${e.danger ? ' action-sheet__item--danger' : ''}`}
        aria-disabled={e.disabled || undefined}
        aria-pressed={e.checked}
        data-testid={e.testId}
        onClick={() => {
          if (e.disabled) return;
          onClose();
          e.onSelect();
        }}
      >
        {hasIcon && <span className="action-sheet__icon" aria-hidden="true">{e.icon}</span>}
        {e.label}
        {details && e.shortcut && <span className="action-sheet__detail">{e.shortcut}</span>}
      </button>,
    );
  });
  return (
    <Modal onClose={onClose} label={label} testId={testId}>
      <div className="action-sheet">
        {title && <div className="action-sheet__header" data-testid={testId ? `${testId}-title` : undefined}>{title}</div>}
        {rows}
        <button type="button" className="action-sheet__item action-sheet__cancel" onClick={onClose} data-testid={testId ? `${testId}-cancel` : undefined}>Cancel</button>
      </div>
    </Modal>
  );
}
