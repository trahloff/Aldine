import { forwardRef, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import type { AuthUser, RemoteInfo, RemoteProviderId } from '../../api';
import { MenuButton, type MenuEntry } from '../Menu';
import { IconChevronDown, IconEllipsis, IconFile, IconPlus, IconSearch, IconX } from '../Icons';
import Wordmark from '../Wordmark';
import { REMOTES } from '../../remotes';
import { appearanceMenuItems } from '../Appearance';
import { useAppearance } from '../../theme';
import { useShortcutLabel } from '../../util/shortcuts';
import { initials } from '../../util/homeList';

export interface StartActions {
  remotes: RemoteInfo[];
  /** The account each connected host is signed in as. */
  logins: Partial<Record<RemoteProviderId, string>>;
  onNew(): void;
  onImportZip(): void;
  onClone(id: RemoteProviderId): void;
}

export interface AccountActions {
  accounts: boolean;
  user: AuthUser | null;
  admin: boolean;
  onAccount(): void;
  onConnect(): void;
  onAbout(): void;
  onAdmin(): void;
  onSignOut(): void;
}

/** The ways to start a project besides a template: the split button's menu and the phone's + sheet. */
export function startItems(a: StartActions): MenuEntry[] {
  return [
    { id: 'import-zip', label: 'Import a ZIP…', shortcut: 'from Overleaf', icon: <IconFile />, onSelect: a.onImportZip, testId: 'import-zip' },
    ...a.remotes.map((r): MenuEntry => ({
      id: `new-from-${r.id}`,
      label: `Clone from ${r.label}…`,
      shortcut: a.logins[r.id],
      icon: REMOTES[r.id]?.icon,
      onSelect: () => a.onClone(r.id),
      testId: `new-from-${r.id}`,
    })),
    { kind: 'separator' },
    { kind: 'hint', label: 'Or drop .zip files anywhere on this page', testId: 'drop-hint' },
  ];
}

function accountItems(a: AccountActions, appearance: ReturnType<typeof useAppearance>): MenuEntry[] {
  const appearanceSub: MenuEntry = { kind: 'submenu', id: 'appearance', label: 'Appearance', items: appearanceMenuItems(appearance), testId: 'appearance' };
  if (!a.accounts || !a.user) {
    return [
      appearanceSub,
      { id: 'connect', label: 'Connect Claude…', onSelect: a.onConnect, testId: 'open-connect-claude' },
      { kind: 'separator' },
      { id: 'about', label: 'About & source', onSelect: a.onAbout, testId: 'open-about' },
    ];
  }
  return [
    { kind: 'header', title: a.user.name, detail: a.user.email ?? (a.user.orcid ? `ORCID ${a.user.orcid}` : null), testId: 'account-header' },
    { kind: 'separator' },
    { id: 'account', label: 'Account settings…', onSelect: a.onAccount, testId: 'user-name' },
    appearanceSub,
    { id: 'connect', label: 'Connect Claude…', onSelect: a.onConnect, testId: 'open-connect-claude' },
    ...(a.admin ? [{ id: 'admin', label: 'Server admin', onSelect: a.onAdmin, testId: 'admin-link' } as MenuEntry] : []),
    { kind: 'separator' },
    { id: 'about', label: 'About & source', onSelect: a.onAbout, testId: 'open-about' },
    { id: 'sign-out', label: 'Sign out', onSelect: a.onSignOut, testId: 'logout' },
  ];
}

/** The avatar with the account menu, or "…" with the same minus the account when there are no accounts. */
export function AccountButton(a: AccountActions) {
  const appearance = useAppearance();
  const items = () => accountItems(a, appearance);
  if (a.accounts && a.user) {
    return (
      <MenuButton items={items} label="Account" ariaLabel={`Account: ${a.user.name}`} title={a.user.name} className="home-avatar" testId="account-menu" menuTestId="account-menu-list" placement="bottom-end">
        <span className="home-avatar__face" aria-hidden="true">{initials(a.user.name)}</span>
      </MenuButton>
    );
  }
  return (
    <MenuButton items={items} label="More" ariaLabel="More" title="More" className="home-tool home-tool--icon" testId="home-more" menuTestId="home-more-list" placement="bottom-end">
      <IconEllipsis width={16} height={16} />
    </MenuButton>
  );
}

interface SearchProps {
  value: string;
  onChange(v: string): void;
  onOpenPalette(): void;
  /** Arrow Down from the field moves into the results. */
  onExit?(): void;
}

/** Filters the shelf in place as you type; the keycap opens the command palette. */
export const HomeSearch = forwardRef<HTMLInputElement, SearchProps>(function HomeSearch({ value, onChange, onOpenPalette, onExit }, ref) {
  const keys = useShortcutLabel('palette');
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (value) onChange('');
      else e.currentTarget.blur();
    } else if (e.key === 'ArrowDown' && onExit) {
      e.preventDefault();
      onExit();
    }
  };
  return (
    <div className="home-search" role="search">
      <IconSearch width={15} height={15} aria-hidden="true" className="home-search__glass" />
      <label htmlFor="home-search" className="visually-hidden">Search projects</label>
      <input
        ref={ref}
        id="home-search"
        className="home-search__input"
        type="search"
        placeholder="Search projects"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        data-testid="home-search"
      />
      {value ? (
        <button type="button" className="home-search__clear" aria-label="Clear the search" onClick={() => onChange('')} data-testid="home-search-clear"><IconX width={12} height={12} /></button>
      ) : (
        <button type="button" className="home-search__kbd" onClick={onOpenPalette} aria-label={`Search commands (${keys})`} aria-haspopup="dialog" title="Search commands" data-testid="palette-open">
          <kbd className="kbd">{keys}</kbd>
        </button>
      )}
    </div>
  );
});

interface ToolbarProps {
  compact: boolean;
  scrolled: boolean;
  /** The page's large title has scrolled under the bar. */
  titleInBar?: boolean;
  start: StartActions;
  account: AccountActions;
  onOpenAddSheet(): void;
  search: React.ReactNode;
}

/** Wordmark, search, New project and the account: the one bar of the project list. */
export default function HomeToolbar({ compact, scrolled, titleInBar, start, account, onOpenAddSheet, search }: ToolbarProps) {
  return (
    <header className={`home-bar${scrolled ? ' is-scrolled' : ''}${compact ? ' home-bar--compact' : ''}`} aria-label="Projects toolbar" data-testid="home-bar">
      <div className="home-bar__inner">
        <Link to="/" className="home-bar__brand"><Wordmark height={compact ? 19 : 20} /></Link>
        {compact && <span className={`home-bar__title${titleInBar ? ' is-shown' : ''}`} aria-hidden="true">Projects</span>}
        {!compact && search}
        <span className="home-bar__spacer" />
        {!compact && (
          <div className="split" role="group" aria-label="New project">
            <button type="button" className="split__main" onClick={start.onNew} data-testid="new-project">
              <IconPlus width={14} height={14} strokeWidth={1.8} aria-hidden="true" />
              New project
            </button>
            <MenuButton
              items={() => startItems(start)}
              label="More ways to start a project"
              ariaLabel="More ways to start a project"
              title="More ways to start a project"
              className="split__more"
              testId="new-menu"
              menuTestId="new-menu-list"
              placement="bottom-end"
            >
              <IconChevronDown width={12} height={12} />
            </MenuButton>
          </div>
        )}
        <AccountButton {...account} />
        {compact && (
          <button type="button" className="home-tool home-tool--icon home-tool--add" onClick={onOpenAddSheet} aria-label="New project" aria-haspopup="dialog" data-testid="home-add">
            <IconPlus width={22} height={22} strokeWidth={1.8} />
          </button>
        )}
      </div>
    </header>
  );
}
