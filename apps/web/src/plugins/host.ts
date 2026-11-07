import { useEffect, useRef } from 'react';
import { withBase } from '../basePath';

/**
 * Aldine plugin host.
 * Plugins are ES modules served from /plugins/<id>/<entry> exporting:
 *   export default { activate(aldine: AldineAPI): void }
 * The API is intentionally small and stable; panels render vanilla DOM.
 */

export interface PluginPanel {
  id: string;
  title: string;
  mount(el: HTMLElement): void;
  /** Called each time the panel comes into view. */
  onShow?(): void;
}

/** A question the app asks in its own dialog; see AldineAPI.ui.confirm. */
export interface PluginConfirm {
  title: string;
  body?: string;
  /** Names the action: "Unlink", not "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Destroys something or cannot be taken back: a red button, and Enter takes the way out. */
  danger?: boolean;
}

/** A button a plugin adds to the header of the errors list. */
export interface PluginErrorsAction {
  id: string;
  label: string;
  title?: string;
  run(): void;
}

/** `explicit`: someone asked for this typeset (Typeset, ⌘S, the palette, a
 *  plugin), as opposed to auto-typeset, the run a project opens with, or a
 *  co-author's or an agent's run. */
type LastCompile = { ok: boolean; errors: Array<{ type: string; line: number | null; message: string; file?: string }>; log: string; explicit: boolean } | null;

/** A command a plugin adds to the editor's command palette. */
export interface PluginCommand {
  id: string;
  title: string;
  /** The palette section it is listed under; "Plugins" by default. */
  group?: string;
  keywords?: string;
  run(): void;
}

export interface PluginCtx {
  projectId: string;
  branch: string;
  getActiveFile(): string | null;
  getCompileResult(): LastCompile;
  insertAtCursor(text: string): void;
  insertCitation(key: string): CitationResult;
  refreshFiles(): Promise<unknown>;
  refreshProject(): Promise<unknown>;
  compile(): void;
  toast(text: string, kind?: 'info' | 'error' | 'ok'): void;
  /** `reveal`: also show a hidden sidebar. */
  showPanel(id: string, reveal?: boolean): void;
  confirm(o: PluginConfirm): Promise<boolean>;
}

/** What citing a key did: a new \cite, a key added to the citation at the
 *  cursor, a citation that has it already, or false when no TeX file is open
 *  in the editor to cite it in. */
export type CitationResult = 'inserted' | 'added' | 'present' | false;

export interface AldineAPI {
  version: 1;
  project: {
    readonly id: string;
    readonly branch: string;
    activeFile(): string | null;
    lastCompile(): LastCompile;
    refreshFiles(): Promise<unknown>;
    refresh(): Promise<unknown>;
    /**
     * Calls `listener` each time the editor has re-read the branch's file
     * list: after a file is added, removed, renamed or rewritten here, in
     * another tab, by a collaborator or on the server (an import, a sync, a
     * pull). Returns a function that stops the calls.
     */
    onFilesChanged(listener: () => void): () => void;
  };
  editor: {
    insertAtCursor(text: string): void;
    /** Cite `key` at the cursor of the open TeX file: in the citation there, else as \cite{key}. */
    insertCitation(key: string): CitationResult;
  };
  compile(): void;
  toast(text: string, kind?: 'info' | 'error' | 'ok'): void;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  ui: {
    /** `render` runs once, when the panel is first shown; `onShow` each time
     *  it comes into view, which is the moment to re-read what may have changed. */
    registerSidebarPanel(panel: { id: string; title: string; render(el: HTMLElement): void; onShow?(): void }): void;
    /** Select one of this plugin's panels by the id it registered. A hidden
     *  sidebar is shown too, unless `reveal` is false. */
    showPanel(id: string, opts?: { reveal?: boolean }): void;
    /** Add a button to the header of the errors list, shown while the last
     *  typeset failed. */
    registerErrorsAction(action: { id: string; label: string; title?: string; run(): void }): void;
    /** Add a command to the editor's command palette. */
    registerCommand(command: PluginCommand): void;
    /** Ask in the app's own dialog. Resolves true when confirmed; false on the
     *  way out, Escape or a click outside. */
    confirm(o: PluginConfirm): Promise<boolean>;
  };
}

interface Props {
  ctx: PluginCtx;
  onPanels(panels: PluginPanel[]): void;
  onErrorsActions?(actions: PluginErrorsAction[]): void;
  onCommands?(commands: PluginCommand[]): void;
  /** The branch's file list; a new value each time the editor re-reads it. */
  files: unknown;
}

export function PluginHost({ ctx, onPanels, onErrorsActions, onCommands, files }: Props) {
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const filesListeners = useRef(new Set<() => void>());

  useEffect(() => {
    let cancelled = false;
    const panels: PluginPanel[] = [];
    const actions: PluginErrorsAction[] = [];
    const commands: PluginCommand[] = [];
    const listeners = new Set<() => void>();
    filesListeners.current = listeners;

    const api: AldineAPI = {
      version: 1,
      project: {
        get id() { return ctxRef.current.projectId; },
        get branch() { return ctxRef.current.branch; },
        activeFile: () => ctxRef.current.getActiveFile(),
        lastCompile: () => ctxRef.current.getCompileResult(),
        refreshFiles: () => ctxRef.current.refreshFiles(),
        refresh: () => ctxRef.current.refreshProject(),
        onFilesChanged: (listener) => {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
      },
      editor: {
        insertAtCursor: (t) => ctxRef.current.insertAtCursor(t),
        insertCitation: (key) => ctxRef.current.insertCitation(key),
      },
      compile: () => ctxRef.current.compile(),
      toast: (t, k) => ctxRef.current.toast(t, k),
      // plugins address the API root-relatively; the base path is the host's concern
      fetch: (url, init) => fetch(url.startsWith('/') ? withBase(url) : url, init),
      ui: {
        registerSidebarPanel(panel) {
          const onShow = typeof panel.onShow === 'function'
            ? () => { try { panel.onShow!(); } catch (err) { console.error(`[plugins] ${panel.id}: onShow failed`, err); } }
            : undefined;
          panels.push({ id: `plugin:${panel.id}`, title: panel.title, mount: (el) => panel.render(el), onShow });
        },
        showPanel: (panelId, opts) => ctxRef.current.showPanel(`plugin:${panelId}`, opts?.reveal !== false),
        registerErrorsAction(action) {
          actions.push({ id: action.id, label: action.label, title: action.title, run: () => action.run() });
        },
        registerCommand(command) {
          if (command && typeof command.run === 'function' && command.id && command.title) commands.push(command);
        },
        confirm: (o) => {
          if (!o || typeof o.title !== 'string' || typeof o.confirmLabel !== 'string') return Promise.reject(new TypeError('confirm needs a title and a confirmLabel'));
          return ctxRef.current.confirm({ title: o.title, body: o.body, confirmLabel: o.confirmLabel, cancelLabel: o.cancelLabel, danger: !!o.danger });
        },
      },
    };

    (async () => {
      try {
        const res = await fetch(withBase('/api/plugins'));
        const manifests = (await res.json()) as Array<{ id: string; entry: string; enabled?: boolean }>;
        for (const m of manifests) {
          if (m.enabled === false) continue;
          try {
            const mod = await import(/* @vite-ignore */ withBase(`/plugins/${m.id}/${m.entry}`));
            mod.default?.activate?.(api);
          } catch (err) {
            console.error(`[plugins] failed to load ${m.id}`, err);
          }
        }
        if (!cancelled) { onPanels([...panels]); onErrorsActions?.([...actions]); onCommands?.([...commands]); }
      } catch (err) {
        console.error('[plugins] registry unavailable', err);
      }
    })();

    return () => { cancelled = true; listeners.clear(); onPanels([]); onErrorsActions?.([]); onCommands?.([]); };
    // re-activate per project/branch so panels rebuild against fresh context
  }, [ctx.projectId, ctx.branch]);

  useEffect(() => {
    for (const listener of [...filesListeners.current]) {
      try { listener(); } catch (err) { console.error('[plugins] onFilesChanged listener failed', err); }
    }
  }, [files]);

  return null;
}
