import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';
import { ApiError, TreeEntry, api } from '../api';
import { fileIcon, IconChevronRight } from './Icons';
import { useDialogs } from './Dialogs';
import { useExitGhost } from '../exitGhost';

interface Props {
  files: TreeEntry[];
  active: string | null;
  rootFile: string;
  projectId: string;
  branch: string;
  onOpen(path: string): void;
  onCreate(path: string): void;
  onUploaded(paths: string[]): void;
  onDelete(path: string): void;
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

interface Node { name: string; path: string; type: 'file' | 'dir'; binary?: boolean; children: Node[] }

/** Build a nested tree from the flat path list (handles files in subdirectories). */
function buildTree(files: TreeEntry[]): Node[] {
  const root: Node = { name: '', path: '', type: 'dir', children: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let cur = root;
    parts.forEach((seg, i) => {
      const isLeaf = i === parts.length - 1;
      const p = parts.slice(0, i + 1).join('/');
      let child = cur.children.find((c) => c.name === seg);
      if (!child) {
        child = { name: seg, path: p, type: isLeaf && f.type === 'file' ? 'file' : 'dir', binary: isLeaf ? f.binary : undefined, children: [] };
        cur.children.push(child);
      }
      cur = child;
    });
  }
  const sort = (n: Node) => {
    n.children.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
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

export default function FileTree({ files, active, rootFile, projectId, branch, onOpen, onCreate, onUploaded, onDelete, onRename, onSetRoot, newFileRequest = 0, onNewFileHandled }: Props) {
  const dialogs = useDialogs();
  const leave = useExitGhost();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  // A project with no files of the user's own (the .gitignore every project
  // carries does not count) gets main.tex suggested: that name also makes the
  // file the typeset root without a further step.
  const startAdding = () => {
    setName(files.some((f) => f.type === 'file' && !f.path.split('/').pop()!.startsWith('.')) ? '' : 'main.tex');
    setAdding(true);
  };
  useEffect(() => { if (newFileRequest) { startAdding(); onNewFileHandled?.(); } }, [newFileRequest]);
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The menu opens at the pointer; near the right or bottom edge it would
  // hang off the window, so it is pulled back in before the first paint.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el || !menu) return;
    const r = el.getBoundingClientRect();
    const x = Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8));
    const y = Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.querySelector<HTMLElement>('.menu__item')?.focus({ preventScroll: true });
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    const away = (e: PointerEvent) => { if (!menuRef.current?.contains(e.target as Element)) setMenu(null); };
    window.addEventListener('keydown', key);
    window.addEventListener('pointerdown', away);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('pointerdown', away); };
  }, [menu]);
  const [dragOver, setDragOver] = useState(false);
  const [sourceOnly, setSourceOnly] = useState(true);
  // User expand/collapse overrides. Default: dot-directories (.github, .devcontainer, …)
  // start collapsed; everything else expanded. This overlay avoids depending on
  // `files` at mount (which is empty on first render).
  const [override, setOverride] = useState<Map<string, boolean>>(new Map());
  const fileInput = useRef<HTMLInputElement>(null);

  const isDot = (p: string) => p.split('/').pop()!.startsWith('.');
  const isOpen = (p: string) => (override.has(p) ? override.get(p)! : !isDot(p));
  const toggle = (p: string) => setOverride((m) => new Map(m).set(p, !isOpen(p)));

  const tree = useMemo(() => {
    const full = buildTree(files);
    if (!sourceOnly) return full;
    // keep source files + any directory that (recursively) contains one
    const SOURCE = /\.(tex|bib|cls|bbx|cbx|sty|bst|png|jpe?g|pdf|eps|svg|tikz)$/i;
    const prune = (nodes: Node[]): Node[] => nodes.map((n) => {
      if (n.type === 'file') return SOURCE.test(n.name) ? n : null;
      const kids = prune(n.children);
      return kids.length ? { ...n, children: kids } : null;
    }).filter(Boolean) as Node[];
    return prune(full);
  }, [files, sourceOnly]);

  const submit = () => {
    const n = name.trim();
    setAdding(false);
    setName('');
    if (n) onCreate(n);
  };

  const uploadFiles = async (list: FileList | File[]) => {
    const done: string[] = [];
    for (const f of Array.from(list)) {
      if (f.size > MAX_UPLOAD) { alert(`${f.name} is larger than 10 MB`); continue; }
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
        await api.writeFile(projectId, branch, f.name, btoa(binary), 'base64', { createOnly: true });
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 409) throw err;
        if (!(await dialogs.confirm({ title: `Replace ${f.name}?`, body: `${f.name} already exists in this project. The uploaded file takes its place.`, confirmLabel: 'Replace file' }))) continue;
        await api.writeFile(projectId, branch, f.name, btoa(binary), 'base64');
      }
      done.push(f.name);
    }
    if (done.length) onUploaded(done);
  };

  const renderNode = (node: Node, depth: number): JSX.Element => {
    // one level is the chevron plus the gap, so a child's chevron sits under
    // its folder's icon
    const pad = 8 + depth * 18;
    if (node.type === 'dir') {
      const open = isOpen(node.path);
      return (
        <div key={node.path}>
          <button className="tree__item tree__dir" style={{ paddingLeft: pad }} onClick={() => toggle(node.path)} data-testid={`dir-${node.path}`} title={node.path}>
            <span className={`tree__chevron ${open ? 'tree__chevron--open' : ''}`}><IconChevronRight /></span>
            <span className="tree__icon"><FolderIcon /></span>
            {node.name}
          </button>
          {open && node.children.map((c) => renderNode(c, depth + 1))}
        </div>
      );
    }
    return (
      <button
        key={node.path}
        className={`tree__item ${active === node.path ? 'tree__item--active' : ''}`}
        style={{ paddingLeft: pad }}
        data-testid={`file-${node.path}`}
        onClick={() => !node.binary && onOpen(node.path)}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ path: node.path, x: e.clientX, y: e.clientY }); }}
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
      className={`panel-list filetree ${dragOver ? 'filetree--drag' : ''}`}
      data-testid="file-tree"
      onClick={() => setMenu(null)}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={async (e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) await uploadFiles(e.dataTransfer.files); }}
    >
      {tree.map((n) => renderNode(n, 0))}

      {adding ? (
        <input
          autoFocus className="input" style={{ margin: '4px 0' }} placeholder="chapter.tex" value={name} data-testid="new-file-name"
          onChange={(e) => setName(e.target.value)} onBlur={submit}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { setAdding(false); setName(''); } }}
        />
      ) : (
        <div className="tree__actions">
          <button className="btn btn--ghost btn--small" onClick={startAdding} data-testid="new-file">+ New file</button>
          <button className="btn btn--ghost btn--small" onClick={() => fileInput.current?.click()} data-testid="upload-file">↑ Upload</button>
          <button className="btn btn--ghost btn--small" onClick={() => setSourceOnly((v) => !v)} data-testid="source-only" title="Show only LaTeX source & images">{sourceOnly ? '☰ All' : '⌇ Source'}</button>
          <input ref={fileInput} type="file" multiple hidden data-testid="upload-input"
            onChange={async (e) => { if (e.target.files?.length) await uploadFiles(e.target.files); e.target.value = ''; }} />
        </div>
      )}
      <p className="filetree__hint">Drop files here to upload</p>

      {menu && (
        <div ref={(el) => { menuRef.current = el; leave(el); }} className="menu" role="menu" style={{ left: menu.x, top: menu.y, position: 'fixed' }} onClick={(e) => e.stopPropagation()} data-testid="file-menu">
          <button className="menu__item" onClick={() => { onSetRoot(menu.path); setMenu(null); }}>Set as main document</button>
          <button className="menu__item" data-testid="file-menu-rename" onClick={async () => {
            const from = menu.path;
            setMenu(null);
            const to = (await dialogs.prompt({ title: `Rename ${from}`, value: from, confirmLabel: 'Rename', selectTo: stemEnd(from) }))?.trim();
            if (to && to !== from) onRename(from, to);
          }}>Rename…</button>
          <div className="menu__sep" />
          <button className="menu__item" data-testid="file-menu-delete" onClick={async () => {
            const path = menu.path;
            setMenu(null);
            if (await dialogs.confirm({ title: `Delete ${path}?`, confirmLabel: 'Delete file', danger: true })) onDelete(path);
          }}>Delete</button>
        </div>
      )}
    </div>
  );
}
