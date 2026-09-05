import { useEffect, useState } from 'react';
import { withBase } from '../basePath';
import { api, GithubStatus } from '../api';
import { useToast } from './Toast';
import Modal from './Modal';

const GH_ICON = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" style={{ flexShrink: 0 }}><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
);

const slug = (s: string) => s.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);

/** Publish an unlinked project to a fresh GitHub repo (backup + ongoing sync). */
export default function GithubPublish({ projectId, projectName, onClose, onLinked }: {
  projectId: string; projectName: string; onClose(): void; onLinked(): void;
}) {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [token, setToken] = useState('');
  const [name, setName] = useState(slug(projectName));
  const [priv, setPriv] = useState(true);
  const [busy, setBusy] = useState('');
  const toast = useToast();

  const loadStatus = () => api.githubStatus().then(setStatus).catch(() => setStatus({ connected: false, oauth: false }));
  useEffect(() => { loadStatus(); }, []);

  const connectPat = async () => {
    if (!token.trim()) return;
    setBusy('connect');
    try { await api.githubConnect(token.trim()); setToken(''); await loadStatus(); }
    catch (err: any) { toast(err.message, 'error'); }
    setBusy('');
  };

  const publish = async () => {
    if (!slug(name)) { toast('Repository name required', 'error'); return; }
    setBusy('publish');
    try {
      const r = await api.githubLink(projectId, slug(name), priv);
      toast(`Published to ${r.github.fullName}`, 'ok');
      onLinked();
      onClose();
    } catch (err: any) { toast(err.message, 'error'); setBusy(''); }
  };

  return (
    <Modal onClose={onClose} label="Publish to GitHub" testId="github-publish">
      <div>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>{GH_ICON} Publish to GitHub</h2>
        <p className="modal__sub">
          This project lives only on this server. Publishing creates a GitHub repo,
          pushes everything, and keeps it synced from then on.
        </p>

        {!status && <p className="modal__sub">Checking connection…</p>}

        {status && !status.connected && (
          <div style={{ marginTop: 4 }}>
            {status.oauth && (
              <>
                <a className="btn login__oauth" href={withBase('/api/github/oauth')} data-testid="github-connect-oauth">{GH_ICON} Connect with GitHub</a>
                <div className="login__or">or use a token</div>
              </>
            )}
            <input
              className="input login__input" type="password" placeholder="GitHub token (needs repo scope)"
              value={token} data-testid="github-token" onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && connectPat()}
            />
            <button className="btn btn--primary" style={{ width: '100%', justifyContent: 'center' }} onClick={connectPat} disabled={busy === 'connect'} data-testid="github-connect">
              {busy === 'connect' ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        )}

        {status?.connected && (
          <>
            <label style={{ display: 'block', margin: '10px 0 4px', color: 'var(--text-2)', fontSize: 12.5 }}>Repository name</label>
            <input className="input" style={{ width: '100%' }} value={name} data-testid="publish-repo-name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && publish()} autoFocus />
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, margin: '10px 0 0', fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={priv} data-testid="publish-private" onChange={(e) => setPriv(e.target.checked)} />
              Private repository
            </label>
            <div className="modal__row" style={{ marginTop: 16 }}>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn btn--primary" onClick={publish} disabled={busy === 'publish'} data-testid="publish-submit">
                {busy === 'publish' ? 'Publishing…' : `Publish as ${status.login}/${slug(name) || '…'}`}
              </button>
            </div>
          </>
        )}

        {status && !status.connected && (
          <div className="modal__row" style={{ marginTop: 14 }}><button className="btn" onClick={onClose}>Close</button></div>
        )}
      </div>
    </Modal>
  );
}
