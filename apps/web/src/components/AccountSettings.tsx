import { useEffect, useState } from 'react';
import { api, AccessToken, AuthUser, ProjectSummary } from '../api';
import { withBase } from '../basePath';
import { useToast } from './Toast';
import { useAuth } from './Auth';
import Modal from './Modal';
import { friendlyDate } from '../util/dates';

const EXPIRY_CHOICES = [
  { value: '', label: 'Never expires' },
  { value: '7', label: 'Expires in 7 days' },
  { value: '30', label: 'Expires in 30 days' },
  { value: '90', label: 'Expires in 90 days' },
];

/** claude.ai calls the instance from Anthropic's cloud: plain http, loopback,
 *  RFC 1918 ranges and .local names never resolve from there. Claude Code
 *  (on the user's machine) reaches them fine. */
export function unreachableFromCloud(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return true;
    const h = u.hostname;
    return h === 'localhost' || /\.local$/i.test(h) || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h === '::1' || h === '[::1]';
  } catch { return true; }
}

/** Access tokens for agents (Claude connector onboarding lives here). Only
 *  mounted when auth is on — token routes 404 without users. */
function AgentAccess() {
  const { mcpEnabled } = useAuth();
  const [tokens, setTokens] = useState<AccessToken[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [scopeIds, setScopeIds] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('');
  const [busy, setBusy] = useState(false);
  const [minted, setMinted] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<AccessToken | null>(null);
  const toast = useToast();
  const connectorUrl = `${location.origin}${withBase('/mcp')}`;
  const cloudBlocked = unreachableFromCloud(connectorUrl);

  useEffect(() => { api.listTokens().then(setTokens).catch(() => setTokens([])); }, []);
  // Project names are needed for the form's scope picker and for the scope
  // shown on a scoped token's row.
  const needProjects = showForm || !!tokens?.some((t) => t.projectIds);
  useEffect(() => {
    if (needProjects && projects === null) api.listProjects().then(setProjects).catch(() => setProjects([]));
  }, [needProjects, projects]);

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
    setRevoking(null);
    try {
      await api.revokeToken(t.id);
      setTokens((cur) => cur?.filter((x) => x.id !== t.id) ?? cur);
      toast(`Revoked ${t.name}`, 'ok');
    } catch (err: any) {
      toast(`Could not revoke the token: ${err.message}`, 'error');
    }
  };

  const scopeLabel = (t: AccessToken) => {
    if (!t.projectIds) return 'All projects';
    const n = t.projectIds.length;
    return `${n} project${n === 1 ? '' : 's'}`;
  };
  const scopeNames = (t: AccessToken) => t.projectIds
    ? t.projectIds.map((id) => projects?.find((p) => p.id === id)?.name ?? id).join(', ')
    : 'Every project you can open, now and later';

  return (
    <>
      <div className="menu__label" style={{ margin: '18px 0 6px' }}>Agent access</div>
      {!mcpEnabled ? (
        <p style={{ color: 'var(--text-2)', fontSize: 13, margin: '0 0 12px' }} data-testid="agent-connector-off">
          The Claude connector is not enabled on this server. Whoever runs it sets <code>ALDINE_MCP=1</code> (docs/AGENT_API.md); the tokens below then work at <code>{connectorUrl}</code>.
        </p>
      ) : (
        <>
          <p style={{ color: 'var(--text-2)', fontSize: 13, margin: '0 0 6px' }}>
            {cloudBlocked
              ? 'In Claude Code: claude mcp add --transport http aldine <connector URL>, then /mcp → login. You pick which projects Claude may touch when it asks.'
              : 'In Claude: Settings → Connectors → Add custom connector → Connect. You pick which projects Claude may touch when it asks.'}
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: cloudBlocked ? 6 : 12 }}>
            <code data-testid="agent-connector-url" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>{connectorUrl}</code>
            <button className="btn btn--small" style={{ flexShrink: 0, marginLeft: 'auto' }} onClick={() => copy(connectorUrl, 'Connector URL')} data-testid="agent-connector-copy">Copy connector URL</button>
          </div>
          {cloudBlocked && (
            <p style={{ color: 'var(--text-3)', fontSize: 11.5, margin: '0 0 12px' }} data-testid="agent-connector-unreachable">
              claude.ai, Claude Desktop and Cowork call this address from Anthropic's cloud and cannot reach it — use Claude Code on this machine, or expose the instance over public HTTPS (docs/AGENT_API.md, “Reachability”).
            </p>
          )}
        </>
      )}

      <div className="menu__label" style={{ margin: '14px 0 6px' }}>Access tokens for scripts</div>
      <p style={{ color: 'var(--text-2)', fontSize: 13, margin: '0 0 10px' }}>
        For scripts and anything without a Connect button: send a token as the Authorization bearer or the X-Aldine-Token header. Connections made through Connect show up here too and can be revoked the same way.
      </p>

      {minted && (
        <div style={{ marginBottom: 12 }}>
          <p style={{ color: 'var(--text-2)', fontSize: 13, margin: '0 0 6px' }}>You won't see this again — copy the token now.</p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <input className="input" readOnly value={minted} aria-label="New access token" data-testid="agent-token-value" style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)', fontSize: 12 }} onFocus={(e) => e.target.select()} />
            <button className="btn btn--small" style={{ flexShrink: 0 }} onClick={() => copy(minted, 'Token')} data-testid="agent-token-copy">Copy token</button>
          </div>
          <p style={{ color: 'var(--text-3)', fontSize: 11.5, margin: '0 0 8px' }}>Send it as <code>Authorization: Bearer …</code> or in an <code>X-Aldine-Token</code> header to {connectorUrl}. Claude connectors don’t need a token — use Connect.</p>
          <button className="btn btn--small" onClick={() => setMinted(null)} data-testid="agent-token-done">Done</button>
        </div>
      )}

      {showForm ? (
        <div style={{ marginBottom: 12 }}>
          <label htmlFor="agent-token-name" style={{ display: 'block', fontSize: 12, color: 'var(--text-2)', marginBottom: 4 }}>Token name</label>
          <input
            id="agent-token-name"
            autoFocus
            className="input"
            placeholder="e.g. Claude on my laptop"
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
          <select className="input" value={expiry} aria-label="Token expiry" data-testid="agent-token-expiry" onChange={(e) => setExpiry(e.target.value)} style={{ marginBottom: 8 }}>
            {EXPIRY_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn btn--small" onClick={() => setShowForm(false)}>Cancel</button>
            <button className="btn btn--primary btn--small" onClick={create} disabled={busy} aria-busy={busy || undefined} data-testid="agent-token-submit">{busy ? '…' : 'Create token'}</button>
          </div>
        </div>
      ) : (
        <button className="btn btn--small" onClick={() => setShowForm(true)} data-testid="agent-token-create" style={{ marginBottom: 4 }}>Create access token</button>
      )}

      {tokens !== null && tokens.length === 0 && !showForm && !minted && (
        <p style={{ color: 'var(--text-3)', fontSize: 11.5, margin: '6px 0 0' }}>No access tokens yet — nothing is connected to your projects.</p>
      )}
      {tokens?.map((t) => (
        <div key={t.id} className="settings__row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 2 }} data-testid={`agent-token-${t.id}`}>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
            {t.clientName !== null && (
              <span className="gh-repo__badge" title="Created by the Connect button in Claude; revoking also ends its refresh tokens" data-testid="agent-token-via-connect">via Connect</span>
            )}
            <button className="btn btn--ghost btn--small" style={{ flexShrink: 0 }} onClick={() => setRevoking(t)} aria-label={`Revoke ${t.name}`} data-testid="agent-token-revoke">Revoke</button>
          </span>
          <span style={{ display: 'flex', gap: 10, flexWrap: 'wrap', color: 'var(--text-3)', fontSize: 11.5 }}>
            <span title={scopeNames(t)} data-testid="agent-token-scope">{scopeLabel(t)}</span>
            <span>Created {friendlyDate(t.createdAt)}</span>
            <span>{t.lastUsedAt ? `Used ${friendlyDate(t.lastUsedAt)}` : 'Never used'}</span>
            {/* A Connect session's access token rotates daily; its expiry is the
                connection's plumbing, not when Claude loses access. */}
            {t.expiresAt && t.clientName === null && <span>Expires {friendlyDate(t.expiresAt)}</span>}
            {t.clientName !== null && <span>Renews itself while in use</span>}
          </span>
        </div>
      ))}

      {revoking && (
        <Modal onClose={() => setRevoking(null)} label="Revoke access token" testId="agent-token-revoke-dialog">
          <div>
            <h2>Revoke “{revoking.name}”?</h2>
            <p className="modal__sub">
              {scopeLabel(revoking)} · {revoking.lastUsedAt ? `last used ${friendlyDate(revoking.lastUsedAt)}` : 'never used'}
            </p>
            <p style={{ color: 'var(--text-2)', fontSize: 13, margin: 0 }}>
              Anything connected with it loses access at its next request{revoking.clientName !== null ? ' and Claude will ask you to connect again' : ''}.
            </p>
            <div className="modal__row">
              <button className="btn" onClick={() => setRevoking(null)}>Keep it</button>
              <button className="btn btn--primary" onClick={() => revoke(revoking)} data-testid="agent-token-revoke-confirm">Revoke</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

const PROVIDER_NAME: Record<string, string> = { github: 'GitHub', google: 'Google', orcid: 'ORCID' };

/** Account settings: identity, agent access, change password (password accounts only). */
export default function AccountSettings({ user, onClose }: { user: AuthUser; onClose(): void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const isSso = !!user.provider;
  // The footer's password action is the hero only once both fields are
  // filled; before that it would sit as a second primary under "Create token".
  const passwordReady = current.length > 0 && next.length > 0;

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

        {/* The onboarding funnel comes before the password block: a 70vh
            panel opened at scrollTop 0 must show the connector and the
            Create button, not clip them under the sticky footer. */}
        <AgentAccess />

        {isSso ? (
          <p style={{ color: 'var(--text-2)', fontSize: 13, marginTop: 18 }}>
            Your password is managed by {PROVIDER_NAME[user.provider!] || user.provider}. There's nothing to change here.
            {user.orcid && !user.email && ' Collaborators invite you by your ORCID iD, since this account has no email address.'}
          </p>
        ) : (
          <>
            <div className="menu__label" style={{ margin: '18px 0 6px' }}>Change password</div>
            <input className="input login__input" type="password" placeholder="Current password" aria-label="Current password" value={current} data-testid="current-password" onChange={(e) => setCurrent(e.target.value)} />
            <input className="input login__input" type="password" placeholder="New password (min 8)" aria-label="New password" value={next} data-testid="new-password" onChange={(e) => setNext(e.target.value)} />
            <p style={{ color: 'var(--text-3)', fontSize: 11.5, margin: '4px 0 0' }}>Changing your password signs out your other sessions.</p>
          </>
        )}

        <div className="modal__row" style={{ marginTop: 18 }}>
          <button className="btn" onClick={onClose}>Close</button>
          {!isSso && <button className={`btn${passwordReady ? ' btn--primary' : ''}`} onClick={change} disabled={busy} aria-busy={busy || undefined} data-testid="save-password">{busy ? '…' : 'Update password'}</button>}
        </div>
      </div>
    </Modal>
  );
}
