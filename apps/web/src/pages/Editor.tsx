import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, CompileResult, ProjectDetail, TreeEntry, Comment, localUser } from '../api';
import { useToast } from '../components/Toast';
import { useAuth } from '../components/Auth';
import ShareModal from '../components/ShareModal';
import FileTree from '../components/FileTree';
import CodePane, { CodePaneHandle, EditorMode } from '../components/CodePane';
import PdfPane, { PdfPaneHandle } from '../components/PdfPane';
import BranchMenu from '../components/BranchMenu';
import HistoryPanel from '../components/HistoryPanel';
import ReviewPanel from '../components/ReviewPanel';
import Presence, { PresenceUser } from '../components/Presence';
import { PluginHost, PluginPanel } from '../plugins/host';
import { hintFor } from '../editor/errorHints';
import { IconChevronLeft } from '../components/Icons';
import CommandPalette, { Command } from '../components/CommandPalette';
import { invalidateBibCache, invalidateLabelCache } from '../editor/latexExtras';
import { useCommentSignal } from '../editor/commentSignal';
import GithubSync from '../components/GithubSync';
import GithubPublish from '../components/GithubPublish';
import CommentComposer from '../components/CommentComposer';
import Modal from '../components/Modal';
import FormatToolbar from '../components/FormatToolbar';
import { toggleTheme } from '../theme';

type CompileStatus = 'idle' | 'compiling' | 'ok' | 'error';

export default function Editor() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const branch = params.get('branch') || 'main';
  const navigate = useNavigate();
  const toast = useToast();

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [files, setFiles] = useState<TreeEntry[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [tab, setTab] = useState<'files' | 'history' | string>('files');
  const [compile, setCompile] = useState<{ status: CompileStatus; result: CompileResult | null }>({ status: 'idle', result: null });
  const [pdfWidth, setPdfWidth] = useState(() => Math.max(360, Math.round(window.innerWidth * 0.4)));
  const [users, setUsers] = useState<PresenceUser[]>([]);
  const [pluginPanels, setPluginPanels] = useState<PluginPanel[]>([]);
  const [auto, setAuto] = useState(() => localStorage.getItem('aldine.autoTypeset') !== '0');
  const [stats, setStats] = useState<{ words: number; selWords: number | null }>({ words: 0, selWords: null });
  const [zoom, setZoomState] = useState(() => {
    const z = Number(localStorage.getItem('aldine.pdfZoom'));
    return z >= 0.5 && z <= 3 ? z : 1;
  });
  const setZoom = useCallback((v: number | ((z: number) => number)) => {
    setZoomState((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      localStorage.setItem('aldine.pdfZoom', String(next));
      return next;
    });
  }, []);
  const [showLog, setShowLog] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const { authEnabled } = useAuth();
  const [spellcheck, setSpellcheck] = useState(() => localStorage.getItem('aldine.spellcheck') === '1');
  // Visual mode is gated by an experimental flag until it graduates.
  const visualEnabled = localStorage.getItem('aldine.experimental.visualEditor') === '1';
  const [mode, setMode] = useState<EditorMode>(() =>
    visualEnabled && localStorage.getItem('aldine.editorMode') === 'visual' ? 'visual' : 'source');
  const switchMode = (m: EditorMode) => { localStorage.setItem('aldine.editorMode', m); setMode(m); };
  const [comments, setComments] = useState<Comment[]>([]);
  const [composing, setComposing] = useState<{ from: number; to: number; quote: string } | null>(null);
  const codeRef = useRef<CodePaneHandle>(null);
  const pdfRef = useRef<PdfPaneHandle>(null);
  const compilingRef = useRef(false);
  const pendingRef = useRef(false);
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoRef = useRef(auto);
  autoRef.current = auto;

  const loadProject = useCallback(async () => {
    try {
      const p = await api.getProject(id);
      setProject(p);
      return p;
    } catch {
      toast('Project not found', 'error');
      navigate('/');
      return null;
    }
  }, [id]);

  // Whole-document word count (the include graph from the root file). The
  // status bar swaps the active file's server count for the live editor count,
  // so the total stays current while typing without refetching.
  const [docWords, setDocWords] = useState<{ total: number; files: Record<string, number> } | null>(null);
  const docWordsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshDocWords = useCallback(() => {
    api.wordcount(id, branch).then(setDocWords).catch(() => { /* keep the last total */ });
  }, [id, branch]);
  useEffect(() => { refreshDocWords(); }, [refreshDocWords]);

  const loadFiles = useCallback(async () => {
    // Several call sites invoke this fire-and-forget (onChanged, tree callbacks);
    // swallow transient failures with a toast instead of an unhandled rejection.
    try {
      const f = await api.listFiles(id, branch);
      setFiles(f);
      // files changed (rename/delete/upload/Zotero import) → bib & label indexes are stale
      invalidateBibCache();
      invalidateLabelCache();
      refreshDocWords();
      return f;
    } catch {
      toast('Could not refresh the file list', 'error');
      return [];
    }
  }, [id, branch, toast, refreshDocWords]);

  useEffect(() => {
    (async () => {
      const p = await loadProject();
      if (!p) return;
      const f = await loadFiles();
      const first = f.find((e) => e.path === p.rootFile) || f.find((e) => e.type === 'file' && e.path.endsWith('.tex')) || f.find((e) => e.type === 'file' && !e.binary);
      setActiveFile((cur) => (cur && f.some((e) => e.path === cur) ? cur : first?.path || null));
      // One-time nudge per project: work on an unlinked project exists only on
      // this server until it's published to GitHub. Only the owner can publish,
      // so only the owner is nudged.
      const owner = !authEnabled || !!p.isOwner;
      if (owner && !p.github && !localStorage.getItem(`aldine.ghNudged.${id}`)) {
        localStorage.setItem(`aldine.ghNudged.${id}`, '1');
        toast('This project lives only on this server — publish it to GitHub to keep a synced copy.');
      }
    })();
  }, [id, branch]);

  const doCompile = useCallback(async () => {
    if (compilingRef.current) { pendingRef.current = true; return; }
    compilingRef.current = true;
    // A typeset is where freshly typed \label/\cite content becomes relevant —
    // drop the client index caches so the next autocomplete/hover refetches
    // (cheap now: the server caches per content version).
    invalidateBibCache();
    invalidateLabelCache();
    setCompile((c) => ({ ...c, status: 'compiling' }));
    try {
      const result = await api.compile(id, branch);
      setCompile({ status: result.ok ? 'ok' : 'error', result });
    } catch (err: any) {
      setCompile({ status: 'error', result: null });
      toast(`Typesetting failed: ${err.message}`, 'error');
    } finally {
      compilingRef.current = false;
      if (pendingRef.current) {
        pendingRef.current = false;
        setTimeout(() => doCompile(), 400);
      }
    }
  }, [id, branch]);

  /** Auto-typeset ~2s after edits settle. */
  const onDocChanged = useCallback(() => {
    if (docWordsTimer.current) clearTimeout(docWordsTimer.current);
    docWordsTimer.current = setTimeout(refreshDocWords, 3000);
    if (!autoRef.current) return;
    if (autoTimer.current) clearTimeout(autoTimer.current);
    autoTimer.current = setTimeout(() => doCompile(), 2000);
  }, [doCompile, refreshDocWords]);

  useEffect(() => () => {
    if (autoTimer.current) clearTimeout(autoTimer.current);
    if (docWordsTimer.current) clearTimeout(docWordsTimer.current);
  }, []);

  const toggleAuto = () => {
    const next = !auto;
    setAuto(next);
    localStorage.setItem('aldine.autoTypeset', next ? '1' : '0');
  };

  // Cmd+S → typeset, Cmd+K → command palette
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        doCompile();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doCompile]);

  const switchBranch = (name: string) => {
    setParams(name === 'main' ? {} : { branch: name });
    setCompile({ status: 'idle', result: null });
  };

  const renameProject = async (el: HTMLElement, name: string) => {
    if (!project || !name.trim() || name === project.name) return;
    try {
      const p = await api.patchProject(id, { name: name.trim() });
      setProject((prev) => (prev ? { ...prev, name: p.name } : prev));
    } catch (err: any) {
      // The name lives in a contentEditable React doesn't control, so a
      // rejected rename would otherwise leave the refused text on screen.
      el.textContent = project.name;
      toast(`Could not rename: ${err.message}`, 'error');
    }
  };

  const jumpToLine = (line: number | null, file?: string) => {
    if (line == null || !project) return;
    // Older compilers report error paths relative to the compile dir (the root
    // file's dir), so fall back to a suffix match before giving up on the file.
    const norm = (file || '').replace(/\/(?:\.\/)+/g, '/');
    const target = (norm && (
      files.find((f) => f.path === norm)
      ?? files.find((f) => norm.endsWith('/' + f.path))
      ?? files.find((f) => f.path.endsWith('/' + norm))
    )?.path) || project.rootFile;
    if (activeFile !== target) setActiveFile(target);
    requestAnimationFrame(() => setTimeout(() => codeRef.current?.gotoLine(line), 60));
  };

  const insertAtCursor = useCallback((text: string) => codeRef.current?.insertAtCursor(text), []);

  // ---- review comments ----
  const loadComments = useCallback(async () => {
    try { setComments(await api.comments(id, branch)); } catch { setComments([]); }
  }, [id, branch]);
  useEffect(() => { loadComments(); }, [id, branch]);
  // live-sync: re-fetch when any collaborator changes comments
  const bumpComments = useCommentSignal(id, branch, loadComments);

  // push this file's comment ranges into the editor as highlight decorations
  useEffect(() => {
    if (!activeFile) return;
    const ranges = comments
      .filter((c) => c.file === activeFile)
      .map((c) => ({ id: c.id, from: c.anchor.from, to: c.anchor.to, resolved: c.resolved, suggestion: c.suggestion, quote: c.anchor.quote }));
    requestAnimationFrame(() => codeRef.current?.setCommentRanges(ranges));
  }, [comments, activeFile]);

  const startComment = useCallback(() => {
    if (!activeFile) return;
    const sel = codeRef.current?.getSelection();
    if (!sel) { toast('Select some text to comment on first.', 'info'); return; }
    setComposing(sel);
  }, [activeFile, toast]);

  const submitComment = useCallback(async (body: string, suggestion?: string) => {
    if (!composing || !activeFile) return;
    try {
      await api.addComment(id, { branch, file: activeFile, anchor: composing, body, suggestion, author: localUser().name });
      await loadComments();
      bumpComments();
      setTab('review');
    } catch (err: any) {
      toast(`Could not add comment: ${err.message}`, 'error');
    }
    setComposing(null);
  }, [composing, id, branch, activeFile, loadComments, bumpComments, toast]);

  const revealComment = useCallback((c: Comment) => {
    if (c.file !== activeFile) setActiveFile(c.file);
    requestAnimationFrame(() => setTimeout(() => codeRef.current?.revealPos(c.anchor.from), 80));
  }, [activeFile]);

  const acceptSuggestion = useCallback(async (c: Comment) => {
    if (c.suggestion === undefined) return;
    try {
      const content = await api.readFile(id, branch, c.file);
      let next: string | null = null;
      // prefer the anchored range if it still holds the quoted text; else find the quote
      if (content.slice(c.anchor.from, c.anchor.to) === c.anchor.quote) {
        next = content.slice(0, c.anchor.from) + c.suggestion + content.slice(c.anchor.to);
      } else if (
        c.anchor.quote &&
        // Only safe when the quote is the WHOLE original selection. The server
        // caps quote at 2000 chars (comments.ts), so for a longer selection the
        // quote is truncated and a text-replace would drop the tail — bail instead.
        c.anchor.quote.length === c.anchor.to - c.anchor.from &&
        content.split(c.anchor.quote).length === 2
      ) {
        // exactly one occurrence → unambiguous; function replacer keeps it literal
        const suggestion = c.suggestion;
        next = content.replace(c.anchor.quote, () => suggestion);
      }
      if (next === null) { toast('The commented text has changed — apply manually.', 'error'); return; }
      await api.writeFile(id, branch, c.file, next);
      await api.resolveComment(id, c.id, true);
      await loadComments();
      bumpComments();
      toast('Suggestion applied', 'ok');
    } catch (err: any) {
      toast(`Could not accept: ${err.message}`, 'error');
    }
  }, [id, branch, loadComments, toast]);

  // visual-mode suggestion widgets dispatch accept/dismiss as window events
  useEffect(() => {
    const onAction = (e: Event) => {
      const { id: cid, action } = (e as CustomEvent<{ id: string; action: 'accept' | 'resolve' }>).detail;
      const c = comments.find((x) => x.id === cid);
      if (!c) return;
      if (action === 'accept') acceptSuggestion(c);
      else api.resolveComment(id, c.id, true).then(() => { loadComments(); bumpComments(); });
    };
    window.addEventListener('aldine:suggestion', onAction);
    return () => window.removeEventListener('aldine:suggestion', onAction);
  }, [comments, id, acceptSuggestion, loadComments, bumpComments]);


  // Inverse SyncTeX: double-click in the PDF → open the source file at that line.
  const onPdfInverse = useCallback(async (page: number, x: number, y: number) => {
    try {
      const res = await api.synctex(id, branch, { direction: 'inverse', page, x, y });
      const rec = res.records?.find((r) => r.input || r.line != null);
      if (!rec) return;
      const line = Number(rec.line);
      // Older compilers return the path as TeX opened it (…/paper/./ch1.tex);
      // collapse "/./" segments or the suffix match below never fires and the
      // jump lands in the wrong (still-open) file.
      let file = String(rec.input || '').replace(/\/(?:\.\/)+/g, '/');
      // synctex returns an absolute/relative path; reduce to a project-relative one
      const match = files.find((f) => file.endsWith('/' + f.path) || file.endsWith(f.path) || f.path === file);
      if (match) file = match.path;
      if (file && files.some((f) => f.path === file)) setActiveFile(file);
      if (!Number.isNaN(line)) requestAnimationFrame(() => setTimeout(() => codeRef.current?.gotoLine(line), 80));
    } catch { /* synctex unavailable */ }
  }, [id, branch, files]);

  // Forward SyncTeX: from the editor, jump the PDF to the current line.
  const jumpToPdf = useCallback(async () => {
    if (!activeFile) return;
    const line = codeRef.current?.currentLine();
    if (line == null) return;
    try {
      const res = await api.synctex(id, branch, { direction: 'forward', file: activeFile, line, column: 0 });
      const rec = res.records?.find((r) => r.page != null && (r.y != null || r.v != null));
      if (!rec) return;
      pdfRef.current?.showForward(Number(rec.page), Number(rec.y ?? rec.v));
    } catch { /* synctex unavailable */ }
  }, [id, branch, activeFile]);

  const pluginCtx = useMemo(() => ({
    projectId: id,
    branch,
    getActiveFile: () => activeFile,
    getCompileResult: () => (compile.result ? { ok: compile.result.ok, errors: compile.result.errors || [], log: compile.result.log || '' } : null),
    insertAtCursor,
    refreshFiles: loadFiles,
    refreshProject: loadProject,
    compile: doCompile,
    toast,
  }), [id, branch, activeFile, compile.result, insertAtCursor, loadFiles, loadProject, doCompile, toast]);

  const commands: Command[] = useMemo(() => {
    const cmds: Command[] = [
      { id: 'typeset', group: 'Action', title: 'Typeset document', hint: '⌘S', run: doCompile },
      { id: 'auto', group: 'Action', title: auto ? 'Turn auto-typeset off' : 'Turn auto-typeset on', run: toggleAuto },
      { id: 'jump-pdf', group: 'Action', title: 'Jump PDF to cursor', hint: '⌘J', run: () => jumpToPdf() },
      { id: 'spell', group: 'Action', title: spellcheck ? 'Turn spellcheck off' : 'Turn spellcheck on', run: () => setSpellcheck((s) => { localStorage.setItem('aldine.spellcheck', s ? '0' : '1'); return !s; }) },
      { id: 'theme', group: 'View', title: 'Toggle light/dark theme', run: () => { toggleTheme(); } },
      ...(visualEnabled
        ? [{ id: 'mode', group: 'View', title: mode === 'visual' ? 'Switch to Source editing' : 'Switch to Visual editing', run: () => switchMode(mode === 'visual' ? 'source' : 'visual') }]
        : [{ id: 'experimental-visual', group: 'View', title: 'Enable experimental Visual editor', run: () => { localStorage.setItem('aldine.experimental.visualEditor', '1'); location.reload(); } }]),
      { id: 'commit', group: 'Git', title: 'Save a checkpoint…', run: () => { setTab('history'); } },
      { id: 'newbranch', group: 'Git', title: 'New branch…', run: () => { setTab('files'); document.querySelector<HTMLElement>('[data-testid="branch-menu"]')?.click(); } },
    ];
    if (activeFile) {
      cmds.push({
        id: 'rename-file', group: 'File', title: `Rename ${activeFile}…`, run: async () => {
          const to = window.prompt('Rename file to', activeFile);
          if (to && to !== activeFile) {
            await api.renameFile(id, branch, activeFile, to);
            await loadFiles();
            setActiveFile(to);
          }
        },
      });
      cmds.push({
        id: 'delete-file', group: 'File', title: `Delete ${activeFile}…`, run: async () => {
          if (window.confirm(`Delete ${activeFile}?`)) {
            await api.deleteFile(id, branch, activeFile);
            await loadFiles();
            setActiveFile(null);
          }
        },
      });
    }
    for (const s of [
      { id: 'fig', title: 'Insert figure', text: '\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{}\n  \\caption{}\n  \\label{fig:}\n\\end{figure}\n' },
      { id: 'tab', title: 'Insert table', text: '\\begin{table}[htbp]\n  \\centering\n  \\begin{tabular}{ll}\n    \\hline\n    A & B \\\\\n    \\hline\n  \\end{tabular}\n  \\caption{}\n  \\label{tab:}\n\\end{table}\n' },
      { id: 'eq', title: 'Insert equation', text: '\\begin{equation}\n  \\label{eq:}\n\\end{equation}\n' },
    ]) {
      cmds.push({ id: `snippet-${s.id}`, group: 'Insert', title: s.title, run: () => insertAtCursor(s.text) });
    }
    for (const f of files.filter((f) => f.type === 'file' && !f.binary)) {
      cmds.push({ id: `open-${f.path}`, group: 'Open', title: f.path, run: () => setActiveFile(f.path) });
    }
    return cmds;
  }, [files, activeFile, id, branch, auto, spellcheck, doCompile, toggleAuto, jumpToPdf, insertAtCursor, loadFiles]);

  const errors = compile.result?.errors?.filter((e) => e.type !== 'typesetting') || [];
  const errCount = errors.filter((e) => e.type === 'error').length;
  const showErrors = compile.result != null && (errors.length > 0 || !compile.result.ok);
  // a PDF is already on screen when the last compile produced one (recompiles keep it visible)
  const hasPdf = compile.result?.pdfUrl != null;

  if (!project) return <div className="editor-shell" />;

  // Without auth everyone is owner and member; with it, trust the server's word.
  const isProjectOwner = !authEnabled || !!project.isOwner;
  const canSync = !authEnabled || !!project.isMember;

  return (
    <div className="editor-shell" data-testid="editor-shell">
      <PluginHost ctx={pluginCtx} onPanels={setPluginPanels} />
      <header className="toolbar">
        <button className="btn btn--ghost" onClick={() => navigate('/')} title="All projects" aria-label="Back to projects"><IconChevronLeft /></button>
        <span
          className="toolbar__name"
          contentEditable
          suppressContentEditableWarning
          data-testid="project-name"
          onBlur={(e) => renameProject(e.currentTarget, e.currentTarget.textContent || '')}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLElement).blur(); } }}
        >
          {project.name}
        </span>
        <BranchMenu
          projectId={id}
          current={branch}
          onSwitch={switchBranch}
          onChanged={() => { loadProject(); loadFiles(); }}
        />
        {visualEnabled && (
          <div className="seg" role="tablist" aria-label="Editing mode" data-testid="mode-toggle">
            <button role="tab" aria-selected={mode === 'source'} className={`seg__btn ${mode === 'source' ? 'seg__btn--active' : ''}`} onClick={() => switchMode('source')}>Source</button>
            <button role="tab" aria-selected={mode === 'visual'} className={`seg__btn ${mode === 'visual' ? 'seg__btn--active' : ''}`} onClick={() => switchMode('visual')}>Visual</button>
          </div>
        )}
        <div className="toolbar__spacer" />
        {/* Syncing is members-only and publishing is owner-only server-side —
            don't offer either to someone here on a share link. */}
        {project.github ? (
          canSync && <GithubSync projectId={id} fullName={project.github.fullName} onPulled={() => { loadFiles(); loadProject(); }} />
        ) : (
          isProjectOwner && (
            <button className="btn btn--ghost" onClick={() => setPublishOpen(true)} data-testid="github-publish-open" title="Publish this project to a GitHub repo — backup + sync">
              Publish to GitHub
            </button>
          )
        )}
        {authEnabled && project.isOwner && (
          <button className="btn" onClick={() => setShareOpen(true)} data-testid="share-project" title="Invite collaborators or share by link">Share</button>
        )}
        <button className="btn" onClick={startComment} data-testid="add-comment" title="Comment on the selected text">Comment</button>
        <Presence users={users} />
        <div className="toolbar__group">
          <button
            className="btn btn--primary"
            onClick={doCompile}
            disabled={compile.status === 'compiling'}
            data-testid="typeset-button"
            title="Typeset (⌘S)"
          >
            {compile.status === 'compiling' ? <span className="spinner" /> : null}
            Typeset
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className="pane sidebar">
          <div className="sidebar__tabs" role="tablist">
            <button className={`sidebar__tab ${tab === 'files' ? 'sidebar__tab--active' : ''}`} onClick={() => setTab('files')} role="tab">Files</button>
            <button className={`sidebar__tab ${tab === 'history' ? 'sidebar__tab--active' : ''}`} onClick={() => setTab('history')} role="tab">History</button>
            <button className={`sidebar__tab ${tab === 'review' ? 'sidebar__tab--active' : ''}`} onClick={() => setTab('review')} role="tab" data-testid="tab-review">
              Review{comments.some((c) => !c.resolved) ? ` (${comments.filter((c) => !c.resolved).length})` : ''}
            </button>
            {pluginPanels.map((p) => (
              <button key={p.id} className={`sidebar__tab ${tab === p.id ? 'sidebar__tab--active' : ''}`} onClick={() => setTab(p.id)} role="tab" data-testid={`tab-${p.id}`}>
                {p.title}
              </button>
            ))}
          </div>
          <div className="sidebar__body">
            {tab === 'files' && (
              <FileTree
                files={files}
                active={activeFile}
                rootFile={project.rootFile}
                projectId={id}
                branch={branch}
                onOpen={setActiveFile}
                onCreate={async (path) => {
                  try {
                    await api.createFile(id, branch, path);
                    await loadFiles();
                    setActiveFile(path);
                  } catch (err: any) {
                    if (/already exists/i.test(err?.message)) { toast(`"${path}" already exists`, 'error'); setActiveFile(path); }
                    else toast(`Could not create file: ${err.message}`, 'error');
                  }
                }}
                onUploaded={async (paths) => {
                  await loadFiles();
                  toast(paths.length === 1 ? `Uploaded ${paths[0]}` : `Uploaded ${paths.length} files`, 'ok');
                }}
                onDelete={async (path) => {
                  await api.deleteFile(id, branch, path);
                  await loadFiles();
                  if (activeFile === path) setActiveFile(null);
                }}
                onRename={async (from, to) => {
                  try {
                    await api.renameFile(id, branch, from, to);
                    await loadFiles();
                    if (activeFile === from) setActiveFile(to);
                  } catch (err: any) {
                    toast(/already exists/i.test(err?.message) ? `"${to}" already exists` : `Could not rename: ${err.message}`, 'error');
                  }
                }}
                onSetRoot={async (path) => {
                  await api.patchProject(id, { rootFile: path });
                  await loadProject();
                  toast(`Typeset root is now ${path}`, 'ok');
                }}
              />
            )}
            {tab === 'history' && <HistoryPanel projectId={id} branch={branch} />}
            {tab === 'review' && (
              <ReviewPanel
                comments={comments}
                activeFile={activeFile}
                onReveal={revealComment}
                onResolve={async (c, resolved) => { await api.resolveComment(id, c.id, resolved); await loadComments(); bumpComments(); }}
                onDelete={async (c) => { if (!window.confirm('Delete this comment thread?')) return; await api.deleteComment(id, c.id); await loadComments(); bumpComments(); }}
                onReply={async (c, body) => { await api.replyComment(id, c.id, body, localUser().name); await loadComments(); bumpComments(); }}
                onAccept={acceptSuggestion}
              />
            )}
            {pluginPanels.map((p) => (
              <div key={p.id} style={{ display: tab === p.id ? 'block' : 'none' }} ref={(el) => { if (el && !el.hasChildNodes()) p.mount(el); }} />
            ))}
          </div>
        </aside>

        <main className="pane" style={{ flex: 1 }}>
          {activeFile ? (
            <>
              <div className="pane__header">
                <span className="statusbar__file">{activeFile}</span>
                {visualEnabled && mode === 'visual' && <FormatToolbar target={codeRef} />}
                <span className="toolbar__spacer" />
                {(() => {
                  // document total with the open file's count kept live; a file
                  // outside the include graph falls back to its own count
                  const inDoc = !!(docWords && activeFile && docWords.files[activeFile] != null);
                  const total = inDoc ? docWords!.total - docWords!.files[activeFile!] + stats.words : stats.words;
                  return (
                    <span
                      className="pdf-status"
                      data-testid="word-count"
                      title={inDoc ? 'Words in the whole document (root file plus everything it includes)' : 'Words in this file (it is not included from the root file)'}
                    >
                      {stats.selWords != null
                        ? `${stats.selWords.toLocaleString()} of ${total.toLocaleString()} words`
                        : `${total.toLocaleString()} words`}
                    </span>
                  );
                })()}
              </div>
              <CodePane
                key={`${id}::${branch}::${activeFile}`}
                ref={codeRef}
                projectId={id}
                branch={branch}
                filePath={activeFile}
                rootFile={project?.rootFile}
                onUsers={setUsers}
                onSave={doCompile}
                onDocChanged={onDocChanged}
                onStats={setStats}
                onJumpToPdf={jumpToPdf}
                spellcheck={spellcheck}
                mode={mode}
              />
            </>
          ) : (
            <div className="pdf-empty"><p>Select a file to start writing.</p></div>
          )}
          {showErrors && (
            <div className="errors" data-testid="errors-panel">
              <div className="errors__head">
                <span>{errCount > 0 ? `${errCount} error${errCount === 1 ? '' : 's'}` : 'Problems'}</span>
                <button className="btn btn--ghost btn--small" onClick={() => setShowLog(true)} data-testid="view-log">View log</button>
              </div>
              {errors.slice(0, 50).map((e, i) => {
                const hint = hintFor(e.message);
                return (
                  <button key={i} className="errors__row" onClick={() => jumpToLine(e.line, (e as { file?: string }).file)}>
                    <span className={`errors__badge errors__badge--${e.type}`}>{e.type === 'error' ? 'Error' : 'Warning'}</span>
                    {e.line != null && <span className="errors__line">line {e.line}</span>}
                    <span className="errors__msgwrap">
                      <span className="errors__msg" title={e.message}>{e.message}</span>
                      {hint && <span className="errors__hint">{hint}</span>}
                    </span>
                  </button>
                );
              })}
              {errors.length === 0 && (
                <div className="errors__row" style={{ cursor: 'default' }}>
                  <span className="errors__msg">
                    {compile.result?.timedOut
                      ? 'Typesetting timed out — the document took too long (a possible infinite loop, or it needs a bigger compile budget). Open the log for details.'
                      : 'Typesetting failed — open the log for details.'}
                  </span>
                </div>
              )}
            </div>
          )}
        </main>

        <div
          className="resizer"
          onMouseDown={(e) => {
            const startX = e.clientX;
            const start = pdfWidth;
            // Floor the upper bound so a narrow window can't push it below the
            // 280 minimum (which would invert the clamp and collapse the pane).
            const move = (ev: MouseEvent) => {
              const maxW = Math.max(360, window.innerWidth - 500);
              setPdfWidth(Math.min(Math.max(280, start + (startX - ev.clientX)), maxW));
            };
            const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
            window.addEventListener('mousemove', move);
            window.addEventListener('mouseup', up);
          }}
        />

        <section className="pane" style={{ width: pdfWidth, flex: 'none' }}>
          <div className="pane__header">
            <span>Preview</span>
            <span className="pdf-status" data-testid="pdf-status" style={{ marginLeft: 10 }}>
              {compile.status === 'compiling' && hasPdf && <><span className="dot dot--busy" /> Typesetting…</>}
              {compile.status === 'ok' && compile.result && <><span className="dot dot--ok" /> Typeset in {(compile.result.durationMs / 1000).toFixed(1)}s</>}
              {compile.status === 'error' && <><span className="dot dot--error" /> {errCount > 0 ? `${errCount} error${errCount === 1 ? '' : 's'}` : 'Failed'}</>}
            </span>
            <span className="toolbar__spacer" />
            <div className="zoom" data-testid="zoom-controls">
              <button className="btn btn--ghost btn--small" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)))} title="Zoom out" aria-label="Zoom out">−</button>
              <button className="zoom__label" onClick={() => setZoom(1)} title="Reset to fit width" aria-label={`PDF zoom ${Math.round(zoom * 100)}%, click to reset`}>{Math.round(zoom * 100)}%</button>
              <button className="btn btn--ghost btn--small" onClick={() => setZoom((z) => Math.min(3, +(z + 0.1).toFixed(2)))} title="Zoom in" aria-label="Zoom in">+</button>
            </div>
            {compile.result?.pdfUrl && (
              <a
                className="btn btn--ghost btn--small"
                href={compile.result.pdfUrl}
                download={`${(project?.name || 'document').replace(/[\\/:*?"<>|]/g, '-')}.pdf`}
                title="Download the compiled PDF"
                data-testid="download-pdf"
              >
                Download PDF
              </a>
            )}
            <button
              className={`auto-toggle ${auto ? 'auto-toggle--on' : ''}`}
              onClick={toggleAuto}
              title={auto ? 'Auto-typeset is on — typesets shortly after you stop typing' : 'Auto-typeset is off'}
              data-testid="auto-toggle"
            >
              <span className="auto-toggle__knob" />
              Auto
            </button>
          </div>
          <PdfPane ref={pdfRef} pdfUrl={compile.result?.pdfUrl || null} status={compile.status} zoom={zoom} onFirstOpen={doCompile} onInverse={onPdfInverse} />
        </section>
      </div>

      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />

      {composing && (
        <CommentComposer quote={composing.quote} onSubmit={submitComment} onClose={() => setComposing(null)} />
      )}

      {publishOpen && project && (
        <GithubPublish projectId={id} projectName={project.name} onClose={() => setPublishOpen(false)} onLinked={() => loadProject()} />
      )}

      {shareOpen && (
        <ShareModal
          project={project}
          onClose={() => setShareOpen(false)}
          onSaved={(updated) => { setShareOpen(false); setProject((prev) => (prev ? { ...prev, share: updated.share } : prev)); }}
        />
      )}

      {showLog && compile.result && (
        <Modal onClose={() => setShowLog(false)} label="Typesetting log" wide>
          <div>
            <h2>Typesetting log</h2>
            <pre className="logview" data-testid="log-view">{compile.result.log || '(no log)'}</pre>
            <div className="modal__row">
              <button className="btn" onClick={() => setShowLog(false)}>Close</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
