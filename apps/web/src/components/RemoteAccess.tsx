import { useEffect, useState } from 'react';
import { api, RemoteAccess as Access, RemoteStatus } from '../api';
import { remoteDescriptor, RemoteProviderId } from '../remotes';
import { useToast } from './Toast';
import Modal from './Modal';
import RemoteConnectForm from './RemoteConnect';

/** Whose token a linked project syncs with, and the two places to change it:
 *  a token stored on this project (the owner's call; it wins over every
 *  account) and the viewer's own account connection. `rejected` is the
 *  server's message when the host just refused the token in use. */
export default function RemoteAccess({ projectId, provider, fullName, isOwner, rejected, onClose, onChanged }: {
  projectId: string;
  provider: RemoteProviderId;
  fullName: string;
  isOwner: boolean;
  rejected: string | null;
  onClose(): void;
  onChanged(): void;
}) {
  const d = remoteDescriptor(provider);
  const [access, setAccess] = useState<Access | null>(null);
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [editing, setEditing] = useState<'' | 'project' | 'account'>('');
  const [projectToken, setProjectToken] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = async () => {
    const [a, s] = await Promise.all([
      api.projectRemoteAccess(projectId).catch(() => null),
      api.remoteStatus(provider).catch(() => ({ connected: false, oauth: false, selfHosted: d.selfHosted } as RemoteStatus)),
    ]);
    setAccess(a);
    setStatus(s);
  };
  useEffect(() => { load(); }, [projectId, provider]);

  const changed = async (message: string) => {
    toast(message, 'ok');
    setEditing('');
    await load();
    onChanged();
  };

  const saveProjectToken = async () => {
    if (!projectToken.trim()) return;
    setBusy(true);
    try {
      const r = await api.setProjectRemoteToken(projectId, projectToken.trim());
      setProjectToken('');
      await changed(`This project now syncs with the token of ${r.login}`);
    } catch (err: any) { toast(err.message, 'error'); }
    setBusy(false);
  };
  const removeProjectToken = async () => {
    setBusy(true);
    try { await api.removeProjectRemoteToken(projectId); await changed("Removed this project's token"); }
    catch (err: any) { toast(err.message, 'error'); }
    setBusy(false);
  };
  const disconnect = async () => {
    setBusy(true);
    try { await api.remoteDisconnect(provider); await changed(`Disconnected your ${d.label} account`); }
    catch (err: any) { toast(err.message, 'error'); }
    setBusy(false);
  };

  const via = !access ? '…'
    : !access.source ? `No token reaches ${fullName} yet`
    : access.source === 'project' ? `${access.login}, with this project's token`
    : access.source === 'own' ? `${access.login}, with your account's token`
    : access.source === 'linker' ? `${access.login}, with the token of the account that linked this project`
    : "the server's service account";

  return (
    <Modal onClose={onClose} label="Git access" testId={`${provider}-access-dialog`}>
      <div>
        <h2 style={{ marginBottom: 2 }}>Git access</h2>
        <p className="modal__sub">{fullName} on {d.label}</p>
        {rejected && <p className="modal__sub" style={{ color: 'var(--error)' }} data-testid={`${provider}-access-rejected`}>{rejected}</p>}

        <div className="settings__row">
          <span className="settings__label">Syncs as</span>
          <span data-testid={`${provider}-access-source`}>{via}</span>
        </div>

        <div className="menu__label" style={{ margin: '18px 0 6px' }}>This project's token</div>
        {access?.projectToken ? (
          <div className="settings__row">
            <span data-testid={`${provider}-project-token-login`}>Token of {access.projectToken.login}</span>
            {isOwner && (
              <span style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn--small" onClick={() => setEditing('project')} disabled={busy} data-testid={`${provider}-project-token-replace`}>Replace</button>
                <button className="btn btn--small" onClick={removeProjectToken} disabled={busy} data-testid={`${provider}-project-token-remove`}>Remove</button>
              </span>
            )}
          </div>
        ) : (
          <div className="settings__row">
            <span style={{ color: 'var(--text-2)' }}>None: syncing uses an account's token.</span>
            {isOwner && editing !== 'project' && (
              <button className="btn btn--small" onClick={() => setEditing('project')} data-testid={`${provider}-project-token-add`}>Add a token</button>
            )}
          </div>
        )}
        {!isOwner && <p style={{ color: 'var(--text-3)', fontSize: 'var(--text-s)', margin: '4px 0 0' }}>Only the owner can change this project's token.</p>}
        {isOwner && editing === 'project' && (
          <div style={{ marginTop: 8 }}>
            <input
              className="input login__input" type="password" placeholder={d.tokenPlaceholder} aria-label={`${d.label} token for this project`} autoFocus
              value={projectToken} data-testid={`${provider}-project-token`} onChange={(e) => setProjectToken(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveProjectToken()}
            />
            <div className="modal__row" style={{ marginTop: 6 }}>
              <button className="btn" onClick={() => { setEditing(''); setProjectToken(''); }}>Cancel</button>
              <button className="btn btn--primary" onClick={saveProjectToken} disabled={busy || !projectToken.trim()} data-testid={`${provider}-project-token-save`}>{busy ? 'Checking…' : 'Use for this project'}</button>
            </div>
            <p style={{ color: 'var(--text-3)', fontSize: 'var(--text-s)', marginTop: 8 }}>
              Any {d.label} account's token that can push to {fullName} works, one limited to this repository too. Everyone who syncs this project uses it, and nobody can read it back.
            </p>
          </div>
        )}

        <div className="menu__label" style={{ margin: '18px 0 6px' }}>Your {d.label} account</div>
        <div className="settings__row">
          <span data-testid={`${provider}-access-account`}>
            {!status ? '…' : status.connected ? <>Connected as <strong>{status.login}</strong></> : 'Not connected'}
          </span>
          {status && editing !== 'account' && (
            <span style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn--small" onClick={() => setEditing('account')} disabled={busy} data-testid={`${provider}-access-connect`}>{status.connected ? 'Replace token' : 'Connect'}</button>
              {status.connected && <button className="btn btn--small" onClick={disconnect} disabled={busy} data-testid={`${provider}-access-disconnect`}>Disconnect</button>}
            </span>
          )}
        </div>
        {status && editing === 'account' && (
          <div style={{ marginTop: 8 }}>
            <RemoteConnectForm provider={provider} status={status} onConnected={() => changed(`Connected your ${d.label} account`)} />
          </div>
        )}

        <div className="modal__row" style={{ marginTop: 18 }}><button className="btn" onClick={onClose}>Close</button></div>
      </div>
    </Modal>
  );
}
