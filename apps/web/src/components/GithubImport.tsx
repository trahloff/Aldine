import { useEffect, useState } from 'react';
import { withBase } from '../basePath';
import { api, GithubRepo, GithubStatus } from '../api';
import { useToast } from './Toast';
import { friendlyDate } from '../util/dates';
import Modal from './Modal';

const GH_ICON = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" style={{ flexShrink: 0 }}><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
);

/** Connect GitHub and import a repo as a new project — the primary create flow. */
export default function GithubImport({ onClose, onImported }: { onClose(): void; onImported(id: string): void }) {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [token, setToken] = useState('');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState('');
  const toast = useToast();

  const loadStatus = () => api.githubStatus().then(setStatus).catch(() => setStatus({ connected: false, oauth: false }));
  useEffect(() => { loadStatus(); }, []);
  useEffect(() => {
    if (status?.connected) { setRepos(null); api.githubRepos().then(setRepos).catch(() => setRepos([])); }
  }, [status?.connected]);

  const connectPat = async () => {
    if (!token.trim()) return;
    setBusy('connect');
    try { await api.githubConnect(token.trim()); setToken(''); await loadStatus(); }
    catch (err: any) { toast(err.message, 'error'); }
    setBusy('');
  };

  const importRepo = async (r: GithubRepo) => {
    setBusy(r.fullName);
    try {
      const p = await api.githubImport(r.fullName);
      toast(`Imported ${r.fullName}`, 'ok');
      onImported(p.id);
    } catch (err: any) { toast(err.message, 'error'); setBusy(''); }
  };

  const disconnect = async () => { await api.githubDisconnect(); setRepos(null); loadStatus(); };

  const shown = (repos || []).filter((r) => r.fullName.toLowerCase().includes(filter.toLowerCase()));

  return (
    <Modal onClose={onClose} label="Import from GitHub" wide testId="github-import">
      <div>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>{GH_ICON} Import from GitHub</h2>

        {!status && <p className="modal__sub">Checking connection…</p>}

        {status && !status.connected && (
          <div style={{ marginTop: 10 }}>
            <p className="modal__sub" style={{ marginBottom: 14 }}>Connect your GitHub account to browse and import repositories.</p>
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
            <p style={{ color: 'var(--text-3)', fontSize: 11.5, marginTop: 8 }}>
              Create one at github.com → Settings → Developer settings → Personal access tokens, with repo access.
            </p>
          </div>
        )}

        {status?.connected && (
          <>
            <p className="modal__sub" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Connected as <strong>{status.login}</strong></span>
              <button className="btn btn--ghost btn--small" onClick={disconnect} data-testid="github-disconnect">Disconnect</button>
            </p>
            <input className="input" style={{ width: '100%', margin: '8px 0' }} placeholder="Filter repositories…" value={filter} data-testid="github-filter" onChange={(e) => setFilter(e.target.value)} autoFocus />
            <div className="gh-repos" data-testid="github-repos">
              {!repos && <p style={{ color: 'var(--text-2)', padding: 8 }}>Loading your repositories…</p>}
              {repos && shown.length === 0 && <p style={{ color: 'var(--text-2)', padding: 8 }}>No matching repositories.</p>}
              {shown.map((r) => (
                <button key={r.fullName} className="gh-repo" onClick={() => importRepo(r)} disabled={!!busy} data-testid={`github-repo-${r.fullName}`}>
                  <div className="gh-repo__main">
                    <span className="gh-repo__name">{r.fullName}</span>
                    {r.private && <span className="gh-repo__badge">private</span>}
                  </div>
                  <span className="gh-repo__meta">{busy === r.fullName ? 'Importing…' : (r.updatedAt ? `updated ${friendlyDate(r.updatedAt)}` : '')}</span>
                </button>
              ))}
            </div>
          </>
        )}

        <div className="modal__row" style={{ marginTop: 14 }}><button className="btn" onClick={onClose}>Close</button></div>
      </div>
    </Modal>
  );
}
