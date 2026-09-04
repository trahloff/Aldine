import { useRef } from 'react';
import Modal from './Modal';
import { shortcut } from '../platform';
/** First-run welcome shown once (localStorage-gated by the parent). */
export default function Onboarding({ onNew, onGithub, onImportZip, onClose }: {
  onNew(): void; onGithub(): void; onImportZip(file: File): void; onClose(): void;
}) {
  const start = (fn: () => void) => { onClose(); fn(); };
  // A <label> around a hidden file input is not focusable, so the tile was
  // mouse-only; a button that opens the input keeps it on the tab order.
  const zipInput = useRef<HTMLInputElement>(null);

  return (
    <Modal onClose={onClose} label="Welcome to Aldine" testId="onboarding" wide>
      <div className="onboard">
        <h1 className="home__brand" style={{ fontSize: 30, marginBottom: 2 }}>aldine<em>.</em></h1>
        <p className="home__tag" style={{ marginBottom: 20 }}>Write LaTeX together — fast, versioned, yours.</p>

        <div className="onboard__tiles">
          <button className="onboard__tile" onClick={() => start(onNew)} data-testid="onboard-new">
            <span className="onboard__tile-title">Start a paper</span>
            <span className="onboard__tile-sub">A blank doc or a template.</span>
          </button>
          <button className="onboard__tile onboard__tile--gh" onClick={() => start(onGithub)} data-testid="onboard-github">
            <span className="onboard__tile-title">Import from GitHub</span>
            <span className="onboard__tile-sub">Clone a repo, then push &amp; pull as you write.</span>
          </button>
          <button className="onboard__tile" data-testid="onboard-zip" onClick={() => zipInput.current?.click()}>
            <span className="onboard__tile-title">Import a ZIP</span>
            <span className="onboard__tile-sub">Bring a project over from Overleaf.</span>
          </button>
          <input ref={zipInput} type="file" accept=".zip" hidden aria-hidden="true" tabIndex={-1}
            onChange={(e) => { if (e.target.files?.[0]) { const f = e.target.files[0]; onClose(); onImportZip(f); } }} />
        </div>

        <ul className="onboard__points">
          <li><strong>Typeset</strong> with {shortcut('S')} — errors jump to the line; double-click the PDF to jump back.</li>
          <li><strong>Collaborate</strong> live — invite others, see their cursors, leave anchored comments.</li>
          <li><strong>Version</strong> everything — branches, checkpoints, and full GitHub sync.</li>
        </ul>

        <div className="modal__row" style={{ justifyContent: 'center', marginTop: 4 }}>
          <button className="btn btn--primary" onClick={onClose} data-testid="onboard-dismiss">Get started</button>
        </div>
      </div>
    </Modal>
  );
}
