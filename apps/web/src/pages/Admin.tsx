import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, AdminStats, AdminUserRow } from '../api';
import { useAuth } from '../components/Auth';

/**
 * Instance administration: who is on this server and how busy it is.
 * Everything shown is metadata the server already holds about accounts and
 * projects — never a project's files. The server guards the routes; this
 * page only decides what to render.
 */

function ago(iso: string | undefined, now: number): string {
  if (!iso) return 'never';
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days} d ago`;
  return new Date(iso).toLocaleDateString();
}

function minutes(seconds: number): string {
  return seconds < 60 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60)} min`;
}

function Stat({ label, value, hint, testId }: { label: string; value: string | number; hint?: string; testId: string }) {
  return (
    <div className="admin__stat" data-testid={testId}>
      <div className="admin__stat-value">{value}</div>
      <div className="admin__stat-label">{label}</div>
      {hint && <div className="admin__stat-hint">{hint}</div>}
    </div>
  );
}

export default function Admin() {
  const { authEnabled, admin } = useAuth();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = async () => {
    try {
      const [s, u] = await Promise.all([api.adminStats(), api.adminUsers()]);
      setStats(s);
      setUsers(u);
      setNow(Date.now());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load server statistics');
    }
  };

  useEffect(() => {
    if (authEnabled && !admin) return;
    load();
    // The online count changes with every socket; keep the numbers live while the page is open.
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [authEnabled, admin]);

  if (authEnabled && !admin) {
    return (
      <div className="notfound" data-testid="admin-denied">
        <h1>Administrator access required</h1>
        <p>Your account is not on this server’s admin list (ALDINE_ADMIN_EMAILS).</p>
        <Link className="btn btn--primary" to="/">Back to your projects</Link>
      </div>
    );
  }

  return (
    <div className="home admin" data-testid="admin-page">
      <div className="home__inner">
        <div className="home__bar">
          <div>
            <h1 className="home__brand">aldine<em>.</em></h1>
            <p className="home__tag">Server admin</p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn" onClick={load} data-testid="admin-refresh">Refresh</button>
            <Link className="btn" to="/">Back to projects</Link>
          </div>
        </div>

        {error && <p className="admin__error" data-testid="admin-error">{error}</p>}

        {stats && (
          <>
            <h2 className="home__section">People</h2>
            <div className="admin__stats">
              <Stat label="Accounts" value={stats.users.total} testId="stat-users-total" />
              <Stat label="Active, last 7 days" value={stats.users.active7d} testId="stat-users-active7d" />
              <Stat label="Active, last 30 days" value={stats.users.active30d} testId="stat-users-active30d" />
              <Stat label="Editing right now" value={stats.users.onlineNow} hint={`${stats.collab.connections} open sockets`} testId="stat-users-online" />
            </div>

            <h2 className="home__section">Work</h2>
            <div className="admin__stats">
              <Stat label="Projects" value={stats.projects.total} hint={stats.projects.trashed ? `${stats.projects.trashed} in trash` : undefined} testId="stat-projects" />
              <Stat label="Open documents" value={stats.collab.documents} testId="stat-docs" />
              <Stat
                label={`Compile time, ${stats.compile.month}`}
                value={minutes(stats.compile.seconds)}
                hint={stats.compile.metering ? `${minutes(stats.compile.quotaSeconds)} quota per user` : 'no quota set'}
                testId="stat-compile"
              />
            </div>

            <h2 className="home__section">Accounts</h2>
            <div className="admin__table-wrap">
              <table className="admin__table" data-testid="admin-users">
                <thead>
                  <tr><th>Name</th><th>Email</th><th>Sign-in</th><th>Joined</th><th>Last seen</th><th className="admin__num">Projects</th><th className="admin__num">Compile, this month</th></tr>
                </thead>
                <tbody>
                  {(users || []).map((u) => (
                    <tr key={u.id} data-testid="admin-user-row">
                      <td>{u.name}{u.admin && <span className="admin__badge" title="On the admin list">admin</span>}</td>
                      <td>{u.email || <span className="admin__muted">no email</span>}</td>
                      <td>{u.provider || 'password'}</td>
                      <td title={u.createdAt}>{new Date(u.createdAt).toLocaleDateString()}</td>
                      <td title={u.lastSeenAt}>{ago(u.lastSeenAt, now)}</td>
                      <td className="admin__num">{u.projects}</td>
                      <td className="admin__num">{minutes(u.compileSecondsThisMonth)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="admin__foot">
              Admins: {stats.admins.length ? stats.admins.join(', ') : 'none configured (auth is off, so everyone can see this page)'}.
              Activity is recorded to the nearest few minutes. Project files are never shown here.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
