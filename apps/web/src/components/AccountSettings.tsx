import { useEffect, useState } from 'react';
import { api, AccessToken, AuthUser, ProjectSummary } from '../api';
import { useToast } from './Toast';
import Modal from './Modal';
import { friendlyDate } from '../util/dates';

const EXPIRY_CHOICES = [
  { value: '', label: 'Never expires' },
  { value: '7', label: 'Expires in 7 days' },
  { value: '30', label: 'Expires in 30 days' },
  { value: '90', label: 'Expires in 90 days' },
];

/** Access tokens for agents (Claude connector onboarding lives here). Only
 *  mounted when auth is on — token routes 404 without users. */
function AgentAccess() {
  const [tokens, setTokens] = useState<AccessToken[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [scopeIds, setScopeIds] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('');
  const [busy, setBusy] = useState(false);
  const [minted, setMinted] = useState<string | null>(null);
  const toast = useToast();
  const connectorUrl = `${location.origin}/mcp`;

  useEffect(() => { api.listTokens().then(setTokens).catch(() => setTokens([])); }, []);
  useEffect(() => {
    if (showForm && projects === null) api.listProjects().then(setProjects).catch(() => setProjects([]));
  }, [showForm, projects]);

  const copy = async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast(`${what} copied`, 'ok');
    } catch {
      toast(`Could not copy the ${what.toLowerCase()} — select it and copy manually`, 'error');
    }
  };

  const create = async () => {
    const n = name.trim();
    if (!n) { toast('Give the token a name first', 'error'); return; }
    setBusy(true);
    try {
      const expiresAt = expiry ? new Date(Date.now() + Number(expiry) * 86400_000).toISOString() : undefined;
      const t = await api.createToken(n, scopeIds.length ? scopeIds : undefined, expiresAt);
      setMinted(t.token);
      setShowForm(false);
      setName(''); setScopeIds([]); setExpiry('');
      api.listTokens().then(setTokens).catch(() => {});
    } catch (err: any) {
      toast(`Could not create the token: ${err.message}`, 'error');
    }
    setBusy(false);
  };

  const revoke = async (t: AccessToken) => {
    if (!window.confirm(`Revoke “${t.name}”? Anything connected with it loses access.`)) return;
    try {
      await api.revokeToken(t.id);
      setTokens((cur) => cur?.filter((x) => x.id !== t.id) ?? cur);
      toast(`Revoked ${t.name}`, 'ok');
    } catch (err: any) {
      toast(`Could not revoke the token: ${err.message}`, 'error');
    }
  };

  return (
    <>
      <div className="menu__label" style={{ margin: '18px 0 6px' }}>Agent access</div>
      <p style={{ color: 'var(--text-2)', fontSize: 13, margin: '0 0 10px' }}>
        Access tokens let Claude and other agents open your projects through the API.
      </p>

      {minted && (
        <div style={{ marginBottom: 12 }}>
          <p style={{ color: 'var(--text-2)', fontSize: 13, margin: '0 0 6px' }}>You won't see this again — copy the token now.</p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <input className="input" readOnly value={minted} data-testid="agent-token-value" style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)', fontSize: 12 }} onFocus={(e) => e.target.select()} />
            <button className="btn btn--small" style={{ flexShrink: 0 }} onClick={() => copy(minted, 'Token')} data-testid="agent-token-copy">Copy token</button>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
            <code data-testid="agent-connector-url" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>{connectorUrl}</code>
            <button className="btn btn--small" style={{ flexShrink: 0, marginLeft: 'auto' }} onClick={() => copy(connectorUrl, 'Connector URL')}>Copy connector URL</button>
          </div>
          <p style={{ color: 'var(--text-3)', fontSize: 11.5, margin: '0 0 8px' }}>In Claude: Settings → Connectors → Add custom connector.</p>
          <button className="btn btn--small" onClick={() => setMinted(null)} data-testid="agent-token-done">Done</button>
        </div>
      )}

      {showForm ? (
        <div style={{ marginBottom: 12 }}>
          <input
            autoFocus
            className="input"
            placeholder="Token name (e.g. Claude on my laptop)"
            value={name}
            data-testid="agent-token-name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') create(); }}
            style={{ marginBottom: 8 }}
          />
          {projects !== null && projects.length > 0 && (
            <>
              <p style={{ color: 'var(--text-3)', fontSize: 11.5, margin: '0 0 4px' }}>Limit to specific projects — none checked means all your projects.</p>
              <div style={{ maxHeight: 110, overflowY: 'auto', border: '1px solid var(--hairline)', borderRadius: 'var(--radius-m)', padding: '4px 8px', marginBottom: 8 }}>
                {projects.map((p) => (
                  <label key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '2px 0', fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={scopeIds.includes(p.id)}
                      data-testid={`agent-token-scope-${p.id}`}
                      onChange={(e) => setScopeIds((cur) => e.target.checked ? [...cur, p.id] : cur.filter((id) => id !== p.id))}
                    />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                  </label>
                ))}
              </div>
            </>
          )}
          <select className="input" value={expiry} data-testid="agent-token-expiry" onChange={(e) => setExpiry(e.target.value)} style={{ marginBottom: 8 }}>
            {EXPIRY_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn btn--small" onClick={() => setShowForm(false)}>Cancel</button>
            <button className="btn btn--primary btn--small" onClick={create} disabled={busy} data-testid="agent-token-submit">{busy ? '…' : 'Create token'}</button>
          </div>
        </div>
      ) : (
        <button className="btn btn--small" onClick={() => setShowForm(true)} data-testid="agent-token-create" style={{ marginBottom: 4 }}>Create access token</button>
      )}

      {tokens !== null && tokens.length === 0 && !showForm && !minted && (
        <p style={{ color: 'var(--text-3)', fontSize: 11.5, margin: '6px 0 0' }}>No access tokens yet — create one to connect Claude to your projects.</p>
      )}
      {tokens?.map((t) => (
        <div key={t.id} className="settings__row" style={{ alignItems: 'center', gap: 10 }} data-testid={`agent-token-${t.id}`}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
            <span style={{ color: 'var(--text-3)', fontSize: 11.5 }}>Created {friendlyDate(t.createdAt)}</span>
            <span style={{ color: 'var(--text-3)', fontSize: 11.5 }}>{t.lastUsedAt ? `Used ${friendlyDate(t.lastUsedAt)}` : 'Never used'}</span>
            <button className="btn btn--ghost btn--small" onClick={() => revoke(t)} data-testid="agent-token-revoke">Revoke</button>
          </span>
        </div>
      ))}
    </>
  );
}

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
        <p className="modal__sub">{user.email}</p>

        <div className="settings__row">
          <span className="settings__label">Name</span>
          <span>{user.name}</span>
        </div>
        <div className="settings__row">
          <span className="settings__label">Sign-in</span>
          <span>{isSso ? `Single sign-on (${user.provider})` : 'Email & password'}</span>
        </div>

        {isSso ? (
          <p style={{ color: 'var(--text-2)', fontSize: 13, marginTop: 14 }}>
            Your password is managed by {user.provider}. There's nothing to change here.
          </p>
        ) : (
          <>
            <div className="menu__label" style={{ margin: '18px 0 6px' }}>Change password</div>
            <input className="input login__input" type="password" placeholder="Current password" value={current} data-testid="current-password" onChange={(e) => setCurrent(e.target.value)} />
            <input className="input login__input" type="password" placeholder="New password (min 8)" value={next} data-testid="new-password" onChange={(e) => setNext(e.target.value)} />
            <p style={{ color: 'var(--text-3)', fontSize: 11.5, margin: '4px 0 0' }}>Changing your password signs out your other sessions.</p>
          </>
        )}

        <AgentAccess />

        <div className="modal__row" style={{ marginTop: 18 }}>
          <button className="btn" onClick={onClose}>Close</button>
          {!isSso && <button className="btn btn--primary" onClick={change} disabled={busy} data-testid="save-password">{busy ? '…' : 'Update password'}</button>}
        </div>
      </div>
    </Modal>
  );
}
