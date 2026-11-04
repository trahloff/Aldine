import { useEffect, useRef, useState } from 'react';
import { api, LINKED_PUSH_FAILED, RemoteInfo, RemoteStatus } from '../api';
import { remoteDescriptor, RemoteProviderId } from '../remotes';
import { useToast } from './Toast';
import Modal from './Modal';
import RemoteConnectForm from './RemoteConnect';

const slug = (s: string) => s.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);

/** Publish an unlinked project to a fresh repository on a git host (backup +
 *  ongoing sync). With more than one provider on offer, a segmented control
 *  picks the host; the connect block and the publish call follow it.
 *  `onPush` opens the push dialog of the now linked project. */
export default function RemotePublish({ projectId, projectName, onClose, onLinked, onPush }: {
  projectId: string; projectName: string; onClose(): void; onLinked(): void; onPush(provider: RemoteProviderId): void;
}) {
  const [providers, setProviders] = useState<RemoteInfo[] | null>(null);
  const [provider, setProvider] = useState<RemoteProviderId | null>(null);
  const [statusOf, setStatusOf] = useState<{ provider: RemoteProviderId; status: RemoteStatus } | null>(null);
  const [name, setName] = useState(slug(projectName));
  const [priv, setPriv] = useState(true);
  const [busy, setBusy] = useState('');
  const [replacing, setReplacing] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api.remotes().then((list) => { setProviders(list); setProvider(list[0]?.id ?? null); })
      .catch(() => { setProviders([]); });
  }, []);

  // The status is stored with the host it answers for and read back only for
  // the selected host: a switch shows "Checking connection…" in the very
  // render it happens in (an effect-side reset would first paint the new host
  // with the old host's connect form), and a late answer from the previous
  // host is never shown as the new host's.
  const status = statusOf?.provider === provider ? statusOf.status : null;
  const providerRef = useRef(provider); providerRef.current = provider;
  const loadStatus = (p: RemoteProviderId) => api.remoteStatus(p)
    .then((s) => { if (providerRef.current === p) setStatusOf({ provider: p, status: s }); })
    .catch(() => { if (providerRef.current === p) setStatusOf({ provider: p, status: { connected: false, oauth: false, selfHosted: remoteDescriptor(p).selfHosted } }); });
  useEffect(() => { if (provider) loadStatus(provider); }, [provider]);

  const d = provider ? remoteDescriptor(provider) : null;

  const publish = async () => {
    if (!provider) return;
    if (!slug(name)) { toast('Repository name required', 'error'); return; }
    setBusy('publish');
    try {
      const r = await api.remoteLink(projectId, provider, slug(name), priv);
      toast(`Published to ${r.remote.fullName}`, 'ok');
      onLinked();
      onClose();
    } catch (err: any) {
      // The link can be stored before a failure (the first push), so the project is reloaded either way.
      onLinked();
      if (err?.code === LINKED_PUSH_FAILED) {
        const p = provider;
        toast(err.message, 'error', { label: 'Push…', testId: 'publish-push-retry', onClick: () => onPush(p) });
        onClose();
        return;
      }
      toast(err.message, 'error'); setBusy('');
    }
  };

  const submitLabel = () => {
    if (!d || !status) return '';
    const repo = slug(name) || '…';
    return provider === 'github' ? `Publish as ${status.login}/${repo}` : `Publish to ${d.label} as ${repo}`;
  };

  return (
    <Modal onClose={onClose} label="Publish this project" testId="remote-publish">
      <div>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>{d?.icon} Publish to {d?.label ?? 'a git host'}</h2>
        <p className="modal__sub">
          This project lives only on this server. Publishing creates a {d?.label ?? 'remote'} repository,
          pushes everything, and keeps it synced from then on.
        </p>

        {providers && providers.length > 1 && (
          <div className="seg" role="tablist" aria-label="Git host" style={{ margin: '8px 0 12px' }}>
            {providers.map((p) => (
              <button key={p.id} role="tab" aria-selected={provider === p.id} className={`seg__btn ${provider === p.id ? 'seg__btn--active' : ''}`}
                onClick={() => setProvider(p.id)} data-testid={`remote-publish-provider-${p.id}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {remoteDescriptor(p.id).icon} {p.label}
              </button>
            ))}
          </div>
        )}

        {providers && providers.length === 0 && (
          <p className="modal__sub" style={{ color: 'var(--error)' }}>No git host is available on this server.</p>
        )}

        {provider && !status && <p className="modal__sub">Checking connection…</p>}

        {provider && status && !status.connected && (
          <div style={{ marginTop: 4 }}>
            {/* keyed so a host switch starts a fresh form: the URL field's presence is decided at mount */}
            <RemoteConnectForm key={provider} provider={provider} status={status} onConnected={() => loadStatus(provider)} returnTo={`/p/${projectId}`} />
          </div>
        )}

        {provider && status?.connected && (
          <>
            <p className="modal__sub" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, margin: '4px 0 0' }}>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Connected as <strong>{status.login}</strong></span>
              <button className="btn btn--ghost btn--small" onClick={() => setReplacing(!replacing)} data-testid={`${provider}-replace-token`}>Replace token</button>
            </p>
            {replacing && <RemoteConnectForm key={provider} provider={provider} status={status} onConnected={async () => { setReplacing(false); await loadStatus(provider); }} returnTo={`/p/${projectId}`} />}
            <label style={{ display: 'block', margin: '10px 0 4px', color: 'var(--text-2)', fontSize: 'var(--text-s)' }}>Repository name</label>
            <input className="input" style={{ width: '100%' }} value={name} data-testid="publish-repo-name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && publish()} autoFocus />
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, margin: '10px 0 0', fontSize: 'var(--text-m)', cursor: 'pointer' }}>
              <input type="checkbox" checked={priv} data-testid="publish-private" onChange={(e) => setPriv(e.target.checked)} />
              Private repository
            </label>
            <div className="modal__row" style={{ marginTop: 16 }}>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn btn--primary" onClick={publish} disabled={busy === 'publish'} data-testid="publish-submit">
                {busy === 'publish' ? 'Publishing…' : submitLabel()}
              </button>
            </div>
          </>
        )}

        {(!provider || (status && !status.connected)) && (
          <div className="modal__row" style={{ marginTop: 14 }}><button className="btn" onClick={onClose}>Close</button></div>
        )}
      </div>
    </Modal>
  );
}
