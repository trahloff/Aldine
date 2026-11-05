import { useEffect, useRef, useState } from 'react';
import { api, RemoteRepo, RemoteStatus, RemoteTokenError } from '../api';
import { remoteDescriptor, RemoteProviderId } from '../remotes';
import { useToast } from './Toast';
import { friendlyDate } from '../util/dates';
import Modal from './Modal';
import RemoteConnectForm, { TokenHelp } from './RemoteConnect';

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
  const [replacing, setReplacing] = useState(false);
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

  const disconnect = async () => { await api.remoteDisconnect(provider); setRepos(null); setReplacing(false); loadStatus(); };
  // Connecting again overwrites the stored token. `connected` stays true, so
  // the effect above does not fire again: the new account's list is asked for here.
  const replaced = async () => {
    setReplacing(false);
    setRepos(null);
    await loadStatus();
    api.remoteRepos(provider).then(setRepos).catch((err) => { setRepos([]); toast(err.message, 'error'); });
  };

  const local = (repos || []).filter((r) => r.fullName.toLowerCase().includes(filter.trim().toLowerCase()));
  const shown = [...local, ...(found || []).filter((r) => !local.some((l) => l.fullName === r.fullName))];

  return (
    <Modal onClose={onClose} label={`Clone from ${d.label}`} wide testId={`${provider}-import`}>
      <div>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>{d.icon} Clone from {d.label}</h2>

        {!status && <p className="modal__sub">Checking connection…</p>}

        {status && !status.connected && (
          <div style={{ marginTop: 10 }}>
            {reconnect
              ? <p className="modal__sub" style={{ marginBottom: 14, color: 'var(--error)' }} data-testid={`${provider}-reconnect`}>{reconnect}</p>
              : <p className="modal__sub" style={{ marginBottom: 14 }}>Connect your {d.label} account to browse and clone repositories.</p>}
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
              <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                <button className="btn btn--ghost btn--small" onClick={() => setReplacing(!replacing)} data-testid={`${provider}-replace-token`}>Replace token</button>
                <button className="btn btn--ghost btn--small" onClick={disconnect} data-testid={`${provider}-disconnect`}>Disconnect</button>
              </span>
            </p>
            {replacing && status && <RemoteConnectForm provider={provider} status={status} onConnected={replaced} />}
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

        {status && <SingleRepoClone provider={provider} instanceUrl={status.instanceUrl} onImported={onImported} />}

        <div className="modal__row" style={{ marginTop: 14 }}><button className="btn" onClick={onClose}>Close</button></div>
      </div>
    </Modal>
  );
}

/** Clone one repository with a token given just for it: a repository of
 *  another account, or a token limited to that repository. The token stays
 *  with the new project and never becomes the account's connection. */
function SingleRepoClone({ provider, instanceUrl, onImported }: { provider: RemoteProviderId; instanceUrl?: string; onImported(id: string): void }) {
  const d = remoteDescriptor(provider);
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState('');
  const [token, setToken] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const clone = async () => {
    if (!repo.trim() || !token.trim()) return;
    if (d.baseUrlRequired && !baseUrl.trim()) { toast(`Enter the ${d.label} instance URL, ${d.baseUrlPlaceholder} for example`, 'error'); return; }
    setBusy(true);
    try {
      const p = await api.remoteImport(provider, repo.trim(), { token: token.trim(), ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}) });
      toast(`Imported ${repo.trim()}`, 'ok');
      onImported(p.id);
    } catch (err: any) { toast(err.message, 'error'); setBusy(false); }
  };

  if (!open) {
    return (
      <button className="btn btn--ghost btn--small" style={{ marginTop: 10 }} onClick={() => setOpen(true)} data-testid={`${provider}-single`}>
        Clone one repository with its own token…
      </button>
    );
  }
  return (
    <div style={{ marginTop: 14 }} data-testid={`${provider}-single-form`}>
      <div className="menu__label" style={{ marginBottom: 6 }}>One repository, its own token</div>
      {d.selfHosted && (
        <input className="input login__input" type="url" placeholder={d.baseUrlRequired ? d.baseUrlPlaceholder : `${d.baseUrlPlaceholder} (leave empty for ${d.label}'s default)`} aria-label={`${d.label} instance URL`}
          value={baseUrl} data-testid={`${provider}-single-baseurl`} onChange={(e) => setBaseUrl(e.target.value)} />
      )}
      <input className="input login__input" placeholder="owner/repo or its URL" aria-label="Repository"
        value={repo} data-testid={`${provider}-single-repo`} onChange={(e) => setRepo(e.target.value)} />
      <input className="input login__input" type="password" placeholder={d.tokenPlaceholder} aria-label={`${d.label} token for this repository`}
        value={token} data-testid={`${provider}-single-token`} onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && clone()} />
      <button className="btn btn--primary" style={{ width: '100%', justifyContent: 'center' }} onClick={clone} disabled={busy || !repo.trim() || !token.trim()} data-testid={`${provider}-single-clone`}>
        {busy ? 'Cloning…' : 'Clone'}
      </button>
      <TokenHelp provider={provider} base={baseUrl} instanceUrl={instanceUrl} testId={`${provider}-single-token-page`} oneRepo />
      <p style={{ color: 'var(--text-3)', fontSize: 'var(--text-s)', marginTop: 8 }}>
        The token stays with the new project only: it syncs with it, and your account connection is left as it is.
      </p>
    </div>
  );
}
