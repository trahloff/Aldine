import { useEffect, useState } from 'react';
import { api, RemoteStatus, RemoteProviderId, RemoteProviderInfo } from '../api';
import { REMOTES } from '../remotes';
import { useToast } from './Toast';
import Modal from './Modal';

const slug = (s: string) => s.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);

/** Publish an unlinked project to a fresh repo on a git host (backup + ongoing sync). */
export default function RemotePublish({ projectId, projectName, onClose, onLinked }: {
  projectId: string; projectName: string; onClose(): void; onLinked(): void;
}) {
  const [providers, setProviders] = useState<RemoteProviderInfo[]>([]);
  const [provider, setProvider] = useState<RemoteProviderId>('github');
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [token, setToken] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [showBaseUrl, setShowBaseUrl] = useState(false);
  const [name, setName] = useState(slug(projectName));
  const [priv, setPriv] = useState(true);
  const [busy, setBusy] = useState('');
  const toast = useToast();
  const d = REMOTES[provider];

  useEffect(() => {
    api.remotes().then((list) => {
      setProviders(list);
      if (list.length && !list.some((p) => p.id === provider)) setProvider(list[0].id);
    }).catch(() => setProviders([]));
  }, []);

  const loadStatus = () => api.remoteStatus(provider).then(setStatus).catch(() => setStatus({ connected: false, oauth: false }));
  useEffect(() => { setStatus(null); loadStatus(); }, [provider]);

  const connectPat = async () => {
    if (!token.trim()) return;
    setBusy('connect');
    try { await api.remoteConnect(provider, token.trim(), baseUrl.trim() || undefined); setToken(''); await loadStatus(); }
    catch (err: any) { toast(err.message, 'error'); }
    setBusy('');
  };

  const publish = async () => {
    if (!slug(name)) { toast('Repository name required', 'error'); return; }
    setBusy('publish');
    try {
      const r = await api.remoteLink(projectId, provider, slug(name), priv);
      toast(`Published to ${r.remote.fullName}`, 'ok');
      onLinked();
      onClose();
    } catch (err: any) { toast(err.message, 'error'); setBusy(''); }
  };

  return (
    <Modal onClose={onClose} label={`Publish to ${d.label}`} testId="remote-publish">
      <div>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>{d.icon} Publish to {d.label}</h2>
        <p className="modal__sub">
          This project lives only on this server. Publishing creates a {d.label} repository,
          pushes everything, and keeps it synced from then on.
        </p>

        {providers.length > 1 && (
          <div className="seg" style={{ display: 'flex', gap: 6, margin: '10px 0 2px' }}>
            {providers.map((p) => (
              <button
                key={p.id}
                className={`btn btn--small ${p.id === provider ? 'btn--primary' : ''}`}
                onClick={() => setProvider(p.id)}
                data-testid={`remote-publish-provider-${p.id}`}
              >
                {REMOTES[p.id].icon} {p.label}
              </button>
            ))}
          </div>
        )}

        {!status && <p className="modal__sub">Checking connection…</p>}

        {status && !status.connected && (
          <div style={{ marginTop: 4 }}>
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
