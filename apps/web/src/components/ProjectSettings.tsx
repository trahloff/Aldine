import { ReactNode, useEffect, useRef, useState } from 'react';
import { api, CompilerInfo, ProjectSummary, TreeEntry } from '../api';
import Modal from './Modal';
import { ENGINES, texliveLabel } from '../util/engines';
import { Appearance, APPEARANCES, setAppearance, useAppearance } from '../theme';
import { chordConflict, chordFromEvent, chordProblem, isDefaultChord, setChord, ShortcutId, SHORTCUTS, useShortcutLabel } from '../util/shortcuts';

interface Props {
  project: Pick<ProjectSummary, 'id' | 'name' | 'rootFile' | 'engine' | 'stopOnFirstError' | 'manualCommits'>;
  files: TreeEntry[];
  /** The auto-typeset switch lives in localStorage, not in the project. */
  autoTypeset: boolean;
  /** Shown under the compiler picker right after an import: where the choice came from. */
  importNote?: string;
  onClose(): void;
  onRename(name: string): Promise<void>;
  onSetRoot(path: string): Promise<void>;
  onSetEngine(engine: string): Promise<void>;
  onSetStopOnFirstError(on: boolean): Promise<void>;
  onSetManualCommits(on: boolean): Promise<void>;
  onToggleAutoTypeset(): void;
  /** Opened from the palette's shortcut command: scroll to that section. */
  focus?: 'shortcuts';
}

/** Label and explanation on the left, the control in one column on the right. */
function Row({ label, htmlFor, hint, hintTestId, hintError, children }: { label: string; htmlFor?: string; hint?: ReactNode; hintTestId?: string; hintError?: boolean; children: ReactNode }) {
  return (
    <div className="settings__row">
      <div className="settings__text">
        {htmlFor ? <label className="settings__label" htmlFor={htmlFor}>{label}</label> : <span className="settings__label">{label}</span>}
        {hint && <span className={`settings__hint${hintError ? ' settings__hint--error' : ''}`} data-testid={hintTestId}>{hint}</span>}
      </div>
      <div className="settings__control">{children}</div>
    </div>
  );
}

/** Click the keys, press new ones; Esc keeps the old ones. */
function ShortcutRow({ id, label }: { id: ShortcutId; label: string }) {
  const keys = useShortcutLabel(id);
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const stop = () => { setRecording(false); setProblem(null); };
  useEffect(() => {
    if (!recording) return;
    // Window capture runs before the dialog's Escape and the editor's own
    // shortcuts, so the chord being recorded does nothing else. Keyup too:
    // Space would otherwise click the button on release.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) { stop(); return; }
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'keyup') return;
      if (e.key === 'Escape') { stop(); return; }
      const chord = chordFromEvent(e);
      if (!chord) return;
      const why = chordProblem(chord, id);
      if (why) { setProblem(why); return; }
      setChord(id, chord);
      stop();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
    };
  }, [recording, id]);

  const clash = recording ? null : chordConflict(id);
  const clashHint = clash ? `${keys} is also ${clash} — change one of them` : null;
  return (
    <Row label={label} hint={problem ?? clashHint ?? (recording ? 'Press the new keys · Esc keeps these' : undefined)} hintTestId={`shortcut-hint-${id}`} hintError={!!(problem || clashHint)}>
      <button
        type="button"
        className={`input shortcut${recording ? ' is-recording' : ''}`}
        onClick={() => (recording ? stop() : setRecording(true))}
        onBlur={stop}
        aria-label={`${label}: ${keys}. Press to change`}
        data-testid={`shortcut-${id}`}
      >
        {recording ? 'Press keys…' : <kbd className="kbd">{keys}</kbd>}
      </button>
      {!isDefaultChord(id) && (
        <button type="button" className="btn btn--small shortcut__reset" onClick={() => setChord(id, null)} title="Use the default keys" data-testid={`shortcut-reset-${id}`}>Reset</button>
      )}
    </Row>
  );
}

/**
 * The permanent home of the project's compile options (the palette's engine
 * commands and the log dialog's stop-on-error box are shortcuts to the same
 * state). What is stored with the project comes first; what this browser
 * remembers on its own is kept apart. Every change saves on its own; there is
 * no Save button.
 */
export default function ProjectSettings({ project, files, autoTypeset, importNote, onClose, onRename, onSetRoot, onSetEngine, onSetStopOnFirstError, onSetManualCommits, onToggleAutoTypeset, focus }: Props) {
  const [name, setName] = useState(project.name);
  const appearance = useAppearance();
  const [compiler, setCompiler] = useState<CompilerInfo | null>(null);
  const shortcutsRef = useRef<HTMLElement>(null);
  useEffect(() => { if (focus === 'shortcuts') shortcutsRef.current?.scrollIntoView({ block: 'nearest' }); }, [focus]);
  useEffect(() => {
    let live = true;
    api.compilerInfo()
      .then((info) => { if (live) setCompiler(info); })
      .catch(() => { if (live) setCompiler({ ok: false, texlive: { release: 'unknown', scheme: 'unknown' } }); });
    return () => { live = false; };
  }, []);

  const texFiles = files.filter((f) => f.type === 'file' && /\.tex$/i.test(f.path)).map((f) => f.path);
  // A root that is not in the tree (deleted on this branch, or not a .tex
  // file) must still be selectable, or the select would show the wrong file.
  const rootOptions = texFiles.includes(project.rootFile) ? texFiles : [project.rootFile, ...texFiles];
  const engine = ENGINES.some((e) => e.id === project.engine) ? project.engine : 'pdf';

  // Escape unmounts the dialog without a blur, so the close path commits too;
  // the ref keeps blur-then-close from sending the same rename twice.
  const committed = useRef(project.name);
  const commitName = () => {
    const next = name.trim();
    if (!next || next === committed.current) { setName(committed.current); return; }
    committed.current = next;
    onRename(next).catch(() => { committed.current = project.name; setName(project.name); });
  };
  const close = () => { commitName(); onClose(); };

  return (
    <Modal onClose={close} label="Project settings" testId="project-settings" width={560}>
      <div>
        <h2>Project settings</h2>
        <p className="modal__sub">Changes save as you make them.</p>

        <section className="settings__section" data-testid="settings-this-project">
          <div className="menu__label settings__heading">This project</div>
          <Row label="Name" htmlFor="settings-name">
            <input
              id="settings-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              data-testid="settings-name"
            />
          </Row>
          <Row label="Main document" htmlFor="settings-root-file" hint="The file a typeset starts from">
            <select
              id="settings-root-file"
              className="input"
              value={project.rootFile}
              onChange={(e) => onSetRoot(e.target.value)}
              data-testid="settings-root-file"
            >
              {rootOptions.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Row>
          <Row label="Compiler" htmlFor="settings-engine" hint={importNote} hintTestId="settings-engine-note">
            <select
              id="settings-engine"
              className="input"
              value={engine}
              onChange={(e) => onSetEngine(e.target.value)}
              data-testid="settings-engine"
            >
              {ENGINES.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
            </select>
          </Row>
          <Row label="TeX Live" hint="Set by this server">
            <span className="settings__value" data-testid="settings-texlive" title="Release and scheme of the compiler this server talks to">{texliveLabel(compiler)}</span>
          </Row>
          <Row
            label="Stop on first error"
            htmlFor="settings-stop-on-error"
            hint={project.stopOnFirstError ? 'The run stops at the first error and keeps the previous PDF' : 'The run continues to the end and lists the errors beside the PDF'}
          >
            <input
              id="settings-stop-on-error"
              type="checkbox"
              checked={!!project.stopOnFirstError}
              onChange={(e) => onSetStopOnFirstError(e.target.checked)}
              data-testid="settings-stop-on-error"
            />
          </Row>
          <Row
            label="Commit changes"
            htmlFor="settings-commit-mode"
            hint={project.manualCommits ? 'Edits are saved, and wait in History for a commit with your message' : 'Every pause in typing becomes an autosave commit'}
          >
            <select
              id="settings-commit-mode"
              className="input"
              value={project.manualCommits ? 'manual' : 'auto'}
              onChange={(e) => onSetManualCommits(e.target.value === 'manual')}
              data-testid="settings-commit-mode"
            >
              <option value="auto">Automatically</option>
              <option value="manual">When I commit</option>
            </select>
          </Row>
        </section>

        <section className="settings__section" data-testid="settings-this-browser">
          <div className="menu__label settings__heading">This browser</div>
          <Row
            label="Auto-typeset"
            htmlFor="settings-auto-typeset"
            hint={autoTypeset ? 'Typesets shortly after you stop typing' : 'Typeset by hand only'}
          >
            <input
              id="settings-auto-typeset"
              type="checkbox"
              checked={autoTypeset}
              onChange={onToggleAutoTypeset}
              data-testid="settings-auto-typeset"
            />
          </Row>
          <Row label="Appearance" htmlFor="settings-theme">
            <select
              id="settings-theme"
              className="input"
              value={appearance}
              onChange={(e) => setAppearance(e.target.value as Appearance)}
              data-testid="settings-theme"
            >
              {APPEARANCES.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </Row>
        </section>

        <section className="settings__section" data-testid="settings-shortcuts" ref={shortcutsRef}>
          <div className="menu__label settings__heading">Keyboard shortcuts in this browser</div>
          {SHORTCUTS.map((s) => <ShortcutRow key={s.id} id={s.id} label={s.label} />)}
        </section>

        <div className="modal__row">
          <button className="btn" onClick={close} data-testid="settings-close">Close</button>
        </div>
      </div>
    </Modal>
  );
}
