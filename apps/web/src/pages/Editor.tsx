import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, CompileResult, ImportedProject, ProjectDetail, TreeEntry, Comment, localUser } from '../api';
import { useToast } from '../components/Toast';
import { useAuth } from '../components/Auth';
import ShareModal from '../components/ShareModal';
import About from '../components/About';
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
import { shortcut } from '../platform';
import ProjectSettings from '../components/ProjectSettings';
import { ENGINES } from '../util/engines';

type CompileStatus = 'idle' | 'compiling' | 'ok' | 'error';

/** A text field that is not the code editor (whose own keymap owns Mod-j). */
function inTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  if (el.closest('.cm-editor')) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

export default function Editor() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const branch = params.get('branch') || 'main';
  const navigate = useNavigate();
  // Home hands the import result over in history state so the settings
  // panel can say where the compiler choice came from.
  const imported = (useLocation().state as { import?: ImportedProject['import'] } | null)?.import;
  const toast = useToast();

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [files, setFiles] = useState<TreeEntry[]>([]);
  // The on-open typeset waits for the first file listing: before it, every
  // project looks empty and a blank one must not compile at all.
  const [filesLoaded, setFilesLoaded] = useState(false);
  const [newFileRequest, setNewFileRequest] = useState(0);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [tab, setTab] = useState<'files' | 'history' | string>('files');
  const [compile, setCompile] = useState<{ status: CompileStatus; result: CompileResult | null; wallMs?: number }>({ status: 'idle', result: null });
  const [pdfWidth, setPdfWidth] = useState(() => Math.max(360, Math.round(window.innerWidth * 0.4)));
  // The pane keeps an absolute width, so shrinking the window would otherwise
  // leave a preview wider than the room for it and squeeze the editor away.
  // Same bound as the resizer's.
  useEffect(() => {
    const fit = () => setPdfWidth((w) => Math.min(w, Math.max(280, window.innerWidth - 500)));
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
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
  // Scroll the log to its first error once the dialog has rendered.
  const logHit = useRef<HTMLElement>(null);
  useEffect(() => {
    if (showLog) logHit.current?.scrollIntoView({ block: 'center' });
  }, [showLog]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
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
  // Every project carries a .gitignore; dotfiles are not what the user wrote,
  // so they neither open on load nor count against the empty state.
  const isUserFile = (f: TreeEntry) => f.type === 'file' && !f.path.split('/').pop()!.startsWith('.');
  const hasFiles = files.some(isUserFile);
  const hasTex = files.some((f) => f.type === 'file' && f.path.endsWith('.tex'));
  const hasTexRef = useRef(hasTex);
  hasTexRef.current = hasTex;

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
      const first = f.find((e) => e.path === p.rootFile) || f.find((e) => e.type === 'file' && e.path.endsWith('.tex')) || f.find((e) => isUserFile(e) && !e.binary);
      setActiveFile((cur) => (cur && f.some((e) => e.path === cur) ? cur : first?.path || null));
      setFilesLoaded(true);
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

  const doCompile = useCallback(async (attempt = 0) => {
    if (compilingRef.current) { pendingRef.current = true; return; }
    compilingRef.current = true;
    // A typeset is where freshly typed \label/\cite content becomes relevant —
    // drop the client index caches so the next autocomplete/hover refetches
    // (cheap now: the server caches per content version).
    invalidateBibCache();
    invalidateLabelCache();
    setCompile((c) => ({ ...c, status: 'compiling' }));
    const t0 = Date.now();
    try {
      const result = await api.compile(id, branch);
      setCompile({ status: result.ok ? 'ok' : 'error', result, wallMs: Date.now() - t0 });
    } catch (err: any) {
      // A capacity rejection is the server being busy, not a broken document —
      // keep the busy state and retry with backoff instead of showing "Failed".
      if (/too many typesets/i.test(err?.message || '') && attempt < 3) {
        pendingRef.current = false; // the retry below also serves any queued request
        setTimeout(() => doCompile(attempt + 1), 1500 * (attempt + 1));
        return;
      }
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

  /** Auto-typeset ~2s after this client's own edits settle — remote edits
   *  refresh the word count but never trigger a compile (the editing client
   *  compiles; N passive collaborators racing to rebuild the same PDF only
   *  starve the compile gate). */
  const onDocChanged = useCallback((local: boolean) => {
    if (docWordsTimer.current) clearTimeout(docWordsTimer.current);
    docWordsTimer.current = setTimeout(refreshDocWords, 3000);
    // Nothing to typeset until the project has a .tex file.
    if (!local || !autoRef.current || !hasTexRef.current) return;
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

  const switchBranch = (name: string) => {
    setParams(name === 'main' ? {} : { branch: name });
    setCompile({ status: 'idle', result: null });
  };

  const saveName = useCallback(async (name: string) => {
    try {
      const p = await api.patchProject(id, { name: name.trim() });
      setProject((prev) => (prev ? { ...prev, name: p.name } : prev));
    } catch (err: any) {
      toast(`Could not rename: ${err.message}`, 'error');
      throw err;
    }
  }, [id, toast]);

  const renameProject = async (el: HTMLElement, name: string) => {
    if (!project || !name.trim() || name === project.name) return;
    // The name lives in a contentEditable React doesn't control, so a
    // rejected rename would otherwise leave the refused text on screen.
    await saveName(name).catch(() => { el.textContent = project.name; });
  };

  const setRootFile = useCallback(async (path: string) => {
    if (!project || path === project.rootFile) return;
    try {
      await api.patchProject(id, { rootFile: path });
      await loadProject();
      toast(`Main document is now ${path}`, 'ok');
    } catch (err: any) {
      toast(`Could not change the main document: ${err.message}`, 'error');
    }
  }, [id, project, loadProject, toast]);

  const setStopOnFirstError = useCallback(async (on: boolean) => {
    if (!project || on === !!project.stopOnFirstError) return;
    // The checkbox is controlled: flip it now so it follows the click, and
    // roll back if the server refuses.
    setProject((prev) => (prev ? { ...prev, stopOnFirstError: on } : prev));
    try {
      await api.patchProject(id, { stopOnFirstError: on });
      toast(on ? 'Typesetting now stops at the first error' : 'Typesetting now runs to the end and lists the errors', 'ok');
    } catch (err: any) {
      setProject((prev) => (prev ? { ...prev, stopOnFirstError: !on } : prev));
      toast(`Could not change the setting: ${err.message}`, 'error');
    }
  }, [id, project, toast]);

  const setEngine = useCallback(async (engine: string) => {
    if (!project || engine === project.engine) return;
    try {
      await api.patchProject(id, { engine });
      await loadProject();
      // A PDF on screen was typeset with the old engine — rebuild it.
      if (compile.result) doCompile();
    } catch (err: any) {
      toast(`Could not change the engine: ${err.message}`, 'error');
    }
  }, [id, project, compile.result, loadProject, doCompile, toast]);

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

  // Accept happens server-side against the LIVE collab doc — a client-side
  // read-replace-write of the disk copy silently reverted every collaborator's
  // unflushed edits and failed on freshly typed (not yet autosaved) text.
  const acceptSuggestion = useCallback(async (c: Comment) => {
    if (c.suggestion === undefined) return;
    try {
      await api.acceptSuggestion(id, c.id, branch);
      await loadComments();
      bumpComments();
      toast('Suggestion applied', 'ok');
    } catch (err: any) {
      toast(err.message || 'Could not accept the suggestion', 'error');
    }
  }, [id, branch, loadComments, bumpComments, toast]);

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


  // The preview is stale when the last run produced no PDF: the server keeps
  // the previous pdfUrl and flags it, or the run never produced a result and
  // the pane still shows the old canvases. A run that logged errors but wrote
  // a PDF is current — the errors sit in the list beside it. Refs so the
  // inverse callback reads the live values.
  const pdfStale = (compile.status === 'error' && !compile.result) || !!compile.result?.pdfStale;
  const pdfStaleRef = useRef(pdfStale);
  pdfStaleRef.current = pdfStale;
  const compileIdRef = useRef<number | undefined>(undefined);
  compileIdRef.current = compile.result?.compileId;

  // Inverse SyncTeX: double-click in the PDF → open the source file at that line.
  const onPdfInverse = useCallback(async (page: number, x: number, y: number) => {
    if (pdfStaleRef.current) toast('This preview is from the last successful typeset — fix the errors and typeset again to jump accurately');
    try {
      const res = await api.synctex(id, branch, { direction: 'inverse', page, x, y, compileId: compileIdRef.current });
      const rec = res.records?.find((r) => r.input || r.line != null);
      if (!rec) { toast('No source location for that spot', 'error'); return; }
      const line = Number(rec.line);
      // Older compilers return the path as TeX opened it (…/paper/./ch1.tex);
      // collapse "/./" segments or the suffix match below never fires and the
      // jump lands in the wrong (still-open) file.
      let file = String(rec.input || '').replace(/\/(?:\.\/)+/g, '/');
      // Exact project path first — a suffix match must never beat it, or the
      // template's stub main.tex hijacks every jump meant for paper/main.tex.
      const match = files.find((f) => f.path === file)
        ?? files.find((f) => file.endsWith('/' + f.path))
        ?? files.find((f) => f.path.endsWith('/' + file));
      if (match) file = match.path;
      if (file && files.some((f) => f.path === file)) setActiveFile(file);
      if (!Number.isNaN(line)) requestAnimationFrame(() => setTimeout(() => codeRef.current?.gotoLine(line), 80));
    } catch (err: any) {
      // 409: the preview on screen and the SyncTeX on disk are different runs.
      if (err instanceof ApiError && err.status === 409) { toast(err.message); return; }
      toast('Jump to source unavailable — typeset first', 'error');
    }
  }, [id, branch, files, toast]);

  // Forward SyncTeX: from the editor, jump the PDF to the current line.
  const jumpToPdf = useCallback(async () => {
    if (!activeFile) return;
    const line = codeRef.current?.currentLine();
    if (line == null) return;
    try {
      const res = await api.synctex(id, branch, { direction: 'forward', file: activeFile, line, column: 0 });
      const rec = res.records?.find((r) => r.page != null && (r.y != null || r.v != null));
      if (!rec) { toast('No PDF location for this line — typeset first', 'error'); return; }
      pdfRef.current?.showForward(Number(rec.page), Number(rec.y ?? rec.v));
    } catch {
      toast('Jump unavailable for this file', 'error');
    }
  }, [id, branch, activeFile, toast]);

  // Cmd+S → typeset, Cmd+K → command palette, Cmd+J → jump the PDF to the cursor
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        doCompile();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j' && !e.defaultPrevented && !inTextField(e.target)) {
        // CodeMirror binds Mod-j itself (and prevents default) when the editor
        // has focus; this catches the shortcut from the PDF pane, tree, etc.
        // Other text fields (comment composer, dialogs, palette) keep the
        // keystroke: a jump against the editor's cursor from there is noise.
        e.preventDefault();
        jumpToPdf();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doCompile, jumpToPdf]);

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
      { id: 'typeset', group: 'Action', title: 'Typeset document', hint: shortcut('S'), run: doCompile },
      { id: 'auto', group: 'Action', title: auto ? 'Turn auto-typeset off' : 'Turn auto-typeset on', run: toggleAuto },
      { id: 'jump-pdf', group: 'Action', title: 'Jump PDF to cursor', hint: shortcut('J'), run: () => jumpToPdf() },
      ...ENGINES.map((e) => ({ id: `engine-${e.id}`, group: 'Action', title: `Typeset with ${e.label}`, run: () => setEngine(e.id) })),
      { id: 'stop-on-error', group: 'Action', title: project?.stopOnFirstError ? 'Stop on first error: on' : 'Stop on first error: off', run: () => setStopOnFirstError(!project?.stopOnFirstError) },
      { id: 'spell', group: 'Action', title: spellcheck ? 'Turn spellcheck off' : 'Turn spellcheck on', run: () => setSpellcheck((s) => { localStorage.setItem('aldine.spellcheck', s ? '0' : '1'); return !s; }) },
      { id: 'theme', group: 'View', title: 'Toggle light/dark theme', run: () => { toggleTheme(); } },
      { id: 'settings', group: 'View', title: 'Project settings: compiler, main document, TeX Live', run: () => setSettingsOpen(true) },
      { id: 'about', group: 'View', title: 'About Aldine and its source code', run: () => setAboutOpen(true) },
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
            try {
              await api.renameFile(id, branch, activeFile, to);
            } catch (err: any) {
              toast(err.message || 'Could not rename the file', 'error');
              return;
            }
            await loadFiles();
            loadProject(); // the root designation may have moved with the rename
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
  }, [files, activeFile, id, branch, auto, spellcheck, doCompile, toggleAuto, jumpToPdf, setEngine, setStopOnFirstError, project?.stopOnFirstError, insertAtCursor, loadFiles, loadProject, toast]);

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
        <button className="btn" onClick={() => setSettingsOpen(true)} data-testid="project-settings-open" title="Project settings: compiler, main document, TeX Live">Settings</button>
        <button className="btn" onClick={startComment} data-testid="add-comment" title="Comment on the selected text">Comment</button>
        <Presence users={users} />
        <div className="toolbar__group">
          <button
            className="btn btn--primary"
            onClick={() => doCompile()}
            disabled={compile.status === 'compiling'}
            data-testid="typeset-button"
            title={`Typeset (${shortcut('S')})`}
          >
            {compile.status === 'compiling' ? <span className="spinner" /> : null}
            Typeset
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className="pane sidebar">
          <div className="sidebar__tabs" role="tablist">
            <button className={`sidebar__tab ${tab === 'files' ? 'sidebar__tab--active' : ''}`} onClick={() => setTab('files')} role="tab" data-testid="tab-files">Files</button>
            <button className={`sidebar__tab ${tab === 'history' ? 'sidebar__tab--active' : ''}`} onClick={() => setTab('history')} role="tab" data-testid="tab-history">History</button>
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
                newFileRequest={newFileRequest}
                onNewFileHandled={() => setNewFileRequest(0)}
                onCreate={async (path) => {
                  try {
                    await api.createFile(id, branch, path);
                    await loadFiles();
                    loadProject(); // the first .tex of a rootless project becomes its root
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
                  loadProject(); // deleting the root re-derives (or unsets) it
                  if (activeFile === path) setActiveFile(null);
                }}
                onRename={async (from, to) => {
                  try {
                    await api.renameFile(id, branch, from, to);
                    await loadFiles();
                    loadProject(); // the root designation may have moved with the rename
                    if (activeFile === from) setActiveFile(to);
                  } catch (err: any) {
                    toast(/already exists/i.test(err?.message) ? `"${to}" already exists` : `Could not rename: ${err.message}`, 'error');
                  }
                }}
                onSetRoot={setRootFile}
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

        <main className="pane pane--editor" style={{ flex: 1 }}>
          {activeFile ? (
            <>
              <div className="pane__header">
                <span className="statusbar__file" data-testid="active-file">{activeFile}</span>
                {visualEnabled && mode === 'visual' && <FormatToolbar target={codeRef} />}
                <span className="toolbar__spacer" />
                <button
                  className="btn btn--ghost btn--small"
                  onClick={() => jumpToPdf()}
                  title={`Show this line in the PDF (${shortcut('J')})`}
                  data-testid="jump-to-pdf"
                >
                  Jump to PDF <span className="kbd">{shortcut('J')}</span>
                </button>
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
          ) : filesLoaded && !hasFiles ? (
            <div className="pdf-empty" data-testid="empty-project">
              <p>Create a file to start writing.</p>
              <button className="btn btn--primary" data-testid="empty-new-file" onClick={() => { setTab('files'); setNewFileRequest((n) => n + 1); }}>New file</button>
            </div>
          ) : (
            <div className="pdf-empty"><p>Select a file to start writing.</p></div>
          )}
          {showErrors && (
            <div className="errors" data-testid="errors-panel">
              <div className="errors__head">
                <span>{errCount > 0 ? `${errCount} error${errCount === 1 ? '' : 's'}` : 'Problems'}</span>
                <button className="btn btn--ghost btn--small" onClick={() => setShowLog(true)} data-testid="view-log">View log</button>
              </div>
              {(() => {
                // Errors render before warnings: a failing biblatex run emits
                // 100+ citation warnings and the one actionable error must
                // never sit past the row cap.
                const ordered = [...errors].sort((a, b) => (a.type === 'error' ? 0 : 1) - (b.type === 'error' ? 0 : 1));
                const shown = ordered.slice(0, 50);
                return (
                  <>
                    {shown.map((e, i) => {
                      const hint = hintFor(e.message);
                      const file = (e as { file?: string }).file;
                      // Warnings carry no file attribution — jumping would land at
                      // a meaningless line in the root file, so they don't jump.
                      const clickable = e.line != null && (file != null || e.type === 'error');
                      const body = (
                        <>
                          <span className={`errors__badge errors__badge--${e.type}`}>{e.type === 'error' ? 'Error' : 'Warning'}</span>
                          {e.line != null && <span className="errors__line">{file ? `${file} · ` : ''}line {e.line}</span>}
                          <span className="errors__msgwrap">
                            <span className="errors__msg" title={e.message}>{e.message}</span>
                            {hint && <span className="errors__hint">{hint}</span>}
                          </span>
                        </>
                      );
                      return clickable ? (
                        <button key={i} className="errors__row" onClick={() => jumpToLine(e.line, file)}>{body}</button>
                      ) : (
                        <div key={i} className="errors__row" style={{ cursor: 'default' }}>{body}</div>
                      );
                    })}
                    {ordered.length > shown.length && (
                      <div className="errors__row" style={{ cursor: 'default' }}>
                        <span className="errors__msg">… {ordered.length - shown.length} more — open the log for the full list.</span>
                      </div>
                    )}
                  </>
                );
              })()}
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

        <section className="pane pane--preview" style={{ width: pdfWidth, flex: 'none' }}>
          <div className="pane__header">
            <span className="pane__title">Preview</span>
            <span className="pdf-status" data-testid="pdf-status" style={{ marginLeft: 10 }}>
              {compile.status === 'compiling' && hasPdf && <><span className="dot dot--busy" /> Typesetting…</>}
              {compile.status === 'ok' && compile.result && <><span className="dot dot--ok" /> Typeset in {((compile.wallMs ?? compile.result.durationMs) / 1000).toFixed(1)}s</>}
              {compile.status === 'error' && <><span className="dot dot--error" /> {errCount > 0 ? `${errCount} error${errCount === 1 ? '' : 's'}` : 'Failed'}</>}
            </span>
            <span className="toolbar__spacer" />
            <select
              className="fmt__select"
              value={ENGINES.some((e) => e.id === project.engine) ? project.engine : 'pdf'}
              onChange={(e) => setEngine(e.target.value)}
              title="Typesetting engine"
              aria-label="Typesetting engine"
              data-testid="engine-select"
            >
              {ENGINES.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
            </select>
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
                Download
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
          <PdfPane
            ref={pdfRef}
            pdfUrl={compile.result?.pdfUrl || null}
            branch={branch}
            status={compile.status}
            zoom={zoom}
            hasErrors={errCount > 0}
            stale={pdfStale}
            // The on-open typeset is auto-typeset's job — a user who turned the
            // toggle off gets the "Press ⌘S" empty state, not a surprise compile.
            // A project without a .tex has nothing to typeset.
            ready={filesLoaded}
            hasTex={hasTex}
            onFirstOpen={() => { if (autoRef.current && hasTexRef.current) doCompile(); }}
            onInverse={onPdfInverse}
          />
        </section>
      </div>

      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />

      {composing && (
        <CommentComposer quote={composing.quote} onSubmit={submitComment} onClose={() => setComposing(null)} />
      )}

      {publishOpen && project && (
        <GithubPublish projectId={id} projectName={project.name} onClose={() => setPublishOpen(false)} onLinked={() => loadProject()} />
      )}

      {aboutOpen && <About onClose={() => setAboutOpen(false)} />}

      {settingsOpen && (
        <ProjectSettings
          project={project}
          files={files}
          autoTypeset={auto}
          importNote={imported && imported.engineReason && imported.engine === project.engine ? `Set on import because of ${imported.engineReason}` : undefined}
          onClose={() => setSettingsOpen(false)}
          onRename={saveName}
          onSetRoot={setRootFile}
          onSetEngine={setEngine}
          onSetStopOnFirstError={setStopOnFirstError}
          onToggleAutoTypeset={toggleAuto}
        />
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
            <pre className="logview" data-testid="log-view">{(() => {
              const log = compile.result.log || '(no log)';
              // Open at the first error, not at the pdfTeX banner: the reason
              // for opening the log is 300 lines below the top.
              const at = log.search(/^(?:! |[^\n]*:\d+: )/m);
              if (at < 0) return log;
              const end = log.indexOf('\n', at);
              return (<>
                {log.slice(0, at)}
                <mark className="logview__hit" ref={logHit} data-testid="log-first-error">{log.slice(at, end < 0 ? undefined : end)}</mark>
                {end < 0 ? '' : log.slice(end)}
              </>);
            })()}</pre>
            <div className="modal__row">
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginRight: 'auto', fontSize: 12.5 }} title="On: the run stops at the first error and the preview keeps the previous PDF. Off: the run continues to the end and the complete PDF is shown beside the errors">
                <input type="checkbox" data-testid="stop-on-error-toggle" checked={!!project?.stopOnFirstError} onChange={(e) => setStopOnFirstError(e.target.checked)} />
                Stop on first error
              </label>
              <button className="btn" onClick={() => setShowLog(false)}>Close</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
