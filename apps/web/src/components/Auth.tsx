import { createContext, useContext, useEffect, useState, type JSX } from 'react';
import { withBase } from '../basePath';
import { api, AuthUser, OAuthProviderInfo } from '../api';

interface AuthState {
  loading: boolean;
  authEnabled: boolean;
  user: AuthUser | null;
  providers: OAuthProviderInfo[];
  passwordAuth: boolean;
  /** ALDINE_MCP=1 on this server — the Agent access card must not advertise a connector URL that answers 404. */
  mcpEnabled: boolean;
  /** ALDINE_PUBLIC_URL as the server knows it (null when unset). */
  publicUrl: string | null;
  setUser(u: AuthUser | null): void;
  refresh(): Promise<void>;
}

const Ctx = createContext<AuthState>({ loading: true, authEnabled: false, user: null, providers: [], passwordAuth: true, mcpEnabled: false, publicUrl: null, setUser: () => {}, refresh: async () => {} });

/** The OAuth consent page validates the requesting client BEFORE asking for
 *  credentials and renders the sign-in form itself, so the provider's gate
 *  must let it mount while signed out. */
const SELF_GATED_PATHS = ['/oauth/authorize'];

export function useAuth() { return useContext(Ctx); }

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [providers, setProviders] = useState<OAuthProviderInfo[]>([]);
  const [passwordAuth, setPasswordAuth] = useState(true);
  const [mcpEnabled, setMcpEnabled] = useState(false);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const me = await api.me();
      setAuthEnabled(me.authEnabled);
      setUser(me.user);
      setProviders(me.providers || []);
      setPasswordAuth(me.passwordAuth !== false);
      setMcpEnabled(me.mcpEnabled === true);
      setPublicUrl(me.publicUrl || null);
    } catch {
      setAuthEnabled(false);
      setUser(null);
    }
    setLoading(false);
  };

  useEffect(() => { refresh(); }, []);

  if (loading) return <div style={{ height: '100%' }} />;

  // Show the login/reset screen when signed out, OR when a reset link was opened
  // in an already-signed-in session (otherwise the ?reset_token= link does nothing).
  const hasResetToken = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('reset_token');
  const selfGated = typeof window !== 'undefined' && SELF_GATED_PATHS.some((p) => window.location.pathname === withBase(p));
  if (authEnabled && (!user || hasResetToken) && !selfGated) return <LoginScreen providers={providers} passwordAuth={passwordAuth} onAuthed={(u) => setUser(u)} />;

  return <Ctx.Provider value={{ loading, authEnabled, user, providers, passwordAuth, mcpEnabled, publicUrl, setUser, refresh }}>{children}</Ctx.Provider>;
}

type Mode = 'login' | 'register' | 'forgot' | 'reset';

const PROVIDER_ICON: Record<string, JSX.Element> = {
  orcid: (
    <svg width="15" height="15" viewBox="0 0 256 256" aria-hidden="true"><circle cx="128" cy="128" r="128" fill="#A6CE39"/><path fill="#fff" d="M86.3 186.2H70.9V79.1h15.4v107.1zM108.9 79.1h41.6c39.6 0 57 28.3 57 53.6 0 27.5-21.5 53.6-56.8 53.6h-41.8V79.1zm15.4 93.3h24.5c34.9 0 42.9-26.5 42.9-39.7 0-21.5-13.7-39.7-43.7-39.7h-23.7v79.4zM88.7 56.8c0 5.5-4.5 10.1-10.1 10.1s-10.1-4.6-10.1-10.1c0-5.6 4.5-10.1 10.1-10.1s10.1 4.6 10.1 10.1z"/></svg>
  ),
  github: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
  ),
  google: (
    <svg width="15" height="15" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62Z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"/><path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"/></svg>
  ),
};

/** `heading`/`registerHeading` keep the caller's context ("connect Claude")
 *  on both the sign-in and the sign-up step; `notice` is an info line shown
 *  on arrival (why the person is back at the form). */
export function LoginScreen({ providers, passwordAuth, onAuthed, heading, registerHeading, notice }: { providers: OAuthProviderInfo[]; passwordAuth: boolean; onAuthed(u: AuthUser): void; heading?: string; registerHeading?: string; notice?: string }) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState(notice ?? '');
  const [busy, setBusy] = useState(false);

  const reset = () => { setError(''); setInfo(''); };

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

  const submit = async () => {
    reset();
    setBusy(true);
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
        await api.resetPassword(token.trim(), password);
        setInfo('Password updated. You can sign in now.');
        setMode('login'); setPassword(''); setBusy(false);
        return;
      }
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  const title = mode === 'login' ? (heading ?? 'Sign in to your projects.')
    : mode === 'register' ? (registerHeading ?? 'Create an account to get started.')
    : mode === 'forgot' ? 'Reset your password.'
    : 'Set a new password.';

  return (
    <div className="login">
      <div className="login__card">
        <h1 className="home__brand" style={{ fontSize: 30, marginBottom: 2 }}>aldine<em>.</em></h1>
        <p className="home__tag" style={{ marginBottom: 18 }}>{title}</p>

        {providers.map((p) => (
          <a key={p.id} className="btn login__oauth" href={withBase(`/api/auth/oauth/${p.id}`)} data-testid={`oauth-${p.id}`}>
            {PROVIDER_ICON[p.id]}
            Continue with {p.label}
          </a>
        ))}
        {providers.length > 0 && passwordAuth && <div className="login__or">or</div>}

        {!passwordAuth && providers.length === 0 && (
          <p className="login__error">No sign-in method is configured. Contact the administrator.</p>
        )}

        {passwordAuth && (
          <>
            {mode === 'register' && (
              <input className="input login__input" placeholder="Name (optional)" value={name} data-testid="auth-name" onChange={(e) => setName(e.target.value)} />
            )}
            {mode !== 'reset' && (
              <input className="input login__input" type="email" placeholder="Email" value={email} data-testid="auth-email" autoFocus onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
            )}
            {mode === 'reset' && (
              <input className="input login__input" placeholder="Reset token" value={token} data-testid="auth-token" onChange={(e) => setToken(e.target.value)} />
            )}
            {mode !== 'forgot' && (
              <input className="input login__input" type="password" placeholder={mode === 'reset' ? 'New password (min 8)' : 'Password (min 8 characters)'} value={password} data-testid="auth-password" onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
            )}

            {error && <p className="login__error" data-testid="auth-error">{error}</p>}
            {info && <p className="login__info" data-testid="auth-info">{info}</p>}

            <button className="btn btn--primary login__submit" onClick={submit} disabled={busy} aria-busy={busy || undefined} data-testid="auth-submit">
              {busy ? '…' : mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : mode === 'forgot' ? 'Send reset link' : 'Set password'}
            </button>

            {(mode === 'login' || mode === 'register') && (
              <button className="btn btn--ghost login__switch" data-testid="auth-switch" onClick={() => { reset(); setMode(mode === 'login' ? 'register' : 'login'); }}>
                {mode === 'login' ? 'Need an account? Sign up' : 'Have an account? Sign in'}
              </button>
            )}
            {mode === 'login' && (
              <button className="btn btn--ghost login__switch" data-testid="auth-forgot" onClick={() => { reset(); setMode('forgot'); }}>Forgot password?</button>
            )}
            {(mode === 'forgot' || mode === 'reset') && (
              <button className="btn btn--ghost login__switch" onClick={() => { reset(); setMode('login'); }}>Back to sign in</button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
