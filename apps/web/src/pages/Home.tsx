import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, ProjectSummary, RemoteInfo, RemoteProviderId, TemplateInfo, TrashedProject } from '../api';
import { withBase } from '../basePath';
import { useToast, useToastDismiss } from '../components/Toast';
import { useDialogs } from '../components/Dialogs';
import { useAuth } from '../components/Auth';
import EmailConfirmBanner from '../components/EmailConfirmBanner';
import InvitationsStrip from '../components/home/InvitationsStrip';
import ShareModal from '../components/ShareModal';
import { appearanceCommands } from '../components/Appearance';
import AccountSettings from '../components/AccountSettings';
import { MenuButton, useContextMenu, type MenuEntry } from '../components/Menu';
import ActionSheet from '../components/ActionSheet';
import { IconChevronDown, IconPlus } from '../components/Icons';
import HomeToolbar, { HomeSearch, startItems, type AccountActions, type StartActions } from '../components/home/HomeToolbar';
import {
  BlankSheet, ImportSheet, pageRatio, ProjectSheet, SkeletonSheet, stageRatio, TemplateSheet, TrashSheet, type SheetActions, type TemplateKind,
} from '../components/home/ProjectSheet';
import NewProjectSheet from '../components/NewProjectSheet';
import { useAppearance } from '../theme';
import { useDocumentTitle } from '../util/documentTitle';
import RemoteImport from '../components/RemoteImport';
import { isRemoteProviderId } from '../remotes';
import { rememberedNamespace } from '../components/NamespacePicker';
import About from '../components/About';
import CommandPalette, { Command, usePaletteHotkey } from '../components/CommandPalette';
import ConnectClaudeModal from '../components/ClaudeConnect';
import { useMinuteTick } from '../util/dates';
import { OAUTH_RESUME_KEY } from '../util/oauthParams';
import { takeInviteResume } from '../util/invites';
import { importSummary } from '../util/engines';
import { safeSession, safeStorage } from '../util/safeStorage';
import { gridMove, isGridKey } from '../util/rovingGrid';
import { useMediaQuery, prefersReducedMotion } from '../util/useMediaQuery';
import { useFlip } from '../util/useFlip';
import { isMac } from '../platform';
import {
  isSharedWithMe, matchSentence, matchesQuery, parseShow, parseSort, pdfBranch, pdfOutputPath, projectHref, sectionsOf, SORT_KEY, SORTS,
  sortProjects, type ShelfSection, type Show, type SortKey,
} from '../util/homeList';

declare const __ALDINE_VERSION__: string;

/** AGPL section 13: the source of the version running here (About.tsx says the same). */
const SOURCE_URL = 'https://github.com/trahloff/Aldine';

/** Mirrors IMPORT_MAX_ZIP_BYTES in apps/server/src/routes.ts — the server
 *  enforces it; this pre-flight only spares the upload. */
const IMPORT_MAX_ZIP_MB = 60;
const IMPORT_MAX_ZIP_BYTES = IMPORT_MAX_ZIP_MB * 1024 * 1024;

/** The palette's sections before anything is typed: projects first. */
const PALETTE_GROUPS = ['Projects', 'New', 'Appearance', 'More'];

/** Matches .sheet.is-leaving in app.css. */
const EXIT_MS = 150;
/** A list that answers quicker than this never shows its skeleton. */
const SKELETON_DELAY_MS = 300;
/** With this few projects a blank "New project" page ends the shelf. */
const BLANK_SHEET_MAX = 3;

const PHONE = '(max-width: 640px)';
/** The shelf's column track and gap (.shelf__grid in home.css): the columns are counted from the width, not read back. */
const COL_MIN = 168;
const COL_GAP = 32;
const columnsFor = (width: number, phone: boolean) => (phone ? 2 : Math.max(1, Math.floor((width + COL_GAP) / (COL_MIN + COL_GAP))));

/** The starting points the empty list offers, in this order, when the server has them. */
const STARTERS: { match: (t: TemplateInfo) => boolean; name: (t: TemplateInfo) => string; title: string; detail: string; kind: TemplateKind }[] = [
  { match: (t) => t.id === 'article', name: () => 'Article', title: 'Title of Your Article', detail: 'One column, biblatex', kind: 'article' },
  { match: (t) => t.id === 'report', name: () => 'Thesis', title: 'Title of Your Thesis', detail: 'Chapters in their own files', kind: 'thesis' },
  { match: (t) => t.id === 'beamer', name: () => 'Presentation', title: 'Title of Your Talk', detail: 'Beamer, 16:9', kind: 'slides' },
  { match: (t) => /(^|[:/])neurips/i.test(t.id), name: (t) => withYear('NeurIPS', t), title: 'Paper Title', detail: 'Official kit, fetched on create', kind: 'two-column' },
];

/** "NeurIPS 2026": the year of the call the venue kit points at, when its address names one. */
function withYear(name: string, t: TemplateInfo): string {
  const year = /\b(20\d\d)\b/.exec(t.kit?.homepage ?? t.kit?.url ?? '')?.[1];
  return year ? `${name} ${year}` : name;
}

/** What the tab keeps of the list for an instant return: what the shelf draws, nothing it does not (no invite
 *  addresses, no Zotero account, no repository names). The fetch that follows replaces it. */
function forCache(p: ProjectSummary): ProjectSummary {
  return {
    ...p,
    share: p.share ? { mode: p.share.mode, collaborators: p.share.collaborators.map(() => '') } : p.share,
    zotero: null,
    remote: p.remote ? ({ provider: p.remote.provider, fullName: '' } as ProjectSummary['remote']) : p.remote,
  };
}
/** A row from that cache, before the fetch answered: its sharing details are not known. */
const fromCache = (p: ProjectSummary) => !!p.share?.collaborators.some((c) => !c);

interface ImportJob {
  key: string;
  name: string;
  state: 'uploading' | 'importing' | 'failed';
  progress: number | null;
  error?: string;
  ctrl: AbortController;
}

const ratioOf = (p: ProjectSummary) => pageRatio(p.thumb);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
/** A dialog or menu is open: page shortcuts stand aside. */
const overlayOpen = () => !!document.querySelector('.modal-backdrop:not(.is-leaving), .menu--floating:not(.is-leaving)');

function download(href: string, filename?: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename ?? '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function failureReason(err: unknown): string {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'You are offline.';
  if (err instanceof ApiError && err.status === 0) return 'The server didn’t answer.';
  if (err instanceof ApiError) return `The server answered: ${err.message}.`;
  return 'The server didn’t answer.';
}

export default function Home() {
  const navigate = useNavigate();
  const toast = useToast();
  const dismissToast = useToastDismiss();
  const dialogs = useDialogs();
  const appearance = useAppearance();
  const { authEnabled, user, admin, setUser } = useAuth();
  const myId = user?.id ?? null;
  const compact = useMediaQuery(PHONE);
  const now = useMinuteTick();
  const [params] = useSearchParams();
  const show: Show = parseShow(params.get('show'), authEnabled);
  useDocumentTitle('Projects');

  const cacheKey = `aldine.home.list:${myId ?? 'local'}`;
  const [projects, setProjects] = useState<ProjectSummary[] | null>(() => safeSession.getJSON<ProjectSummary[] | null>(cacheKey, null, (v): v is ProjectSummary[] => Array.isArray(v)));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [trash, setTrash] = useState<TrashedProject[] | null>(null);
  const [remotes, setRemotes] = useState<RemoteInfo[]>([]);
  const [logins, setLogins] = useState<Partial<Record<RemoteProviderId, string>>>({});
  const [sort, setSortState] = useState<SortKey>(() => parseSort(safeStorage.get(SORT_KEY)));
  const [query, setQuery] = useState('');
  const [skeleton, setSkeleton] = useState(false);
  const [starters, setStarters] = useState<TemplateInfo[] | null>(null);
  const [imports, setImports] = useState<ImportJob[]>([]);
  const [leaving, setLeaving] = useState<Set<string>>(() => new Set());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const [titleUnder, setTitleUnder] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);

  const [creating, setCreating] = useState<{ template?: string } | null>(null);
  const [sharing, setSharing] = useState<ProjectSummary | null>(null);
  const [showAccount, setShowAccount] = useState(false);
  const [importFrom, setImportFrom] = useState<RemoteProviderId | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [addSheet, setAddSheet] = useState<{ keyboard: boolean } | null>(null);
  const [emptying, setEmptying] = useState(false);
  const [startKey, setStartKey] = useState<string | null>(null);
  usePaletteHotkey(useCallback(() => setPaletteOpen((o) => !o), []));

  const zipInput = useRef<HTMLInputElement>(null);
  const startRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const shelfRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | null | 'title'>(null);
  /** Mod+Z: each notice that can be undone, by its key, newest last. */
  const undos = useRef(new Map<string, () => void>());
  /** Items on their way out: a second Delete on one is not a second request. */
  const busy = useRef(new Set<string>());
  /** Bumped by every change made here, so a list fetched before it does not undo it. */
  const edits = useRef(0);
  const loads = useRef(0);
  const flip = useFlip(shelfRef);
  const mainRef = useRef<HTMLElement>(null);
  /** The shelf's width; its columns are the rows each sheet's stage is sized by. Measured before the first paint. */
  const [shelfWidth, setShelfWidth] = useState(() => (typeof window === 'undefined' ? 1168 : Math.min(1168, window.innerWidth - 48)));
  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      setShelfWidth(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const cols = columnsFor(shelfWidth, compact);
  const dragDepth = useRef(0);

  const setSort = (s: SortKey) => { setSortState(s); safeStorage.set(SORT_KEY, s); };

  const loadTrash = useCallback(() => api.listTrash().then(setTrash).catch(() => setTrash((t) => t ?? [])), []);
  const load = useCallback((): Promise<void> => {
    loadTrash();
    const seq = ++loads.current;
    const at = edits.current;
    return api.listProjects()
      .then((p) => {
        if (seq !== loads.current) return;
        // Changed here while the answer was on its way: it is already out of date.
        if (at !== edits.current) return load();
        setProjects(p);
        setLoadError(null);
      })
      .catch((err) => {
        if (seq !== loads.current) return;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) safeSession.remove(cacheKey);
        setLoadError(failureReason(err));
      });
  }, [cacheKey, loadTrash]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (projects) safeSession.setJSON(cacheKey, projects.map(forCache)); }, [projects, cacheKey]);
  /** Every local change to the list goes through here. */
  const change = (fn: (cur: ProjectSummary[] | null) => ProjectSummary[] | null) => { edits.current += 1; setProjects(fn); };
  // Confirming the address brings in the projects shared with it.
  const wasPending = useRef(!!user?.emailPending);
  useEffect(() => {
    if (wasPending.current && !user?.emailPending) load();
    wasPending.current = !!user?.emailPending;
  }, [user?.emailPending]);
  // Back online: the list that failed to load tries again by itself.
  useEffect(() => {
    if (!loadError) return;
    const retry = () => { load(); };
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [loadError, load]);
  useEffect(() => {
    if (projects !== null) { setSkeleton(false); return; }
    const t = setTimeout(() => setSkeleton(true), SKELETON_DELAY_MS);
    return () => clearTimeout(t);
  }, [projects]);

  // Signed in through an SSO provider while an app was waiting on
  // /oauth/authorize, or from an invitation's page: the provider callback
  // lands here, so go back to where the sign-in started.
  useEffect(() => {
    if (!authEnabled || !user) return;
    const resume = safeSession.get(OAUTH_RESUME_KEY);
    safeSession.remove(OAUTH_RESUME_KEY);
    const invite = takeInviteResume();
    if (resume) navigate(`/oauth/authorize${resume}`, { replace: true });
    else if (invite) navigate(invite, { replace: true });
  }, []);
  useEffect(() => {
    api.remotes().then((list) => {
      setRemotes(list);
      // Which account each host is connected as, for the Clone items.
      for (const r of list) {
        api.remoteStatus(r.id).then((s) => { if (s.connected && s.login) setLogins((cur) => ({ ...cur, [r.id]: s.login })); }).catch(() => {});
      }
    }).catch(() => setRemotes([]));
  }, []);
  // returning from a host's OAuth connect → reopen the import flow (now
  // connected). `?github=connected` is the pre-GitLab callback and stays.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const back = q.get('remote') ?? (q.get('github') === 'connected' ? 'github' : null);
    if (back) {
      if (isRemoteProviderId(back)) setImportFrom(back);
      window.history.replaceState({}, '', location.pathname);
    }
  }, []);
  const empty = projects !== null && projects.length === 0 && show === 'all';
  useEffect(() => {
    if (!empty || starters) return;
    api.templates().then(setStarters).catch(() => setStarters([]));
  }, [empty, starters]);

  // The toolbar takes its material once anything has scrolled under it.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setScrolled(!e.isIntersecting));
    io.observe(el);
    // The large title has gone under the bar: the phone's bar shows it instead.
    const t = titleRef.current;
    const titleIo = t ? new IntersectionObserver(([e]) => setTitleUnder(!e.isIntersecting && e.boundingClientRect.top < 60), { rootMargin: '-44px 0px 0px 0px' }) : null;
    if (t) titleIo!.observe(t);
    return () => { io.disconnect(); titleIo?.disconnect(); };
  }, []);

  // ---------- what is shown ----------
  const sharedCount = useMemo(() => (projects ?? []).filter(isSharedWithMe).length, [projects]);
  const visible = useMemo(() => {
    const base = (projects ?? []).filter((p) => (show === 'shared' ? isSharedWithMe(p) : true));
    const q = query.trim();
    return sortProjects(q ? base.filter((p) => matchesQuery(p, q)) : base, sort);
  }, [projects, show, query, sort]);
  const trashVisible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return [...(trash ?? [])]
      .filter((t) => !q || t.name.toLocaleLowerCase().includes(q))
      .sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime());
  }, [trash, query]);
  const sections: ShelfSection[] = useMemo(() => (query.trim()
    ? [{ key: 'all', label: null, items: visible }]
    : sectionsOf(visible, sort, now)), [visible, sort, now, query]);
  const blankSheet = show === 'all' && !query.trim() && projects !== null && projects.length > 0 && projects.length <= BLANK_SHEET_MAX;

  /** The roving items in reading order. */
  const keys: string[] = useMemo(() => {
    if (show === 'trash') return trashVisible.map((t) => t.id);
    return [...visible.map((p) => p.id), ...(blankSheet ? ['new'] : [])];
  }, [show, trashVisible, visible, blankSheet]);
  const tabKey = activeKey && keys.includes(activeKey) ? activeKey : keys[0] ?? null;
  const tabIndexOf = (key: string) => (key === tabKey ? 0 : -1);

  /** The focusable part of a roving item: a project's link, or the blank "New project" page. */
  const linkFor = (key: string) => (key === 'new'
    ? shelfRef.current?.querySelector<HTMLElement>('[data-testid="new-project-tile"]')
    : shelfRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(key)}"] .sheet__link`)) ?? null;

  // Focus that has to wait for the list to re-render (after a trash, a duplicate).
  useEffect(() => {
    const want = pendingFocus.current;
    if (want === null) return;
    pendingFocus.current = null;
    if (want === 'title') { titleRef.current?.focus(); return; }
    const el = linkFor(want);
    if (el) { setActiveKey(want); el.focus(); } else titleRef.current?.focus();
  });

  // ---------- actions ----------
  const byId = (id: string) => projects?.find((p) => p.id === id) ?? null;

  /** Where focus goes when the item `id` leaves the list: the next, else the previous, else the title. */
  const focusAfter = (id: string): string | 'title' => {
    const i = keys.indexOf(id);
    return keys[i + 1] ?? keys[i - 1] ?? 'title';
  };

  /** Fades the item out, then takes it off the list while its neighbours close the gap. */
  const exit = async (id: string, work: Promise<unknown>, hadFocus: boolean): Promise<boolean> => {
    const next = focusAfter(id);
    // From its menu, focus is on the item's "…" button, which leaves with it.
    hadFocus ||= !!(document.activeElement instanceof Element && document.activeElement.closest(`[data-id="${CSS.escape(id)}"]`));
    setLeaving((s) => new Set(s).add(id));
    try {
      await Promise.all([work, wait(prefersReducedMotion() ? 0 : EXIT_MS)]);
    } catch (err) {
      setLeaving((s) => { const n = new Set(s); n.delete(id); return n; });
      throw err;
    }
    flip();
    if (hadFocus) pendingFocus.current = next;
    change((cur) => cur?.filter((p) => p.id !== id) ?? cur);
    setTrash((cur) => (show === 'trash' ? cur?.filter((t) => t.id !== id) ?? cur : cur));
    setLeaving((s) => { const n = new Set(s); n.delete(id); return n; });
    return true;
  };

  /** Puts a project back where the sort says, growing in. Focus left nowhere (the Undo that was clicked went with its notice) lands on it. */
  const reinsert = (p: ProjectSummary) => {
    flip([p.id]);
    const a = document.activeElement;
    if (!a || a === document.body || a.closest('.toasts')) pendingFocus.current = p.id;
    change((cur) => (cur ? [p, ...cur.filter((x) => x.id !== p.id)] : [p]));
  };

  /** Mod+Z does `run` for as long as the notice with `key` is up. */
  const armUndo = (key: string, run: () => void) => {
    undos.current.delete(key);
    undos.current.set(key, run);
  };
  const disarm = (key: string) => { undos.current.delete(key); };
  const expireUndo = (key: string) => () => disarm(key);

  /** Runs `work` for `id` unless it is already under way for it. */
  const once = async (id: string, work: () => Promise<void>) => {
    if (busy.current.has(id)) return;
    busy.current.add(id);
    try { await work(); } finally { busy.current.delete(id); }
  };

  const restoreFromTrash = async (id: string, name: string, original?: ProjectSummary) => {
    disarm(`undo-trash-${id}`);
    try {
      if (show === 'trash') {
        // From its own menu in the trash: the item leaves like any other, and focus moves on.
        await exit(id, api.restoreProject(id), false);
        toast(`Restored ${name}`, 'ok');
        load();
        return;
      }
      await api.restoreProject(id);
      toast(`Restored ${name}`, 'ok');
      // A reload here would re-sort under an open menu and close it; the row is known.
      if (original) { reinsert(original); loadTrash(); } else load();
    } catch (err: any) { toast(err.message, 'error'); }
  };

  const moveToTrash = (p: ProjectSummary, hadFocus = false) => once(p.id, async () => {
    // No question first: the trash keeps the project, and the notification
    // carries the way back.
    try {
      await exit(p.id, api.deleteProject(p.id), hadFocus);
    } catch (err: any) {
      toast(`Could not move ${p.name} to the trash: ${err.message}`, 'error');
      return;
    }
    const key = `undo-trash-${p.id}`;
    const run = () => { dismissToast(key); restoreFromTrash(p.id, p.name, p); };
    toast(`Moved ${p.name} to the trash`, 'info', { label: 'Undo', testId: 'undo-trash', key, onExpire: expireUndo(key), onClick: () => restoreFromTrash(p.id, p.name, p) });
    armUndo(key, run);
    loadTrash();
  });

  const removeFromList = (p: ProjectSummary, hadFocus = false) => once(p.id, async () => {
    try {
      await exit(p.id, api.removeFromList(p.id), hadFocus);
    } catch (err: any) {
      toast(`Could not remove ${p.name} from your list: ${err.message}`, 'error');
      return;
    }
    const key = `undo-remove-${p.id}`;
    const back = async () => {
      disarm(key);
      // Back as it was: the same open, so a change not seen yet stays marked.
      try { await api.restoreListing(p.id, p.opened); reinsert(p); } catch (err: any) { toast(err.message, 'error'); }
    };
    toast(`Removed ${p.name} from your list`, 'info', { label: 'Undo', testId: 'undo-remove', key, onExpire: expireUndo(key), onClick: back });
    armUndo(key, () => { dismissToast(key); back(); });
  });

  const purge = (t: TrashedProject, hadFocus = false) => once(t.id, async () => {
    if (!(await dialogs.confirm({ title: `Delete “${t.name}” forever?`, body: 'This cannot be undone.', confirmLabel: 'Delete forever', danger: true }))) return;
    try {
      await exit(t.id, api.deleteProject(t.id, true), hadFocus);
      toast(`Deleted ${t.name} forever`, 'ok');
    } catch (err: any) { toast(err.message, 'error'); }
  });

  const emptying$ = useRef(false);
  const emptyTrash = async () => {
    const list = trash ?? [];
    if (!list.length || emptying$.current) return;
    emptying$.current = true;
    setEmptying(true);
    try {
      const n = list.length;
      if (!(await dialogs.confirm({
        title: `Delete ${n === 1 ? `“${list[0].name}”` : `all ${n} projects in the trash`} forever?`,
        body: 'This cannot be undone.',
        confirmLabel: 'Empty trash',
        danger: true,
      }))) return;
      let failed = 0;
      for (const t of list) {
        // Gone already (deleted from another tab): not a failure.
        try { await api.deleteProject(t.id, true); } catch (err) { if (!(err instanceof ApiError && err.status === 404)) failed += 1; }
      }
      flip();
      // Its own button goes with the last project in the trash.
      pendingFocus.current = 'title';
      await loadTrash();
      toast(failed ? `Emptied the trash · ${failed} could not be deleted` : 'Emptied the trash', failed ? 'error' : 'ok');
    } finally {
      emptying$.current = false;
      setEmptying(false);
    }
  };

  const claim = async (p: ProjectSummary) => {
    if (!(await dialogs.confirm({ title: `Claim “${p.name}”?`, body: 'You become its owner and other users lose access.', confirmLabel: 'Claim project' }))) return;
    try { await api.claimProject(p.id); toast(`You now own ${p.name}`, 'ok'); }
    catch (err: any) { toast(err.message, 'error'); } // e.g. someone claimed it first
    load(); // winner sees owner controls; a loser sees the project disappear
  };

  const rename = async (p: ProjectSummary) => {
    const name = await dialogs.prompt({ title: 'Rename project', value: p.name, confirmLabel: 'Rename' });
    if (name === null || !name.trim() || name.trim() === p.name) return;
    try {
      const updated = await api.patchProject(p.id, { name: name.trim() });
      change((cur) => cur?.map((x) => (x.id === p.id ? { ...x, name: updated.name } : x)) ?? cur);
    } catch (err: any) { toast(`Could not rename ${p.name}: ${err.message}`, 'error'); }
  };

  const duplicate = async (p: ProjectSummary) => {
    try {
      const c = await api.copyProject(p.id);
      if (c.remoteError) toast(c.remoteError, 'error');
      flip([c.id]);
      pendingFocus.current = c.id;
      change((cur) => (cur ? [c, ...cur] : [c]));
      toast(`Duplicated ${p.name} as “${c.name}”`, 'ok');
    } catch (err: any) { toast(`Could not duplicate ${p.name}: ${err.message}`, 'error'); }
  };

  const downloadPdf = (p: ProjectSummary) => {
    download(api.pdfUrl(p.id, pdfBranch(p), pdfOutputPath(p.rootFile)), `${p.name.replace(/[\\/:*?"<>|]/g, '-')}.pdf`);
  };

  const canManage = (p: ProjectSummary) => !authEnabled || !!p.isOwner;
  const trashKeys = isMac ? '⌘⌫' : 'Del';

  const projectMenu = (p: ProjectSummary): MenuEntry[] => {
    const href = projectHref(p);
    const open: MenuEntry[] = [
      { id: 'open', label: 'Open', shortcut: '↩', onSelect: () => navigate(href), testId: 'menu-open' },
      { id: 'open-tab', label: 'Open in new tab', shortcut: isMac ? '⌘↩' : 'Ctrl+↩', onSelect: () => window.open(withBase(href), '_blank', 'noopener'), testId: 'menu-open-tab' },
    ];
    const downloads: MenuEntry[] = [
      // A thumbnail is optional (the compiler may render none); a finished typeset is what makes the PDF.
      { id: 'pdf', label: 'Download PDF', disabled: !p.thumb && p.compile?.status !== 'ok', onSelect: () => downloadPdf(p), testId: 'menu-download-pdf' },
      { id: 'zip', label: 'Download source (.zip)', onSelect: () => download(api.archiveUrl(p.id, p.opened?.branch ?? 'main')), testId: 'menu-download-zip' },
    ];
    const claimItem: MenuEntry[] = authEnabled && !p.ownerId
      ? [{ kind: 'separator' }, { id: 'claim', label: 'Claim project…', onSelect: () => claim(p), testId: `claim-${p.id}` }]
      : [];
    if (!canManage(p)) {
      return [
        ...open,
        ...downloads,
        ...claimItem,
        ...(p.ownerId ? [{ kind: 'separator' } as MenuEntry, { id: 'remove', label: 'Remove from my list', onSelect: () => removeFromList(p), testId: 'menu-remove' } as MenuEntry] : []),
      ];
    }
    return [
      ...open,
      { kind: 'separator' },
      { id: 'rename', label: 'Rename…', onSelect: () => rename(p), testId: 'menu-rename' },
      { id: 'duplicate', label: 'Duplicate', onSelect: () => duplicate(p), testId: 'menu-duplicate' },
      ...(authEnabled ? [{ id: 'share', label: 'Share…', disabled: fromCache(p), onSelect: () => setSharing(p), testId: `share-${p.id}` } as MenuEntry] : []),
      { kind: 'separator' },
      ...downloads,
      ...claimItem,
      { kind: 'separator' },
      { id: 'trash', label: 'Move to Trash', shortcut: trashKeys, danger: true, onSelect: () => moveToTrash(p), testId: 'menu-trash' },
    ];
  };

  const trashMenu = (t: TrashedProject): MenuEntry[] => [
    { id: 'restore', label: 'Restore', onSelect: () => restoreFromTrash(t.id, t.name), testId: `restore-${t.id}` },
    { kind: 'separator' },
    { id: 'purge', label: 'Delete forever…', danger: true, onSelect: () => purge(t), testId: `purge-${t.id}` },
  ];

  const ctx = useContextMenu({ label: 'Project actions', testId: 'project-menu' });

  // ---------- importing ----------
  const importFiles = async (files: File[]) => {
    const zips = files.filter((f) => /\.zip$/i.test(f.name));
    if (!zips.length) { toast(files.length > 1 ? 'Those are not .zip files' : 'Please drop a .zip file', 'error'); return; }
    const single = zips.length === 1 && files.length === 1;
    const jobs: (ImportJob & { file: File })[] = zips.map((file, i) => ({
      key: `import-${Date.now()}-${i}`, name: file.name.replace(/\.zip$/i, ''), file, state: 'uploading', progress: 0, ctrl: new AbortController(),
    }));
    const tooBig = jobs.filter((j) => j.file.size > IMPORT_MAX_ZIP_BYTES);
    for (const j of tooBig) {
      j.state = 'failed';
      j.error = `the ZIP is ${(j.file.size / (1024 * 1024)).toFixed(1)} MB; the limit is ${IMPORT_MAX_ZIP_MB} MB`;
    }
    if (single && tooBig.length) { toast(`ZIP is ${(zips[0].size / (1024 * 1024)).toFixed(1)} MB; the limit is ${IMPORT_MAX_ZIP_MB} MB`, 'error'); return; }
    // The placeholders and the new projects are drawn in the list of all projects.
    if (!single && show !== 'all') navigate('/');
    setImports((cur) => [...jobs.map(({ file: _f, ...j }) => j), ...cur]);
    // Progress arrives many times a second: one state update per frame.
    const pending = new Map<string, Partial<ImportJob>>();
    let frame = 0;
    const flush = () => {
      frame = 0;
      const batch = new Map(pending);
      pending.clear();
      setImports((cur) => cur.map((j) => (batch.has(j.key) ? { ...j, ...batch.get(j.key) } : j)));
    };
    const patch = (key: string, p: Partial<ImportJob>) => {
      pending.set(key, { ...pending.get(key), ...p });
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const drop = (key: string) => { pending.delete(key); setImports((cur) => cur.filter((j) => j.key !== key)); };
    let ok = 0;
    let failed = tooBig.length;
    for (const j of jobs) {
      if (j.state === 'failed' || j.ctrl.signal.aborted) continue;
      try {
        // One-click import: the group is the last one picked in the new-project
        // dialog (none until the picker has been shown once).
        const p = await api.importZipWithProgress(j.name, j.file, {
          namespace: rememberedNamespace(),
          signal: j.ctrl.signal,
          onProgress: (fr) => patch(j.key, fr !== null && fr >= 1 ? { state: 'importing', progress: 1 } : { progress: fr }),
        });
        ok += 1;
        if (p.remoteError) toast(p.remoteError, 'error');
        else if (p.remote) toast(`Also created on GitLab in ${p.remote.owner}`, 'ok');
        if (single) {
          toast(importSummary(p), 'ok');
          drop(j.key);
          navigate(`/p/${p.id}`, { state: { import: p.import } });
          return;
        }
        flip([p.id]);
        drop(j.key);
        change((cur) => (cur ? [p, ...cur.filter((x) => x.id !== p.id)] : [p]));
      } catch (err: any) {
        if (err?.name === 'AbortError') { drop(j.key); continue; }
        failed += 1;
        // A 413 without the route's own text comes from a proxy or body limit
        // below what the app allows — the size is the only number worth stating.
        const mb = (j.file.size / (1024 * 1024)).toFixed(1);
        const msg = err instanceof ApiError && err.status === 413 && !/limit is/.test(err.message)
          ? `${mb} MB was refused before it reached the app, which allows ${IMPORT_MAX_ZIP_MB} MB`
          : err.message;
        if (single) { drop(j.key); toast(`Import failed: ${msg}`, 'error'); return; }
        pending.delete(j.key);
        setImports((cur) => cur.map((x) => (x.key === j.key ? { ...x, state: 'failed', error: msg } : x)));
      }
    }
    if (!single && (ok || failed)) {
      const head = `Imported ${ok} ${ok === 1 ? 'project' : 'projects'}`;
      toast(failed ? `${head} · ${failed} failed` : head, failed ? 'error' : 'ok');
    }
    if (ok) load();
  };

  // ---------- keyboard ----------
  const focusKey = (key: string) => {
    const el = linkFor(key);
    if (el) { setActiveKey(key); el.focus(); el.scrollIntoView({ block: 'nearest' }); }
  };

  const onItemKeyDown = (key: string) => (e: ReactKeyboardEvent<HTMLElement>) => {
    if (isGridKey(e.key) && !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      const links = [...(shelfRef.current?.querySelectorAll<HTMLElement>('.sheet__link') ?? [])].filter((l) => l.closest('.sheet:not(.sheet--import)'));
      const boxes = links.map((l) => { const r = (l.closest('.sheet') as HTMLElement).getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width }; });
      const from = links.indexOf(e.currentTarget);
      const to = gridMove(boxes, from, e.key);
      e.preventDefault();
      if (to >= 0 && to !== from) focusKey(keys[to]);
      return;
    }
    const del = e.key === 'Delete' || (e.key === 'Backspace' && (e.metaKey || e.ctrlKey));
    if (!del) return;
    e.preventDefault();
    if (e.repeat || busy.current.has(key)) return;
    if (show === 'trash') {
      const t = trash?.find((x) => x.id === key);
      if (t) purge(t, true);
      return;
    }
    const p = byId(key);
    if (p && canManage(p)) moveToTrash(p, true);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
        const last = [...undos.current].pop();
        if (!last || isTyping(e.target) || overlayOpen()) return;
        e.preventDefault();
        undos.current.delete(last[0]);
        last[1]();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || overlayOpen()) return;
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); }
      else if (e.key === 'n' && !e.shiftKey) { e.preventDefault(); setCreating({}); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---------- drop to import ----------
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  const dropHandlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDrag(e.dataTransfer.items?.length || 1);
    },
    onDragOver: (e: React.DragEvent) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } },
    onDragLeave: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDrag(null);
    },
    onDrop: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDrag(null);
      const files = Array.from(e.dataTransfer.files);
      if (files.length) importFiles(files);
    },
  };

  // ---------- chrome ----------
  const start: StartActions = {
    remotes,
    logins,
    onNew: () => setCreating({}),
    onImportZip: () => zipInput.current?.click(),
    onClone: (id) => setImportFrom(id),
  };
  const account: AccountActions = {
    accounts: authEnabled,
    user,
    admin: admin && authEnabled,
    onAccount: () => setShowAccount(true),
    onConnect: () => setConnectOpen(true),
    onAbout: () => setAboutOpen(true),
    onAdmin: () => navigate('/admin'),
    onSignOut: async () => { await api.logout(); safeSession.remove(cacheKey); setUser(null); },
  };

  const paletteCommands: Command[] = useMemo(() => [
    ...(projects || []).map((p) => ({ id: `open-${p.id}`, group: 'Projects', title: p.name, run: () => navigate(projectHref(p)) })),
    { id: 'new-project', group: 'New', title: 'New project…', run: () => setCreating({}) },
    { id: 'import-zip', group: 'New', title: 'Import a ZIP…', keywords: 'overleaf upload', run: () => zipInput.current?.click() },
    ...remotes.map((r) => ({ id: `new-from-${r.id}`, group: 'New', title: `Clone from ${r.label}…`, keywords: 'import git repository', run: () => setImportFrom(r.id) })),
    ...appearanceCommands(appearance),
    ...(authEnabled ? [{ id: 'shared', group: 'More', title: 'Show projects shared with me', run: () => navigate('/?show=shared') }] : []),
    { id: 'trash', group: 'More', title: trash?.length ? `Show the trash (${trash.length})` : 'Show the trash', run: () => navigate('/?show=trash') },
    ...(authEnabled && user ? [{ id: 'account', group: 'More', title: 'Account settings…', run: () => setShowAccount(true) }] : []),
    ...(admin && authEnabled ? [{ id: 'admin', group: 'More', title: 'Server admin: accounts and usage', run: () => navigate('/admin') }] : []),
    { id: 'about', group: 'More', title: 'About Aldine and its source code', run: () => setAboutOpen(true) },
    { id: 'connect-claude', group: 'More', title: 'Connect Claude (MCP connector)…', run: () => setConnectOpen(true) },
  ], [remotes, authEnabled, user, admin, trash, projects, navigate, appearance]);

  const search = (
    <HomeSearch
      ref={searchRef}
      value={query}
      onChange={setQuery}
      onOpenPalette={() => setPaletteOpen(true)}
      onExit={() => { if (tabKey) focusKey(tabKey); }}
    />
  );

  // One object for every sheet, so a sheet re-renders only when its own project does.
  const latest = useRef({ projectMenu, trashMenu, onItemKeyDown, byId, trash, show });
  latest.current = { projectMenu, trashMenu, onItemKeyDown, byId, trash, show };
  const actions: SheetActions = useMemo(() => ({
    menu: (id) => {
      const l = latest.current;
      if (l.show === 'trash') { const t = l.trash?.find((x) => x.id === id); return t ? l.trashMenu(t) : []; }
      const p = l.byId(id);
      return p ? l.projectMenu(p) : [];
    },
    bind: ctx.bind,
    onKeyDown: (id, e) => latest.current.onItemKeyDown(id)(e),
    onFocus: (id) => setActiveKey(id),
  }), [ctx.bind]);

  // The counts arrive together: one answering before the other would push the segments sideways twice.
  const counted = projects !== null && trash !== null;
  const filters: { show: Show; label: string; count?: number; testId: string; to: string }[] = [
    { show: 'all', label: 'All', testId: 'filter-all', to: '/' },
    ...(authEnabled ? [{ show: 'shared' as Show, label: compact ? 'Shared' : 'Shared with me', count: (counted && sharedCount) || undefined, testId: 'filter-shared', to: '/?show=shared' }] : []),
    { show: 'trash', label: 'Trash', count: (counted && trash?.length) || undefined, testId: 'open-trash', to: '/?show=trash' },
  ];
  const sortLabel = SORTS.find((s) => s.id === sort)!.label;
  const searching = !!query.trim();
  const listed = show === 'trash' ? trashVisible.length : visible.length;
  /** What happens to what is in the trash, in the days the server keeps it (ALDINE_TRASH_DAYS). */
  const trashNote = (() => {
    const t = trash?.find((x) => x.purgeAt);
    if (!t) return null;
    const days = Math.round((Date.parse(t.purgeAt!) - Date.parse(t.deletedAt)) / 86_400_000);
    return days > 0 ? `Projects in the trash are deleted ${days === 1 ? '1 day' : `${days} days`} after you move them there.` : null;
  })();

  // ---------- the shelf ----------
  const blankRatio = visible.length ? ratioOf(visible[visible.length - 1]) : pageRatio(null);
  /** Each sheet's stage, per section, recomputed only when the rows can change. */
  const stages = useMemo(() => ({
    trash: rowStages(trashVisible.map((t) => pageRatio(t.thumb)), cols),
    sections: sections.map((s, si) => {
      const lead = si === 0 ? imports.length : 0;
      const withBlank = si === sections.length - 1 && blankSheet;
      return rowStages([...Array.from({ length: lead }, () => pageRatio(null)), ...s.items.map(ratioOf), ...(withBlank ? [blankRatio] : [])], cols);
    }),
  }), [trashVisible, sections, imports.length, blankSheet, blankRatio, cols]);

  const renderShelf = () => {
    if (projects === null) {
      if (loadError) return null;
      return (
        <div role="status" aria-live="polite" data-testid="projects-loading">
          <span className="visually-hidden">Loading projects…</span>
          {skeleton && (
            <div className="shelf__section" aria-hidden="true">
              <span className="shelf__heading--placeholder" />
              <ul role="list" className="shelf__grid shelf__grid--skeleton">{Array.from({ length: cols * 2 }, (_, i) => <SkeletonSheet key={i} />)}</ul>
            </div>
          )}
        </div>
      );
    }
    if (show === 'trash') {
      if (trash === null) return null;
      if (!trashVisible.length) {
        return searching ? <NoMatches query={query} onClear={() => setQuery('')} /> : (
          <div className="shelf-empty" data-testid="trash-empty">
            <h2 className="shelf-empty__title">The trash is empty</h2>
            <p className="shelf-empty__text">Projects you move to the trash stay here for a while, then are deleted for good.</p>
          </div>
        );
      }
      return (
        <section aria-labelledby="sec-trash" className="shelf__section">
          <h2 id="sec-trash" className="visually-hidden">Trash</h2>
          {trashNote && <p className="shelf-note shelf-note--trash" data-testid="trash-note">{trashNote}</p>}
          <ul role="list" className="shelf__grid" data-testid="trash-grid">
            {trashVisible.map((t, i) => <TrashSheet key={t.id} t={t} now={now} tabIndex={tabIndexOf(t.id)} actions={actions} stage={stages.trash[i]} />)}
          </ul>
        </section>
      );
    }
    if (empty && !imports.length) return null;
    if (!visible.length && !imports.length) {
      if (searching) return <NoMatches query={query} onClear={() => setQuery('')} />;
      return (
        <div className="shelf-empty" data-testid="shared-empty">
          <h2 className="shelf-empty__title">Nothing shared with you yet</h2>
          <p className="shelf-empty__text">Projects others invite you to, and projects you open through a share link, appear here.</p>
        </div>
      );
    }
    return sections.map((s, si) => {
      const lead = si === 0 ? imports : [];
      const withBlank = si === sections.length - 1 && blankSheet;
      const stage = stages.sections[si];
      return (
      <section key={s.key} aria-labelledby={`sec-${s.key}`} className="shelf__section">
        <h2 id={`sec-${s.key}`} className={s.label ? 'shelf__heading' : 'visually-hidden'}>{s.label ?? (show === 'shared' ? 'Shared with me' : 'All projects')}</h2>
        <ul role="list" className="shelf__grid" data-testid={si === 0 ? 'project-grid' : undefined}>
          {lead.map((j, i) => (
            <ImportSheet key={j.key} testId={j.key} name={j.name} state={j.state} progress={j.progress} error={j.error} stage={stage[i]}
              onCancel={() => { j.ctrl.abort(); setImports((cur) => cur.filter((x) => x.key !== j.key)); }} />
          ))}
          {s.items.map((p, i) => (
              <ProjectSheet key={p.id} leaving={leaving.has(p.id)} p={p} accounts={authEnabled} myId={myId} now={now} compact={compact} tabIndex={tabIndexOf(p.id)} actions={actions} stage={stage[lead.length + i]} />
          ))}
          {withBlank && (
            <BlankSheet
              stage={stage[stage.length - 1]}
              testId="new-project-tile"
              title="New project"
              detail="Template, ZIP or repository"
              ratio={blankRatio}
              tabIndex={tabIndexOf('new')}
              onActivate={() => setCreating({})}
              onKeyDown={onItemKeyDown('new')}
              onFocus={() => setActiveKey('new')}
            />
          )}
        </ul>
      </section>
      );
    });
  };


  const starterSheets = (() => {
    const list = starters ?? [];
    const picked = STARTERS.map((s) => ({ s, t: list.find(s.match) })).filter((x) => x.t);
    return picked as { s: (typeof STARTERS)[number]; t: TemplateInfo }[];
  })();
  /** The starting points are one Tab stop too, with arrows by position. */
  const startKeys = ['start-blank', ...starterSheets.map(({ t }) => startTestId(t)), 'start-more'];
  const startTab = startKey && startKeys.includes(startKey) ? startKey : startKeys[0];
  const startRoving = (key: string) => ({
    tabIndex: key === startTab ? 0 : -1,
    onFocus: () => setStartKey(key),
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
      if (!isGridKey(e.key) || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const links = [...(startRef.current?.querySelectorAll<HTMLElement>('.sheet__link') ?? [])];
      const boxes = links.map((l) => { const r = (l.closest('.sheet') as HTMLElement).getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width }; });
      const to = gridMove(boxes, links.indexOf(e.currentTarget), e.key);
      e.preventDefault();
      const el = links[to];
      if (el && el !== e.currentTarget) { setStartKey(startKeys[to]); el.focus(); }
    },
  });

  return (
    <div className="shelf-page" {...dropHandlers}>
      <a className="skip-link" href="#projects">Skip to projects</a>
      <div ref={sentinel} className="shelf-page__sentinel" aria-hidden="true" />
      <HomeToolbar compact={compact} scrolled={scrolled} titleInBar={titleUnder} start={start} account={account} onOpenAddSheet={(keyboard) => setAddSheet({ keyboard })} search={search} />
      <input ref={zipInput} type="file" accept=".zip,application/zip" multiple hidden data-testid="import-input" aria-hidden="true" tabIndex={-1}
        onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ''; if (files.length) importFiles(files); }} />

      <main className="shelf-page__main" id="projects" tabIndex={-1} ref={mainRef}>
        <div className="shelf-page__title-row">
          <h1 className="shelf-page__title" ref={titleRef} tabIndex={-1}>Projects</h1>
          {show !== 'trash' && !empty && (
            <MenuButton
              items={() => SORTS.map((s) => ({ id: s.id, label: s.label, checked: sort === s.id, onSelect: () => setSort(s.id), testId: `sort-${s.id}` }))}
              label="Sort by"
              className="home-sort"
              testId="sort-menu"
              menuTestId="sort-menu-list"
              placement="bottom-end"
              title="Sort by"
            >
              <span className="visually-hidden">Sort by </span>{sortLabel}<IconChevronDown width={11} height={11} />
            </MenuButton>
          )}
          {show === 'trash' && !!trash?.length && (
            <button type="button" className="home-sort" onClick={emptyTrash} disabled={emptying} aria-busy={emptying || undefined} data-testid="empty-trash">Empty trash…</button>
          )}
        </div>
        {authEnabled && <EmailConfirmBanner />}
        {authEnabled && show !== 'trash' && <InvitationsStrip onAccepted={() => { load(); }} />}
        {compact && search}
        <nav className="seg home-filter" aria-label="Show">
          {filters.map((f) => (
            <Link key={f.show} to={f.to} className={`seg__btn${show === f.show ? ' seg__btn--active' : ''}`} aria-current={show === f.show ? 'page' : undefined} data-testid={f.testId}>
              {f.label}{f.count ? <span className="home-filter__count">{f.count}</span> : null}
            </Link>
          ))}
        </nav>
        <p className="visually-hidden" aria-live="polite" data-testid="search-status">{searching && projects !== null ? matchSentence(listed, query) : ''}</p>

        {loadError && (
          <div className={`home-error${projects ? ' home-error--inline' : ''}`} role="alert" data-testid="projects-error">
            <p className="home-error__text"><strong>{projects ? 'Couldn’t refresh your projects.' : 'Couldn’t load your projects.'}</strong> {loadError}</p>
            <button type="button" className="btn" onClick={() => load()} data-testid="projects-retry">Try again</button>
          </div>
        )}

        {empty && !imports.length && (
          <div className="shelf-start" data-testid="projects-empty">
            <h2 className="shelf-start__title">Start your first project</h2>
            <p className="shelf-start__text">Pick a starting point. You can change everything later.</p>
            <ul role="list" className="shelf__grid" ref={startRef}>
              <BlankSheet testId="start-blank" title="Blank project" detail="No files yet" {...startRoving('start-blank')} onActivate={() => setCreating({ template: starters?.some((t) => t.id === 'blank') ? 'blank' : undefined })} />
              {starterSheets.map(({ s, t }) => {
                const testId = startTestId(t);
                return <TemplateSheet key={t.id} testId={testId} title={s.title} name={s.name(t)} detail={s.detail} kind={s.kind} {...startRoving(testId)} onActivate={() => setCreating({ template: t.id })} />;
              })}
              <TemplateSheet testId="start-more" title={(() => { const n = (starters?.length ?? 0) - starterSheets.length - 1; return n > 0 ? `${n} more templates` : 'More templates'; })()} name="More templates…" detail="Journals, conferences, theses" {...startRoving('start-more')} onActivate={() => setCreating({})} />
            </ul>
            <p className="shelf-start__import">
              Or bring one over: <button type="button" className="link-button" onClick={() => zipInput.current?.click()} data-testid="empty-import-zip">Import a ZIP from Overleaf</button>
              {remotes.map((r, i) => (
                <span key={r.id}>{' · '}<button type="button" className="link-button" onClick={() => setImportFrom(r.id)} data-testid={`empty-clone-${r.id}`}>{i === 0 ? `Clone from ${r.label}` : r.label}</button></span>
              ))}
            </p>
            <p className="shelf-start__hint">You can also drop .zip files anywhere on this page.</p>
          </div>
        )}

        <div ref={shelfRef} className="shelf" key={show}>
          {renderShelf()}
        </div>
      </main>

      {/* AGPL section 13: a network instance must offer its users the source. */}
      <footer className="shelf-page__colophon" data-testid="colophon">
        Aldine {__ALDINE_VERSION__} · AGPL-3.0 · <a href={SOURCE_URL} target="_blank" rel="noreferrer" data-testid="colophon-source">Source code</a>
      </footer>

      {drag !== null && (
        <div className="home-drop" aria-hidden="true" data-testid="drop-overlay">
          <span className="home-drop__label">{drag > 1 ? `Drop to import ${drag} projects` : 'Drop to import as a new project'}</span>
        </div>
      )}

      {ctx.element}
      {aboutOpen && <About onClose={() => setAboutOpen(false)} />}
      {connectOpen && <ConnectClaudeModal onClose={() => setConnectOpen(false)} onManage={authEnabled && user ? () => setShowAccount(true) : undefined} />}
      <CommandPalette open={paletteOpen} commands={paletteCommands} onClose={() => setPaletteOpen(false)} placeholder="Type a command or project…" groupOrder={PALETTE_GROUPS} idleSectionLimit={8} />

      {addSheet && (
        <ActionSheet
          label="Start a project"
          testId="home-add-sheet"
          primaryId="new"
          details
          keyboard={addSheet.keyboard}
          onClose={() => setAddSheet(null)}
          items={[
            { id: 'new', label: 'New project…', icon: <IconPlus width={15} height={15} strokeWidth={1.8} />, onSelect: () => setCreating({}), testId: 'new-project' },
            { kind: 'separator' },
            ...startItems(start).filter((m) => m.kind === undefined || m.kind === 'item'),
          ]}
        />
      )}

      {sharing && (
        <ShareModal
          project={sharing}
          onClose={() => setSharing(null)}
          onSaved={(updated) => {
            setSharing(null);
            change((cur) => cur?.map((p) => (p.id === updated.id ? { ...p, share: updated.share } : p)) ?? cur);
          }}
        />
      )}
      {showAccount && user && <AccountSettings user={user} onClose={() => setShowAccount(false)} />}
      {importFrom && (
        <RemoteImport key={importFrom} provider={importFrom} onClose={() => setImportFrom(null)} onImported={(id) => navigate(`/p/${id}`)} />
      )}
      {creating && (
        <NewProjectSheet
          template={creating.template}
          provisioning={remotes.some((r) => r.provisioning)}
          onClose={() => setCreating(null)}
          onImportZip={() => zipInput.current?.click()}
        />
      )}
    </div>
  );
}

/** Each sheet's stage: as tall as the tallest page in its row of `cols`. */
function rowStages(ratios: number[], cols: number): number[] {
  const n = Math.max(1, cols);
  return ratios.map((_, i) => { const start = i - (i % n); return stageRatio(ratios.slice(start, start + n)); });
}

const startTestId = (t: TemplateInfo) => `start-${t.id.replace(/[^a-z0-9-]/gi, '-')}`;

function NoMatches({ query, onClear }: { query: string; onClear(): void }) {
  return (
    <div className="shelf-empty" data-testid="search-empty">
      <h2 className="shelf-empty__title">No projects match “{query.trim()}”</h2>
      <p className="shelf-empty__text">Check the spelling, or search for part of a name.</p>
      <button type="button" className="btn" onClick={onClear} data-testid="search-clear">Clear search</button>
    </div>
  );
}
