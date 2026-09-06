import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, AuthUser, OAuthApiError, OAuthClientInfo, ProjectSummary } from '../api';
import { LoginScreen, useAuth } from '../components/Auth';
import { consentBody, OAUTH_RESUME_KEY, readAuthorizeParams } from '../util/oauthParams';

type ClientState =
  | { status: 'loading' }
  | { status: 'error'; message: string; detail?: string }
  | { status: 'ok'; client: OAuthClientInfo };

/** The server's protocol strings ("redirect_uri is not registered for this
 *  client") name nothing a researcher can do; the error code does. The raw
 *  string stays available for support. */
export function describeClientError(err: unknown): { message: string; detail?: string } {
  if (err instanceof OAuthApiError) {
    if (err.status === 429) return { message: 'Too many requests — wait a moment and reload this page.' };
    switch (err.code) {
      case 'invalid_redirect_uri':
        return { message: 'The app’s return address doesn’t match what it registered. Start the connection again from the app.', detail: err.message };
      case 'invalid_client':
        return { message: 'Aldine doesn’t recognize the app that sent you here. Start the connection again from the app; if it keeps failing, the app needs to register again.', detail: err.message };
      case 'invalid_request':
        return { message: 'This link is incomplete — start the connection again from the app.', detail: err.message };
    }
    return { message: 'Could not check the app that asked for access.', detail: err.message };
  }
  if (err instanceof TypeError) return { message: 'Aldine didn’t answer — check your connection and reload this page.' };
  return { message: 'Could not check the app that asked for access.', detail: err instanceof Error ? err.message : undefined };
}

/**
 * /oauth/authorize — the OAuth 2.1 consent page. The client is validated by
 * the server before anything else is shown, and an invalid client or
 * redirect ends here with no redirect at all: the only URLs this page ever
 * navigates to are the `redirectTo` the server hands back after checking them.
 */
export default function OAuthConsent() {
  const { authEnabled, user, setUser } = useAuth();
  const params = useMemo(() => readAuthorizeParams(window.location.search), []);
  const [client, setClient] = useState<ClientState>({ status: 'loading' });
  // Why the sign-in form is back (a session that expired mid-consent).
  const [notice, setNotice] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!authEnabled) {
      setClient({ status: 'error', message: 'Sign-in is switched off on this server, so there is no account to connect to.' });
      return;
    }
    let cancelled = false;
    api.getOAuthClient(params.clientId, params.redirectUri)
      .then((c) => { if (!cancelled) setClient({ status: 'ok', client: c }); })
      .catch((err: unknown) => {
        if (cancelled) return;
        setClient({ status: 'error', ...describeClientError(err) });
      });
    return () => { cancelled = true; };
  }, [authEnabled, params]);

  if (client.status === 'loading') {
    return <div className="login"><div className="spinner" /></div>;
  }

  if (client.status === 'error') {
    return (
      <div className="login">
        <div className="login__card consent" data-testid="oauth-error">
          <h1 className="home__brand" style={{ fontSize: 30, marginBottom: 2 }}>aldine<em>.</em></h1>
          <p className="home__tag" style={{ marginBottom: 14 }}>This connection request can’t continue.</p>
          <p className="consent__error" title={client.detail}>{client.message}</p>
          <p className="consent__hint">Nothing was granted. Go back to the app that sent you here and start the connection again.</p>
          {client.detail && (
            <details className="consent__detail" data-testid="oauth-error-detail">
              <summary>Details for support</summary>
              <code>{client.detail}</code>
            </details>
          )}
          <Link className="btn consent__back" to="/">Back to your projects</Link>
        </div>
      </div>
    );
  }

  if (!user) return <SignInStep client={client.client} onAuthed={setUser} notice={notice} />;
  return <ConsentStep client={client.client} params={params} onSessionEnded={() => setNotice('Your session ended before the request went through — sign in again to continue.')} />;
}

function SignInStep({ client, onAuthed, notice }: { client: OAuthClientInfo; onAuthed(u: AuthUser): void; notice?: string }) {
  const { providers, passwordAuth } = useAuth();
  // An SSO provider's callback lands on "/"; Home reads this key and brings
  // the user straight back here with the same request.
  useEffect(() => {
    try { sessionStorage.setItem(OAUTH_RESUME_KEY, window.location.search); } catch { /* private mode */ }
  }, []);
  return (
    <LoginScreen
      providers={providers}
      passwordAuth={passwordAuth}
      onAuthed={onAuthed}
      heading={`Sign in to connect ${client.name}.`}
      registerHeading={`Create an account to connect ${client.name}.`}
      notice={notice}
    />
  );
}

function ConsentStep({ client, params, onSessionEnded }: { client: OAuthClientInfo; params: ReturnType<typeof readAuthorizeParams>; onSessionEnded(): void }) {
  const { user, setUser } = useAuth();
  // null = still loading; 'error' = the list could not be fetched, which is
  // not the same as having no projects (an empty list would push the user
  // toward "All projects", the opposite of what they were choosing).
  const [projects, setProjects] = useState<ProjectSummary[] | 'error' | null>(null);
  const [scope, setScope] = useState<'all' | 'pick'>('all');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    try { sessionStorage.removeItem(OAUTH_RESUME_KEY); } catch { /* private mode */ }
    api.listProjects().then(setProjects).catch(() => setProjects('error'));
  }, []);

  const decide = async (decision: 'allow' | 'deny') => {
    setError('');
    setBusy(decision);
    try {
      const projectIds = scope === 'all' ? null : picked;
      const { redirectTo } = await api.postOAuthConsent(consentBody(params, decision, projectIds));
      window.location.assign(redirectTo);
    } catch (err: unknown) {
      if (err instanceof OAuthApiError && err.status === 401) {
        // The session ended while the page was open — sign in again in place.
        onSessionEnded();
        setUser(null);
        return;
      }
      setError(err instanceof TypeError
        ? 'Aldine didn’t answer — check your connection and try Allow again.'
        : err instanceof Error ? err.message : 'Something went wrong — try again.');
      setBusy(null);
    }
  };

  const projectList = Array.isArray(projects) ? projects : null;
  const allowDisabled = busy !== null || (scope === 'pick' && (projectList === null || picked.length === 0));

  return (
    <div className="login">
      <div className="login__card consent" data-testid="oauth-consent">
        <h1 className="home__brand" style={{ fontSize: 30, marginBottom: 2 }}>aldine<em>.</em></h1>
        <p className="home__tag" style={{ marginBottom: 18 }}>Connect an app to your projects.</p>

        <h2 className="consent__title">
          <span className="consent__client" data-testid="oauth-client-name">{client.name}</span> wants to work in your Aldine projects
        </h2>
        <p className="consent__origin">
          {client.kind === 'cimd' ? 'Identified by' : 'Registered from'} <code>{client.host}</code>
          {client.redirectHost && client.redirectHost !== client.host && <> · sends you back to <code>{client.redirectHost}</code></>}
        </p>
        {client.loopbackOnly && (
          <p className="consent__warn" data-testid="oauth-loopback-warning">
            This app runs on your own computer. Only continue if you started this request yourself.
          </p>
        )}

        <p className="consent__what">It will be able to read and edit the projects you choose, on your behalf, until you revoke access in Account settings.</p>

        <div className="consent__scope" role="radiogroup" aria-label="Which projects">
          <label className="consent__option">
            <input type="radio" name="oauth-scope" checked={scope === 'all'} data-testid="oauth-scope-all" onChange={() => setScope('all')} />
            <span>
              <span className="consent__option-title">All projects, now and later</span>
              <span className="consent__option-sub">Includes projects you create or are invited to after today.</span>
            </span>
          </label>
          <label className="consent__option">
            <input type="radio" name="oauth-scope" checked={scope === 'pick'} data-testid="oauth-scope-pick" onChange={() => setScope('pick')} />
            <span>
              <span className="consent__option-title">Only these projects</span>
              <span className="consent__option-sub">Pick from the projects you can open today.</span>
            </span>
          </label>
          {scope === 'pick' && (
            <div className="consent__projects" data-testid="oauth-project-list">
              {projects === null && <div className="spinner" style={{ margin: '8px auto' }} />}
              {projects === 'error' && (
                <p className="consent__error" style={{ margin: '6px 0' }} data-testid="oauth-projects-error">
                  Could not load your projects — <button type="button" className="btn btn--ghost btn--small" onClick={() => window.location.reload()}>Reload the page</button> or choose “All projects”.
                </p>
              )}
              {projectList !== null && projectList.length === 0 && <p className="consent__hint" style={{ margin: '6px 0' }}>You have no projects yet — choose “All projects” or create one first.</p>}
              {projectList !== null && projectList.length > 0 && picked.length === 0 && <p className="consent__hint" style={{ margin: '4px 0 2px' }} data-testid="oauth-pick-hint">Pick at least one project to continue.</p>}
              {projectList?.map((p) => (
                <label key={p.id} className="consent__project">
                  <input
                    type="checkbox"
                    checked={picked.includes(p.id)}
                    data-testid={`oauth-project-${p.id}`}
                    onChange={(e) => setPicked((cur) => e.target.checked ? [...cur, p.id] : cur.filter((id) => id !== p.id))}
                  />
                  <span className="consent__project-name">{p.name}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {error && <p className="login__error" data-testid="oauth-consent-error">{error}</p>}

        <div className="consent__actions">
          <button className="btn" onClick={() => decide('deny')} disabled={busy !== null} data-testid="oauth-deny">{busy === 'deny' ? '…' : 'Deny'}</button>
          <button className="btn btn--primary" onClick={() => decide('allow')} disabled={allowDisabled} aria-busy={busy === 'allow' || undefined} data-testid="oauth-allow">{busy === 'allow' ? '…' : 'Allow'}</button>
        </div>

        <p className="consent__who">
          Signed in as <strong>{user?.name}</strong>
          <button className="btn btn--ghost btn--small" data-testid="oauth-switch-account" onClick={async () => { await api.logout().catch(() => {}); setUser(null); }}>Not you? Switch account</button>
        </p>
      </div>
    </div>
  );
}
