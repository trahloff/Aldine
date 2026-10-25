import { useId, useState, type CSSProperties, type HTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, type ProjectSummary, type ProjectThumb, type TrashedProject } from '../../api';
import { MenuButton, type MenuEntry } from '../Menu';
import { IconBranch, IconEllipsis, IconLink, IconPeople, IconPlus } from '../Icons';
import { REMOTES } from '../../remotes';
import { errorLabel, initials, isUnread, metaLine, projectHref } from '../../util/homeList';
import { dayAgo, shortDate } from '../../util/dates';

/** Width to height of an A4 page: the stage every sheet stands on. */
const A4 = Math.SQRT2;

/** The paper's box on its stage: full width, bottom-aligned; a page taller than A4 narrows instead of growing. */
function paperStyle(thumb: Pick<ProjectThumb, 'w' | 'h'> | null | undefined): CSSProperties {
  const ratio = thumb && thumb.w > 0 && thumb.h > 0 ? thumb.h / thumb.w : A4;
  if (ratio > A4) return { width: `${(A4 / ratio) * 100}%`, aspectRatio: `1 / ${ratio}` };
  return { width: '100%', aspectRatio: `1 / ${ratio}` };
}

/** A page for a project that has never been typeset: its name set as a title page. */
export function TitlePage({ title, slide }: { title: string; slide?: boolean }) {
  return (
    <span className={`titlepage${slide ? ' titlepage--slide' : ''}`} aria-hidden="true">
      <span className="titlepage__title">{title}</span>
      <span className="titlepage__rule" />
      <span className="titlepage__bar" />
      <span className="titlepage__bar titlepage__bar--short" />
      {!slide && <span className="titlepage__folio">1</span>}
    </span>
  );
}

/** Page 1 of the last good typeset, multiplied onto the paper; fades in once decoded. */
function Thumbnail({ id, thumb, onFail }: { id: string; thumb: ProjectThumb; onFail(): void }) {
  const [shown, setShown] = useState(false);
  return (
    <img
      className={`sheet__img${shown ? ' is-shown' : ''}`}
      src={api.thumbnailUrl(id, thumb)}
      alt=""
      width={thumb.w}
      height={thumb.h}
      decoding="async"
      loading="lazy"
      draggable={false}
      onLoad={(e) => {
        const img = e.currentTarget;
        (img.decode ? img.decode() : Promise.resolve()).catch(() => {}).finally(() => setShown(true));
      }}
      onError={onFail}
    />
  );
}

export function Avatar({ name, size = 16 }: { name: string | null | undefined; size?: number }) {
  return <span className="avatar" style={{ width: size, height: size, fontSize: Math.max(7, Math.round(size * 0.45)) }} aria-hidden="true">{initials(name)}</span>;
}

function Chip({ children, title, testId, tone }: { children: ReactNode; title?: string; testId?: string; tone?: 'quiet' }) {
  return <span className={`chip${tone === 'quiet' ? ' chip--quiet' : ''}`} title={title} data-testid={testId}>{children}</span>;
}

/** At most two: unclaimed, the branch it opens on, who it is shared with, the git host. */
function chipsFor(p: ProjectSummary, accounts: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  if (accounts && !p.ownerId) {
    out.push(<Chip key="unclaimed" title="This project predates accounts on this server and has no owner yet" testId={`unclaimed-${p.id}`}>Unclaimed</Chip>);
  }
  const branch = p.opened?.branch;
  if (branch && branch !== 'main') out.push(<Chip key="branch" title={`Opens on ${branch}`}><IconBranch width={11} height={11} /><span className="chip__text">{branch}</span></Chip>);
  if (accounts && p.ownerId) {
    const shared = p.access ? p.access !== 'owner' : p.isOwner === false;
    if (shared) {
      out.push(<Chip key="owner" title={`${p.ownerName || 'Someone'}’s project`} testId={`owner-${p.id}`}><Avatar name={p.ownerName} size={14} /><span className="chip__text">{p.ownerName || 'Shared'}</span></Chip>);
    } else if (p.share?.mode === 'link') {
      out.push(<Chip key="link" title="Anyone signed in with the link can edit" testId={`shared-link-${p.id}`}><IconLink width={11} height={11} /><span className="chip__text">Link</span></Chip>);
    } else if (p.share?.collaborators.length) {
      const n = p.share.collaborators.length;
      out.push(<Chip key="people" title={`Shared with ${n} ${n === 1 ? 'person' : 'people'}`} testId={`shared-people-${p.id}`}><IconPeople width={12} height={12} /><span className="chip__text">{n}</span></Chip>);
    }
  }
  if (p.remote && REMOTES[p.remote.provider]) {
    const d = REMOTES[p.remote.provider];
    out.push(<Chip key="host" title={`Synced with ${d.label}: ${p.remote.fullName}`}>{d.icon}<span className="visually-hidden">{d.label}</span></Chip>);
  }
  return out.slice(0, 2);
}

interface SheetProps {
  p: ProjectSummary;
  accounts: boolean;
  myId: string | null;
  now: number;
  /** The roving tab stop: exactly one item in the collection is 0. */
  tabIndex: number;
  menu(): MenuEntry[];
  /** Right-click, long press, Shift+F10 (useContextMenu's bind). */
  contextMenu: HTMLAttributes<HTMLElement>;
  onKeyDown(e: KeyboardEvent<HTMLElement>): void;
  onFocus(): void;
  /** On its way out (to the trash, off the list). */
  leaving?: boolean;
}

export function ProjectSheet({ p, accounts, myId, now, tabIndex, menu, contextMenu, onKeyDown, onFocus, leaving }: SheetProps) {
  const metaId = useId();
  const [thumbFailed, setThumbFailed] = useState(false);
  const thumb = !thumbFailed ? p.thumb : null;
  const unread = isUnread(p, myId);
  const failing = p.compile?.status === 'error';
  const meta = metaLine(p, myId, now);
  const when = p.lastEdit?.at ?? p.createdAt;
  const chips = chipsFor(p, accounts);
  const slide = !!thumb && thumb.w > thumb.h;
  return (
    <li className={`sheet${leaving ? ' is-leaving' : ''}${unread ? ' sheet--unread' : ''}`} data-testid={`project-card-${p.id}`} data-id={p.id}>
      <div className="sheet__stage">
        <span className={`sheet__paper${thumb ? ' sheet__paper--typeset' : ''}`} style={paperStyle(thumb)}>
          {thumb ? <Thumbnail id={p.id} thumb={thumb} onFail={() => setThumbFailed(true)} /> : <TitlePage title={p.name} slide={slide} />}
          {failing && (
            <span className="sheet__status" data-testid={`compile-error-${p.id}`}>
              <span className="dot dot--error" aria-hidden="true" />{errorLabel(p.compile!.errors)}
            </span>
          )}
          <MenuButton
            items={menu}
            label={`Actions for ${p.name}`}
            ariaLabel={`Actions for ${p.name}`}
            className="sheet__more"
            testId={`project-menu-${p.id}`}
            menuTestId="project-menu"
            tabIndex={-1}
          >
            <IconEllipsis width={14} height={14} />
          </MenuButton>
        </span>
      </div>
      <Link
        to={projectHref(p)}
        className="sheet__link"
        tabIndex={tabIndex}
        aria-describedby={metaId}
        data-testid={`open-${p.id}`}
        onKeyDown={(e: KeyboardEvent<HTMLAnchorElement>) => { contextMenu.onKeyDown?.(e); if (!e.defaultPrevented) onKeyDown(e); }}
        onFocus={onFocus}
        onContextMenu={contextMenu.onContextMenu}
        onPointerDown={contextMenu.onPointerDown}
        onPointerMove={contextMenu.onPointerMove}
        onPointerUp={contextMenu.onPointerUp}
        onPointerCancel={contextMenu.onPointerCancel}
        onTouchEnd={contextMenu.onTouchEnd}
        data-context-menu=""
        draggable={false}
      >
        {unread && <span className="sheet__unread" data-testid={`unread-${p.id}`} />}
        <span className="sheet__name" title={p.name}>{p.name}</span>
        {unread && <span className="visually-hidden">, changed since you opened it</span>}
        {failing && <span className="visually-hidden">, {errorLabel(p.compile!.errors)}</span>}
      </Link>
      <p className="sheet__meta" id={metaId}>
        {meta.who && <span className="sheet__who" title={p.lastEdit?.byName ?? undefined}>{meta.who}&nbsp;</span>}
        <time className="sheet__when" dateTime={when}>{meta.text}</time>
      </p>
      {chips.length > 0 && <p className="sheet__chips">{chips}</p>}
    </li>
  );
}

/** A project in the trash: dimmed, with the day it goes for good. Activating it opens its menu. */
export function TrashSheet({ t, now, tabIndex, menu, contextMenu, onKeyDown, onFocus }: {
  t: TrashedProject; now: number; tabIndex: number; menu(): MenuEntry[]; contextMenu: HTMLAttributes<HTMLElement>;
  onKeyDown(e: KeyboardEvent<HTMLElement>): void; onFocus(): void;
}) {
  const metaId = useId();
  const [thumbFailed, setThumbFailed] = useState(false);
  const thumb = !thumbFailed ? t.thumb : null;
  const text = `Deleted ${dayAgo(t.deletedAt, now)}${t.purgeAt ? ` · gone ${shortDate(t.purgeAt, now)}` : ''}`;
  return (
    <li className="sheet sheet--trashed" data-testid={`trash-${t.id}`} data-id={t.id}>
      <div className="sheet__stage">
        <span className="sheet__paper" style={paperStyle(thumb)}>
          {thumb ? <Thumbnail id={t.id} thumb={thumb} onFail={() => setThumbFailed(true)} /> : <TitlePage title={t.name} />}
          <MenuButton
            items={menu}
            label={`Actions for ${t.name}`}
            ariaLabel={`Actions for ${t.name}`}
            className="sheet__more"
            testId={`trash-menu-${t.id}`}
            menuTestId="project-menu"
            tabIndex={-1}
          >
            <IconEllipsis width={14} height={14} />
          </MenuButton>
        </span>
      </div>
      <button
        type="button"
        className="sheet__link"
        tabIndex={tabIndex}
        aria-describedby={metaId}
        aria-haspopup="menu"
        data-testid={`trash-open-${t.id}`}
        onKeyDown={(e) => { contextMenu.onKeyDown?.(e); if (!e.defaultPrevented) onKeyDown(e); }}
        onFocus={onFocus}
        onClick={(e) => {
          // Opens the same menu as the "…" button, from where the sheet is.
          (e.currentTarget.parentElement?.querySelector('.sheet__more') as HTMLButtonElement | null)?.click();
        }}
        onContextMenu={contextMenu.onContextMenu}
        onPointerDown={contextMenu.onPointerDown}
        onPointerMove={contextMenu.onPointerMove}
        onPointerUp={contextMenu.onPointerUp}
        onPointerCancel={contextMenu.onPointerCancel}
        onTouchEnd={contextMenu.onTouchEnd}
        data-context-menu=""
      >
        <span className="sheet__name" title={t.name}>{t.name}</span>
      </button>
      <p className="sheet__meta" id={metaId}><time className="sheet__when" dateTime={t.deletedAt}>{text}</time></p>
    </li>
  );
}

/** The blank page that ends a short shelf, or starts an empty one. */
export function BlankSheet({ title, detail, tabIndex, testId, onActivate, onKeyDown, onFocus }: {
  title: string; detail: string; tabIndex?: number; testId: string; onActivate(): void;
  onKeyDown?(e: KeyboardEvent<HTMLElement>): void; onFocus?(): void;
}) {
  const metaId = useId();
  return (
    <li className="sheet sheet--blank" data-testid={`${testId}-item`}>
      <div className="sheet__stage">
        <span className="sheet__paper sheet__paper--blank" style={paperStyle(null)}>
          <IconPlus width={28} height={28} strokeWidth={1.4} aria-hidden="true" />
        </span>
      </div>
      <button type="button" className="sheet__link" tabIndex={tabIndex} aria-describedby={metaId} data-testid={testId} onClick={onActivate} onKeyDown={onKeyDown} onFocus={onFocus}>
        <span className="sheet__name">{title}</span>
      </button>
      <p className="sheet__meta" id={metaId}>{detail}</p>
    </li>
  );
}

/** A template's first page, standing in until templates bring rendered previews. */
export function TemplateSheet({ title, name, detail, slide, testId, onActivate, tabIndex, onKeyDown, onFocus }: {
  title: string; name: string; detail: string; slide?: boolean; testId: string; onActivate(): void;
  tabIndex?: number; onKeyDown?(e: KeyboardEvent<HTMLElement>): void; onFocus?(): void;
}) {
  const metaId = useId();
  return (
    <li className="sheet" data-testid={`${testId}-item`}>
      <div className="sheet__stage">
        <span className="sheet__paper" style={paperStyle(slide ? { w: 16, h: 9 } : null)}>
          <TitlePage title={title} slide={slide} />
        </span>
      </div>
      <button type="button" className="sheet__link" tabIndex={tabIndex} aria-describedby={metaId} data-testid={testId} onClick={onActivate} onKeyDown={onKeyDown} onFocus={onFocus}>
        <span className="sheet__name">{name}</span>
      </button>
      <p className="sheet__meta" id={metaId}>{detail}</p>
    </li>
  );
}

/** A ZIP on its way in: progress on the page, Cancel underneath. */
export function ImportSheet({ name, state, progress, error, onCancel, testId }: {
  name: string; state: 'uploading' | 'importing' | 'failed'; progress: number | null; error?: string; onCancel(): void; testId: string;
}) {
  const pct = progress === null ? null : Math.round(progress * 100);
  const label = state === 'failed' ? `Not imported: ${error ?? 'unknown error'}`
    : state === 'importing' ? 'Importing…'
      : pct === null ? 'Uploading…' : `Uploading ${pct}%`;
  return (
    <li className={`sheet sheet--import${state === 'failed' ? ' sheet--failed' : ''}`} data-testid={testId}>
      <div className="sheet__stage">
        <span className="sheet__paper" style={paperStyle(null)}>
          <TitlePage title={name} />
          {state !== 'failed' && (
            <span className="sheet__progress" role="progressbar" aria-label={`Importing ${name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={state === 'importing' ? 100 : pct ?? undefined}>
              <span className="sheet__progress-bar" style={{ transform: `scaleX(${state === 'importing' ? 1 : progress ?? 0.05})` }} />
            </span>
          )}
        </span>
      </div>
      <span className="sheet__name sheet__name--static" title={name}>{name}</span>
      <p className="sheet__meta" role={state === 'failed' ? 'alert' : undefined}>{label}</p>
      <p className="sheet__chips">
        <button type="button" className="btn btn--small btn--ghost" onClick={onCancel} data-testid={`${testId}-cancel`}>{state === 'failed' ? 'Dismiss' : 'Cancel'}</button>
      </p>
    </li>
  );
}

/** A sheet-shaped silhouette while the list loads. */
export function SkeletonSheet() {
  return (
    <li className="sheet sheet--skeleton" aria-hidden="true">
      <div className="sheet__stage"><span className="sheet__paper" style={paperStyle(null)} /></div>
      <span className="skeleton-line" />
      <span className="skeleton-line skeleton-line--short" />
    </li>
  );
}

