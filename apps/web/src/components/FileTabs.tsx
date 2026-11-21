import { useEffect, useRef } from 'react';
import { IconX } from './Icons';
import { tabLabels } from '../util/openTabs';

/**
 * The files open in this branch, one tab each: choosing one shows it, the ×
 * (or a middle click) closes it. Shown from two files on; with one, the
 * pane's header already names it.
 */
export default function FileTabs({ tabs, active, onSelect, onClose }: {
  tabs: readonly string[];
  active: string | null;
  onSelect(path: string): void;
  onClose(path: string): void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The strip's own scroll only: scrollIntoView would scroll the panes around it as well.
    const strip = stripRef.current;
    const el = active ? strip?.querySelector<HTMLElement>(`[data-path="${CSS.escape(active)}"]`) : null;
    if (!strip || !el) return;
    if (el.offsetLeft < strip.scrollLeft) strip.scrollLeft = el.offsetLeft;
    else if (el.offsetLeft + el.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = el.offsetLeft + el.offsetWidth - strip.clientWidth;
  }, [active, tabs]);
  if (tabs.length < 2) return null;
  const labels = tabLabels(tabs);
  return (
    <nav className="file-tabs" aria-label="Open files" data-testid="file-tabs" ref={stripRef}>
      {tabs.map((path, i) => {
        const on = path === active;
        return (
          <div key={path} className={`file-tab${on ? ' file-tab--active' : ''}`} data-testid="file-tab" data-path={path} data-active={on ? 'true' : 'false'}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(path); } }}>
            <button type="button" className="file-tab__name" data-testid="file-tab-name" title={path} aria-current={on ? 'page' : undefined} onClick={() => onSelect(path)}>
              {labels[i]}
            </button>
            <button type="button" className="file-tab__close" aria-label={`Close ${path}`} title="Close tab" data-testid="file-tab-close" onClick={() => onClose(path)}>
              <IconX />
            </button>
          </div>
        );
      })}
    </nav>
  );
}
