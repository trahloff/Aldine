import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { IconCheck, IconChevronRight } from './Icons';
import { useExitGhost } from '../exitGhost';
import { menuKey, placeMenu, typeahead, type MenuAnchor, type MenuPlacement } from '../util/menuModel';

/** One command. `checked` makes it one of a set of choices (radio) or an on/off switch (checkbox). */
export interface MenuAction {
  kind?: 'item';
  id: string;
  label: string;
  onSelect(): void;
  icon?: ReactNode;
  /** The command's keys, shown on the right. */
  shortcut?: string;
  /** Destroys or removes something: drawn in the error colour. */
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  role?: 'radio' | 'checkbox';
  testId?: string;
}

export interface MenuSubmenu {
  kind: 'submenu';
  id: string;
  label: string;
  items: MenuEntry[];
  icon?: ReactNode;
  disabled?: boolean;
  testId?: string;
}

export type MenuEntry =
  | MenuAction
  | MenuSubmenu
  | { kind: 'separator'; id?: string }
  | { kind: 'label'; id?: string; label: string }
  /** A line of advice that does nothing when chosen ("Drop .zip files anywhere on this page"). */
  | { kind: 'hint'; id?: string; label: string; testId?: string };

export type MenuCloseReason = 'escape' | 'tab' | 'outside' | 'select';
export type { MenuAnchor };

const LONG_PRESS_MS = 500;
/** A finger that travels further than this is scrolling, not pressing. */
const LONG_PRESS_SLOP = 10;
const SUBMENU_OPEN_MS = 120;
/** Long enough to cross a neighbouring item on the way into an open submenu. */
const SUBMENU_CLOSE_MS = 250;
const TYPEAHEAD_MS = 500;

const takesFocus = (e: MenuEntry) => e.kind !== 'separator' && e.kind !== 'label';
const labelOf = (e: MenuEntry) => ('label' in e ? e.label : '');

interface Tree {
  instant: boolean;
  elements: Set<HTMLElement>;
  closeAll(reason: MenuCloseReason): void;
  select(item: MenuAction): void;
}

export interface MenuProps {
  items: MenuEntry[];
  anchor: MenuAnchor;
  /** The menu's accessible name, unless `labelledBy` names an element that has one. */
  label: string;
  labelledBy?: string;
  id?: string;
  testId?: string;
  /** Keyboard opens focus an item; a pointer opens the menu with nothing highlighted. */
  initialFocus?: 'first' | 'last' | 'menu';
  /** Opened from the keyboard: no entrance or exit animation. */
  instant?: boolean;
  /** Focus goes back here when the menu closes. */
  returnFocus?: HTMLElement | null;
  /** A press on this element is not a press outside (the button that toggles the menu). */
  trigger?: HTMLElement | null;
  className?: string;
  onClose(reason: MenuCloseReason): void;
}

/**
 * A menu in the ARIA menu pattern, drawn over the page: arrow keys, Home and
 * End, typeahead, Escape, Tab closes, one level of submenus, and placement
 * that flips to stay inside the window. Focus returns to `returnFocus` when
 * it closes. Usually opened through MenuButton or useContextMenu.
 */
export function Menu({ items, anchor, label, labelledBy, id, testId, initialFocus = 'first', instant = false, returnFocus, trigger, className, onClose }: MenuProps) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const closed = useRef(false);

  const tree = useMemo<Tree>(() => {
    const t: Tree = {
      instant,
      elements: new Set(),
      closeAll(reason) {
        if (closed.current) return;
        closed.current = true;
        const back = returnFocus;
        if (reason === 'outside') {
          // The press lands where it was aimed. Only when it landed on nothing
          // that takes focus does focus go back to where the menu came from.
          requestAnimationFrame(() => {
            const active = document.activeElement;
            if (back?.isConnected && (!active || active === document.body)) back.focus({ preventScroll: true });
          });
        } else {
          back?.focus({ preventScroll: true });
        }
        closeRef.current(reason);
      },
      select(item) {
        t.closeAll('select');
        item.onSelect();
      },
    };
    return t;
    // One tree per open menu: the props it reads are fixed while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const inside = (target: EventTarget | null) => target instanceof Node && [...tree.elements].some((el) => el.contains(target));
    const onDown = (e: PointerEvent) => {
      if (inside(e.target) || (trigger && e.target instanceof Node && trigger.contains(e.target))) return;
      tree.closeAll('outside');
    };
    const onScroll = (e: Event) => { if (!inside(e.target)) tree.closeAll('outside'); };
    // An on-screen keyboard that comes or goes changes only the height; the
    // menu's anchor moves only when the width does.
    let width = window.innerWidth;
    const onResize = () => { if (window.innerWidth !== width) tree.closeAll('outside'); width = window.innerWidth; };
    const onBlur = () => tree.closeAll('outside');
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('blur', onBlur);
    };
  }, [tree, trigger]);

  return (
    <MenuLevel
      tree={tree}
      depth={0}
      items={items}
      anchor={anchor}
      initialFocus={initialFocus}
      focusNonce={0}
      label={label}
      labelledBy={labelledBy}
      id={id}
      testId={testId}
      className={className}
      onCloseLevel={() => tree.closeAll('escape')}
    />
  );
}

interface LevelProps {
  tree: Tree;
  depth: number;
  items: MenuEntry[];
  anchor: MenuAnchor;
  initialFocus: 'first' | 'last' | 'menu' | 'none';
  /** Bumped by the parent to move focus into an already open submenu. */
  focusNonce: number;
  label: string;
  labelledBy?: string;
  id?: string;
  testId?: string;
  className?: string;
  onCloseLevel(): void;
  onPointerEnterLevel?(): void;
}

function MenuLevel({ tree, depth, items, anchor, initialFocus, focusNonce, label, labelledBy, id, testId, className, onCloseLevel, onPointerEnterLevel }: LevelProps) {
  const ownId = useId();
  const menuId = id ?? `menu${ownId}`;
  const ref = useRef<HTMLDivElement | null>(null);
  const leave = useExitGhost();
  const rows = useRef<(HTMLElement | null)[]>([]);
  const [place, setPlace] = useState<MenuPlacement | null>(null);
  const [sub, setSub] = useState<{ index: number; rect: DOMRect; focus: 'first' | 'none'; nonce: number } | null>(null);
  const openTimer = useRef<{ index: number; id: number } | null>(null);
  const closeTimer = useRef<number | null>(null);
  const typed = useRef({ text: '', timer: 0 });

  const focusable = items.map((e, i) => (takesFocus(e) ? i : -1)).filter((i) => i >= 0);
  const current = () => focusable.findIndex((i) => rows.current[i] === document.activeElement);
  const focusRow = (n: number) => { if (n >= 0) rows.current[focusable[n]]?.focus(); };

  const cancelTimers = useCallback(() => {
    if (openTimer.current) { clearTimeout(openTimer.current.id); openTimer.current = null; }
    if (closeTimer.current !== null) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  }, []);
  useEffect(() => () => { cancelTimers(); clearTimeout(typed.current.timer); }, [cancelTimers]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    tree.elements.add(el);
    const r = el.getBoundingClientRect();
    setPlace(placeMenu(anchor, r.width, r.height, document.documentElement.clientWidth || window.innerWidth, window.innerHeight));
    return () => { tree.elements.delete(el); };
    // Placed once, when it opens: a menu does not follow its anchor around.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    if (!place) return;
    if (initialFocus === 'first') focusRow(0);
    else if (initialFocus === 'last') focusRow(focusable.length - 1);
    else if (initialFocus === 'menu') ref.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place, focusNonce]);

  const openSub = (index: number, focus: 'first' | 'none') => {
    const row = rows.current[index];
    if (!row) return;
    cancelTimers();
    setSub((s) => ({ index, rect: row.getBoundingClientRect(), focus, nonce: (s?.nonce ?? 0) + 1 }));
  };
  const closeSub = () => {
    const at = sub?.index;
    cancelTimers();
    setSub(null);
    if (at !== undefined) rows.current[at]?.focus();
  };

  const activate = (index: number, fromKeyboard: boolean) => {
    const e = items[index];
    if (e.kind === 'submenu') { if (!e.disabled) openSub(index, fromKeyboard ? 'first' : 'none'); return; }
    if (e.kind === 'separator' || e.kind === 'label' || e.kind === 'hint' || e.disabled) return;
    tree.select(e);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // A submenu is drawn apart from its parent: its keys are its own.
    if (!ref.current?.contains(e.target as Node)) return;
    const at = current();
    const entry = at >= 0 ? items[focusable[at]] : null;
    const action = menuKey(e, {
      count: focusable.length,
      index: at,
      isSubmenu: depth > 0,
      onSubmenuItem: entry?.kind === 'submenu' && !entry.disabled,
      typing: typed.current.text.length > 0,
    });
    if (!action) return;
    if (action.type === 'close' && action.reason === 'tab') {
      // No preventDefault: focus is back on the trigger, and Tab moves on from there.
      tree.closeAll('tab');
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    switch (action.type) {
      case 'focus': if (sub) setSub(null); focusRow(action.index); break;
      case 'activate': activate(focusable[at], true); break;
      case 'open-submenu': openSub(focusable[at], 'first'); break;
      case 'close-submenu': onCloseLevel(); break;
      case 'close': tree.closeAll(action.reason); break;
      case 'typeahead': {
        const t = typed.current;
        clearTimeout(t.timer);
        t.text += action.char;
        t.timer = window.setTimeout(() => { t.text = ''; }, TYPEAHEAD_MS);
        const hit = typeahead(focusable.map((i) => labelOf(items[i])), at, t.text);
        if (hit >= 0) { if (sub) setSub(null); focusRow(hit); }
        break;
      }
    }
  };

  // Only a pointer that moves highlights a row, so a menu that opens under a
  // resting pointer does not pick whatever happens to be beneath it.
  const onRowPointerMove = (index: number, e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === 'touch') return;
    const row = rows.current[index];
    if (row && document.activeElement !== row) row.focus({ preventScroll: true });
    const entry = items[index];
    if (entry.kind === 'submenu' && !entry.disabled) {
      if (closeTimer.current !== null) { clearTimeout(closeTimer.current); closeTimer.current = null; }
      if (sub?.index === index || openTimer.current?.index === index) return;
      if (openTimer.current) clearTimeout(openTimer.current.id);
      openTimer.current = { index, id: window.setTimeout(() => { openTimer.current = null; openSub(index, 'none'); }, SUBMENU_OPEN_MS) };
      return;
    }
    if (openTimer.current) { clearTimeout(openTimer.current.id); openTimer.current = null; }
    if (sub && closeTimer.current === null) {
      closeTimer.current = window.setTimeout(() => { closeTimer.current = null; setSub(null); }, SUBMENU_CLOSE_MS);
    }
  };

  const hasCheck = items.some((e) => (e.kind === undefined || e.kind === 'item') && e.checked !== undefined);
  const hasIcon = items.some((e) => 'icon' in e && !!e.icon);
  const rowId = (i: number) => `${menuId}-row-${i}`;

  const body = items.map((e, i) => {
    if (e.kind === 'separator') return <div key={e.id ?? `sep-${i}`} role="separator" className="menu__sep" />;
    if (e.kind === 'label') return <div key={e.id ?? `label-${i}`} role="presentation" className="menu__label">{e.label}</div>;
    const common = {
      id: rowId(i),
      ref: (el: HTMLElement | null) => { rows.current[i] = el; },
      tabIndex: -1,
      onPointerMove: (ev: ReactPointerEvent<HTMLElement>) => onRowPointerMove(i, ev),
      onClick: () => activate(i, false),
      'data-testid': e.testId,
    };
    if (e.kind === 'hint') {
      return (
        <div key={e.id ?? `hint-${i}`} {...common} role="menuitem" aria-disabled="true" className="menu__item menu__item--hint">
          <span className="menu__text">{e.label}</span>
        </div>
      );
    }
    const lead = (
      <>
        {hasCheck && <span className="menu__check" aria-hidden="true">{e.kind !== 'submenu' && e.checked ? <IconCheck /> : null}</span>}
        {hasIcon && <span className="menu__icon" aria-hidden="true">{e.icon}</span>}
        <span className="menu__text">{e.label}</span>
      </>
    );
    if (e.kind === 'submenu') {
      const open = sub?.index === i;
      return (
        <div
          key={e.id}
          {...common}
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-disabled={e.disabled || undefined}
          className={`menu__item${open ? ' menu__item--open' : ''}`}
        >
          {lead}
          <span className="menu__chev" aria-hidden="true"><IconChevronRight /></span>
        </div>
      );
    }
    const role = e.checked === undefined ? 'menuitem' : e.role === 'checkbox' ? 'menuitemcheckbox' : 'menuitemradio';
    return (
      <div
        key={e.id}
        {...common}
        role={role}
        aria-checked={e.checked === undefined ? undefined : e.checked}
        aria-disabled={e.disabled || undefined}
        className={`menu__item${e.danger ? ' menu__item--danger' : ''}`}
      >
        {lead}
        {e.shortcut && <span className="menu__hint">{e.shortcut}</span>}
      </div>
    );
  });

  const subEntry = sub ? items[sub.index] : null;

  const panel = (
    <div
      ref={(el) => { ref.current = el; if (!tree.instant) leave(el); }}
      role="menu"
      id={menuId}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-orientation="vertical"
      tabIndex={-1}
      className={`menu menu--floating${className ? ` ${className}` : ''}`}
      data-instant={tree.instant || undefined}
      data-testid={testId}
      style={place
        ? { left: place.left, top: place.top, maxHeight: place.maxHeight, transformOrigin: place.origin }
        : { left: 0, top: 0, visibility: 'hidden' }}
      onKeyDown={onKeyDown}
      onPointerEnter={() => { cancelTimers(); onPointerEnterLevel?.(); }}
      onPointerLeave={(e) => {
        // Leaving the menu takes the highlight along, unless it went into the open submenu.
        if (e.pointerType !== 'touch' && !sub && ref.current?.contains(document.activeElement)) ref.current.focus({ preventScroll: true });
      }}
      onContextMenu={(e: ReactMouseEvent) => e.preventDefault()}
    >
      {body}
    </div>
  );

  return (
    <>
      {createPortal(panel, document.body)}
      {sub && subEntry?.kind === 'submenu' && (
        <MenuLevel
          key={sub.index}
          tree={tree}
          depth={depth + 1}
          items={subEntry.items}
          anchor={{ type: 'rect', rect: sub.rect, placement: 'right-start' }}
          initialFocus={sub.focus}
          focusNonce={sub.nonce}
          label={subEntry.label}
          labelledBy={rowId(sub.index)}
          testId={subEntry.testId ? `${subEntry.testId}-menu` : undefined}
          className={className}
          onCloseLevel={closeSub}
          onPointerEnterLevel={cancelTimers}
        />
      )}
    </>
  );
}

type Placement = 'bottom-start' | 'bottom-end';

/**
 * A button that opens a menu: click, Enter or Space opens it, ArrowDown
 * opens it on its first item and ArrowUp on its last. A pointer click opens
 * it with nothing highlighted; the arrow keys then start at either end.
 */
export function MenuButton({
  items, label, children, className = 'btn', testId, menuTestId, placement = 'bottom-start', title, ariaLabel, disabled, menuClassName,
}: {
  items: MenuEntry[] | (() => MenuEntry[]);
  /** The menu's name for assistive tech when the button's own text does not name it. */
  label: string;
  children: ReactNode;
  className?: string;
  testId?: string;
  menuTestId?: string;
  placement?: Placement;
  title?: string;
  ariaLabel?: string;
  disabled?: boolean;
  menuClassName?: string;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const btnId = useId();
  const menuId = useId();
  const [open, setOpen] = useState<{ items: MenuEntry[]; rect: DOMRect; focus: 'first' | 'last' | 'menu'; keyboard: boolean } | null>(null);
  const show = (focus: 'first' | 'last' | 'menu', keyboard: boolean) => {
    if (!btn.current) return;
    setOpen({ items: typeof items === 'function' ? items() : items, rect: btn.current.getBoundingClientRect(), focus, keyboard });
  };
  return (
    <>
      <button
        ref={btn}
        id={btnId}
        type="button"
        className={className}
        aria-haspopup="menu"
        aria-expanded={!!open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        data-testid={testId}
        // A click from Enter or Space has no pointer position (detail 0).
        onClick={(e) => (open ? setOpen(null) : show(e.detail === 0 ? 'first' : 'menu', e.detail === 0))}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          show(e.key === 'ArrowDown' ? 'first' : 'last', true);
        }}
      >
        {children}
      </button>
      {open && (
        <Menu
          items={open.items}
          anchor={{ type: 'rect', rect: open.rect, placement }}
          label={label}
          labelledBy={ariaLabel ? undefined : btnId}
          id={menuId}
          testId={menuTestId}
          initialFocus={open.focus}
          instant={open.keyboard}
          returnFocus={btn.current}
          trigger={btn.current}
          className={menuClassName}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

/** How long after a long press is released its click may still arrive. */
const RELEASE_CLICK_MS = 350;

/** Swallows the click that ends a long press, which would otherwise activate what was pressed. */
function swallowClickOnRelease(): void {
  const stop = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
  const release = () => {
    window.removeEventListener('pointerup', release, true);
    window.removeEventListener('pointercancel', release, true);
    setTimeout(() => window.removeEventListener('click', stop, true), RELEASE_CLICK_MS);
  };
  window.addEventListener('click', stop, true);
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
}

/** Under (or over) the pressed element, not under the finger that pressed it. */
function besideElement(el: HTMLElement): MenuAnchor {
  return { type: 'rect', rect: el.getBoundingClientRect(), placement: 'bottom-start' };
}

/**
 * A context menu for any element: right-click (or Control-click), a 500ms
 * long press on touch, and Shift+F10 or the Menu key. Spread
 * `bind(() => items)` onto the element and render `element`.
 */
export function useContextMenu({ label, testId, className }: { label: string; testId?: string; className?: string }) {
  const [state, setState] = useState<{ items: MenuEntry[]; anchor: MenuAnchor; trigger: HTMLElement; keyboard: boolean } | null>(null);
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);

  const endPress = () => {
    if (press.current) clearTimeout(press.current.timer);
  };

  const bind = useCallback((getItems: () => MenuEntry[]) => ({
    'data-context-menu': '',
    onContextMenu(e: ReactMouseEvent<HTMLElement>) {
      e.preventDefault();
      const p = press.current;
      if (p?.fired) return; // the long press already opened it
      if (p) {
        // A touch browser's own long press (Android): the same as ours.
        endPress();
        p.fired = true;
        swallowClickOnRelease();
        setState({ items: getItems(), anchor: besideElement(e.currentTarget), trigger: e.currentTarget, keyboard: false });
        return;
      }
      setState({ items: getItems(), anchor: { type: 'point', x: e.clientX, y: e.clientY }, trigger: e.currentTarget, keyboard: false });
    },
    onKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
      if (!(e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) return;
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      setState({ items: getItems(), anchor: { type: 'rect', rect: r, placement: 'bottom-start' }, trigger: e.currentTarget, keyboard: true });
    },
    onPointerDown(e: ReactPointerEvent<HTMLElement>) {
      endPress();
      press.current = null;
      if (e.pointerType === 'mouse' || !e.isPrimary) return;
      const el = e.currentTarget;
      const { clientX: x, clientY: y } = e;
      const p = { x, y, fired: false, timer: 0 };
      p.timer = window.setTimeout(() => {
        p.fired = true;
        swallowClickOnRelease();
        setState({ items: getItems(), anchor: besideElement(el), trigger: el, keyboard: false });
      }, LONG_PRESS_MS);
      press.current = p;
    },
    onPointerMove(e: ReactPointerEvent<HTMLElement>) {
      const p = press.current;
      if (p && !p.fired && Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_SLOP) { endPress(); press.current = null; }
    },
    onPointerUp() {
      if (press.current && !press.current.fired) { endPress(); press.current = null; }
    },
    onPointerCancel() {
      if (press.current && !press.current.fired) { endPress(); press.current = null; }
    },
    onTouchEnd(e: ReactTouchEvent<HTMLElement>) {
      // A cancelled touchend is one the browser makes no click of.
      if (press.current?.fired && e.cancelable) e.preventDefault();
    },
  }), []);

  useEffect(() => () => endPress(), []);

  const element = state ? (
    <Menu
      items={state.items}
      anchor={state.anchor}
      label={label}
      testId={testId}
      className={className}
      initialFocus={state.keyboard ? 'first' : 'menu'}
      instant={state.keyboard}
      returnFocus={state.trigger}
      onClose={() => setState(null)}
    />
  ) : null;

  return { bind, element, open: !!state, close: () => setState(null) };
}
