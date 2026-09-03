import { useEffect, useRef, useState } from 'react';
import { api, CompilerInfo, ProjectSummary, TreeEntry } from '../api';
import Modal from './Modal';
import { ENGINES, texliveLabel } from '../util/engines';

interface Props {
  project: Pick<ProjectSummary, 'id' | 'name' | 'rootFile' | 'engine' | 'stopOnFirstError'>;
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
  onToggleAutoTypeset(): void;
}

/**
 * The permanent home of the project's compile options (the preview header's
 * engine picker and the log dialog's stop-on-error box are shortcuts to the
 * same state). Every change saves on its own; there is no Save button.
 */
export default function ProjectSettings({ project, files, autoTypeset, importNote, onClose, onRename, onSetRoot, onSetEngine, onSetStopOnFirstError, onToggleAutoTypeset }: Props) {
  const [name, setName] = useState(project.name);
  const [compiler, setCompiler] = useState<CompilerInfo | null>(null);
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
    <Modal onClose={close} label="Project settings" testId="project-settings" width={520}>
      <div>
        <h2>Project settings</h2>
        <p className="modal__sub">Changes save as you make them.</p>

        <div className="settings__row">
          <label className="settings__label" htmlFor="settings-name">Name</label>
          <input
            id="settings-name"
            className="input settings__control"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            data-testid="settings-name"
          />
        </div>

        <section data-testid="compiler-settings">
          <div className="menu__label" style={{ margin: '18px 0 4px', padding: 0 }}>Compiler</div>

          <div className="settings__row">
            <label className="settings__label" htmlFor="settings-root-file">Main document</label>
            <select
              id="settings-root-file"
              className="input settings__control"
              value={project.rootFile}
              onChange={(e) => onSetRoot(e.target.value)}
              data-testid="settings-root-file"
            >
              {rootOptions.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>

          <div className="settings__row">
            <label className="settings__label" htmlFor="settings-engine">Compiler</label>
            <select
              id="settings-engine"
              className="input settings__control"
              value={engine}
              onChange={(e) => onSetEngine(e.target.value)}
              data-testid="settings-engine"
            >
              {ENGINES.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
            </select>
          </div>
          {importNote && (
            <div className="settings__row">
              <span className="settings__label" />
              <span className="settings__hint" data-testid="settings-engine-note">{importNote}</span>
            </div>
          )}

          <div className="settings__row">
            <span className="settings__label">TeX Live</span>
            <span data-testid="settings-texlive" title="Release and scheme of the compiler this server talks to">{texliveLabel(compiler)}</span>
          </div>

          <div className="settings__row">
            <label className="settings__label" htmlFor="settings-stop-on-error">Stop on first error</label>
            <span className="settings__control settings__control--check">
              <input
                id="settings-stop-on-error"
                type="checkbox"
                checked={!!project.stopOnFirstError}
                onChange={(e) => onSetStopOnFirstError(e.target.checked)}
                data-testid="settings-stop-on-error"
              />
              <span className="settings__hint">{project.stopOnFirstError ? 'The run stops at the first error and keeps the previous PDF' : 'The run continues to the end and lists the errors beside the PDF'}</span>
            </span>
          </div>

          <div className="settings__row">
            <label className="settings__label" htmlFor="settings-auto-typeset">Auto-typeset</label>
            <span className="settings__control settings__control--check">
              <input
                id="settings-auto-typeset"
                type="checkbox"
                checked={autoTypeset}
                onChange={onToggleAutoTypeset}
                data-testid="settings-auto-typeset"
              />
              <span className="settings__hint">{autoTypeset ? 'Typesets shortly after you stop typing, on this browser' : 'Typeset by hand only, on this browser'}</span>
            </span>
          </div>
        </section>

        <div className="modal__row">
          <button className="btn" onClick={close} data-testid="settings-close">Close</button>
        </div>
      </div>
    </Modal>
  );
}
