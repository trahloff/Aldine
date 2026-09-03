import { useEffect, useState } from 'react';
import { api, RemoteRepo, RemoteStatus, RemoteProviderId } from '../api';
import { REMOTES } from '../remotes';
import { useToast } from './Toast';
import { friendlyDate } from '../util/dates';
import Modal from './Modal';

/** Connect a git host and import a repo as a new project — the primary create flow. */
export default function RemoteImport({ provider, onClose, onImported }: {
  provider: RemoteProviderId;
  onClose(): void;
  onImported(id: string): void;
}) {
  const d = REMOTES[provider];
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [repos, setRepos] = useState<RemoteRepo[] | null>(null);
  const [token, setToken] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [showBaseUrl, setShowBaseUrl] = useState(false);
  const [tokenInvalid, setTokenInvalid] = useState(false);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState('');
  const toast = useToast();

  const loadStatus = () => api.remoteStatus(provider).then(setStatus).catch(() => setStatus({ connected: false, oauth: false }));
  useEffect(() => { loadStatus(); }, [provider]);
  useEffect(() => {
    if (!status?.connected) return;
    setRepos(null);
    setTokenInvalid(false);
    api.remoteRepos(provider)
      .then(setRepos)
      .catch((err: Error & { tokenInvalid?: boolean }) => {
        // A revoked token reads as connected but lists nothing — say so rather
        // than showing an empty list the user cannot explain.
        if (err.tokenInvalid) setTokenInvalid(true);
        setRepos([]);
      });
  }, [status?.connected, provider]);

  const connectPat = async () => {
    if (!token.trim()) return;
    setBusy('connect');
    try {
      await api.remoteConnect(provider, token.trim(), baseUrl.trim() || undefined);
      setToken('');
      await loadStatus();
    } catch (err: any) { toast(err.message, 'error'); }
    setBusy('');
  };

  const importRepo = async (r: RemoteRepo) => {
    setBusy(r.fullName);
    try {
      const p = await api.remoteImport(provider, r.fullName);
      toast(`Imported ${r.fullName}`, 'ok');
      onImported(p.id);
    } catch (err: any) { toast(err.message, 'error'); setBusy(''); }
  };

  const disconnect = async () => { await api.remoteDisconnect(provider); setRepos(null); loadStatus(); };

  const shown = (repos || []).filter((r) => r.fullName.toLowerCase().includes(filter.toLowerCase()));
  const instance = status?.baseUrl && !/^https:\/\/gitlab\.com$/i.test(status.baseUrl) ? status.baseUrl.replace(/^https:\/\//, '') : null;

  return (
    <Modal onClose={onClose} label={`Import from ${d.label}`} wide testId={`${provider}-import`}>
      <div>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>{d.icon} Import from {d.label}</h2>

        {!status && <p className="modal__sub">Checking connection…</p>}

        {status && !status.connected && (
          <div style={{ marginTop: 10 }}>
            <p className="modal__sub" style={{ marginBottom: 14 }}>Connect your {d.label} account to browse and import repositories.</p>
            {status.oauth && (
              <>
                <a className="btn login__oauth" href={`/api/remotes/${provider}/oauth`} data-testid={`${provider}-connect-oauth`}>{d.icon} Connect with {d.label}</a>
                <div className="login__or">or use a token</div>
              </>
            )}
            <input
              className="input login__input" type="password" placeholder={d.tokenPlaceholder}
              value={token} data-testid={`${provider}-token`} onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && connectPat()}
            />
            {d.selfHosted && (showBaseUrl ? (
              <input
                className="input login__input" placeholder="https://gitlab.example.com"
                value={baseUrl} data-testid={`${provider}-baseurl`} onChange={(e) => setBaseUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && connectPat()}
              />
            ) : (
              <button className="btn btn--ghost btn--small" style={{ marginBottom: 8 }} onClick={() => setShowBaseUrl(true)} data-testid={`${provider}-selfhosted`}>
                Using a self-hosted {d.label}?
              </button>
            ))}
            <button className="btn btn--primary" style={{ width: '100%', justifyContent: 'center' }} onClick={connectPat} disabled={busy === 'connect'} data-testid={`${provider}-connect`}>
              {busy === 'connect' ? 'Connecting…' : 'Connect'}
            </button>
            <p style={{ color: 'var(--text-3)', fontSize: 11.5, marginTop: 8 }}>{d.tokenHelp}</p>
          </div>
        )}

        {status?.connected && (
          <>
            <p className="modal__sub" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Connected as <strong>{status.login}</strong>{instance && <> on {instance}</>}</span>
              <button className="btn btn--ghost btn--small" onClick={disconnect} data-testid={`${provider}-disconnect`}>Disconnect</button>
            </p>
            {tokenInvalid && (
              <p style={{ color: 'var(--danger, #e5534b)', fontSize: 12.5 }} data-testid={`${provider}-token-invalid`}>
                That token is no longer valid — disconnect and reconnect to continue.
              </p>
            )}
            <input className="input" style={{ width: '100%', margin: '8px 0' }} placeholder="Filter repositories…" value={filter} data-testid={`${provider}-filter`} onChange={(e) => setFilter(e.target.value)} autoFocus />
            <div className="gh-repos" data-testid={`${provider}-repos`}>
              {!repos && <p style={{ color: 'var(--text-2)', padding: 8 }}>Loading your repositories…</p>}
              {repos && shown.length === 0 && !tokenInvalid && <p style={{ color: 'var(--text-2)', padding: 8 }}>No matching repositories.</p>}
              {shown.map((r) => (
                <button key={r.fullName} className="gh-repo" onClick={() => importRepo(r)} disabled={!!busy} data-testid={`${provider}-repo-${r.fullName}`}>
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
