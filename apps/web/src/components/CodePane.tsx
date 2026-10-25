import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { wsUrl } from '../basePath';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, highlightSpecialChars, Decoration, DecorationSet } from '@codemirror/view';
import { EditorState, StateField, StateEffect, Compartment, Prec } from '@codemirror/state';
import { indentOnInput, bracketMatching, foldGutter, syntaxHighlighting, defaultHighlightStyle, HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { latex } from 'codemirror-lang-latex';
import * as Y from 'yjs';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { localUser } from '../api';
import { citeCompletionSource, refCompletionSource, citeHoverTooltip, warmBib } from '../editor/latexExtras';
import { setComments, CommentRange } from '../editor/commentsEffect';
import { visualExtensions, editAtCursor, type VisualDeps } from '../editor/visual';
import { agentHighlight } from '../editor/agentHighlight';
import { toggleStyle, setSectionLevel, toggleItemize } from '../editor/visual/commands';
import { commentRangesField } from '../editor/visual/suggestions';
import { closeBeginBrace } from '../editor/beginEnv';
import { documentOutline, OutlineEntry } from '../editor/visual/outline';
import type { PresenceUser } from './Presence';
import { useToast } from './Toast';
import type { Text } from '@codemirror/state';

export type EditorMode = 'source' | 'visual';

/**
 * Re-anchor a comment by its stored quote when its saved offset has drifted
 * (edits above it made while it wasn't being live-tracked — reload, another
 * user's edits). Uses the occurrence of the quote nearest the saved offset;
 * falls back to the clamped saved offset when the quote can't be found. With
 * `context` (a search match), an occurrence whose surrounding text still
 * reads the same is preferred: an insert above moves an earlier occurrence
 * onto the saved offset, and the nearest one is then the wrong one.
 */
function reanchor<R extends { from: number; to: number; quote?: string }>(doc: Text, r: R, context?: MatchContext): R {
  const len = doc.length;
  const from = Math.min(Math.max(0, r.from), len);
  const to = Math.min(Math.max(from, r.to), len);
  const quote = r.quote;
  if (!quote) return { ...r, from, to };
  const fits = (i: number) => !context
    || (doc.sliceString(Math.max(0, i - context.before.length), i) === context.before
      && doc.sliceString(i + quote.length, Math.min(len, i + quote.length + context.after.length)) === context.after);
  if (doc.sliceString(from, to) === quote && fits(from)) return { ...r, from, to }; // still exact
  const text = doc.toString();
  let best = -1, bestDist = Infinity;
  for (const strict of context ? [true, false] : [false]) {
    for (let i = text.indexOf(quote); i !== -1; i = text.indexOf(quote, i + 1)) {
      if (strict && !fits(i)) continue;
      const d = Math.abs(i - r.from);
      if (d < bestDist) { best = i; bestDist = d; }
    }
    if (best !== -1) break;
  }
  if (best === -1) return { ...r, from, to }; // quote gone — keep clamped offset
  return { ...r, from: best, to: best + quote.length };
}

/** The text a search showed on either side of a match, on its line. */
export interface MatchContext { before: string; after: string }

export interface CodePaneHandle {
  /** Deferred until the collab doc has synced: a fresh pane holds an empty
   *  document until then, and line N of nothing is line 1. */
  /** onClamped fires (with the line count) when `line` is past the end of the doc. */
  gotoLine(line: number, opts?: { flash?: boolean; onClamped?: (lines: number) => void }): void;
  /** Select from..to, re-anchored by `quote` (and the text around it) when
   *  edits moved it, and scroll it into view; deferred like gotoLine.
   *  Selection only: no document change. */
  selectRange(from: number, to: number, opts: { quote: string; focus: boolean; context?: MatchContext }): void;
  insertAtCursor(text: string): void;
  currentLine(): number | null;
  getSelection(): { from: number; to: number; quote: string } | null;
  setCommentRanges(ranges: CommentRange[]): void;
  revealPos(pos: number): void;
  format(action: 'bold' | 'italic' | 'list' | { section: 1 | 2 | 3 | 4 }): void;
  getOutline(): OutlineEntry[];
  /** Keyboard focus back to the text, the caret where it was. */
  focus(): void;
  /** Visual mode: opens the formula editor or the table grid at the caret. 'source': a formula
   *  that edits only as source, which the caret is already in; null: neither is at the caret. */
  editAtCursor(): 'opened' | 'source' | null;
}

/** Comment highlight decorations, updatable via an effect and tracking edits. */
const commentMark = Decoration.mark({ class: 'cm-comment-range' });
const commentResolvedMark = Decoration.mark({ class: 'cm-comment-range cm-comment-resolved' });
const commentField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setComments)) {
        const docLen = tr.state.doc.length;
        deco = Decoration.set(
          e.value
            .filter((r) => r.from < r.to && r.to <= docLen)
            .sort((a, b) => a.from - b.from)
            .map((r) => (r.resolved ? commentResolvedMark : commentMark).range(r.from, r.to)),
          true,
        );
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** One-shot line highlight for deep links (?file=&line=): a line decoration
 *  the CSS animates out; cleared by a timer, tracked through edits meanwhile. */
const FLASH_MS = 1600;
const flashLine = StateEffect.define<number>(); // doc offset of the line start
const clearFlash = StateEffect.define<null>();
const flashMark = Decoration.line({ class: 'cm-deeplink-flash', attributes: { 'data-testid': 'deeplink-flash' } });
const flashField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashLine)) deco = Decoration.set([flashMark.range(tr.state.doc.lineAt(e.value).from)]);
      else if (e.is(clearFlash)) deco = Decoration.none;
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

interface Props {
  projectId: string;
  branch: string;
  filePath: string;
  /** Project root file — figure previews resolve image paths against its dir. */
  rootFile?: string;
  onUsers(users: PresenceUser[]): void;
  /** Fires on every doc change; `local` is false for applied remote updates. */
  onDocChanged?(local: boolean): void;
  onStats?(stats: { words: number; selWords: number | null }): void;
  spellcheck?: boolean;
  mode?: EditorMode;
  /** Who this client is to collaborators (awareness): the account when
   *  signed in; without one the browser's anonymous "Writer N". */
  identity?: { name: string; color: string };
}

/** Approximate word count for LaTeX prose: strips comments, commands, math. */
export function latexWordCount(src: string): number {
  const stripped = src
    .replace(/(^|[^\\])%.*$/gm, '$1')            // comments
    .replace(/\\begin\{[^}]*\}|\\end\{[^}]*\}/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$/g, ' EQN ') // math counts as one word
    .replace(/\\[a-zA-Z@]+\*?(\[[^\]]*\])*/g, ' ')   // commands (keep brace contents)
    .replace(/[{}~]/g, ' ');
  const words = stripped.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu);
  return words ? words.length : 0;
}

/** Calm, ink-blue syntax palette that flips with the color scheme via CSS vars. */
const aldineHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.tagName, t.macroName, t.function(t.variableName)], color: 'var(--syn-command)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.string, t.attributeValue, t.inserted], color: 'var(--syn-string)' },
  { tag: [t.number, t.literal, t.bool, t.escape], color: 'var(--syn-value)' },
  { tag: [t.labelName, t.typeName, t.attributeName], color: 'var(--syn-value)' },
  { tag: [t.heading], fontWeight: '600', color: 'var(--text)' },
  { tag: [t.link, t.url], color: 'var(--accent)' },
  { tag: [t.processingInstruction, t.meta, t.bracket], color: 'var(--text-2)' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
]);

const aldineTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--bg-panel)', color: 'var(--text)' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--selection) !important' },
  // remote collaborator caret + always-visible name label (y-codemirror.next)
  '.cm-ySelectionCaret': { position: 'relative', borderLeftWidth: '1.5px', borderRightWidth: '1.5px', marginLeft: '-1px', marginRight: '-1px', boxSizing: 'border-box' },
  '.cm-ySelectionInfo': {
    position: 'absolute', top: '-1.35em', left: '-1px', fontSize: '10px', fontWeight: '600', lineHeight: 'normal',
    color: '#fff', padding: '1px 5px', borderRadius: '4px 4px 4px 0', whiteSpace: 'nowrap', opacity: '1',
    userSelect: 'none', pointerEvents: 'none', zIndex: '20', fontFamily: 'var(--font-sans)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--bg-panel)',
    border: '1px solid var(--hairline)',
    borderRadius: '8px',
    boxShadow: 'var(--shadow-pop)',
    fontFamily: 'var(--font-ui)',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent-fill)', color: 'var(--on-accent)' },
  '.cm-completionDetail': { fontStyle: 'normal', opacity: 0.65, fontSize: '11px' },
  '.cm-panels': { backgroundColor: 'var(--bg-inset)', color: 'var(--text)', borderColor: 'var(--hairline)' },
});

/** Spellcheck is presentation config, swapped at runtime via a Compartment. */
function spellcheckAttrs(spellcheck: boolean, filePath: string) {
  return EditorView.contentAttributes.of({
    spellcheck: spellcheck && /\.(tex|md|txt)$/i.test(filePath) ? 'true' : 'false',
    autocorrect: 'off',
    autocapitalize: 'off',
  });
}

const CodePane = forwardRef<CodePaneHandle, Props>(function CodePane({ projectId, branch, filePath, rootFile, onUsers, onDocChanged, onStats, spellcheck = false, mode = 'source', identity }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const cbRef = useRef({ onDocChanged, onStats });
  cbRef.current = { onDocChanged, onStats };
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  // Per-mount reconfiguration handles: compartments + the deps visualExtensions needs.
  const reconfRef = useRef<{ modeComp: Compartment; spellComp: Compartment; deps: VisualDeps } | null>(null);
  const lastCommentRanges = useRef<CommentRange[]>([]);
  const syncedRef = useRef(false);
  const pendingGoto = useRef<
    | { kind: 'line'; line: number; flash: boolean; onClamped?: (lines: number) => void }
    | { kind: 'range'; from: number; to: number; quote: string; focus: boolean; context?: MatchContext }
    | null
  >(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyRange = (view: EditorView, from: number, to: number, quote: string, focus: boolean, context?: MatchContext) => {
    const r = reanchor(view.state.doc, { from, to, quote }, context);
    view.dispatch({ selection: { anchor: r.from, head: r.to }, effects: EditorView.scrollIntoView(r.from, { y: 'center' }) });
    if (focus) view.focus();
  };

  const applyGoto = (view: EditorView, line: number, flash: boolean, onClamped?: (lines: number) => void) => {
    const l = Math.min(Math.max(1, line), view.state.doc.lines);
    if (line > view.state.doc.lines) onClamped?.(view.state.doc.lines);
    const pos = view.state.doc.line(l).from;
    const effects = [EditorView.scrollIntoView(pos, { y: 'center' }), ...(flash ? [flashLine.of(pos)] : [])];
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true, effects });
    view.focus();
    if (flash) {
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => {
        flashTimer.current = null;
        if (viewRef.current === view) view.dispatch({ effects: clearFlash.of(null) });
      }, FLASH_MS);
    }
  };

  useImperativeHandle(ref, () => ({
    gotoLine(line: number, opts?: { flash?: boolean; onClamped?: (lines: number) => void }) {
      const view = viewRef.current;
      // Before the view exists (handle is live from the first commit, the
      // view from the mount effect) or before the doc has synced: queue it.
      if (!view || !syncedRef.current) { pendingGoto.current = { kind: 'line', line, flash: !!opts?.flash, onClamped: opts?.onClamped }; return; }
      applyGoto(view, line, !!opts?.flash, opts?.onClamped);
    },
    selectRange(from: number, to: number, opts: { quote: string; focus: boolean; context?: MatchContext }) {
      const view = viewRef.current;
      if (!view || !syncedRef.current) { pendingGoto.current = { kind: 'range', from, to, quote: opts.quote, focus: opts.focus, context: opts.context }; return; }
      applyRange(view, from, to, opts.quote, opts.focus, opts.context);
    },
    insertAtCursor(text: string) {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch(view.state.replaceSelection(text));
      view.focus();
    },
    currentLine() {
      const view = viewRef.current;
      if (!view) return null;
      return view.state.doc.lineAt(view.state.selection.main.head).number;
    },
    getSelection() {
      const view = viewRef.current;
      if (!view) return null;
      const sel = view.state.selection.main;
      if (sel.empty) return null;
      return { from: sel.from, to: sel.to, quote: view.state.sliceDoc(sel.from, sel.to) };
    },
    setCommentRanges(ranges) {
      lastCommentRanges.current = ranges; // remember for a re-apply once the doc syncs
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({ effects: setComments.of(ranges.map((r) => reanchor(view.state.doc, r))) });
    },
    revealPos(pos) {
      const view = viewRef.current;
      if (!view) return;
      const p = Math.min(Math.max(0, pos), view.state.doc.length);
      view.dispatch({ selection: { anchor: p }, effects: EditorView.scrollIntoView(p, { y: 'center' }) });
      view.focus();
    },
    format(action) {
      const view = viewRef.current;
      if (!view) return;
      if (action === 'bold') toggleStyle('bold')(view);
      else if (action === 'italic') toggleStyle('italic')(view);
      else if (action === 'list') toggleItemize(view);
      else setSectionLevel(action.section)(view);
      view.focus();
    },
    getOutline() {
      const view = viewRef.current;
      return view ? documentOutline(view.state) : [];
    },
    focus() {
      viewRef.current?.focus();
    },
    editAtCursor() {
      const view = viewRef.current;
      return view ? editAtCursor(view) : null;
    },
  }), []);

  useEffect(() => {
    if (!hostRef.current) return;
    let statsTimer: ReturnType<typeof setTimeout> | null = null;
    warmBib(projectId, branch); // so \cite hover tooltips have data immediately
    const docName = `${projectId}::${branch}::${filePath}`;
    const ydoc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: wsUrl('/collab'),
      name: docName,
      document: ydoc,
      // When auth is enabled the server defines onAuthenticate, which makes
      // Hocuspocus require a token before it loads the doc. The real credential
      // is the HttpOnly session cookie (sent with the WS handshake and validated
      // server-side); this token is just the non-empty trigger. Harmless when
      // auth is off (no hook → ignored).
      token: 'aldine-session',
    });
    const ytext = ydoc.getText('content');
    // Doc-change notifications come from the Y level, not the CM update
    // listener: tr.local distinguishes this client's edits from applied remote
    // updates, so auto-typeset can react to typing without every collaborator
    // recompiling on every remote keystroke.
    const onYChange = (_e: unknown, tr: { local: boolean }) => cbRef.current.onDocChanged?.(tr.local);
    ytext.observe(onYChange);
    const user = identity ?? localUser();
    provider.setAwarenessField('user', { name: user.name, color: user.color, colorLight: user.color + '55' });

    const awareness = provider.awareness!;
    const modeComp = new Compartment();
    const spellComp = new Compartment();
    const deps: VisualDeps = { projectId, branch, rootFile, ydoc, awareness, notify: (text) => toastRef.current(text, 'error') };
    // First-seen times per agent client, so the presence tooltip can say when
    // the session started; entries drop with the awareness state so the next
    // session (same server-side clientID) gets a fresh start time. A start
    // time the server sends wins: it predates this page's load.
    const agentSince = new Map<number, number>();
    const reportUsers = () => {
      // key by Yjs clientID so two collaborators with the same display name stay distinct
      const byClient = new Map<number, PresenceUser>();
      awareness.getStates().forEach((s, clientId) => {
        const u = (s as { user?: PresenceUser }).user;
        if (!u?.name) return;
        if (u.isAgent && !agentSince.has(clientId)) agentSince.set(clientId, Date.now());
        byClient.set(clientId, u.isAgent ? { ...u, startedAt: u.startedAt ?? agentSince.get(clientId) } : u);
      });
      for (const cid of [...agentSince.keys()]) if (!byClient.has(cid)) agentSince.delete(cid);
      onUsers(Array.from(byClient.values()));
    };
    awareness.on('change', reportUsers);
    reportUsers();

    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          foldGutter(),
          drawSelection(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          syntaxHighlighting(aldineHighlight),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          bracketMatching(),
          closeBrackets(),
          rectangularSelection(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          autocompletion(),
          // enableAutocomplete:false skips the package's autocompletion({override}) which
          // would disable ALL languageData sources (incl. our cite/ref completions);
          // its builtin command completions still register via languageData.
          // enableTooltips:false so our richer \cite hover (reference preview) is the only hover
          latex({ autoCloseTags: true, enableLinting: false, enableAutocomplete: false, enableTooltips: false }),
          Prec.high(keymap.of([{ key: '}', run: closeBeginBrace }])),
          citeCompletionSource(projectId, branch),
          refCompletionSource(projectId, branch, () => filePath),
          citeHoverTooltip(projectId, branch),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...yUndoManagerKeymap,
            ...completionKeymap,
            indentWithTab,
            { key: 'Mod-b', run: toggleStyle('bold') },
            { key: 'Mod-i', run: toggleStyle('italic') },
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged || u.selectionSet) {
              if (statsTimer) clearTimeout(statsTimer);
              statsTimer = setTimeout(() => {
                const state = viewRef.current?.state;
                if (!state || !cbRef.current.onStats) return;
                const sel = state.selection.main;
                cbRef.current.onStats({
                  words: latexWordCount(state.doc.toString()),
                  selWords: sel.empty ? null : latexWordCount(state.sliceDoc(sel.from, sel.to)),
                });
              }, 350);
            }
          }),
          commentField,
          // outside the mode compartment: Visual's inline suggestions read it when they mount
          commentRangesField,
          flashField,
          aldineTheme,
          EditorView.lineWrapping,
          // browser-native spellcheck on prose (only meaningful for .tex/.md)
          spellComp.of(spellcheckAttrs(spellcheck, filePath)),
          EditorView.contentAttributes.of({ 'aria-label': `Text of ${filePath}` }),
          modeComp.of(mode === 'visual' ? visualExtensions(deps) : []),
          yCollab(ytext, provider.awareness),
          // after yCollab on purpose — see agentHighlight's ordering contract
          ...(localStorage.getItem('aldine.experimental.agentPresence') === '1'
            ? [agentHighlight(ytext, awareness)]
            : []),
        ],
      }),
    });
    viewRef.current = view;
    reconfRef.current = { modeComp, spellComp, deps };

    syncedRef.current = false;
    const initialStats = () => {
      syncedRef.current = true;
      const goto = pendingGoto.current;
      pendingGoto.current = null;
      if (goto?.kind === 'line') applyGoto(view, goto.line, goto.flash, goto.onClamped);
      else if (goto?.kind === 'range') applyRange(view, goto.from, goto.to, goto.quote, goto.focus, goto.context);
      cbRef.current.onStats?.({ words: latexWordCount(view.state.doc.toString()), selWords: null });
      // Re-anchor comments against the now-populated doc: a push that arrived
      // before the Yjs sync ran against an empty document.
      if (lastCommentRanges.current.length) {
        view.dispatch({ effects: setComments.of(lastCommentRanges.current.map((r) => reanchor(view.state.doc, r))) });
      }
    };
    provider.on('synced', initialStats);

    return () => {
      if (statsTimer) clearTimeout(statsTimer);
      if (flashTimer.current) { clearTimeout(flashTimer.current); flashTimer.current = null; }
      pendingGoto.current = null;
      ytext.unobserve(onYChange);
      provider.off('synced', initialStats);
      awareness.off('change', reportUsers);
      view.destroy();
      provider.destroy();
      ydoc.destroy();
      viewRef.current = null;
      reconfRef.current = null;
    };
  }, [projectId, branch, filePath]);

  // Mode and spellcheck are presentation-only: swap them at runtime through
  // compartments so the Yjs doc, collab socket, scroll, and cursor survive.
  useEffect(() => {
    const view = viewRef.current, rc = reconfRef.current;
    if (!view || !rc) return;
    view.dispatch({ effects: rc.modeComp.reconfigure(mode === 'visual' ? visualExtensions(rc.deps) : []) });
  }, [mode]);
  useEffect(() => {
    const view = viewRef.current, rc = reconfRef.current;
    if (!view || !rc) return;
    view.dispatch({ effects: rc.spellComp.reconfigure(spellcheckAttrs(spellcheck, filePath)) });
  }, [spellcheck, filePath]);

  return <div ref={hostRef} className="code-pane" data-testid="code-pane" />;
});

export default CodePane;
