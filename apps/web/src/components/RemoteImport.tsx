import { useEffect, useRef, useState } from 'react';
import { api, RemoteRepo, RemoteStatus, RemoteTokenError } from '../api';
import { remoteDescriptor, RemoteProviderId } from '../remotes';
import { useToast } from './Toast';
import { friendlyDate } from '../util/dates';
import Modal from './Modal';
import RemoteConnectForm from './RemoteConnect';

/** Connect a git host and import a repository as a new project — the primary create flow. */
export default function RemoteImport({ provider, onClose, onImported }: {
  provider: RemoteProviderId; onClose(): void; onImported(id: string): void;
}) {
  const d = remoteDescriptor(provider);
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [repos, setRepos] = useState<RemoteRepo[] | null>(null);
  /** Set when the host rejected the stored token: the connect form comes back with this above it. */
  const [reconnect, setReconnect] = useState('');
  const [filter, setFilter] = useState('');
  /** What the host's search returned for the current filter; null while there is none. */
  const [found, setFound] = useState<RemoteRepo[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchSeq = useRef(0);
  const [busy, setBusy] = useState('');
  const toast = useToast();

  const loadStatus = () => api.remoteStatus(provider).then(setStatus)
    .catch(() => setStatus({ connected: false, oauth: false, selfHosted: d.selfHosted }));
  useEffect(() => { loadStatus(); }, [provider]);
  useEffect(() => {
    if (!status?.connected) return;
    setRepos(null);
    api.remoteRepos(provider).then(setRepos).catch((err) => {
      if (err instanceof RemoteTokenError) {
        setReconnect(`${d.label} rejected the stored token. Connect again.`);
        setStatus((s) => (s ? { ...s, connected: false, login: undefined } : s));
        return;
      }
      setRepos([]);
      toast(err.message, 'error');
    });
  }, [status?.connected]);

  // The loaded list is one page; anything typed is also asked of the host,
  // after a pause in typing, so a repository outside that page is found too.
  useEffect(() => {
    const q = filter.trim();
    const seq = ++searchSeq.current;
    if (!status?.connected || q.length < 2) { setFound(null); setSearching(false); return; }
    const t = setTimeout(() => {
      setSearching(true);
      api.remoteRepos(provider, q)
        .then((r) => { if (seq === searchSeq.current) setFound(r); })
        .catch(() => { if (seq === searchSeq.current) setFound([]); })
        .finally(() => { if (seq === searchSeq.current) setSearching(false); });
    }, 300);
    return () => clearTimeout(t);
  }, [filter, status?.connected, provider]);

  const importRepo = async (r: RemoteRepo) => {
    setBusy(r.fullName);
    try {
      const p = await api.remoteImport(provider, r.fullName);
      toast(`Imported ${r.fullName}`, 'ok');
      onImported(p.id);
    } catch (err: any) { toast(err.message, 'error'); setBusy(''); }
  };

  const disconnect = async () => { await api.remoteDisconnect(provider); setRepos(null); loadStatus(); };

  const local = (repos || []).filter((r) => r.fullName.toLowerCase().includes(filter.trim().toLowerCase()));
  const shown = [...local, ...(found || []).filter((r) => !local.some((l) => l.fullName === r.fullName))];

  return (
    <Modal onClose={onClose} label={`Import from ${d.label}`} wide testId={`${provider}-import`}>
      <div>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>{d.icon} Import from {d.label}</h2>

        {!status && <p className="modal__sub">Checking connection…</p>}

        {status && !status.connected && (
          <div style={{ marginTop: 10 }}>
            {reconnect
              ? <p className="modal__sub" style={{ marginBottom: 14, color: 'var(--error)' }} data-testid={`${provider}-reconnect`}>{reconnect}</p>
              : <p className="modal__sub" style={{ marginBottom: 14 }}>Connect your {d.label} account to browse and import repositories.</p>}
            <RemoteConnectForm provider={provider} status={status} onConnected={async () => { setReconnect(''); await loadStatus(); }} />
          </div>
        )}

        {status?.connected && (
          <>
            <p className="modal__sub" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                Connected as <strong>{status.login}</strong>
                {status.baseUrl && <span style={{ color: 'var(--text-3)' }}> on {status.baseUrl.replace(/^https?:\/\//, '')}</span>}
              </span>
              <button className="btn btn--ghost btn--small" onClick={disconnect} data-testid={`${provider}-disconnect`}>Disconnect</button>
            </p>
            <input className="input" style={{ width: '100%', margin: '8px 0' }} placeholder="Filter, or type owner/repo or paste its URL…" value={filter} data-testid={`${provider}-filter`} onChange={(e) => setFilter(e.target.value)} autoFocus />
            <div className="gh-repos" data-testid={`${provider}-repos`}>
              {!repos && <p style={{ color: 'var(--text-2)', padding: 8 }}>Loading your repositories…</p>}
              {repos && shown.length === 0 && (searching
                ? <p style={{ color: 'var(--text-2)', padding: 8 }} data-testid={`${provider}-searching`}>Searching {d.label}…</p>
                : <p style={{ color: 'var(--text-2)', padding: 8 }}>No matching repositories.</p>)}
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
