import { memo, useId, useMemo, useRef, useState, type CSSProperties, type HTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, type ProjectSummary, type ProjectThumb, type TrashedProject } from '../../api';
import { Menu, MenuButton, sheetFits, type MenuEntry } from '../Menu';
import ActionSheet from '../ActionSheet';
import { IconBranch, IconEllipsis, IconLink, IconPeople, IconPlus } from '../Icons';
import { REMOTES } from '../../remotes';
import { errorLabel, firstName, initials, isUnread, metaLine, ownerChipShown, projectHref } from '../../util/homeList';
import { dayAgo, shortDate } from '../../util/dates';

/** Height to width of an A4 page: the tallest stage a section gets. */
export const A4 = Math.SQRT2;
/** Height to width of a US Letter page. */
export const LETTER = 11 / 8.5;

/** Height to width of the page a thumbnail shows; a project never typeset stands as an A4 title page. */
export function pageRatio(thumb: Pick<ProjectThumb, 'w' | 'h'> | null | undefined): number {
  return thumb && thumb.w > 0 && thumb.h > 0 ? thumb.h / thumb.w : A4;
}

/** The stage of a row: as tall as its tallest page, at most A4. */
export function stageRatio(ratios: number[]): number {
  return Math.min(A4, Math.max(0.3, ...ratios));
}

/** An item's stage and where its paper sits on it: `--paper-top` and `--paper-inset` (from the right) as fractions of
 *  the item's width, for what is drawn on the paper's corner from outside it. */
function sheetVars(stage: number | undefined, ratio: number): CSSProperties {
  const s = stage ?? A4;
  return {
    '--stage-ratio': s.toFixed(5),
    '--paper-top': Math.max(0, s - Math.min(ratio, A4)).toFixed(5),
    '--paper-inset': (ratio > A4 ? 1 - A4 / ratio : 0).toFixed(5),
  } as CSSProperties;
}

/** The paper's box on its stage: full width, bottom-aligned; a page taller than A4 narrows instead of growing. */
function paperStyle(ratio: number): CSSProperties {
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

const ABSTRACT = [100, 100, 96, 100, 62];
const BODY = [100, 98, 100, 96, 100, 100, 94, 100, 72, 100, 100, 97, 100, 99, 100, 88, 100, 100, 95, 100, 64, 100, 98, 100, 91, 100, 100, 86];
const COL_A = [100, 98, 100, 94, 100, 100, 97, 100, 88, 100, 100, 96, 100, 70, 100, 99, 100, 92, 100, 96, 100];
const COL_B = [100, 100, 95, 100, 100, 98, 100, 84, 100, 100, 97, 100, 100, 93, 100, 100, 60];

function Lines({ widths, className }: { widths: number[]; className?: string }) {
  return <span className={`tpage__lines${className ? ` ${className}` : ''}`}>{widths.map((w, i) => <span key={i} className="tpage__line" style={{ width: `${w}%` }} />)}</span>;
}

export type TemplateKind = 'article' | 'thesis' | 'two-column' | 'slides';

/** What a template's first page looks like, drawn as type and greeked lines until templates bring rendered previews. */
export function TemplatePage({ kind, title }: { kind: TemplateKind; title: string }) {
  if (kind === 'slides') {
    return (
      <span className="tpage tpage--slides" aria-hidden="true">
        <span className="tpage__title">{title}</span>
        <span className="tpage__rule" style={{ width: '38%' }} />
        <span className="tpage__rule tpage__rule--faint" style={{ width: '24%' }} />
        <span className="tpage__footer" />
      </span>
    );
  }
  if (kind === 'thesis') {
    return (
      <span className="tpage tpage--thesis" aria-hidden="true">
        <span className="tpage__chapter">Chapter 1</span>
        <span className="tpage__title">{title}</span>
        <span className="tpage__hair" />
        <Lines widths={BODY} />
      </span>
    );
  }
  if (kind === 'two-column') {
    return (
      <span className="tpage tpage--two" aria-hidden="true">
        <span className="tpage__title">{title}</span>
        <span className="tpage__rule" style={{ width: '52%' }} />
        <span className="tpage__rule tpage__rule--faint" style={{ width: '34%' }} />
        <Lines widths={ABSTRACT} className="tpage__abstract" />
        <span className="tpage__cols">
          <span className="tpage__col"><span className="tpage__head" style={{ width: '46%' }} /><Lines widths={COL_A} /></span>
          <span className="tpage__col"><span className="tpage__figure" /><Lines widths={COL_B} /></span>
        </span>
      </span>
    );
  }
  return (
    <span className="tpage tpage--article" aria-hidden="true">
      <span className="tpage__title">{title}</span>
      <span className="tpage__rule" style={{ width: '30%' }} />
      <Lines widths={ABSTRACT} className="tpage__abstract" />
      <span className="tpage__body"><span className="tpage__head" style={{ width: '34%' }} /><Lines widths={BODY} /></span>
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

function Chip({ children, title, testId }: { children: ReactNode; title?: string; testId?: string }) {
  return <span className="chip" title={title} data-testid={testId}>{children}</span>;
}

/** At most two: unclaimed, the branch it opens on, who it is shared with, the git host. Each says itself in `sr`. */
function chipsFor(p: ProjectSummary, accounts: boolean, myId: string | null): { node: ReactNode; sr: string }[] {
  const out: { node: ReactNode; sr: string }[] = [];
  if (accounts && !p.ownerId) {
    const t = 'This project predates accounts on this server and has no owner yet';
    out.push({ sr: 'Unclaimed', node: <Chip key="unclaimed" title={t} testId={`unclaimed-${p.id}`}>Unclaimed</Chip> });
  }
  const branch = p.opened?.branch;
  if (branch && branch !== 'main') out.push({ sr: `Opens on ${branch}`, node: <Chip key="branch" title={`Opens on ${branch}`}><IconBranch width={11} height={11} /><span className="chip__text">{branch}</span></Chip> });
  if (accounts && p.ownerId) {
    if (ownerChipShown(p, accounts)) {
      const owner = p.ownerName || 'someone';
      const t = p.access === 'link' ? `Opened through a link from ${owner}` : `${p.ownerName || 'Someone'}’s project`;
      out.push({
        sr: t,
        node: (
          <Chip key="owner" title={t} testId={`owner-${p.id}`}>
            <Avatar name={p.ownerName} size={14} />
            <span className="chip__text">{firstName(p.ownerName) || 'Shared'}</span>
            {p.access === 'link' && <IconLink width={11} height={11} />}
          </Chip>
        ),
      });
    } else if (p.share?.mode === 'link') {
      const t = 'Anyone signed in with the link can edit';
      out.push({ sr: t, node: <Chip key="link" title={t} testId={`shared-link-${p.id}`}><IconLink width={11} height={11} /><span className="chip__text">Link</span></Chip> });
    } else if (p.share?.collaborators.length) {
      const n = p.share.collaborators.length;
      const t = `Shared with ${n} ${n === 1 ? 'person' : 'people'}`;
      out.push({ sr: t, node: <Chip key="people" title={t} testId={`shared-people-${p.id}`}><IconPeople width={12} height={12} /><span className="chip__text">{n}</span></Chip> });
    }
  }
  if (p.remote && REMOTES[p.remote.provider]) {
    const d = REMOTES[p.remote.provider];
    // A row from the tab's cache carries no repository name.
    const t = p.remote.fullName ? `Synced with ${d.label}: ${p.remote.fullName}` : `Synced with ${d.label}`;
    out.push({ sr: t, node: <Chip key="host" title={t}>{d.icon}</Chip> });
  }
  return out.slice(0, 2);
}

/** What every sheet on the shelf does, keyed by the item: one stable object for the whole shelf. */
export interface SheetActions {
  menu(id: string): MenuEntry[];
  /** Right-click, long press, Shift+F10 (useContextMenu's bind). */
  bind(getItems: () => MenuEntry[], sheetTitle?: string): HTMLAttributes<HTMLElement>;
  onKeyDown(id: string, e: KeyboardEvent<HTMLElement>): void;
  onFocus(id: string): void;
}

interface SheetProps {
  p: ProjectSummary;
  accounts: boolean;
  myId: string | null;
  now: number;
  /** A phone: the meta line in short units, with the editor's first name. */
  compact?: boolean;
  /** The roving tab stop: exactly one item in the collection is 0. */
  tabIndex: number;
  actions: SheetActions;
  /** On its way out (to the trash, off the list). */
  leaving?: boolean;
  /** Height to width of the stage its row stands on. */
  stage?: number;
}

export const ProjectSheet = memo(function ProjectSheet({ p, accounts, myId, now, compact, tabIndex, actions, leaving, stage }: SheetProps) {
  const metaId = useId();
  const link = useRef<HTMLAnchorElement>(null);
  const [thumbFailed, setThumbFailed] = useState(false);
  const thumb = !thumbFailed ? p.thumb : null;
  const unread = isUnread(p, myId);
  const failing = p.compile?.status === 'error';
  const ownerChip = ownerChipShown(p, accounts);
  const meta = metaLine(p, myId, now, { ownerOnChip: ownerChip });
  const shown = compact ? metaLine(p, myId, now, { ownerOnChip: ownerChip, short: true }) : meta;
  const sentence = meta.who ? `${meta.who} ${meta.text}` : meta.text;
  const when = p.lastEdit?.at ?? p.createdAt;
  const chips = chipsFor(p, accounts, myId);
  const ctx = useMemo(() => actions.bind(() => actions.menu(p.id), p.name), [actions, p.id, p.name]);
  const menu = useMemo(() => () => actions.menu(p.id), [actions, p.id]);
  // Chips and the editor's name sit above the link's cover for their titles; a click on them still opens the project.
  const forward = () => link.current?.click();
  return (
    <li className={`sheet${leaving ? ' is-leaving' : ''}${unread ? ' sheet--unread' : ''}`} data-testid={`project-card-${p.id}`} data-id={p.id} style={sheetVars(stage, pageRatio(thumb))}>
      <div className="sheet__stage">
        <span className={`sheet__paper${thumb ? ' sheet__paper--typeset' : ''}`} style={paperStyle(pageRatio(thumb))}>
          {thumb ? <Thumbnail id={p.id} thumb={thumb} onFail={() => setThumbFailed(true)} /> : <TitlePage title={p.name} />}
          {failing && (
            <span className="sheet__status" data-testid={`compile-error-${p.id}`}>
              <span className="dot dot--error" aria-hidden="true" />{errorLabel(p.compile!.errors)}
            </span>
          )}
        </span>
      </div>
      <MenuButton
        items={menu}
        label={`Actions for ${p.name}`}
        ariaLabel={`Actions for ${p.name}`}
        className="sheet__more"
        testId={`project-menu-${p.id}`}
        menuTestId="project-menu"
        tabIndex={-1}
        sheetTitle={p.name}
      >
        <IconEllipsis width={14} height={14} />
      </MenuButton>
      <Link
        ref={link}
        to={projectHref(p)}
        className="sheet__link"
        tabIndex={tabIndex}
        title={p.name}
        aria-describedby={metaId}
        data-testid={`open-${p.id}`}
        onKeyDown={(e: KeyboardEvent<HTMLAnchorElement>) => { ctx.onKeyDown?.(e); if (!e.defaultPrevented) actions.onKeyDown(p.id, e); }}
        onFocus={() => actions.onFocus(p.id)}
        onContextMenu={ctx.onContextMenu}
        onPointerDown={ctx.onPointerDown}
        onPointerMove={ctx.onPointerMove}
        onPointerUp={ctx.onPointerUp}
        onPointerCancel={ctx.onPointerCancel}
        onTouchEnd={ctx.onTouchEnd}
        data-context-menu=""
        draggable={false}
      >
        <span className="sheet__label">
          {unread && <span className="sheet__unread" data-testid={`unread-${p.id}`} />}
          <span className="sheet__name">{p.name}</span>
        </span>
        {unread && <span className="visually-hidden">, changed since you opened it</span>}
        {failing && <span className="visually-hidden">, {errorLabel(p.compile!.errors)}</span>}
      </Link>
      <p className="sheet__meta" id={metaId} title={compact ? sentence : undefined}>
        {compact && <span className="visually-hidden">{sentence}</span>}
        {shown.who && <span className="sheet__who" title={meta.who ?? undefined} onClick={forward} aria-hidden={compact || undefined}>{shown.who}&nbsp;</span>}
        <time className="sheet__when" dateTime={when} aria-hidden={compact || undefined}>{shown.text}</time>
        {chips.length > 0 && <span className="visually-hidden">. {chips.map((c) => c.sr).join('. ')}</span>}
      </p>
      {chips.length > 0 && <p className="sheet__chips" aria-hidden="true" onClick={forward}>{chips.map((c) => c.node)}</p>}
    </li>
  );
}, (a, b) => sameExceptNow(a, b) && (a.now === b.now || sheetMeta(a) === sheetMeta(b)));

/** Props equal but for the minute tick. */
function sameExceptNow<T extends { now: number }>(a: T, b: T): boolean {
  for (const k of Object.keys(b) as (keyof T)[]) if (k !== 'now' && a[k] !== b[k]) return false;
  return Object.keys(a).length === Object.keys(b).length;
}
/** What a sheet shows that the clock changes; a tick that leaves it as it was re-renders nothing. */
const sheetMeta = ({ p, myId, now, accounts, compact }: SheetProps) => {
  const m = metaLine(p, myId, now, { ownerOnChip: ownerChipShown(p, accounts), short: compact });
  return `${m.who} ${m.text}`;
};
const trashMeta = (t: TrashedProject, now: number) => `Deleted ${dayAgo(t.deletedAt, now)}${t.purgeAt ? ` · gone ${shortDate(t.purgeAt, now)}` : ''}`;

/** A project in the trash: faded, with the day it goes for good. Activating it opens its menu. */
interface TrashProps { t: TrashedProject; now: number; tabIndex: number; actions: SheetActions; stage?: number }

export const TrashSheet = memo(function TrashSheet({ t, now, tabIndex, actions, stage }: TrashProps) {
  const metaId = useId();
  const menuId = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const lastPointer = useRef('');
  const [open, setOpen] = useState<{ items: MenuEntry[]; rect: DOMRect; keyboard: boolean; sheet: boolean } | null>(null);
  const [thumbFailed, setThumbFailed] = useState(false);
  const thumb = !thumbFailed ? t.thumb : null;
  const text = trashMeta(t, now);
  const ctx = useMemo(() => actions.bind(() => actions.menu(t.id), t.name), [actions, t.id, t.name]);
  const menu = useMemo(() => () => actions.menu(t.id), [actions, t.id]);
  return (
    <li className="sheet sheet--trashed" data-testid={`trash-${t.id}`} data-id={t.id} style={sheetVars(stage, pageRatio(thumb))}>
      <div className="sheet__stage">
        <span className="sheet__paper" style={paperStyle(pageRatio(thumb))}>
          {thumb ? <Thumbnail id={t.id} thumb={thumb} onFail={() => setThumbFailed(true)} /> : <TitlePage title={t.name} />}
        </span>
      </div>
      <MenuButton
        items={menu}
        label={`Actions for ${t.name}`}
        ariaLabel={`Actions for ${t.name}`}
        className="sheet__more"
        testId={`trash-menu-${t.id}`}
        menuTestId="project-menu"
        tabIndex={-1}
        sheetTitle={t.name}
      >
        <IconEllipsis width={14} height={14} />
      </MenuButton>
      <button
        ref={btn}
        type="button"
        className="sheet__link"
        tabIndex={tabIndex}
        title={t.name}
        aria-describedby={metaId}
        aria-haspopup="menu"
        aria-expanded={!!open}
        aria-controls={open && !open.sheet ? menuId : undefined}
        data-testid={`trash-open-${t.id}`}
        onKeyDown={(e) => { ctx.onKeyDown?.(e); if (!e.defaultPrevented) actions.onKeyDown(t.id, e); }}
        onFocus={() => actions.onFocus(t.id)}
        onClick={(e) => {
          if (open) { setOpen(null); return; }
          const keyboard = e.detail === 0;
          setOpen({ items: actions.menu(t.id), rect: e.currentTarget.getBoundingClientRect(), keyboard, sheet: !keyboard && lastPointer.current === 'touch' && sheetFits() });
        }}
        onContextMenu={ctx.onContextMenu}
        onPointerDown={(e) => { lastPointer.current = e.pointerType; ctx.onPointerDown?.(e); }}
        onPointerMove={ctx.onPointerMove}
        onPointerUp={ctx.onPointerUp}
        onPointerCancel={ctx.onPointerCancel}
        onTouchEnd={ctx.onTouchEnd}
        data-context-menu=""
      >
        <span className="sheet__name">{t.name}</span>
      </button>
      <p className="sheet__meta" id={metaId}><time className="sheet__when" dateTime={t.deletedAt}>{text}</time></p>
      {open?.sheet && <ActionSheet label={`Actions for ${t.name}`} title={t.name} items={open.items} testId="project-menu" onClose={() => setOpen(null)} />}
      {open && !open.sheet && (
        <Menu
          items={open.items}
          anchor={{ type: 'rect', rect: open.rect, placement: 'bottom-start' }}
          label={`Actions for ${t.name}`}
          id={menuId}
          testId="project-menu"
          initialFocus={open.keyboard ? 'first' : 'menu'}
          instant={open.keyboard}
          returnFocus={btn.current}
          trigger={btn.current}
          onClose={() => setOpen(null)}
        />
      )}
    </li>
  );
}, (a, b) => sameExceptNow(a, b) && (a.now === b.now || trashMeta(a.t, a.now) === trashMeta(b.t, b.now)));

/** The blank page that ends a short shelf, or starts an empty one. */
export function BlankSheet({ title, detail, tabIndex, testId, ratio = A4, stage, onActivate, onKeyDown, onFocus }: {
  title: string; detail: string; tabIndex?: number; testId: string; ratio?: number; stage?: number; onActivate(): void;
  onKeyDown?(e: KeyboardEvent<HTMLElement>): void; onFocus?(): void;
}) {
  const metaId = useId();
  return (
    <li className="sheet sheet--blank" data-testid={`${testId}-item`} style={sheetVars(stage, ratio)}>
      <div className="sheet__stage">
        <span className="sheet__paper sheet__paper--blank" style={paperStyle(ratio)}>
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

/** A template's first page, standing in until templates bring rendered previews. `kind` absent: a title page. */
export function TemplateSheet({ title, name, detail, kind, testId, onActivate, tabIndex, onKeyDown, onFocus }: {
  title: string; name: string; detail: string; kind?: TemplateKind; testId: string; onActivate(): void;
  tabIndex?: number; onKeyDown?(e: KeyboardEvent<HTMLElement>): void; onFocus?(): void;
}) {
  const metaId = useId();
  return (
    <li className="sheet" data-testid={`${testId}-item`} style={sheetVars(A4, kind === 'slides' ? 9 / 16 : A4)}>
      <div className="sheet__stage">
        <span className="sheet__paper" style={paperStyle(kind === 'slides' ? 9 / 16 : A4)}>
          {kind ? <TemplatePage kind={kind} title={title} /> : <TitlePage title={title} />}
        </span>
      </div>
      <button type="button" className="sheet__link" tabIndex={tabIndex} aria-describedby={metaId} data-testid={testId} onClick={onActivate} onKeyDown={onKeyDown} onFocus={onFocus}>
        <span className="sheet__name">{name}</span>
      </button>
      <p className="sheet__meta" id={metaId}>{detail}</p>
    </li>
  );
}

/** A ZIP on its way in: progress on the page, Cancel underneath while the upload can still be stopped. */
export function ImportSheet({ name, state, progress, error, onCancel, testId, stage }: {
  name: string; state: 'uploading' | 'importing' | 'failed'; progress: number | null; error?: string; onCancel(): void; testId: string; stage?: number;
}) {
  const pct = progress === null ? null : Math.round(progress * 100);
  const label = state === 'failed' ? `Not imported: ${error ?? 'unknown error'}`
    : state === 'importing' ? 'Importing…'
      : pct === null ? 'Uploading…' : `Uploading ${pct}%`;
  return (
    <li className={`sheet sheet--import${state === 'failed' ? ' sheet--failed' : ''}`} data-testid={testId} style={sheetVars(stage, A4)}>
      <div className="sheet__stage">
        <span className="sheet__paper" style={paperStyle(A4)}>
          <TitlePage title={name} />
          {state !== 'failed' && (
            <span className="sheet__progress" role="progressbar" aria-label={`Importing ${name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={state === 'importing' ? 100 : pct ?? undefined}>
              <span className="sheet__progress-bar" style={{ transform: `scaleX(${state === 'importing' ? 1 : progress ?? 0.05})` }} />
            </span>
          )}
        </span>
      </div>
      <span className="sheet__name sheet__name--static" title={name}>{name}</span>
      <p className="sheet__meta" role={state === 'failed' ? 'alert' : undefined} data-testid={`${testId}-status`}>{label}</p>
      {/* Once the server has the whole upload it creates the project whatever the page does. */}
      {state !== 'importing' && (
        <p className="sheet__chips">
          <button type="button" className="btn btn--small btn--ghost" onClick={onCancel} aria-label={`${state === 'failed' ? 'Dismiss' : 'Cancel'} import of ${name}`} data-testid={`${testId}-cancel`}>{state === 'failed' ? 'Dismiss' : 'Cancel'}</button>
        </p>
      )}
    </li>
  );
}

/** A sheet-shaped silhouette while the list loads, Letter-shaped like most first pages. */
export function SkeletonSheet() {
  return (
    <li className="sheet sheet--skeleton" aria-hidden="true" style={sheetVars(LETTER, LETTER)}>
      <div className="sheet__stage"><span className="sheet__paper" style={paperStyle(LETTER)} /></div>
      <span className="skeleton-line" />
      <span className="skeleton-line skeleton-line--short" />
    </li>
  );
}
