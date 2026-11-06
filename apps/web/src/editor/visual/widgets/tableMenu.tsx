import { createRoot } from 'react-dom/client';
import { Menu, type MenuAnchor, type MenuEntry } from '../../../components/Menu';

/**
 * The app's menu, drawn for a table grid (which CodeMirror owns, not React):
 * mounted on its own root while open, gone once it closes. `keyboard`: opened
 * from the keyboard, so its first item takes focus.
 */
export function openTableMenu(opts: { items: MenuEntry[]; anchor: MenuAnchor; keyboard: boolean; returnFocus: HTMLElement | null; trigger?: HTMLElement | null; onClose(): void }): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    // after the event that closed it: a root is not unmounted from its own handler
    setTimeout(() => { root.unmount(); host.remove(); });
    opts.onClose();
  };
  root.render(
    <Menu
      items={opts.items}
      anchor={opts.anchor}
      label="Rows and columns"
      testId="vis-table-menu"
      initialFocus={opts.keyboard ? 'first' : 'menu'}
      instant={opts.keyboard}
      returnFocus={opts.returnFocus}
      trigger={opts.trigger ?? null}
      onClose={close}
    />,
  );
}
