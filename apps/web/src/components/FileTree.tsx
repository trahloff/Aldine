import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type JSX } from 'react';
import { ApiError, TreeEntry, api } from '../api';
import { fileIcon, IconChevronRight, IconFilePlus, IconFilter, IconFolderPlus, IconUpload } from './Icons';
import { useDialogs } from './Dialogs';
import { useContextMenu, type MenuEntry } from './Menu';
import { useToast } from './Toast';
import { buildTree, entryPathError, filesIn, holdsOnlyKeep, moveTarget, normalizeEntryPath, sourceTree, within, type TreeNode } from '../util/fileTree';

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
  /** A file or a folder; a drop onto a folder moves it there the same way. */
  onRename(from: string, to: string): void;
  onSetRoot(path: string): void;
  /** Bumped by the parent to open the new-file input from outside the tree
   *  (the editor's empty state). */
  newFileRequest?: number;
  /** Called once the request opened the input, so the parent resets it: the
   *  tree is unmounted on other sidebar tabs and would otherwise reopen the
   *  input on every remount. */
  onNewFileHandled?(): void;
}

const MAX_UPLOAD = 10 * 1024 * 1024;

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

const parentOf = (path: string) => path.split('/').slice(0, -1).join('/');

export default function FileTree({ files, active, rootFile, projectId, branch, onOpen, onCreate, onCreateFolder, onUploaded, onDelete, onRename, onSetRoot, newFileRequest = 0, onNewFileHandled }: Props) {
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
  const [sourceOnly, setSourceOnly] = useState(true);
  // User expand/collapse overrides. Default: dot-directories (.github, .devcontainer, …)
  // start collapsed; everything else expanded. This overlay avoids depending on
  // `files` at mount (which is empty on first render).
  const [override, setOverride] = useState<Map<string, boolean>>(new Map());
  const fileInput = useRef<HTMLInputElement>(null);
  /** The folder the file picker uploads into: set by the button that opened it. */
  const uploadDir = useRef('');

  const isDot = (p: string) => p.split('/').pop()!.startsWith('.');
  const isOpen = (p: string) => (override.has(p) ? override.get(p)! : !isDot(p));
  const toggle = (p: string) => setOverride((m) => new Map(m).set(p, !isOpen(p)));
  /** Expand `dir` and every folder above it. */
  const reveal = (dir: string) => {
    if (!dir) return;
    setOverride((m) => {
      const next = new Map(m);
      const parts = dir.split('/');
      for (let i = 1; i <= parts.length; i++) next.set(parts.slice(0, i).join('/'), true);
      return next;
    });
  };

  // A project with no files of the user's own (the .gitignore every project
  // carries does not count) gets main.tex suggested: that name also makes the
  // file the typeset root without a further step. Inside a folder the input
  // starts with the folder's path.
  const startAdding = (kind: Adding['kind'] = 'file', dir = '') => {
    const firstFile = kind === 'file' && !dir && !files.some((f) => f.type === 'file' && !f.path.split('/').pop()!.startsWith('.'));
    setName(dir ? `${dir}/` : firstFile ? 'main.tex' : '');
    setNameError(null);
    setAdding({ kind, dir });
    reveal(dir);
  };
  useEffect(() => { if (newFileRequest) { startAdding(); onNewFileHandled?.(); } }, [newFileRequest]);
  const stopAdding = () => { setAdding(null); setName(''); setNameError(null); };

  // An invalid name keeps the input open with the reason under it, on Enter
  // and on blur alike: closing would throw the typed name away.
  const submit = () => {
    if (!adding) return;
    const path = normalizeEntryPath(name);
    if (!path || path === adding.dir) { stopAdding(); return; }
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
      onCreate(path);
    }
  };

  const chooseUpload = (dir: string) => {
    uploadDir.current = dir;
    fileInput.current?.click();
  };

  const uploadFiles = async (list: FileList | File[], dir = '') => {
    const done: string[] = [];
    for (const f of Array.from(list)) {
      const path = dir ? `${dir}/${f.name}` : f.name;
      if (f.size > MAX_UPLOAD) { toast(`${f.name} is larger than 10 MB`, 'error'); continue; }
      const buf = await f.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buf);
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      // Never replace a file that exists without asking: the one being
      // replaced may be open in the editor with unsaved typing in it. The
      // server answers 409 for createOnly, which also covers a file another
      // client added since the tree was loaded.
      try {
        try {
          await api.writeFile(projectId, branch, path, btoa(binary), 'base64', { createOnly: true });
        } catch (err) {
          if (!(err instanceof ApiError) || err.status !== 409) throw err;
          if (!(await dialogs.confirm({ title: `Replace ${path}?`, body: `${path} already exists in this project. The uploaded file takes its place.`, confirmLabel: 'Replace file' }))) continue;
          await api.writeFile(projectId, branch, path, btoa(binary), 'base64');
        }
      } catch (err) {
        toast(`Could not upload ${path}: ${(err as Error).message}`, 'error');
        continue;
      }
      done.push(path);
    }
    if (done.length) { reveal(dir); onUploaded(done); }
  };

  const fileMenu = useContextMenu({ label: 'File actions', testId: 'file-menu' });
  const fileActions = (path: string): MenuEntry[] => [
    { id: 'root', label: 'Set as main document', onSelect: () => onSetRoot(path), disabled: path === rootFile, testId: 'file-menu-root' },
    {
      id: 'rename', label: 'Rename…', testId: 'file-menu-rename',
      onSelect: async () => {
        const to = (await dialogs.prompt({ title: `Rename ${path}`, value: path, confirmLabel: 'Rename', selectTo: stemEnd(path) }))?.trim();
        if (to && to !== path) onRename(path, to);
      },
    },
    { kind: 'separator' },
    {
      id: 'delete', label: 'Delete…', danger: true, testId: 'file-menu-delete',
      onSelect: async () => {
        if (await dialogs.confirm({ title: `Delete ${path}?`, confirmLabel: 'Delete file', danger: true })) onDelete(path);
      },
    },
  ];

  const deleteFolder = async (dir: string) => {
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
    onDelete(dir);
  };
  const renameFolder = async (dir: string) => {
    const raw = await dialogs.prompt({ title: `Rename ${dir}`, value: dir, confirmLabel: 'Rename' });
    if (raw === null) return;
    const to = normalizeEntryPath(raw);
    if (!to || to === dir) return;
    const error = entryPathError(raw) ?? (within(to, dir) ? `${dir} cannot move into a folder inside itself` : null);
    if (error) { toast(error, 'error'); return; }
    reveal(to);
    onRename(dir, to);
  };
  const folderMenu = useContextMenu({ label: 'Folder actions', testId: 'folder-menu' });
  const folderActions = (dir: string): MenuEntry[] => [
    { id: 'new-file', label: 'New file in folder…', testId: 'folder-menu-new-file', onSelect: () => startAdding('file', dir) },
    { id: 'new-folder', label: 'New folder in folder…', testId: 'folder-menu-new-folder', onSelect: () => startAdding('folder', dir) },
    { id: 'upload', label: 'Upload to folder…', testId: 'folder-menu-upload', onSelect: () => chooseUpload(dir) },
    { id: 'rename', label: 'Rename folder…', testId: 'folder-menu-rename', onSelect: () => { void renameFolder(dir); } },
    { kind: 'separator' },
    { id: 'delete', label: 'Delete folder…', danger: true, testId: 'folder-menu-delete', onSelect: () => { void deleteFolder(dir); } },
  ];

  // A row dragged onto a folder moves into it; files from the desktop upload
  // into it. A file's row stands in for the folder it is in, and the space
  // around the rows for the top level.
  const canDrop = (e: DragEvent, dir: string) =>
    dragged.current !== null ? moveTarget(dragged.current, dir) !== null : e.dataTransfer.types.includes('Files');
  const dropTarget = (dir: string) => ({
    onDragOver: (e: DragEvent) => {
      e.stopPropagation();
      if (!canDrop(e, dir)) { setDropDir(null); return; }
      e.preventDefault();
      e.dataTransfer.dropEffect = dragged.current !== null ? 'move' : 'copy';
      setDropDir(dir);
    },
    onDrop: async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDropDir(null);
      const from = e.dataTransfer.getData(DRAG_TYPE);
      if (from) {
        const to = moveTarget(from, dir);
        if (to) { reveal(dir); onRename(from, to); }
      } else if (e.dataTransfer.files.length) {
        await uploadFiles(e.dataTransfer.files, dir);
      }
    },
  });
  const dragSource = (path: string) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      dragged.current = path;
      e.dataTransfer.setData(DRAG_TYPE, path);
      e.dataTransfer.effectAllowed = 'move';
    },
    onDragEnd: () => { dragged.current = null; setDropDir(null); },
  });

  const tree = useMemo(() => {
    const full = buildTree(files);
    return sourceOnly ? sourceTree(full) : full;
  }, [files, sourceOnly]);

  const renderNode = (node: TreeNode, depth: number): JSX.Element => {
    // one level is the chevron plus the gap, so a child's chevron sits under
    // its folder's icon
    const pad = 8 + depth * 18;
    if (node.type === 'dir') {
      const open = isOpen(node.path);
      return (
        <div key={node.path}>
          <button
            className={`tree__item tree__dir ${dropDir === node.path ? 'tree__item--drop' : ''}`} style={{ paddingLeft: pad }} onClick={() => toggle(node.path)}
            data-testid={`dir-${node.path}`} title={node.path} aria-expanded={open}
            {...folderMenu.bind(() => folderActions(node.path))}
            {...dragSource(node.path)} {...dropTarget(node.path)}
          >
            <span className={`tree__chevron ${open ? 'tree__chevron--open' : ''}`}><IconChevronRight /></span>
            <span className="tree__icon"><FolderIcon /></span>
            {node.name}
          </button>
          {open && (node.children.length
            ? node.children.map((c) => renderNode(c, depth + 1))
            : (
              <div className="tree__empty" style={{ paddingLeft: pad + 36 }} data-testid={`dir-empty-${node.path}`} {...dropTarget(node.path)}>
                {holdsOnlyKeep(files, node.path) ? 'Empty folder' : 'No source files'}
              </div>
            ))}
        </div>
      );
    }
    return (
      <button
        key={node.path}
        className={`tree__item ${active === node.path ? 'tree__item--active' : ''}`}
        style={{ paddingLeft: pad }}
        data-testid={`file-${node.path}`}
        onClick={() => onOpen(node.path)}
        {...fileMenu.bind(() => fileActions(node.path))}
        {...dragSource(node.path)} {...dropTarget(parentOf(node.path))}
        title={node.path}
      >
        <span className="tree__chevron" />
        <span className="tree__icon">{fileIcon(node.path, node.path === rootFile)}</span>
        {node.name}
        {node.path === rootFile && <span className="tree__root-tag">root</span>}
      </button>
    );
  };

  return (
    <div
      className={`panel-list filetree ${dropDir === '' ? 'filetree--drag' : ''}`}
      data-testid="file-tree" data-drop={dropDir === '' && dragged.current !== null ? 'move' : undefined}
      {...dropTarget('')}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropDir(null); }}
    >
      {tree.map((n) => renderNode(n, 0))}

      {adding ? (
        <div className="tree__new">
          <input
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
      ) : (
        <div className="tree__actions">
          <button className="btn btn--ghost btn--icon" onClick={() => startAdding('file')} data-testid="new-file" title="New file" aria-label="New file"><IconFilePlus /></button>
          <button className="btn btn--ghost btn--icon" onClick={() => startAdding('folder')} data-testid="new-folder" title="New folder" aria-label="New folder"><IconFolderPlus /></button>
          <button className="btn btn--ghost btn--icon" onClick={() => chooseUpload('')} data-testid="upload-file" title="Upload files" aria-label="Upload files"><IconUpload /></button>
          <button
            className="btn btn--ghost btn--icon tree__filter" onClick={() => setSourceOnly((v) => !v)} aria-pressed={sourceOnly}
            data-testid="source-only" title="Show only LaTeX source and images" aria-label="Show only LaTeX source and images"
          ><IconFilter /></button>
        </div>
      )}
      {/* Outside the toolbar: a folder's menu opens the picker while the name input replaces it. */}
      <input ref={fileInput} type="file" multiple hidden data-testid="upload-input"
        onChange={async (e) => {
          const dir = uploadDir.current;
          uploadDir.current = '';
          if (e.target.files?.length) await uploadFiles(e.target.files, dir);
          e.target.value = '';
        }} />
      <p className="filetree__hint">Drop files here to upload, or onto a folder</p>

      {fileMenu.element}
      {folderMenu.element}
    </div>
  );
}
