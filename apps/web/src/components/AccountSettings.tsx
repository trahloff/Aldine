import { useEffect, useRef, useState } from 'react';
import { api, AccessToken, AccountDeletion, ApiError, AuthUser, PersonalTemplateRepo, ProjectSummary, RemoteConnectionRow, SignInMethods as Methods } from '../api';
import { remoteDescriptor } from '../remotes';
import { useToast } from './Toast';
import { useDialogs } from './Dialogs';
import { confirmDisconnect } from './RemoteAccess';
import { ACCOUNT_DELETED_KEY, useAuth } from './Auth';
import { withBase } from '../basePath';
import { safeSession } from '../util/safeStorage';
import Modal from './Modal';
import { friendlyDate } from '../util/dates';
import { ClaudeConnectSteps, useConnectorUrl } from './ClaudeConnect';
import LoadError from './LoadError';
import { storageLine } from '../util/storage';

/** What this account's projects occupy against the server's storage limit.
 *  Shown only when the server sets one (ALDINE_STORAGE_QUOTA_MB). */
function StorageRow() {
  const [storage, setStorage] = useState<{ usedBytes: number; limitBytes: number } | null>(null);
  useEffect(() => { api.usage().then((u) => setStorage(u.storage ?? null), () => {}); }, []);
  if (!storage || !storage.limitBytes) return null;
  const over = storage.usedBytes >= storage.limitBytes;
  return (
    <>
      <div className="settings__row" data-testid="account-storage-row">
        <span className="settings__label">Storage</span>
        <span data-testid="account-storage" style={over ? { color: 'var(--error)' } : undefined}>{storageLine(storage.usedBytes, storage.limitBytes)}</span>
      </div>
      {over && (
        <p className="login__hint" data-testid="account-storage-over">
          Your projects use all of your storage. Uploads, imports, new projects and duplicates are refused until you delete files or projects, or empty the trash. Editing keeps working.
        </p>
      )}
    </>
  );
}

/** The git host accounts this user connected, each with Disconnect. A
 *  replacement token is entered where it is used: Clone from a host, or a
 *  project's Git access. */
function GitHosts() {
  const [rows, setRows] = useState<RemoteConnectionRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const toast = useToast();
  const dialogs = useDialogs();
  const load = () => api.remoteConnections().then((r) => { setRows(r); setFailed(false); }, () => setFailed(true));
  useEffect(() => { load(); }, []);
  const disconnect = async (r: RemoteConnectionRow) => {
    if (!(await confirmDisconnect(r.provider, dialogs))) return;
    try { await api.remoteDisconnect(r.provider); toast(`Disconnected ${remoteDescriptor(r.provider).label}`, 'ok'); load(); }
    catch (err: any) { toast(err.message, 'error'); }
  };
  return (
    <div data-testid="account-git-hosts">
      <div className="menu__label" style={{ margin: '18px 0 6px' }}>Git hosts</div>
      {failed && <LoadError text="Couldn’t load your git hosts." onRetry={load} testId="account-git-hosts-error" />}
      {!failed && rows?.length === 0 && (
        <p style={{ color: 'var(--text-2)', fontSize: 'var(--text-m)', margin: 0 }}>No git host connected. Connect one from New → Clone, or from a project's Git access.</p>
      )}
      {rows?.map((r) => (
        <div className="settings__row" key={r.provider} data-testid={`account-git-${r.provider}`}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {remoteDescriptor(r.provider).label} · <strong>{r.login}</strong>
            {r.baseUrl && <span style={{ color: 'var(--text-3)' }}> on {r.baseUrl.replace(/^https?:\/\//, '')}</span>}
          </span>
          <button className="btn btn--small" onClick={() => disconnect(r)} data-testid={`account-git-${r.provider}-disconnect`}>Disconnect</button>
        </div>
      ))}
    </div>
  );
}

/** Template repositories only this account sees in the New project gallery.
 *  Hidden when the server turned them off (max 0) or answers 404. */
function PersonalTemplates() {
  const [data, setData] = useState<{ max: number; repos: PersonalTemplateRepo[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  const [folder, setFolder] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const dialogs = useDialogs();
  const load = () => api.personalTemplateRepos().then((r) => { setData(r); setFailed(false); }, (err) => {
    if (err instanceof ApiError && err.status === 404) setData({ max: 0, repos: [] });
    else setFailed(true);
  });
  useEffect(() => { load(); }, []);
  if (data && data.max === 0 && !data.repos.length) return null;
  const reset = () => { setAdding(false); setLabel(''); setUrl(''); setRef(''); setFolder(''); setError(''); };
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!url.trim()) { setError('Enter the repository’s https:// clone URL'); return; }
    setBusy(true);
    try {
      const { repo } = await api.addPersonalTemplateRepo({ label: label.trim() || undefined, url: url.trim(), ref: ref.trim() || undefined, path: folder.trim() || undefined });
      toast(`Added ${repo.label}: ${repo.templates} ${repo.templates === 1 ? 'template' : 'templates'}, shown only to you under New project`, 'ok');
      reset();
      load();
    } catch (err: any) {
      setError(err.message);
    }
    setBusy(false);
  };
  const remove = async (r: PersonalTemplateRepo) => {
    const yes = await dialogs.confirm({ title: `Remove ${r.label}?`, body: 'Its templates leave your gallery. Projects you started from them stay as they are, and the repository itself is not touched.', confirmLabel: 'Remove' });
    if (!yes) return;
    try { await api.removePersonalTemplateRepo(r.id); toast(`Removed ${r.label}`, 'ok'); load(); }
    catch (err: any) { toast(err.message, 'error'); }
  };
  const full = !!data && data.repos.length >= data.max;
  return (
    <div data-testid="account-templates">
      <div className="menu__label" style={{ margin: '18px 0 6px' }}>Personal templates</div>
      {failed && <LoadError text="Couldn’t load your template repositories." onRetry={load} testId="account-templates-error" />}
      {!failed && data?.repos.length === 0 && !adding && (
        <p style={{ color: 'var(--text-2)', fontSize: 'var(--text-m)', margin: 0 }}>Add a git repository of templates that only you see under New project, like letters with your address.</p>
      )}
      {data?.repos.map((r) => (
        <div className="settings__row" key={r.id} data-testid={`account-template-repo-${r.id}`}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.url}>
            <strong>{r.label}</strong>
            <span style={{ color: 'var(--text-3)' }}> · {r.url.replace(/^https?:\/\//, '')}</span>
            {r.ok || r.available
              ? <span style={{ color: 'var(--text-2)' }} data-testid={`account-template-repo-${r.id}-count`}> · {r.templates} {r.templates === 1 ? 'template' : 'templates'}</span>
              : null}
            {!r.ok && r.error && <span style={{ color: 'var(--error)' }} data-testid={`account-template-repo-${r.id}-error`}> · refresh failed: {r.error}</span>}
          </span>
          <button className="btn btn--small" onClick={() => remove(r)} aria-label={`Remove ${r.label}`} data-testid={`account-template-repo-${r.id}-remove`}>Remove</button>
        </div>
      ))}
      {!adding && data && !full && (
        <button type="button" className="btn btn--small" style={{ marginTop: 8 }} onClick={() => setAdding(true)} data-testid="account-templates-add">Add template repository</button>
      )}
      {!adding && full && data!.repos.length > 0 && (
        <p className="login__hint" data-testid="account-templates-full">You can add up to {data!.max}. Remove one to add another.</p>
      )}
      {adding && (
        <form onSubmit={add} noValidate data-testid="account-templates-form" style={{ display: 'grid', gap: 6, marginTop: 8 }}>
          <input className="input" value={url} onChange={(e) => { setUrl(e.target.value); setError(''); }} placeholder="https://github.com/you/latex-templates.git" aria-label="Repository URL" autoFocus spellCheck={false} autoComplete="off" aria-invalid={error ? true : undefined} data-testid="account-templates-url" />
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name in the gallery (optional)" aria-label="Name in the gallery" maxLength={60} data-testid="account-templates-label" />
          <span style={{ display: 'flex', gap: 6 }}>
            <input className="input" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Branch (default branch)" aria-label="Branch" spellCheck={false} autoComplete="off" data-testid="account-templates-ref" />
            <input className="input" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Folder (repository root)" aria-label="Folder" spellCheck={false} autoComplete="off" data-testid="account-templates-path" />
          </span>
          {error
            ? <p className="field__error" role="alert" data-testid="account-templates-error-text">{error}</p>
            : <p className="login__hint">Each template is a folder with a <code>template.json</code>, like the shared template repositories. A private repository is read with your connection to its host under Git hosts.</p>}
          <span style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn--small" onClick={reset} data-testid="account-templates-cancel">Cancel</button>
            <button type="submit" className="btn btn--small btn--primary" disabled={busy} aria-busy={busy || undefined} data-testid="account-templates-save">{busy ? 'Cloning…' : 'Add repository'}</button>
          </span>
        </form>
      )}
    </div>
  );
}

/** The Zotero key the account keeps for linking its projects, with a way to drop it. */
function ZoteroKey() {
  const [key, setKey] = useState<{ saved: boolean; username?: string | null } | null>(null);
  const [failed, setFailed] = useState(false);
  const toast = useToast();
  const load = () => api.zoteroKey().then((k) => { setKey(k); setFailed(false); }, () => setFailed(true));
  useEffect(() => { load(); }, []);
  const forget = async () => {
    try {
      await api.forgetZoteroKey();
      toast('Aldine no longer keeps your Zotero key. Projects linked with it keep syncing until you unlink them.', 'ok');
      load();
    } catch (err: any) { toast(err.message, 'error'); }
  };
  return (
    <div data-testid="account-zotero">
      <div className="menu__label" style={{ margin: '18px 0 6px' }}>Zotero</div>
      {failed && <LoadError text="Couldn’t load your Zotero key." onRetry={load} testId="account-zotero-error" />}
      {!failed && key && !key.saved && (
        <p style={{ color: 'var(--text-2)', fontSize: 'var(--text-m)', margin: 0 }} data-testid="account-zotero-none">No Zotero key saved. Paste one in a project’s Zotero panel; Aldine keeps it here for your other projects.</p>
      )}
      {!failed && key?.saved && (
        <div className="settings__row" data-testid="account-zotero-saved">
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Key saved{key.username ? <> for <strong>{key.username}</strong></> : null}
          </span>
          <button className="btn btn--small" onClick={forget} data-testid="account-zotero-forget">Forget key</button>
        </div>
      )}
    </div>
  );
}

/** The ways a password account signs in: its password, and the single
 *  sign-on providers it connected. Connect goes to the provider and comes
 *  back to this dialog; a session older than ten minutes asks for the
 *  password first. */
function SignInMethods({ focus }: { focus: boolean }) {
  const [m, setM] = useState<Methods | null>(null);
  const [failed, setFailed] = useState(false);
  const [asking, setAsking] = useState<{ id: string; label: string } | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const { refresh } = useAuth();
  const load = () => api.signInMethods().then((r) => { setM(r); setFailed(false); }, () => setFailed(true));
  useEffect(() => { load(); }, []);
  useEffect(() => { if (focus && m) ref.current?.scrollIntoView({ block: 'nearest' }); }, [focus, m]);
  useEffect(() => { if (asking) passwordRef.current?.focus(); }, [asking]);

  if (!failed && (!m || !m.canConnect || (m.providers.length === 0 && m.links.length === 0))) return null;

  const connect = async (p: { id: string; label: string }, typed?: string) => {
    if (busy) return;
    setBusy(p.id);
    setError('');
    try {
      const { url } = await api.connectSignIn(p.id, typed);
      window.location.assign(url);
      return;
    } catch (err: any) {
      if (err instanceof ApiError && err.code === 'reauth-required') {
        setAsking(p);
        if (typed !== undefined) setError(err.message);
      } else {
        toast(`Could not connect ${p.label}: ${err.message}`, 'error');
      }
    }
    setBusy(null);
  };
  const disconnect = async (p: { provider: string; label: string }) => {
    if (busy) return;
    setBusy(p.provider);
    try {
      await api.disconnectSignIn(p.provider);
      toast(`Disconnected ${p.label}. It no longer signs in to this account${p.provider === 'orcid' ? '. Invitations and projects shared with your ORCID iD no longer reach it either' : ''}.`, 'ok');
      await load();
      await refresh();
    } catch (err: any) {
      toast(err.message, 'error');
    }
    setBusy(null);
  };

  const unlinked = m ? m.providers.filter((p) => !m.links.some((l) => l.provider === p.id)) : [];
  return (
    <div ref={ref} data-testid="sign-in-methods">
      <div className="menu__label" style={{ margin: '18px 0 6px' }}>Sign-in methods</div>
      {failed && <LoadError text="Couldn’t load your sign-in methods." onRetry={load} testId="sign-in-methods-error" />}
      {m?.password && (
        <div className="settings__row" data-testid="sign-in-method-password">
          <span>Email &amp; password</span>
        </div>
      )}
      {m?.links.map((l) => (
        <div className="settings__row" key={l.provider} data-testid={`sign-in-method-${l.provider}`}>
          <span style={{ minWidth: 0 }}>
            {l.label} <span style={{ color: 'var(--text-3)' }}>· connected {friendlyDate(l.createdAt)}{l.configured ? '' : ' · no longer offered here'}</span>
          </span>
          <button className="btn btn--small" onClick={() => disconnect(l)} disabled={busy === l.provider} aria-label={`Disconnect ${l.label}`} data-testid={`sign-in-method-${l.provider}-disconnect`}>Disconnect</button>
        </div>
      ))}
      {unlinked.map((p) => (
        <div className="settings__row" key={p.id} data-testid={`sign-in-method-${p.id}`}>
          <span style={{ color: 'var(--text-2)' }}>{p.label}</span>
          <button className="btn btn--small" onClick={() => connect(p)} disabled={busy === p.id} aria-busy={busy === p.id || undefined} aria-label={`Connect ${p.label}`} data-testid={`sign-in-method-${p.id}-connect`}>Connect</button>
        </div>
      ))}
      {asking && (
        <form className="login__form" style={{ marginTop: 8 }} noValidate data-testid="sign-in-method-reauth"
          onSubmit={(e) => { e.preventDefault(); connect(asking, password); }}>
          <div className="login__field">
            <label className="field__label" htmlFor="sign-in-method-password">Enter your password to connect {asking.label}</label>
            <input id="sign-in-method-password" ref={passwordRef} className="input login__input" type="password" autoComplete="current-password" value={password}
              data-testid="sign-in-method-password-input" onChange={(e) => { setPassword(e.target.value); setError(''); }} />
            <p className="login__hint">You signed in more than 10 minutes ago, so confirm it is you.</p>
          </div>
          {error && <p className="login__error" role="alert" data-testid="sign-in-method-reauth-error">{error}</p>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn--small" onClick={() => { setAsking(null); setPassword(''); setError(''); }}>Cancel</button>
            <button type="submit" className="btn btn--primary btn--small" disabled={!password || !!busy} data-testid="sign-in-method-reauth-submit">Continue to {asking.label}</button>
          </div>
        </form>
      )}
      <p style={{ color: 'var(--text-3)', fontSize: 'var(--text-s)', margin: '6px 0 0' }}>A connected provider signs in to this account, as your password does.</p>
    </div>
  );
}

const EXPIRY_CHOICES = [
  { value: '', label: 'Never expires' },
  { value: '7', label: 'Expires in 7 days' },
  { value: '30', label: 'Expires in 30 days' },
  { value: '90', label: 'Expires in 90 days' },
];

/** Access tokens for agents (Claude connector onboarding lives here). Only
 *  mounted when auth is on — token routes 404 without users. */
function AgentAccess({ onSecret }: { onSecret?: (shown: boolean) => void }) {
  const [tokens, setTokens] = useState<AccessToken[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState('');
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [scopeIds, setScopeIds] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('');
  const [busy, setBusy] = useState(false);
  const [minted, setMinted] = useState<string | null>(null);
  useEffect(() => { onSecret?.(!!minted); }, [minted]);
  const [revoking, setRevoking] = useState<AccessToken | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const mintedRef = useRef<HTMLDivElement>(null);
  const tokenRef = useRef<HTMLElement>(null);
  const toast = useToast();
  const connectorUrl = useConnectorUrl();

  useEffect(() => { api.listTokens().then(setTokens).catch(() => setTokens([])); }, []);
  // Project names are needed for the form's scope picker and for the scope
  // shown on a scoped token's row.
  const needProjects = showForm || !!tokens?.some((t) => t.projectIds);
  useEffect(() => {
    if (needProjects && projects === null) api.listProjects().then(setProjects).catch(() => setProjects([]));
  }, [needProjects, projects]);

  // The card sits in a scrolling panel under a sticky action row: an element
  // that is inside the scrollport but under that row never scrolls on its
  // own, so the whole form (and later the whole token block) is brought
  // clear of it before focus lands. Focus on the new token also gives a
  // keyboard user the secret without a trip back to the top of the dialog.
  // The project checklist arrives after the form opened and grows it under
  // the footer again, so the scroll re-runs when the list lands.
  useEffect(() => {
    if (showForm) formRef.current?.scrollIntoView({ block: 'nearest' });
  }, [showForm, projects]);
  useEffect(() => {
    if (showForm) nameRef.current?.focus({ preventScroll: true });
  }, [showForm]);
  useEffect(() => {
    if (!minted) return;
    mintedRef.current?.scrollIntoView({ block: 'nearest' });
    tokenRef.current?.focus({ preventScroll: true });
  }, [minted]);

  const selectAll = (el: HTMLElement) => {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  };

  const copy = async (value: string, label: string, noun: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast(`${label} copied`, 'ok');
    } catch {
      toast(`Could not copy the ${noun} — select it and copy manually`, 'error');
    }
  };

  const create = async () => {
    const n = name.trim();
    if (!n) { setNameError('Give the token a name first'); nameRef.current?.focus(); toast('Give the token a name first', 'error'); return; }
    setBusy(true);
    try {
      const expiresAt = expiry ? new Date(Date.now() + Number(expiry) * 86400_000).toISOString() : undefined;
      const t = await api.createToken(n, scopeIds.length ? scopeIds : undefined, expiresAt);
      setMinted(t.token);
      setShowForm(false);
      setName(''); setScopeIds([]); setExpiry('');
      api.listTokens().then(setTokens).catch(() => {});
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 400 && /name/i.test(err.message)) setNameError(err.message);
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

  const projectName = (id: string) => projects?.find((p) => p.id === id)?.name ?? id;
  // One or two projects are named on the row itself; more become a count
  // with the names in the tooltip (see scopeNames).
  const scopeLabel = (t: AccessToken) => {
    if (!t.projectIds) return 'All projects';
    const n = t.projectIds.length;
    if (n <= 2 && projects !== null) return t.projectIds.map(projectName).join(', ');
    return `${n} project${n === 1 ? '' : 's'}`;
  };
  const scopeNames = (t: AccessToken) => t.projectIds
    ? t.projectIds.map(projectName).join(', ')
    : 'Every project you can open, now and later';

  const connections = tokens?.filter((t) => t.clientName !== null) ?? [];
  const scripted = tokens?.filter((t) => t.clientName === null) ?? [];

  const row = (t: AccessToken) => (
    <div key={t.id} className="settings__row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 2 }} data-testid={`agent-token-${t.id}`}>
      <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
        {t.clientName !== null && (
          <span className="gh-repo__badge" title="Created by the Connect button in Claude; revoking ends the connection and Claude asks you to connect again" data-testid="agent-token-via-connect">via Connect</span>
        )}
        <button className="btn btn--ghost btn--small" style={{ flexShrink: 0 }} onClick={() => setRevoking(t)} aria-label={`Revoke ${t.name}`} data-testid="agent-token-revoke">Revoke</button>
      </span>
      <span style={{ display: 'flex', gap: 10, flexWrap: 'wrap', color: 'var(--text-3)', fontSize: 'var(--text-s)' }}>
        <span title={scopeNames(t)} data-testid="agent-token-scope">{scopeLabel(t)}</span>
        <span>Created {friendlyDate(t.createdAt)}</span>
        <span>{t.lastUsedAt ? `Used ${friendlyDate(t.lastUsedAt)}` : 'Never used'}</span>
        {/* A Connect session's access token rotates daily; its expiry is the
            connection's plumbing, not when Claude loses access. */}
        {t.expiresAt && t.clientName === null && <span>Expires {friendlyDate(t.expiresAt)}</span>}
        {t.clientName !== null && <span>Renews itself while in use</span>}
      </span>
    </div>
  );

  return (
    <>
      <div className="menu__label" style={{ margin: '18px 0 6px' }}>Agent access</div>
      <ClaudeConnectSteps compact />

      {/* Listed before the token funnel so a person looking for "my Claude
          connection" finds it without scrolling; absent rather than empty
          so the Create button stays above the fold until there is one. */}
      {connections.length > 0 && (
        <>
          <div className="menu__label" style={{ margin: '14px 0 6px' }} data-testid="agent-connections">Connections</div>
          {connections.map(row)}
        </>
      )}

      <div className="menu__label" style={{ margin: '14px 0 6px' }}>Access tokens for scripts</div>
      <p style={{ color: 'var(--text-2)', fontSize: 'var(--text-m)', margin: '0 0 10px' }}>
        For scripts and anything without a Connect button: send a token as the Authorization bearer or the X-Aldine-Token header.
      </p>

      {minted && (
        <div ref={mintedRef} style={{ marginBottom: 12 }} role="status" aria-live="polite">
          <p style={{ color: 'var(--text-2)', fontSize: 'var(--text-m)', margin: '0 0 6px' }}>You won't see this again — copy the token now.</p>
          <code
            ref={tokenRef}
            className="agent-token"
            tabIndex={0}
            role="textbox"
            aria-readonly="true"
            aria-label="New access token"
            data-testid="agent-token-value"
            onFocus={(e) => selectAll(e.currentTarget)}
            onClick={(e) => selectAll(e.currentTarget)}
          >{minted}</code>
          <div style={{ display: 'flex', gap: 8, margin: '8px 0' }}>
            <button className="btn btn--primary btn--small" onClick={() => copy(minted, 'Token', 'token')} data-testid="agent-token-copy">Copy token</button>
            <button className="btn btn--small" onClick={() => setMinted(null)} data-testid="agent-token-done">Done</button>
          </div>
          <p style={{ color: 'var(--text-3)', fontSize: 'var(--text-s)', margin: 0 }}>Send it as <code>Authorization: Bearer …</code> or in an <code>X-Aldine-Token</code> header to {connectorUrl}. Claude connectors don’t need a token — use Connect.</p>
        </div>
      )}

      {showForm ? (
        <div ref={formRef} style={{ marginBottom: 12 }}>
          <label htmlFor="agent-token-name" style={{ display: 'block', fontSize: 'var(--text-s)', color: 'var(--text-2)', marginBottom: 4 }}>Token name</label>
          <input
            id="agent-token-name"
            ref={nameRef}
            className="input"
            placeholder="e.g. Claude on my laptop"
            value={name}
            maxLength={100}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? 'agent-token-name-error' : undefined}
            data-testid="agent-token-name"
            onChange={(e) => { setName(e.target.value); setNameError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') create(); }}
            style={{ marginBottom: 8 }}
          />
          {nameError && <p id="agent-token-name-error" className="field__error" data-testid="agent-token-name-error">{nameError}</p>}
          {projects !== null && projects.length > 0 && (
            <>
              <p style={{ color: 'var(--text-3)', fontSize: 'var(--text-s)', margin: '0 0 4px' }}>Limit to specific projects — none checked means all your projects.</p>
              <div style={{ maxHeight: 110, overflowY: 'auto', border: '1px solid var(--hairline)', borderRadius: 'var(--radius-m)', padding: '4px 8px', marginBottom: 8 }}>
                {projects.map((p) => (
                  <label key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '2px 0', fontSize: 'var(--text-m)' }}>
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
            <button className="btn btn--small" onClick={() => { setShowForm(false); setNameError(''); }}>Cancel</button>
            <button className="btn btn--primary btn--small" onClick={create} disabled={busy} aria-busy={busy || undefined} data-testid="agent-token-submit">{busy ? '…' : 'Create token'}</button>
          </div>
        </div>
      ) : (
        <button className="btn btn--small" onClick={() => setShowForm(true)} data-testid="agent-token-create" style={{ marginBottom: 4 }}>Create access token</button>
      )}

      {tokens !== null && scripted.length === 0 && !showForm && !minted && (
        <p style={{ color: 'var(--text-3)', fontSize: 'var(--text-s)', margin: '6px 0 0' }}>No access tokens yet.</p>
      )}
      {scripted.map(row)}

      {revoking && (
        <Modal onClose={() => setRevoking(null)} label="Revoke access token" testId="agent-token-revoke-dialog">
          <div>
            <h2>Revoke “{revoking.name}”?</h2>
            <p className="modal__sub">
              {scopeLabel(revoking)} · {revoking.lastUsedAt ? `last used ${friendlyDate(revoking.lastUsedAt)}` : 'never used'}
            </p>
            <p style={{ color: 'var(--text-2)', fontSize: 'var(--text-m)', margin: 0 }}>
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

const projectCount = (n: number) => `${n} ${n === 1 ? 'project' : 'projects'}`;
const peopleCount = (n: number) => `${n} ${n === 1 ? 'other person' : 'other people'}`;

/** Delete your account: names what goes, asks for the address typed out,
 *  and for the password (or a fresh sign-in) when the session is older than
 *  ten minutes. The server applies every rule again. */
function DeleteAccountDialog({ onClose }: { onClose(): void }) {
  const [info, setInfo] = useState<AccountDeletion | null>(null);
  const [failed, setFailed] = useState(false);
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api.accountDeletion().then((r) => { setInfo(r); setFailed(false); }, () => setFailed(true));
  useEffect(() => { load(); }, []);

  const matches = !!info && typed.trim().toLowerCase() === info.confirm.trim().toLowerCase();
  const canDelete = !!info && !info.refused && matches && info.reauth !== 'sign-in' && (info.reauth !== 'password' || password.length > 0) && !busy;
  const live = info?.projects.filter((p) => !p.trashed) ?? [];
  const trashed = info?.projects.filter((p) => p.trashed) ?? [];
  const shared = info?.projects.filter((p) => p.others > 0) ?? [];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canDelete || !info) return;
    setBusy(true);
    setError('');
    try {
      await api.deleteAccount(typed, info.reauth === 'password' ? password : undefined);
      safeSession.set(ACCOUNT_DELETED_KEY, '1');
      window.location.assign(withBase('/'));
      return;
    } catch (err: any) {
      // The ten minutes can run out while the dialog is open.
      if (err instanceof ApiError && err.code === 'reauth-required' && info.reauth === 'none') {
        setInfo({ ...info, reauth: /password/.test(err.message) ? 'password' : 'sign-in' });
      }
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    }
    setBusy(false);
  };

  const signOut = async () => {
    try { await api.logout(); } catch { /* the sign-in page follows either way */ }
    window.location.assign(withBase('/'));
  };

  let body: React.ReactNode;
  if (failed) body = <LoadError text="Couldn’t load what deleting your account involves." onRetry={load} testId="account-delete-load-error" />;
  else if (!info) body = <p className="modal__sub">Loading…</p>;
  else if (info.refused) {
    body = (
      <>
        <p className="modal__sub" data-testid="account-delete-refused">{info.refused}</p>
        <div className="modal__row">
          <button type="button" className="btn" onClick={onClose} data-testid="account-delete-cancel">Close</button>
        </div>
      </>
    );
  } else {
    body = (
      <form onSubmit={submit} noValidate data-testid="account-delete-form">
        <p className="modal__sub">
          This cannot be undone. Your account, its sessions, access tokens and agent connections are removed, and you come off every project shared with you.
        </p>
        {info.projects.length === 0 ? (
          <p className="modal__sub" data-testid="account-delete-no-projects">You own no projects.</p>
        ) : (
          <p className="modal__sub" data-testid="account-delete-projects">
            Your {projectCount(live.length)}{trashed.length ? ` and the ${projectCount(trashed.length)} in your trash` : ''} {info.projects.length === 1 ? 'is' : 'are'} deleted for good, with {info.projects.length === 1 ? 'its' : 'their'} history.
          </p>
        )}
        {shared.length > 0 && (
          <div data-testid="account-delete-shared">
            <p className="modal__sub" style={{ marginBottom: 4 }}>People lose access to these:</p>
            <ul style={{ margin: '0 0 8px', paddingLeft: 18, fontSize: 'var(--text-m)' }}>
              {shared.map((p) => (
                <li key={p.id} data-testid={`account-delete-shared-${p.id}`}>
                  <strong>{p.name}</strong> <span style={{ color: 'var(--text-2)' }}>· {peopleCount(p.others)}</span>
                </li>
              ))}
            </ul>
            <p className="login__hint">Export your data first, or ask them to make a copy of the project from their project list.</p>
          </div>
        )}
        {info.projects.length > 0 && (
          <p style={{ margin: '6px 0 12px' }}>
            <a className="btn btn--small" href={api.accountExportUrl()} download data-testid="account-delete-export">Export your data</a>
          </p>
        )}
        <label htmlFor="account-delete-confirm" className="field__label">Type <strong>{info.confirm}</strong> to confirm</label>
        <input
          id="account-delete-confirm"
          className="input"
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(e) => { setTyped(e.target.value); setError(''); }}
          data-testid="account-delete-confirm-input"
        />
        {info.reauth === 'password' && (
          <div className="login__field" style={{ marginTop: 10 }}>
            <label className="field__label" htmlFor="account-delete-password">Your password</label>
            <input id="account-delete-password" className="input login__input" type="password" autoComplete="current-password" value={password}
              data-testid="account-delete-password" onChange={(e) => { setPassword(e.target.value); setError(''); }} />
            <p className="login__hint">You signed in more than 10 minutes ago, so confirm it is you.</p>
          </div>
        )}
        {info.reauth === 'sign-in' && (
          <p className="login__hint" style={{ marginTop: 10 }} data-testid="account-delete-sign-in">
            You signed in more than 10 minutes ago. Sign out, sign in again, and delete the account within 10 minutes.{' '}
            <button type="button" className="link-button" onClick={signOut} data-testid="account-delete-sign-out">Sign out</button>
          </p>
        )}
        {error && <p className="login__error" role="alert" data-testid="account-delete-error">{error}</p>}
        <div className="modal__row">
          <button type="button" className="btn" onClick={onClose} data-testid="account-delete-cancel">Cancel</button>
          <button type="submit" className="btn btn--danger" disabled={!canDelete} aria-busy={busy || undefined} data-testid="account-delete-submit">{busy ? 'Deleting…' : 'Delete account'}</button>
        </div>
      </form>
    );
  }
  return (
    <Modal onClose={onClose} label="Delete your account" testId="account-delete-dialog" width={520} dismissable={!busy}>
      <div>
        <h2>Delete your account?</h2>
        {body}
      </div>
    </Modal>
  );
}

/** Export your data, and Delete account. */
function YourData() {
  const [deleting, setDeleting] = useState(false);
  return (
    <div data-testid="account-data">
      <div className="menu__label" style={{ margin: '18px 0 6px' }}>Your data</div>
      <p style={{ color: 'var(--text-2)', fontSize: 'var(--text-m)', margin: '0 0 8px' }}>
        One ZIP with your profile, sign-in methods, token names and comments, and every project you own with all its branches, each as the ZIP the Share dialog downloads. Projects shared with you are listed, without their files.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <a className="btn btn--small" href={api.accountExportUrl()} download data-testid="account-export">Export your data</a>
        <button type="button" className="btn btn--small btn--danger" onClick={() => setDeleting(true)} data-testid="account-delete">Delete account</button>
      </div>
      {deleting && <DeleteAccountDialog onClose={() => setDeleting(false)} />}
    </div>
  );
}

/** The name co-authors see on avatars, comments and commits; changed in place. */
function NameRow({ user }: { user: AuthUser }) {
  const { setUser } = useAuth();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(user.name);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const name = value.trim();
    if (!name) { setError('Enter a name'); return; }
    if (name === user.name) { setEditing(false); return; }
    setBusy(true);
    try {
      const r = await api.updateMe({ name });
      setUser(r.user);
      setEditing(false);
      setError('');
      toast(`Co-authors now see you as ${r.user.name}`, 'ok');
    } catch (err: any) {
      setError(err.message);
    }
    setBusy(false);
  };
  if (!editing) {
    return (
      <div className="settings__row" data-testid="account-name-row">
        <span className="settings__label">Name</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span data-testid="account-name" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.name}</span>
          <button type="button" className="link-button" onClick={() => { setValue(user.name); setError(''); setEditing(true); }} aria-label="Change your name" data-testid="account-name-edit">Change</button>
        </span>
      </div>
    );
  }
  return (
    <form onSubmit={save} noValidate data-testid="account-name-form">
      <div className="settings__row">
        <label className="settings__label" htmlFor="account-name-input">Name</label>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <input
            id="account-name-input"
            className="input"
            value={value}
            maxLength={100}
            autoComplete="name"
            autoFocus
            aria-describedby="account-name-hint"
            aria-invalid={error ? true : undefined}
            onChange={(e) => { setValue(e.target.value); setError(''); }}
            data-testid="account-name-input"
          />
          <button type="button" className="btn btn--small" onClick={() => { setEditing(false); setError(''); }} data-testid="account-name-cancel">Cancel</button>
          <button type="submit" className="btn btn--small btn--primary" disabled={busy} aria-busy={busy || undefined} data-testid="account-name-save">{busy ? 'Saving…' : 'Save'}</button>
        </span>
      </div>
      {error
        ? <p className="field__error" role="alert" data-testid="account-name-error">{error}</p>
        : <p className="login__hint" id="account-name-hint">Co-authors see it on your avatar, your comments and your commits.</p>}
    </form>
  );
}

/** Whether a mention in a review comment, or a thread assigned to this
 *  account, sends an email. Only where the server sends email at all. */
function CommentMailRow({ user }: { user: AuthUser }) {
  const { setUser, sendsEmail } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!sendsEmail || !user.email) return null;
  const on = user.commentMail !== 'off';
  const set = async (next: boolean) => {
    setBusy(true);
    try {
      const r = await api.updateMe({ commentMail: next });
      setUser(r.user);
      toast(next ? 'You get an email when someone mentions you or assigns you a comment' : 'No more emails about mentions and assigned comments', 'ok');
    } catch (err: any) {
      toast(`Could not change the setting: ${err.message}`, 'error');
    }
    setBusy(false);
  };
  return (
    <div className="settings__row" data-testid="account-comment-mail-row">
      <label className="settings__label" htmlFor="account-comment-mail">Email me about comments</label>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <input id="account-comment-mail" type="checkbox" checked={on} disabled={busy} onChange={(e) => void set(e.target.checked)} aria-describedby="account-comment-mail-hint" data-testid="account-comment-mail" />
        <span className="login__hint" id="account-comment-mail-hint" style={{ margin: 0 }}>When someone @mentions you or assigns you a thread</span>
      </span>
    </div>
  );
}

/** The author email on commits Aldine makes for this account (push,
 *  checkpoints, branch switches); the author name stays the account name. */
function CommitEmailRow({ user }: { user: AuthUser }) {
  const { setUser } = useAuth();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(user.commitEmail ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const commitEmail = value.trim();
    if (commitEmail === (user.commitEmail ?? '')) { setEditing(false); return; }
    setBusy(true);
    try {
      const r = await api.updateMe({ commitEmail });
      setUser(r.user);
      setEditing(false);
      setError('');
      toast(r.user.commitEmail ? `Your commits now use ${r.user.commitEmail}` : 'Your commits no longer use a commit email', 'ok');
    } catch (err: any) {
      setError(err.message);
    }
    setBusy(false);
  };
  if (!editing) {
    return (
      <div className="settings__row" data-testid="account-commit-email-row">
        <span className="settings__label">Commit email</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span data-testid="account-commit-email" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: user.commitEmail ? undefined : 'var(--text-2)' }}>{user.commitEmail || 'Not set'}</span>
          <button type="button" className="link-button" onClick={() => { setValue(user.commitEmail ?? ''); setError(''); setEditing(true); }} aria-label={user.commitEmail ? 'Change your commit email' : 'Set a commit email'} data-testid="account-commit-email-edit">{user.commitEmail ? 'Change' : 'Set'}</button>
        </span>
      </div>
    );
  }
  return (
    <form onSubmit={save} noValidate data-testid="account-commit-email-form">
      <div className="settings__row">
        <label className="settings__label" htmlFor="account-commit-email-input">Commit email</label>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <input
            id="account-commit-email-input"
            className="input"
            type="email"
            value={value}
            maxLength={254}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            placeholder="12345+name@users.noreply.github.com"
            aria-describedby="account-commit-email-hint"
            aria-invalid={error ? true : undefined}
            onChange={(e) => { setValue(e.target.value); setError(''); }}
            data-testid="account-commit-email-input"
          />
          <button type="button" className="btn btn--small" onClick={() => { setEditing(false); setError(''); }} data-testid="account-commit-email-cancel">Cancel</button>
          <button type="submit" className="btn btn--small btn--primary" disabled={busy} aria-busy={busy || undefined} data-testid="account-commit-email-save">{busy ? 'Saving…' : 'Save'}</button>
        </span>
      </div>
      {error
        ? <p className="field__error" role="alert" data-testid="account-commit-email-error">{error}</p>
        : <p className="login__hint" id="account-commit-email-hint">Commits Aldine makes for you carry this address, so GitHub or GitLab can link them to your profile. Use your host’s noreply address to keep your own private. Leave it empty to stop.</p>}
    </form>
  );
}

/** Account settings: identity, agent access, change password (password accounts only). */
export default function AccountSettings({ user, onClose, focus }: { user: AuthUser; onClose(): void; focus?: 'sign-in' }) {
  const [current, setCurrent] = useState('');
  const [secretShown, setSecretShown] = useState(false);
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const toast = useToast();
  const isSso = !!user.provider;
  const { providers } = useAuth();
  // OIDC is named by the operator (OIDC_LABEL); the default label is already "Single sign-on".
  const providerName = user.provider ? PROVIDER_NAME[user.provider] || providers.find((p) => p.id === user.provider)?.label || user.provider : '';
  const genericSso = providerName === 'Single sign-on';
  // The footer's password action is the hero only once both fields are
  // filled; before that it would sit as a second primary under "Create token".
  const passwordReady = current.length > 0 && next.length > 0;

  const change = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setPasswordError('');
    if (next.length < 8) { setPasswordError('New password must be at least 8 characters'); return; }
    setBusy(true);
    try {
      const { revokedTokens } = await api.changePassword(current, next);
      toast(revokedTokens ? 'Password updated. Agent access was revoked: reconnect your agents and create new tokens.' : 'Password updated', 'ok');
      setCurrent(''); setNext('');
      onClose();
    } catch (err: any) {
      setPasswordError(err.message);
    }
    setBusy(false);
  };

  return (
    <Modal onClose={onClose} label="Account settings" testId="account-settings" dismissable={!secretShown}>
      <div>
        <h2 style={{ marginBottom: 2 }}>Account</h2>
        <p className="modal__sub" data-testid="account-email">{user.email ?? 'No email address on this account'}</p>

        <NameRow user={user} />
        {user.orcid && (
          <div className="settings__row">
            <span className="settings__label">ORCID iD</span>
            <a href={`https://orcid.org/${user.orcid}`} target="_blank" rel="noreferrer" data-testid="account-orcid">{user.orcid}</a>
          </div>
        )}
        <div className="settings__row">
          <span className="settings__label">Sign-in</span>
          <span data-testid="account-sign-in">{isSso ? (genericSso ? 'Single sign-on' : `Single sign-on (${providerName})`) : 'Email & password'}</span>
        </div>
        <StorageRow />

        {/* The onboarding funnel comes before the password block: a 70vh
            panel opened at scrollTop 0 must show the connector and the
            Create button, not clip them under the sticky footer. */}
        <AgentAccess onSecret={setSecretShown} />

        <GitHosts />
        {/* Below the agent card, which must open above the sticky footer. */}
        <CommitEmailRow user={user} />
        <CommentMailRow user={user} />

        <PersonalTemplates />

        <ZoteroKey />

        {!isSso && <SignInMethods focus={focus === 'sign-in'} />}

        {isSso ? (
          <p style={{ color: 'var(--text-2)', fontSize: 'var(--text-m)', marginTop: 18 }}>
            Your password is managed by {genericSso ? 'your identity provider' : providerName}. There's nothing to change here.
            {user.orcid && !user.email && ' Collaborators invite you by your ORCID iD, since this account has no email address.'}
          </p>
        ) : (
          <>
            <div className="menu__label" id="change-password-label" style={{ margin: '18px 0 6px' }}>Change password</div>
            {/* A form a password manager recognises: Enter submits it, and the
                hidden username tells the manager which saved login to update. */}
            <form id="change-password" className="login__form" onSubmit={change} noValidate aria-labelledby="change-password-label" data-testid="change-password-form">
              <input type="text" name="username" autoComplete="username" value={user.email ?? ''} readOnly hidden />
              <div className="login__field">
                <label className="field__label" htmlFor="account-current-password">Current password</label>
                <input id="account-current-password" className="input login__input" type="password" name="current-password" autoComplete="current-password" value={current} data-testid="current-password" onChange={(e) => { setCurrent(e.target.value); setPasswordError(''); }} />
              </div>
              <div className="login__field">
                <label className="field__label" htmlFor="account-new-password">New password</label>
                <input id="account-new-password" className="input login__input" type="password" name="new-password" autoComplete="new-password" aria-describedby="account-new-password-hint" value={next} data-testid="new-password" onChange={(e) => { setNext(e.target.value); setPasswordError(''); }} />
                <p className="login__hint" id="account-new-password-hint">At least 8 characters.</p>
              </div>
              {passwordError && <p className="login__error" role="alert" data-testid="password-error">{passwordError}</p>}
            </form>
            <p style={{ color: 'var(--text-3)', fontSize: 'var(--text-s)', margin: '4px 0 0' }}>Changing your password signs out your other sessions and revokes agent access.</p>
          </>
        )}

        <YourData />

        <div className="modal__row" style={{ marginTop: 18 }}>
          <button className="btn" onClick={onClose}>Close</button>
          {!isSso && <button type="submit" form="change-password" className={`btn${passwordReady ? ' btn--primary' : ''}`} disabled={busy} aria-busy={busy || undefined} data-testid="save-password">{busy ? '…' : 'Update password'}</button>}
        </div>
      </div>
    </Modal>
  );
}
