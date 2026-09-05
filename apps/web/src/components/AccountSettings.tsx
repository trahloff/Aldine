import { useState } from 'react';
import { api, AuthUser } from '../api';
import { useToast } from './Toast';
import Modal from './Modal';

const PROVIDER_NAME: Record<string, string> = { github: 'GitHub', google: 'Google', orcid: 'ORCID' };

/** Account settings: identity + change password (password accounts only). */
export default function AccountSettings({ user, onClose }: { user: AuthUser; onClose(): void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const isSso = !!user.provider;

  const change = async () => {
    if (next.length < 8) { toast('New password must be at least 8 characters', 'error'); return; }
    setBusy(true);
    try {
      await api.changePassword(current, next);
      toast('Password updated', 'ok');
      setCurrent(''); setNext('');
      onClose();
    } catch (err: any) {
      toast(err.message, 'error');
    }
    setBusy(false);
  };

  return (
    <Modal onClose={onClose} label="Account settings" testId="account-settings">
      <div>
        <h2 style={{ marginBottom: 2 }}>Account</h2>
        <p className="modal__sub" data-testid="account-email">{user.email ?? 'No email address on this account'}</p>

        <div className="settings__row">
          <span className="settings__label">Name</span>
          <span>{user.name}</span>
        </div>
        {user.orcid && (
          <div className="settings__row">
            <span className="settings__label">ORCID iD</span>
            <a href={`https://orcid.org/${user.orcid}`} target="_blank" rel="noreferrer" data-testid="account-orcid">{user.orcid}</a>
          </div>
        )}
        <div className="settings__row">
          <span className="settings__label">Sign-in</span>
          <span>{isSso ? `Single sign-on (${PROVIDER_NAME[user.provider!] || user.provider})` : 'Email & password'}</span>
        </div>

        {isSso ? (
          <p style={{ color: 'var(--text-2)', fontSize: 13, marginTop: 14 }}>
            Your password is managed by {PROVIDER_NAME[user.provider!] || user.provider}. There's nothing to change here.
            {user.orcid && !user.email && ' Collaborators invite you by your ORCID iD, since this account has no email address.'}
          </p>
        ) : (
          <>
            <div className="menu__label" style={{ margin: '18px 0 6px' }}>Change password</div>
            <input className="input login__input" type="password" placeholder="Current password" value={current} data-testid="current-password" onChange={(e) => setCurrent(e.target.value)} />
            <input className="input login__input" type="password" placeholder="New password (min 8)" value={next} data-testid="new-password" onChange={(e) => setNext(e.target.value)} />
            <p style={{ color: 'var(--text-3)', fontSize: 11.5, margin: '4px 0 0' }}>Changing your password signs out your other sessions.</p>
          </>
        )}

        <div className="modal__row" style={{ marginTop: 18 }}>
          <button className="btn" onClick={onClose}>Close</button>
          {!isSso && <button className="btn btn--primary" onClick={change} disabled={busy} data-testid="save-password">{busy ? '…' : 'Update password'}</button>}
        </div>
      </div>
    </Modal>
  );
}
