import { createContext, useContext, useEffect, useState, type JSX } from 'react';
import { withBase } from '../basePath';
import { api, ApiError, AuthUser, OAuthProviderInfo } from '../api';
import Wordmark from './Wordmark';
import { useDocumentTitle } from '../util/documentTitle';
import { forgetInviteResume } from '../util/invites';
import { forgetOAuthResume } from '../util/oauthParams';

/** The outcome of following a confirmation link, for the banner to show. */
export interface EmailNotice { tone: 'ok' | 'error'; text: string }

interface AuthState {
  loading: boolean;
  authEnabled: boolean;
  user: AuthUser | null;
  /** Instance administrator (server allow-list); gates the /admin link only,
   *  the server enforces the routes. */
  admin: boolean;
  providers: OAuthProviderInfo[];
  passwordAuth: boolean;
  /** ALDINE_MCP=1 on this server — the Agent access card must not advertise a connector URL that answers 404. */
  mcpEnabled: boolean;
  /** ALDINE_PUBLIC_URL as the server knows it (null when unset). */
  publicUrl: string | null;
  /** Confirmation links go out by mail (otherwise the operator relays them from the log). */
  sendsEmail: boolean;
  emailNotice: EmailNotice | null;
  clearEmailNotice(): void;
  setUser(u: AuthUser | null): void;
  refresh(): Promise<void>;
}

const Ctx = createContext<AuthState>({ loading: true, authEnabled: false, user: null, admin: false, providers: [], passwordAuth: true, mcpEnabled: false, publicUrl: null, sendsEmail: false, emailNotice: null, clearEmailNotice: () => {}, setUser: () => {}, refresh: async () => {} });

const CONFIRM_PARAM = 'confirm_email';
/** Drop the confirmation token from the address bar, keeping everything else. */
function stripConfirmParam() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(CONFIRM_PARAM)) return;
  url.searchParams.delete(CONFIRM_PARAM);
  window.history.replaceState({}, '', url.pathname + url.search + url.hash);
}

/** The OAuth consent page validates the requesting client BEFORE asking for
 *  credentials and renders the sign-in form itself, so the provider's gate
 *  must let it mount while signed out. So does an invitation page, which
 *  says who the invitation is for before asking anyone to sign in. */
const SELF_GATED_PATHS = ['/oauth/authorize'];
const SELF_GATED_PREFIXES = ['/invite/'];

export function useAuth() { return useContext(Ctx); }

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [admin, setAdmin] = useState(false);
  const [providers, setProviders] = useState<OAuthProviderInfo[]>([]);
  const [passwordAuth, setPasswordAuth] = useState(true);
  const [mcpEnabled, setMcpEnabled] = useState(false);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [sendsEmail, setSendsEmail] = useState(false);
  const [emailNotice, setEmailNotice] = useState<EmailNotice | null>(null);
  // Arriving from a confirmation link (…/?confirm_email=…). The token stays in
  // the address bar until it is used, so a reload on the sign-in form keeps it.
  const [confirmToken, setConfirmToken] = useState<string | null>(() => new URLSearchParams(window.location.search).get(CONFIRM_PARAM));

  const refresh = async () => {
    try {
      const me = await api.me();
      setAuthEnabled(me.authEnabled);
      setUser(me.user);
      setAdmin(!!me.admin);
      setProviders(me.providers || []);
      setPasswordAuth(me.passwordAuth !== false);
      setMcpEnabled(me.mcpEnabled === true);
      setPublicUrl(me.publicUrl || null);
      setSendsEmail(me.sendsEmail === true);
    } catch {
      setAuthEnabled(false);
      setUser(null);
      setAdmin(false);
    }
    setLoading(false);
  };

  useEffect(() => { refresh(); }, []);

  // The server confirms only for the account the link was sent for, so this
  // waits until someone is signed in. A confirmed account cannot tell whether
  // the link was its own (the link's digest is gone once confirmed), so the
  // notice covers a link meant for another account too; that link still
  // works there, since nothing was spent.
  useEffect(() => {
    if (!confirmToken || !user) return;
    const token = confirmToken;
    setConfirmToken(null);
    stripConfirmParam();
    if (!user.emailPending) {
      setEmailNotice({ tone: 'ok', text: `The address of the account you are signed in to${user.email ? ` (${user.email})` : ''} is already confirmed. If the link is for another account, sign out, open the link again and sign in to that account.` });
      return;
    }
    api.confirmEmail(token).then(
      (r) => { setUser(r.user); setEmailNotice({ tone: 'ok', text: 'Your email address is confirmed. Projects shared with it are in your list now, and invitations to it are on this page.' }); },
      (err: any) => setEmailNotice({ tone: 'error', text: err.message }),
    );
  }, [confirmToken, user]);

  if (loading) return <div style={{ height: '100%' }} />;

  // Show the login/reset screen when signed out, OR when a reset link was opened
  // in an already-signed-in session (otherwise the ?reset_token= link does nothing).
  const hasResetToken = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('reset_token');
  const selfGated = typeof window !== 'undefined' && (SELF_GATED_PATHS.some((p) => window.location.pathname === withBase(p))
    || SELF_GATED_PREFIXES.some((p) => window.location.pathname.startsWith(withBase(p))));
  if (authEnabled && (!user || hasResetToken) && !selfGated) {
    return (
      <LoginScreen
        providers={providers}
        passwordAuth={passwordAuth}
        onAuthed={(u) => setUser(u)}
        onStart={() => { forgetInviteResume(); forgetOAuthResume(); }}
        notice={confirmToken && !user ? 'Sign in to confirm your email address.' : undefined}
      />
    );
  }

  return <Ctx.Provider value={{ loading, authEnabled, user, admin, providers, passwordAuth, mcpEnabled, publicUrl, sendsEmail, emailNotice, clearEmailNotice: () => setEmailNotice(null), setUser, refresh }}>{children}</Ctx.Provider>;
}

type Mode = 'login' | 'register' | 'forgot' | 'reset';

const PROVIDER_ICON: Record<string, JSX.Element> = {
  orcid: (
    <svg width="15" height="15" viewBox="0 0 256 256" aria-hidden="true"><circle cx="128" cy="128" r="128" fill="#A6CE39"/><path fill="#fff" d="M86.3 186.2H70.9V79.1h15.4v107.1zM108.9 79.1h41.6c39.6 0 57 28.3 57 53.6 0 27.5-21.5 53.6-56.8 53.6h-41.8V79.1zm15.4 93.3h24.5c34.9 0 42.9-26.5 42.9-39.7 0-21.5-13.7-39.7-43.7-39.7h-23.7v79.4zM88.7 56.8c0 5.5-4.5 10.1-10.1 10.1s-10.1-4.6-10.1-10.1c0-5.6 4.5-10.1 10.1-10.1s10.1 4.6 10.1 10.1z"/></svg>
  ),
  github: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
  ),
  oidc: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="5.5" cy="10.5" r="3"/><path d="M7.6 8.4 14 2m-2.5 2.5 1.8 1.8M9.8 6.2l1.4 1.4"/></svg>
  ),
  google: (
    <svg width="15" height="15" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62Z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"/><path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"/></svg>
  ),
};

/** `heading`/`registerHeading` keep the caller's context ("connect Claude")
 *  on both the sign-in and the sign-up step; `notice` is an info line shown
 *  on arrival (why the person is back at the form) — `noticeTone` 'warn' for
 *  a setback (an ended session), the default green for a completed step.
 *  `initialEmail` fills the address in (the one an invitation is for). */
export function LoginScreen({ providers, passwordAuth, onAuthed, onStart, heading, registerHeading, notice, noticeTone, initialEmail }: {
  providers: OAuthProviderInfo[];
  passwordAuth: boolean;
  onAuthed(u: AuthUser): void;
  /** A sign-in starts here: a provider link followed, or the form sent to sign in or register. */
  onStart?(): void;
  heading?: string;
  registerHeading?: string;
  notice?: string;
  noticeTone?: 'ok' | 'warn';
  initialEmail?: string;
}) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState(initialEmail ?? '');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState(notice ?? '');
  const [busy, setBusy] = useState(false);
  // A throttled sign-in: the button waits out the server's Retry-After.
  const [waitUntil, setWaitUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const waitLeft = Math.max(0, Math.ceil((waitUntil - now) / 1000));
  useEffect(() => {
    if (!waitUntil) return;
    const t = window.setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= waitUntil) { setWaitUntil(0); window.clearInterval(t); }
    }, 250);
    return () => window.clearInterval(t);
  }, [waitUntil]);

  const reset = () => { setError(''); setInfo(''); setWaitUntil(0); };

  // Arriving from a password-reset email link (…/?reset_token=…): pre-fill the
  // token and jump straight to the "set a new password" step.
  useEffect(() => {
    const url = new URL(window.location.href);
    const t = url.searchParams.get('reset_token');
    if (t) {
      setToken(t);
      setMode('reset');
      setInfo('Set a new password below.');
      // strip only reset_token, preserving any co-arriving query params / hash
      url.searchParams.delete('reset_token');
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    }
  }, []);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy || waitLeft > 0) return;
    reset();
    setBusy(true);
    if (mode === 'login' || mode === 'register') onStart?.();
    try {
      if (mode === 'login') onAuthed((await api.login(email.trim(), password)).user);
      else if (mode === 'register') onAuthed((await api.register(email.trim(), password, name.trim() || undefined)).user);
      else if (mode === 'forgot') {
        const r = await api.resetRequest(email.trim());
        if (r.token) { setToken(r.token); setMode('reset'); setInfo('Reset token issued (self-host mode). Set a new password below.'); }
        else { setInfo('If an account exists for that email, a reset link has been sent.'); }
        setBusy(false);
        return;
      } else if (mode === 'reset') {
        const { revokedTokens } = await api.resetPassword(token.trim(), password);
        setInfo(revokedTokens ? 'Password updated, and agent access was revoked. Sign in, then reconnect your agents.' : 'Password updated. You can sign in now.');
        setMode('login'); setPassword(''); setBusy(false);
        return;
      }
    } catch (err: any) {
      setError(err.message);
      if (err instanceof ApiError && err.status === 429 && err.retryAfter) { setNow(Date.now()); setWaitUntil(Date.now() + err.retryAfter * 1000); }
      setBusy(false);
    }
  };

  const title = mode === 'login' ? (heading ?? 'Sign in to your projects.')
    : mode === 'register' ? (registerHeading ?? 'Create an account to get started.')
    : mode === 'forgot' ? 'Reset your password.'
    : 'Set a new password.';
  useDocumentTitle(mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create an account' : 'Reset password');
  const submitLabel = mode === 'login' ? (busy ? 'Signing in…' : 'Sign in')
    : mode === 'register' ? (busy ? 'Creating account…' : 'Create account')
    : mode === 'forgot' ? (busy ? 'Sending…' : 'Send reset link')
    : (busy ? 'Setting password…' : 'Set password');

  return (
    <main className="login">
      <div className="login__card">
        <h1 className="home__brand"><Wordmark height={21} /></h1>
        <p className="login__tagline">Write LaTeX together. Fast, versioned, yours.</p>
        <h2 className="home__tag login__title">{title}</h2>

        {providers.map((p) => (
          <a key={p.id} className="btn login__oauth" href={withBase(`/api/auth/oauth/${p.id}`)} onClick={onStart} data-testid={`oauth-${p.id}`}>
            {PROVIDER_ICON[p.id]}
            {p.label === 'Single sign-on' ? 'Continue with single sign-on' : `Continue with ${p.label}`}
          </a>
        ))}
        {providers.length > 0 && passwordAuth && <div className="login__or">or</div>}

        {!passwordAuth && providers.length === 0 && (
          <p className="login__error" role="alert">No sign-in method is configured. Contact the administrator.</p>
        )}

        {passwordAuth && (
          <>
            <form className="login__form" onSubmit={submit} noValidate aria-label={title}>
              {mode === 'register' && (
                <div className="login__field">
                  <label className="field__label" htmlFor="auth-name">Name <span className="login__optional">(optional)</span></label>
                  <input id="auth-name" className="input login__input" name="name" autoComplete="name" value={name} maxLength={100} data-testid="auth-name" onChange={(e) => setName(e.target.value)} />
                </div>
              )}
              {mode !== 'reset' && (
                <div className="login__field">
                  <label className="field__label" htmlFor="auth-email">Email</label>
                  <input id="auth-email" className="input login__input" type="email" name="email" autoComplete="username" inputMode="email" autoCapitalize="none" spellCheck={false} value={email} data-testid="auth-email" autoFocus onChange={(e) => setEmail(e.target.value)} />
                </div>
              )}
              {mode === 'reset' && (
                <div className="login__field">
                  <label className="field__label" htmlFor="auth-token">Reset token</label>
                  <input id="auth-token" className="input login__input" name="token" autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} value={token} data-testid="auth-token" onChange={(e) => setToken(e.target.value)} />
                </div>
              )}
              {mode !== 'forgot' && (
                <div className="login__field">
                  <label className="field__label" htmlFor="auth-password">{mode === 'reset' ? 'New password' : 'Password'}</label>
                  <input
                    id="auth-password"
                    className="input login__input"
                    type="password"
                    name="password"
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    aria-describedby={mode === 'login' ? undefined : 'auth-password-hint'}
                    value={password}
                    data-testid="auth-password"
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  {mode !== 'login' && <p className="login__hint" id="auth-password-hint">At least 8 characters.</p>}
                </div>
              )}

              {error && <p className="login__error" role="alert" data-testid="auth-error">{error}</p>}
              {info && <p className={`login__info${info === notice && noticeTone === 'warn' ? ' login__info--warn' : ''}`} role="status" data-testid="auth-info">{info}</p>}

              <button type="submit" className="btn btn--primary login__submit" disabled={busy || waitLeft > 0} aria-busy={busy || undefined} data-testid="auth-submit">
                {waitLeft > 0 && !busy ? `Try again in ${waitLeft} s` : submitLabel}
              </button>
            </form>

            {(mode === 'login' || mode === 'register') && (
              <button type="button" className="btn btn--ghost login__switch" data-testid="auth-switch" onClick={() => { reset(); setMode(mode === 'login' ? 'register' : 'login'); }}>
                {mode === 'login' ? 'Need an account? Sign up' : 'Have an account? Sign in'}
              </button>
            )}
            {mode === 'login' && (
              <button type="button" className="btn btn--ghost login__switch" data-testid="auth-forgot" onClick={() => { reset(); setMode('forgot'); }}>Forgot password?</button>
            )}
            {(mode === 'forgot' || mode === 'reset') && (
              <button type="button" className="btn btn--ghost login__switch" onClick={() => { reset(); setMode('login'); }}>Back to sign in</button>
            )}
          </>
        )}
      </div>
    </main>
  );
}
