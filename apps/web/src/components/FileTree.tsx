import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ApiError, TreeEntry, api } from '../api';
import { fileIcon, IconChevronRight, IconEllipsis, IconFilePlus, IconFilter, IconFolderPlus, IconFolderUpload, IconSpark, IconUpload } from './Icons';
import { useDialogs } from './Dialogs';
import { MenuButton, useContextMenu, type MenuEntry } from './Menu';
import { useToast } from './Toast';
import { buildTree, entryPathError, filesIn, hiddenCount, holdsOnlyKeep, moveTarget, normalizeEntryPath, sourceTree, treeKey, typeaheadRow, visibleRows, withTexExtension, within, type TreeNode } from '../util/fileTree';
import { dropRoots, gatherDrop, pickedFolder, runPool, toBase64, type DropRoot, type Picked } from '../util/upload';
import { safeStorage } from '../util/safeStorage';

interface Props {
  files: TreeEntry[];
  active: string | null;
  rootFile: string;
  projectId: string;
  branch: string;
  onOpen(path: string): void;
  onCreate(path: string): void;
  /** `path` is the folder; the parent creates the .gitkeep that holds it in git. */
  onCreateFolder(path: string): void;
  onUploaded(paths: string[]): void;
  /** A file, or a folder with everything in it. */
  onDelete(path: string): void;
  /** A file or a folder; a drop onto a folder moves it there the same way.
   *  Resolves true once it has moved. */
  onRename(from: string, to: string): Promise<boolean>;
  /** Absent for someone who may not reconfigure the project (a link visitor). */
  onSetRoot?(path: string): void;
  /** Bumped by the parent to open the new-file input from outside the tree
   *  (the editor's empty state). */
  newFileRequest?: number;
  /** What the request opens: the name input for a file or a folder, or the picker for files or a folder. */
  newFileKind?: 'file' | 'folder' | 'upload' | 'upload-folder';
  /** Called once the request opened the input. */
  onNewFileHandled?(): void;
  /** On another sidebar tab: the tree stays mounted there, out of sight. */
  hidden?: boolean;
  /** A read-only showcase: the tree opens files and changes its view, and nothing else. */
  readOnly?: boolean;
  /** Per path: Claude is writing this file now ('live'), or changed it since
   *  this person's last review ('changed'). */
  agentMarks?: ReadonlyMap<string, AgentTreeMark>;
  /** Per path: added or changed since the branch's diff baseline, which
   *  `changeNoun` names (the editor gutter's change marks). */
  changeMarks?: ReadonlyMap<string, ChangeTreeMark>;
  changeNoun?: 'checkpoint' | 'commit';
}

export type AgentTreeMark = 'live' | 'changed';
export type ChangeTreeMark = 'added' | 'modified';

/** A closed folder's change mark: 'modified' when any file in it changed. */
function folderChange(marks: ReadonlyMap<string, ChangeTreeMark> | undefined, dir: string): ChangeTreeMark | undefined {
  let found: ChangeTreeMark | undefined;
  for (const [path, kind] of marks ?? []) {
    if (!within(path, dir)) continue;
    if (kind === 'modified') return kind;
    found = kind;
  }
  return found;
}

function ChangeMark({ kind, noun, folder = false }: { kind: ChangeTreeMark | undefined; noun: string; folder?: boolean }) {
  if (!kind) return null;
  const label = folder ? `Holds files changed since the last ${noun}`
    : kind === 'added' ? `Added since the last ${noun}` : `Changed since the last ${noun}`;
  return (
    <span className={`tree__change tree__change--${kind} ${folder ? 'tree__change--folder' : ''}`} title={label} aria-label={label} role="img" data-testid={folder ? 'tree-change-folder' : `tree-change-${kind}`}>
      {!folder && (kind === 'added' ? 'A' : 'M')}
    </span>
  );
}

/** A folder shows its files' marks while it is closed; 'live' wins. */
function folderMark(marks: ReadonlyMap<string, AgentTreeMark> | undefined, dir: string): AgentTreeMark | undefined {
  let found: AgentTreeMark | undefined;
  for (const [path, kind] of marks ?? []) {
    if (!within(path, dir)) continue;
    if (kind === 'live') return 'live';
    found = kind;
  }
  return found;
}

function AgentMark({ kind }: { kind: AgentTreeMark | undefined }) {
  if (!kind) return null;
  const label = kind === 'live' ? 'Claude is editing this file' : 'Changed by Claude since your last review';
  return (
    <span className={`tree__agent tree__agent--${kind}`} title={label} aria-label={label} role="img" data-testid={`tree-agent-${kind}`}>
      {kind === 'live' && <IconSpark />}
    </span>
  );
}

const MAX_UPLOAD = 10 * 1024 * 1024;
/** Files in one upload at most, as in a project made from a ZIP: past it a
 *  folder dropped by mistake (a home folder) is refused, not walked. */
const MAX_UPLOAD_FILES = 1000;
/** Files sent at once. */
const UPLOAD_CONCURRENCY = 3;
/** An upload done sooner shows no progress row, which would only flicker. */
const PROGRESS_DELAY_MS = 300;
/** A pause this long between letters starts a new type-ahead search. */
const TYPEAHEAD_MS = 600;
/** How long a row renamed or left by a Delete may take to show up and take the focus. */
const FOCUS_WAIT_MS = 3000;

/** The name input: a file or a folder, opened at the top level or inside `dir`. */
interface Adding { kind: 'file' | 'folder'; dir: string }

/** What a row being dragged carries, so a drop can tell it from files off the desktop. */
const DRAG_TYPE = 'application/x-aldine-path';

/** "a.tex", "a.tex and b.tex", "a.tex, b.tex, c.tex, d.tex and 3 more". */
function nameList(names: string[]): string {
  const shown = names.length > 5 ? names.slice(0, 4) : names;
  const rest = names.length - shown.length;
  if (rest) return `${shown.join(', ')} and ${rest} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0];
}

const FolderIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style={{ opacity: 0.65 }}>
    <path d="M1.75 4c0-.97.78-1.75 1.75-1.75h2.19c.46 0 .9.18 1.24.51l.79.79h4.53c.97 0 1.75.78 1.75 1.75v6.19c0 .97-.78 1.75-1.75 1.75h-8.75c-.97 0-1.75-.78-1.75-1.75V4z" />
  </svg>
);

/** Where a path's extension starts: a rename selects the name, not the `.tex`. */
export function stemEnd(path: string): number {
  const dot = path.lastIndexOf('.');
  return dot > path.lastIndexOf('/') + 1 ? dot : path.length;
}

/** Where a path's last segment starts: a rename selects the name, not the
 *  folders above it, so typing a new name keeps the entry where it is. */
export const nameStart = (path: string) => path.lastIndexOf('/') + 1;

const parentOf = (path: string) => path.split('/').slice(0, -1).join('/');

/** The open folders, and the file whose folders were last opened for it. */
interface KeptFolders { open: string[]; shown: string | null }

const keptKey = (projectId: string) => `aldine.openFolders.${projectId}`;
/** 'all' while the tree shows every file; unset for the Source view. */
const viewKey = (projectId: string) => `aldine.treeView.${projectId}`;

function loadKept(projectId: string): KeptFolders {
  const v = safeStorage.getJSON<{ open?: unknown; shown?: unknown } | null>(keptKey(projectId), null);
  const open = Array.isArray(v?.open) ? v.open.filter((p): p is string => typeof p === 'string') : [];
  return { open, shown: typeof v?.shown === 'string' ? v.shown : null };
}

/** Without storage, open folders last until the tree unmounts. */
function saveKept(projectId: string, open: Set<string>, shown: string | null): void {
  if (open.size || shown) safeStorage.setJSON(keptKey(projectId), { open: [...open], shown });
  else safeStorage.remove(keptKey(projectId));
}

/** Every folder in a listing, the ones above each file included. */
function foldersIn(files: TreeEntry[]): Set<string> {
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.path.split('/');
    const depth = f.type === 'dir' ? parts.length : parts.length - 1;
    for (let i = 1; i <= depth; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return dirs;
}

type Sent = { kind: 'ok' } | { kind: 'exists' } | { kind: 'unreadable' } | { kind: 'failed'; message: string };

/** What the progress row shows, summed over every upload under way. */
interface Progress { done: number; total: number; fraction: number; name: string }

export default function FileTree({ files, active, rootFile, projectId, branch, onOpen, onCreate, onCreateFolder, onUploaded, onDelete, onRename, onSetRoot, newFileRequest = 0, newFileKind = 'file', onNewFileHandled, hidden = false, readOnly = false, agentMarks, changeMarks, changeNoun = 'checkpoint' }: Props) {
  const dialogs = useDialogs();
  const toast = useToast();
  const errorId = useId();
  const [adding, setAdding] = useState<Adding | null>(null);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  /** The folder a drag is over: '' for the top level, null for no drag. */
  const [dropDir, setDropDir] = useState<string | null>(null);
  /** The row being dragged, if the drag started in this tree. */
  const dragged = useRef<string | null>(null);
  // The Source or All view is kept per project by this browser, as the open
  // folders are below.
  const [sourceOnly, setSourceOnly] = useState(() => safeStorage.get(viewKey(projectId)) !== 'all');
  useEffect(() => {
    if (sourceOnly) safeStorage.remove(viewKey(projectId));
    else safeStorage.set(viewKey(projectId), 'all');
  }, [projectId, sourceOnly]);
  /** Files made or uploaded here since the project was opened: the Source
   *  view lists them whatever they are, so what was just added never vanishes. */
  const [added, setAdded] = useState<ReadonlySet<string>>(() => new Set());
  const keepShown = (paths: string[]) => setAdded((s) => new Set([...s, ...paths]));
  // Folders start closed. The ones opened are kept per project by this
  // browser: a reload would close them all again.
  const [kept] = useState(() => loadKept(projectId));
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set(kept.open));
  const shown = useRef(kept.shown);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);
  /** The folder the file picker uploads into: set by the button that opened it. */
  const uploadDir = useRef('');
  const treeEl = useRef<HTMLDivElement>(null);

  const isOpen = (p: string) => openDirs.has(p);
  const toggle = (p: string) => setOpenDirs((s) => {
    const next = new Set(s);
    if (!next.delete(p)) next.add(p);
    return next;
  });
  /** Expand `dir` and every folder above it. */
  const reveal = (dir: string) => {
    if (!dir) return;
    setOpenDirs((s) => {
      const parts = dir.split('/');
      const above = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
      return above.every((p) => s.has(p)) ? s : new Set([...s, ...above]);
    });
  };
  /** A folder that moves keeps the folders open in it open at the new place. */
  const rename = async (from: string, to: string) => {
    if (!(await onRename(from, to))) return false;
    setOpenDirs((s) => {
      if (![...s].some((p) => within(p, from))) return s;
      return new Set([...s].map((p) => (within(p, from) ? to + p.slice(from.length) : p)));
    });
    return true;
  };
  // The open file's row stays in view, however it was opened. Only a change
  // of file reveals, so a folder closed around the open file stays closed
  // after another tab or a reload.
  useEffect(() => {
    if (!active || active === shown.current) return;
    shown.current = active;
    reveal(parentOf(active));
  }, [active]);
  useEffect(() => { saveKept(projectId, openDirs, shown.current); }, [projectId, openDirs, active]);
  // Folders deleted since, here or by someone else, are forgotten, so one
  // made again under the same name starts closed. Once each time the tree is
  // shown, not on every listing: a rename lists the files before the open
  // folders move along with it.
  const pruned = useRef(false);
  useEffect(() => { if (hidden) pruned.current = false; }, [hidden]);
  useEffect(() => {
    if (hidden || pruned.current || !files.length) return;
    pruned.current = true;
    const dirs = foldersIn(files);
    setOpenDirs((s) => ([...s].every((p) => dirs.has(p)) ? s : new Set([...s].filter((p) => dirs.has(p)))));
  }, [files, hidden]);

  const full = useMemo(() => buildTree(files), [files]);
  const tree = useMemo(() => {
    if (!sourceOnly) return full;
    return sourceTree(full, active ? new Set([...added, active]) : added);
  }, [full, sourceOnly, added, active]);
  const hiddenFiles = useMemo(() => (sourceOnly ? hiddenCount(full, tree) : 0), [full, tree, sourceOnly]);
  const rows = useMemo(() => visibleRows(tree, (p) => openDirs.has(p)), [tree, openDirs]);

  // A project with no files of the user's own (the .gitignore every project
  // carries does not count) gets main.tex suggested: that name also makes the
  // file the typeset root without a further step. Inside a folder the input
  // starts with the folder's path. Unless a folder is named, that is the one
  // the open file is in.
  const startAdding = (kind: Adding['kind'] = 'file', dir = parentOf(active ?? '')) => {
    const firstFile = kind === 'file' && !dir && !files.some((f) => f.type === 'file' && !f.path.split('/').pop()!.startsWith('.'));
    setName(dir ? `${dir}/` : firstFile ? 'main.tex' : '');
    setNameError(null);
    setAdding({ kind, dir });
    reveal(dir);
  };
  useEffect(() => {
    if (!newFileRequest) return;
    if (readOnly) { onNewFileHandled?.(); return; }
    if (newFileKind === 'upload') chooseUpload('');
    else if (newFileKind === 'upload-folder') chooseFolder('');
    else startAdding(newFileKind);
    onNewFileHandled?.();
  }, [newFileRequest]);
  const stopAdding = () => { setAdding(null); setName(''); setNameError(null); };
  /** Where the name input shows: inside its folder, or at the top level
   *  while that folder is not in the tree. */
  const inputDir = adding?.dir && rows.some((r) => r.path === adding.dir && r.open) ? adding.dir : '';

  // An invalid name keeps the input open with the reason under it, on Enter
  // and on blur alike: closing would throw the typed name away.
  const submit = () => {
    if (!adding) return;
    const typed = normalizeEntryPath(name);
    if (!typed || typed === adding.dir) { stopAdding(); return; }
    const path = adding.kind === 'file' ? withTexExtension(typed) : typed;
    // A directory with no file in it is not in git and not in the Source
    // view: making it a folder again is fine.
    const taken = adding.kind === 'folder' && files.some((f) => f.type === 'file' && within(f.path, path));
    const error = entryPathError(name) ?? (taken ? `"${path}" already exists` : null);
    if (error) { setNameError(error); return; }
    stopAdding();
    if (adding.kind === 'folder') {
      reveal(path);
      onCreateFolder(path);
    } else {
      reveal(parentOf(path));
      keepShown([path]);
      onCreate(path);
    }
  };

  const chooseUpload = (dir: string) => {
    uploadDir.current = dir;
    fileInput.current?.click();
  };
  const chooseFolder = (dir: string) => {
    uploadDir.current = dir;
    folderInput.current?.click();
  };

  // ---------- uploads ----------
  const sums = useRef({ batches: 0, done: 0, total: 0, sent: 0, size: 0, name: '' });
  const [progress, setProgress] = useState<Progress | null>(null);
  const [progressShown, setProgressShown] = useState(false);
  const progressTimer = useRef(0);
  useEffect(() => () => clearTimeout(progressTimer.current), []);
  const publish = () => {
    const s = sums.current;
    setProgress(s.batches ? { done: s.done, total: s.total, fraction: s.size ? Math.min(1, s.sent / s.size) : 0, name: s.name } : null);
  };
  const beginBatch = (items: Picked[]) => {
    const s = sums.current;
    if (!s.batches) {
      clearTimeout(progressTimer.current);
      progressTimer.current = window.setTimeout(() => setProgressShown(true), PROGRESS_DELAY_MS);
    }
    s.batches += 1;
    s.total += items.length;
    s.size += items.reduce((n, p) => n + p.file.size, 0);
    s.name = items[0].path;
    publish();
  };
  const endBatch = () => {
    const s = sums.current;
    s.batches -= 1;
    if (!s.batches) {
      Object.assign(s, { done: 0, total: 0, sent: 0, size: 0, name: '' });
      clearTimeout(progressTimer.current);
      setProgressShown(false);
    }
    publish();
  };

  /** One file, base64 in JSON as writeFile takes it. Without `replace` it
   *  never writes over a file: the server answers 409 for createOnly, which
   *  also covers a file another client added since the tree was loaded. */
  const send = async (p: Picked, replace: boolean): Promise<Sent> => {
    const s = sums.current;
    let counted = 0;
    const count = (bytes: number) => { s.sent += bytes - counted; counted = bytes; publish(); };
    try {
      let content: string;
      try { content = toBase64(await p.file.arrayBuffer()); } catch { return { kind: 'unreadable' }; }
      try {
        await api.writeFileWithProgress(projectId, branch, p.path, content, {
          createOnly: !replace,
          onProgress: (sent, total) => count(total ? Math.round((sent / total) * p.file.size) : 0),
        });
        return { kind: 'ok' };
      } catch (err) {
        if (!replace && err instanceof ApiError && err.status === 409) return { kind: 'exists' };
        return { kind: 'failed', message: (err as Error).message };
      }
    } finally {
      count(p.file.size);
      s.done += 1;
      publish();
    }
  };

  // Never replace a file that exists without asking: the one being replaced
  // may be open in the editor with unsaved typing in it. One question for all
  // of them; Enter keeps them, as replacing is the step that loses something.
  const askReplace = (paths: string[]) => dialogs.confirm(paths.length === 1
    ? { title: `Replace ${paths[0]}?`, body: `${paths[0]} already exists in this project. The uploaded file takes its place.`, confirmLabel: 'Replace file', cancelLabel: 'Keep existing', danger: true }
    : { title: `Replace ${paths.length} files?`, body: `${nameList(paths)} already exist in this project. The uploaded files take their place.`, confirmLabel: 'Replace all', cancelLabel: 'Skip existing', danger: true });

  /** `picked` paths are below `dir`; `unreadable` names what a drop could not read. */
  const uploadPicked = async (picked: Picked[], dir = '', unreadable: string[] = []) => {
    const big = picked.filter((p) => p.file.size > MAX_UPLOAD).map((p) => p.path);
    if (big.length) toast(`${nameList(big)} ${big.length === 1 ? 'is' : 'are'} larger than 10 MB`, 'error');
    let todo = picked.filter((p) => p.file.size <= MAX_UPLOAD).map((p) => ({ path: dir ? `${dir}/${p.path}` : p.path, file: p.file }));
    const known = new Set(latest.current.files.filter((f) => f.type === 'file').map((f) => f.path));
    const existing = todo.filter((p) => known.has(p.path)).map((p) => p.path);
    let replace = new Set<string>();
    if (existing.length) {
      if (await askReplace(existing)) replace = new Set(existing);
      else todo = todo.filter((p) => !known.has(p.path));
    }
    const done: string[] = [];
    const unread = [...unreadable];
    const failed = new Map<string, string[]>();
    const late: Picked[] = [];
    const sendAll = async (items: Picked[], replacing: (p: Picked) => boolean) => {
      if (!items.length) return;
      beginBatch(items);
      try {
        await runPool(items, UPLOAD_CONCURRENCY, async (p) => {
          const r = await send(p, replacing(p));
          if (r.kind === 'ok') done.push(p.path);
          else if (r.kind === 'exists') late.push(p);
          else if (r.kind === 'unreadable') unread.push(p.path);
          else failed.set(r.message, [...(failed.get(r.message) ?? []), p.path]);
        });
      } finally { endBatch(); }
    };
    await sendAll(todo, (p) => replace.has(p.path));
    // Added by someone else while this upload ran: the same question, once.
    if (late.length && (await askReplace(late.map((p) => p.path)))) await sendAll(late.splice(0), () => true);
    if (unread.length) toast(`Could not read ${nameList(unread)}`, 'error');
    for (const [message, paths] of failed) toast(`Could not upload ${nameList(paths)}: ${message}`, 'error');
    if (done.length) {
      keepShown(done);
      reveal(dir);
      onUploaded(done);
    }
  };
  const tooMany = () => toast(`Upload at most ${MAX_UPLOAD_FILES} files at a time`, 'error');
  /** A drop's files and folders, read in the drop event (dropRoots) and uploaded into `dir`. */
  const uploadDrop = async (roots: DropRoot[], dir = '') => {
    const got = await gatherDrop(roots, MAX_UPLOAD_FILES);
    if (got.tooMany) { tooMany(); return; }
    if (got.empty.length) toast(`Nothing to upload in ${nameList(got.empty)}`, 'error');
    await uploadPicked(got.picked, dir, got.unreadable);
  };
  /** For what runs after this render's props are gone: an Undo, a window listener. */
  const latest = useRef({ rename, uploadDrop, readOnly, files });
  latest.current = { rename, uploadDrop, readOnly, files };

  // A file dragged over the rest of the window must not open in place of the
  // app. Dropped on the editor it uploads to the top level, as onto the space
  // around the rows: the drop is taken in the capture phase, before
  // CodeMirror's handler would paste the file's text into the shared document
  // (it skips a drop already handled). Dragged text is not a file drag.
  useEffect(() => {
    const fileDrag = (e: globalThis.DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const onEditor = (e: globalThis.DragEvent) => e.target instanceof Element && !!e.target.closest('.cm-editor');
    const over = (e: globalThis.DragEvent) => {
      if (!fileDrag(e) || e.defaultPrevented) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = onEditor(e) && !latest.current.readOnly ? 'copy' : 'none';
    };
    const drop = (e: globalThis.DragEvent) => {
      if (!fileDrag(e)) return;
      e.preventDefault();
      if (!onEditor(e) || latest.current.readOnly) return;
      const roots = dropRoots(e.dataTransfer!);
      if (roots.length) void latest.current.uploadDrop(roots);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop, true);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop, true);
    };
  }, []);

  // ---------- keyboard ----------
  /** The row last focused: the tree's one stop in the Tab order. */
  const [cursor, setCursor] = useState<string | null>(null);
  /** A row to focus once it is on screen, for a moment: the new name after
   *  F2, the row a Delete leaves focus on. */
  const [focusWanted, setFocusWantedAt] = useState<{ path: string; until: number } | null>(null);
  const setFocusWanted = (path: string) => setFocusWantedAt({ path, until: Date.now() + FOCUS_WAIT_MS });
  /** Each row's button, by path; one that has left the page is passed over. */
  const rowEls = useRef(new Map<string, HTMLButtonElement>());
  const rowRef = (path: string) => (el: HTMLButtonElement | null) => {
    if (el) rowEls.current.set(path, el);
  };
  const tabStop = rows.some((r) => r.path === cursor) ? cursor : rows.some((r) => r.path === active) ? active : rows[0]?.path ?? null;
  const focusRow = (path: string) => {
    setCursor(path);
    const el = rowEls.current.get(path);
    if (el?.isConnected) el.focus();
    else setFocusWanted(path);
  };
  // Not when focus has gone elsewhere meanwhile: the editor, another panel.
  useEffect(() => {
    if (!focusWanted) return;
    const el = rowEls.current.get(focusWanted.path);
    if (Date.now() > focusWanted.until) { setFocusWantedAt(null); return; }
    if (!el?.isConnected) return;
    setFocusWantedAt(null);
    const now = document.activeElement;
    if (now && now !== document.body && !treeEl.current?.contains(now)) return;
    setCursor(focusWanted.path);
    el.focus();
  });
  /** The row focus moves to when `path` goes: the next one outside it, else the one above. */
  const rowAfter = (path: string) => {
    const at = rows.findIndex((r) => r.path === path);
    return rows.slice(at + 1).find((r) => !within(r.path, path))?.path ?? rows[at - 1]?.path ?? null;
  };
  const typed = useRef({ text: '', at: 0 });

  // ---------- row actions ----------
  /** Resolves the new path once renamed. */
  const renameFile = async (path: string): Promise<string | null> => {
    const to = (await dialogs.prompt({ title: `Rename ${path}`, value: path, confirmLabel: 'Rename', selectFrom: nameStart(path), selectTo: stemEnd(path) }))?.trim();
    return to && to !== path && (await rename(path, to)) ? to : null;
  };
  /** `after`: the row focus moves to once the delete is confirmed. */
  const deleteFile = async (path: string, after: string | null = null) => {
    if (!(await dialogs.confirm({ title: `Delete ${path}?`, confirmLabel: 'Delete file', danger: true }))) return;
    if (after) setFocusWanted(after);
    onDelete(path);
  };

  const fileMenu = useContextMenu({ label: 'File actions', testId: 'file-menu' });
  const fileActions = (path: string): MenuEntry[] => [
    ...(onSetRoot ? [{ id: 'root', label: 'Set as main document', onSelect: () => onSetRoot(path), disabled: path === rootFile, testId: 'file-menu-root' } as MenuEntry] : []),
    { id: 'rename', label: 'Rename…', testId: 'file-menu-rename', onSelect: () => { void renameFile(path); } },
    { kind: 'separator' },
    { id: 'delete', label: 'Delete…', danger: true, testId: 'file-menu-delete', onSelect: () => { void deleteFile(path); } },
  ];

  const deleteFolder = async (dir: string, after: string | null = null) => {
    const inside = filesIn(files, dir);
    const names = inside.map((p) => p.slice(dir.length + 1));
    const ok = await dialogs.confirm(inside.length
      ? {
        title: `Delete ${dir}?`,
        body: inside.length === 1 ? `The file in it is deleted too: ${names[0]}.` : `The ${inside.length} files in it are deleted too: ${nameList(names)}.`,
        confirmLabel: inside.length === 1 ? 'Delete folder and file' : `Delete folder and ${inside.length} files`,
        danger: true,
      }
      : { title: `Delete ${dir}?`, confirmLabel: 'Delete folder', danger: true });
    if (!ok) return;
    // The server removes a folder with everything in it: look again, so a file
    // a collaborator added since the dialog opened is never deleted unseen.
    let now: TreeEntry[];
    try { now = await api.listFiles(projectId, branch); } catch { toast(`Could not delete ${dir}: the file list did not load`, 'error'); return; }
    if (filesIn(now, dir).some((p) => !inside.includes(p))) {
      toast(inside.length ? `Files were added to ${dir} since, so it was not deleted` : `${dir} is no longer empty, so it was not deleted`, 'error');
      return;
    }
    if (after) setFocusWanted(after);
    onDelete(dir);
  };
  /** Resolves the new path once renamed. */
  const renameFolder = async (dir: string): Promise<string | null> => {
    const raw = await dialogs.prompt({ title: `Rename ${dir}`, value: dir, confirmLabel: 'Rename', selectFrom: nameStart(dir) });
    if (raw === null) return null;
    const to = normalizeEntryPath(raw);
    if (!to || to === dir) return null;
    const error = entryPathError(raw) ?? (within(to, dir) ? `${dir} cannot move into a folder inside itself` : null);
    if (error) { toast(error, 'error'); return null; }
    if (!(await rename(dir, to))) return null;
    reveal(to);
    return to;
  };
  const folderMenu = useContextMenu({ label: 'Folder actions', testId: 'folder-menu' });
  const folderActions = (dir: string): MenuEntry[] => [
    { id: 'new-file', label: 'New file in folder…', testId: 'folder-menu-new-file', onSelect: () => startAdding('file', dir) },
    { id: 'new-folder', label: 'New folder in folder…', testId: 'folder-menu-new-folder', onSelect: () => startAdding('folder', dir) },
    { id: 'upload', label: 'Upload files to folder…', testId: 'folder-menu-upload', onSelect: () => chooseUpload(dir) },
    { id: 'upload-folder', label: 'Upload folder to folder…', testId: 'folder-menu-upload-folder', onSelect: () => chooseFolder(dir) },
    { id: 'rename', label: 'Rename folder…', testId: 'folder-menu-rename', onSelect: () => { void renameFolder(dir); } },
    { kind: 'separator' },
    { id: 'delete', label: 'Delete folder…', danger: true, testId: 'folder-menu-delete', onSelect: () => { void deleteFolder(dir); } },
  ];

  /** The tree view's keys on a row (treeKey), F2 to rename, Delete (⌘⌫ on a
   *  Mac) to delete, and letters to jump to a name. Enter and Space are the
   *  row's click: open the file, open or close the folder. */
  const onRowKey = (e: ReactKeyboardEvent<HTMLButtonElement>, node: TreeNode) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey) return;
    const plain = !e.metaKey && !e.shiftKey;
    const move = plain ? treeKey(rows, node.path, e.key) : null;
    if (move) {
      e.preventDefault();
      if (move.open) reveal(move.open);
      if (move.close) toggle(move.close);
      if (move.focus) focusRow(move.focus);
      return;
    }
    if (!readOnly && plain && e.key === 'F2') {
      e.preventDefault();
      void (node.type === 'dir' ? renameFolder(node.path) : renameFile(node.path)).then((to) => {
        if (!to) return;
        reveal(parentOf(to));
        setFocusWanted(to);
      });
      return;
    }
    if (!readOnly && ((plain && e.key === 'Delete') || (e.metaKey && !e.shiftKey && e.key === 'Backspace'))) {
      e.preventDefault();
      const after = rowAfter(node.path);
      void (node.type === 'dir' ? deleteFolder(node.path, after) : deleteFile(node.path, after));
      return;
    }
    if (e.key.length === 1 && e.key !== ' ' && !e.metaKey) {
      const t = typed.current;
      t.text = e.timeStamp - t.at > TYPEAHEAD_MS ? e.key : t.text + e.key;
      t.at = e.timeStamp;
      const to = typeaheadRow(rows, node.path, t.text);
      if (to) { e.preventDefault(); focusRow(to); }
    }
  };

  // A row dragged onto a folder moves into it; files from the desktop upload
  // into it. A file's row stands in for the folder it is in, and the space
  // around the rows for the top level.
  const canDrop = (e: DragEvent, dir: string) =>
    dragged.current !== null ? moveTarget(dragged.current, dir) !== null : e.dataTransfer.types.includes('Files');
  // A showcase leaves every drop to the window's handlers, which keep a file
  // from opening in place of the app and upload nothing.
  const dropTarget = (dir: string) => ({
    onDragOver: (e: DragEvent) => {
      if (readOnly) return;
      e.stopPropagation();
      if (!canDrop(e, dir)) { setDropDir(null); return; }
      e.preventDefault();
      e.dataTransfer.dropEffect = dragged.current !== null ? 'move' : 'copy';
      setDropDir(dir);
    },
    onDrop: async (e: DragEvent) => {
      if (readOnly) return;
      e.preventDefault();
      e.stopPropagation();
      setDropDir(null);
      const from = e.dataTransfer.getData(DRAG_TYPE);
      if (from) {
        const to = moveTarget(from, dir);
        if (to && (await rename(from, to))) {
          reveal(dir);
          // A slip of the pointer can move a file: the move says so, and can be taken back.
          toast(`Moved ${to.split('/').pop()} to ${dir ? `${dir}/` : 'the top level'}`, 'ok', {
            label: 'Undo', testId: 'undo-move', key: 'tree-move',
            onClick: () => { void latest.current.rename(to, from).then((ok) => { if (ok) reveal(parentOf(from)); }); },
          });
        }
        return;
      }
      const roots = dropRoots(e.dataTransfer);
      if (roots.length) await uploadDrop(roots, dir);
    },
  });
  const dragSource = (path: string) => ({
    draggable: !readOnly,
    onDragStart: (e: DragEvent) => {
      dragged.current = path;
      e.dataTransfer.setData(DRAG_TYPE, path);
      e.dataTransfer.effectAllowed = 'move';
    },
    onDragEnd: () => { dragged.current = null; setDropDir(null); },
  });

  /** The row's menu, for whoever does not right-click: the same actions. Off
   *  the Tab order and out of the accessibility tree: the row itself opens
   *  the menu with Shift+F10. */
  const rowMenu = (node: TreeNode) => (
    <MenuButton
      items={() => (node.type === 'dir' ? folderActions(node.path) : fileActions(node.path))}
      label={node.type === 'dir' ? 'Folder actions' : 'File actions'}
      ariaLabel={`Actions for ${node.path}`} title={node.type === 'dir' ? 'Folder actions' : 'File actions'}
      className="tree__more" testId={`row-menu-${node.path}`} menuTestId={node.type === 'dir' ? 'folder-menu' : 'file-menu'} tabIndex={-1} ariaHidden
    >
      <IconEllipsis width={14} height={14} />
    </MenuButton>
  );

  /** The props every row shares: its place in the tree view, the roving Tab stop and its keys. */
  const rowProps = (node: TreeNode, depth: number, pos: number, size: number) => {
    const menu = readOnly ? null : (node.type === 'dir' ? folderMenu.bind(() => folderActions(node.path)) : fileMenu.bind(() => fileActions(node.path)));
    return {
      ...menu,
      ref: rowRef(node.path),
      role: 'treeitem' as const,
      'aria-level': depth + 1,
      'aria-setsize': size,
      'aria-posinset': pos,
      'aria-keyshortcuts': readOnly ? undefined : 'F2 Delete',
      tabIndex: tabStop === node.path ? 0 : -1,
      onFocus: () => setCursor(node.path),
      onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => { menu?.onKeyDown(e); onRowKey(e, node); },
      ...dragSource(node.path),
    };
  };

  const nameInput = (depth: number) => adding && (
    <div className="tree__new" style={depth ? { paddingLeft: depth * 18 } : undefined}>
      <input
        key={`${adding.kind}:${adding.dir}`}
        autoFocus className="input" spellCheck={false} autoComplete="off"
        placeholder={adding.kind === 'folder' ? 'figures' : 'chapter.tex'}
        aria-label={adding.kind === 'folder' ? 'New folder name' : 'New file name'}
        aria-invalid={nameError ? true : undefined}
        aria-describedby={nameError ? errorId : undefined}
        value={name}
        data-testid={adding.kind === 'folder' ? 'new-folder-name' : 'new-file-name'}
        onFocus={(e) => { if (adding.dir) { const end = e.target.value.length; e.target.setSelectionRange(end, end); } }}
        onChange={(e) => { setName(e.target.value); setNameError(null); }}
        onBlur={submit}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') stopAdding(); }}
      />
      {nameError && <p id={errorId} className="tree__error" role="alert" data-testid="new-name-error">{nameError}</p>}
    </div>
  );

  const renderNode = (node: TreeNode, depth: number, pos: number, size: number): JSX.Element => {
    // one level is the chevron plus the gap, so a child's chevron sits under
    // its folder's icon
    const pad = 8 + depth * 18;
    if (node.type === 'dir') {
      const open = isOpen(node.path);
      const inputHere = !!adding && open && inputDir === node.path;
      return (
        <div key={node.path}>
          <div className="tree__row" {...dropTarget(node.path)}>
            <button
              className={`tree__item tree__dir ${dropDir === node.path ? 'tree__item--drop' : ''}`} style={{ paddingLeft: pad }} onClick={() => toggle(node.path)}
              data-testid={`dir-${node.path}`} title={node.path} aria-expanded={open}
              {...rowProps(node, depth, pos, size)}
            >
              <span className={`tree__chevron ${open ? 'tree__chevron--open' : ''}`}><IconChevronRight /></span>
              <span className="tree__icon"><FolderIcon /></span>
              {node.name}
              {!open && <AgentMark kind={folderMark(agentMarks, node.path)} />}
              {!open && <ChangeMark kind={folderChange(changeMarks, node.path)} noun={changeNoun} folder />}
            </button>
            {!readOnly && rowMenu(node)}
          </div>
          {open && (
            <div role="group">
              {inputHere && nameInput(depth + 1)}
              {node.children.length
                ? node.children.map((c, i) => renderNode(c, depth + 1, i + 1, node.children.length))
                : !inputHere && (
                  <div className="tree__empty" style={{ paddingLeft: pad + 36 }} data-testid={`dir-empty-${node.path}`} {...dropTarget(node.path)}>
                    {holdsOnlyKeep(files, node.path) ? 'Empty folder' : 'No source files'}
                  </div>
                )}
            </div>
          )}
        </div>
      );
    }
    return (
      <div key={node.path} className={`tree__row ${active === node.path ? 'tree__row--active' : ''}`} {...dropTarget(parentOf(node.path))}>
        <button
          className={`tree__item ${active === node.path ? 'tree__item--active' : ''}`}
          style={{ paddingLeft: pad }}
          data-testid={`file-${node.path}`}
          onClick={() => onOpen(node.path)}
          aria-current={active === node.path ? 'true' : undefined}
          {...rowProps(node, depth, pos, size)}
          title={node.path}
        >
          <span className="tree__chevron" />
          <span className="tree__icon">{fileIcon(node.path, node.path === rootFile)}</span>
          {node.name}
          {node.path === rootFile && <span className="tree__root-tag">root</span>}
          <AgentMark kind={agentMarks?.get(node.path)} />
          <ChangeMark kind={changeMarks?.get(node.path)} noun={changeNoun} />
        </button>
        {!readOnly && rowMenu(node)}
      </div>
    );
  };

  const uploadLabel = progress && (progress.total === 1 ? `Uploading ${progress.name}…` : `Uploading ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`);

  return (
    <div
      className={`panel-list filetree ${dropDir === '' ? 'filetree--drag' : ''}`}
      data-testid="file-tree" data-drop={dropDir === '' && dragged.current !== null ? 'move' : undefined}
      {...dropTarget('')}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropDir(null); }}
    >
      {/* Rows only: the tree view's own controls and notes sit outside it. */}
      <div ref={treeEl} role="tree" aria-label="Files" data-testid="file-tree-rows">
        {tree.map((n, i) => renderNode(n, 0, i + 1, tree.length))}
      </div>
      {adding && !inputDir && nameInput(0)}
      {hiddenFiles > 0 && (
        <div className="tree__hidden" data-testid="tree-hidden">
          <span>{hiddenFiles === 1 ? '1 file hidden' : `${hiddenFiles} files hidden`}</span>
          <span aria-hidden="true">·</span>
          <button type="button" className="tree__show-all" onClick={() => setSourceOnly(false)} data-testid="tree-show-all">Show all</button>
        </div>
      )}

      {/* Pinned to the foot of the panel while a long tree scrolls under it. */}
      <div className="tree__foot">
        <div role="status">
          {progress && progressShown && (
            <div className="tree__upload" data-testid="upload-progress">
              <span className="tree__upload-label">{uploadLabel}</span>
              <span className="tree__upload-bar"><span style={{ transform: `scaleX(${progress.fraction})` }} /></span>
            </div>
          )}
        </div>
        <div className="tree__actions">
          {!readOnly && (
            <>
              <button className="btn btn--ghost btn--icon" onClick={() => startAdding('file')} data-testid="new-file" title="New file" aria-label="New file"><IconFilePlus /></button>
              <button className="btn btn--ghost btn--icon" onClick={() => startAdding('folder')} data-testid="new-folder" title="New folder" aria-label="New folder"><IconFolderPlus /></button>
              <button className="btn btn--ghost btn--icon" onClick={() => chooseUpload('')} data-testid="upload-file" title="Upload files" aria-label="Upload files"><IconUpload /></button>
              <button className="btn btn--ghost btn--icon" onClick={() => chooseFolder('')} data-testid="upload-folder" title="Upload a folder" aria-label="Upload a folder"><IconFolderUpload /></button>
            </>
          )}
          <button
            className="btn btn--ghost btn--icon tree__filter" onClick={() => setSourceOnly((v) => !v)} aria-pressed={sourceOnly}
            data-testid="source-only" title="Show only source files: LaTeX, bibliographies, figures, data and notes" aria-label="Show only source files"
          ><IconFilter /></button>
        </div>
      </div>
      {/* Outside the toolbar: a folder's menu opens the pickers too. */}
      <input ref={fileInput} type="file" multiple hidden data-testid="upload-input"
        onChange={async (e) => {
          const dir = uploadDir.current;
          uploadDir.current = '';
          const list = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (list.length > MAX_UPLOAD_FILES) tooMany();
          else if (list.length) await uploadPicked(list.map((file) => ({ path: file.name, file })), dir);
        }} />
      <input ref={(el) => { folderInput.current = el; if (el) el.webkitdirectory = true; }} type="file" hidden data-testid="upload-folder-input"
        onChange={async (e) => {
          const dir = uploadDir.current;
          uploadDir.current = '';
          const list = pickedFolder(Array.from(e.target.files ?? []));
          e.target.value = '';
          if (list.length > MAX_UPLOAD_FILES) tooMany();
          else if (list.length) await uploadPicked(list, dir);
        }} />
      {!readOnly && <p className="filetree__hint">Drop files or folders here to upload, or onto a folder</p>}

      {fileMenu.element}
      {folderMenu.element}
    </div>
  );
}
