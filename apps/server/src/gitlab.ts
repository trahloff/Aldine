import { injectToken } from './gitops.js';
import { gitlabConfig } from './config.js';
import type { RemoteProvider, RemoteRepo, RemoteConnection, CreateRepoOpts } from './remotes.js';

/**
 * GitLab implementation of RemoteProvider, for gitlab.com and self-hosted
 * instances. The instance base lives on the connection rather than in env,
 * because one Aldine deployment may face several GitLab instances.
 *
 * Auth is a Bearer token for both PATs (scope `api`) and OAuth tokens, so
 * unlike GitHub there is only one code path.
 */

/**
 * Test-only: point the client at a local mock, prefix included. Never set in
 * production. Read lazily — capturing it at module load makes behaviour depend
 * on import order, which silently sends tests at the real gitlab.com.
 */
const apiOverride = () => process.env.GITLAB_API_BASE;

/**
 * Normalise a GitLab instance base. https is required: the token rides in the
 * Authorization header on every call, so a plaintext base would leak it.
 */
export function normaliseBaseUrl(input?: string): string {
  const raw = (input || '').trim() || 'https://gitlab.com';
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`That is not a valid URL: ${raw}`); }
  if (u.protocol !== 'https:') throw new Error('The GitLab URL must start with https://');
  return u.origin + u.pathname.replace(/\/+$/, '');
}

/** GitLab addresses a project or group by its URL-encoded full path. */
export const encodePath = (fullName: string): string =>
  encodeURIComponent((fullName || '').trim().replace(/^\/+|\/+$/g, ''));

export function mapProject(p: any): RemoteRepo {
  return {
    fullName: p.path_with_namespace,
    name: p.path,
    owner: p.namespace?.full_path || String(p.path_with_namespace || '').split('/').slice(0, -1).join('/'),
    private: p.visibility !== 'public',
    defaultBranch: p.default_branch || 'main',
    cloneUrl: p.http_url_to_repo,
    updatedAt: p.last_activity_at || p.updated_at || '',
  };
}

/**
 * Carries the HTTP status, so callers can tell "not there" (a valid answer)
 * from "could not ask" (a failure). The message is unchanged, since callers
 * match on it for GitLab's field-level errors.
 */
export class GitlabApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'GitlabApiError';
  }
}

export async function api(conn: RemoteConnection, path: string, init: RequestInit = {}): Promise<any> {
  const base = apiOverride() || `${normaliseBaseUrl(conn.baseUrl)}/api/v4`;
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${conn.token}`,
      accept: 'application/json',
      'user-agent': 'aldine',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GitlabApiError(res.status, `GitLab API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

/**
 * GET that answers null for a missing project instead of throwing. Only 404:
 * an unreachable or refusing instance must NOT read as "already deleted", or a
 * delete against a down GitLab reports success and drops the link that the
 * purge sweep would have retried.
 */
async function getOrNull(conn: RemoteConnection, path: string): Promise<any> {
  try {
    return await api(conn, path);
  } catch (err) {
    if (err instanceof GitlabApiError && err.status === 404) return null;
    throw err;
  }
}

/** Where the OAuth dance happens — the instance itself, not the API path. */
const oauthBase = () => normaliseBaseUrl(process.env.GITLAB_OAUTH_BASE || gitlabConfig.url);

/**
 * Whether new projects are auto-created in a GitLab group. Both vars are
 * required: a token with no group has nowhere to put them, a group with no
 * token no way to create them.
 */
export function autoProvisionEnabled(): boolean {
  return !!(gitlabConfig.token && gitlabConfig.defaultGroup);
}

/**
 * A connection backed by the instance service token. `login` is a marker, not a
 * real GitLab username — nothing calls whoami() on it.
 */
export function serviceConnection(): RemoteConnection | null {
  if (!gitlabConfig.token) return null;
  return { token: gitlabConfig.token, login: 'aldine-service', baseUrl: gitlabConfig.url };
}

export async function resolveGroup(conn: RemoteConnection, fullPath: string): Promise<{ id: number; full_path: string }> {
  const g = await api(conn, `/groups/${encodePath(fullPath)}`);
  return { id: g.id, full_path: g.full_path };
}

const trimPath = (p: string) => (p || '').trim().replace(/^\/+|\/+$/g, '');

/**
 * Whether `candidate` is the configured root group or a descendant of it.
 * The trailing '/' in the prefix test is a privilege boundary, not tidiness:
 * without it "research/latex-archive" passes as a child of "research/latex",
 * and the subgroup endpoint becomes "create a group anywhere on the instance".
 */
export function withinRoot(rootPath: string, candidate: string): boolean {
  const root = trimPath(rootPath);
  const c = trimPath(candidate);
  if (!root || !c) return false;
  return c === root || c.startsWith(`${root}/`);
}

export interface Namespace { id: number; fullPath: string; name: string }

/** The root group plus every descendant, flat — one extra call, rendered as a tree client-side. */
export async function listNamespaces(conn: RemoteConnection, rootPath: string): Promise<Namespace[]> {
  const [root, descendants] = await Promise.all([
    api(conn, `/groups/${encodePath(rootPath)}`),
    api(conn, `/groups/${encodePath(rootPath)}/descendant_groups?per_page=100`),
  ]);
  return [root, ...(descendants || [])].map((g: any) => ({ id: g.id, fullPath: g.full_path, name: g.name }));
}

export async function createSubgroup(conn: RemoteConnection, parentPath: string, name: string): Promise<{ id: number; fullPath: string }> {
  const path = trimPath(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  if (!path) throw new Error('A subgroup name is required');
  const parent = await resolveGroup(conn, parentPath);
  const g = await api(conn, '/groups', {
    method: 'POST',
    body: JSON.stringify({ name: name.trim(), path, parent_id: parent.id, visibility: gitlabConfig.visibility }),
  });
  return { id: g.id, fullPath: g.full_path };
}

export const gitlab: RemoteProvider = {
  id: 'gitlab',
  label: 'GitLab',
  changeRequestLabel: 'merge request',

  oauthEnabled: () => !!(process.env.GITLAB_CLIENT_ID && process.env.GITLAB_CLIENT_SECRET),

  connectUrl(state, redirectUri) {
    const p = new URLSearchParams({
      client_id: process.env.GITLAB_CLIENT_ID!,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'api',
      state,
    });
    return `${oauthBase()}/oauth/authorize?${p}`;
  },

  async exchangeCode(code, redirectUri) {
    const res = await fetch(`${oauthBase()}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GITLAB_CLIENT_ID!,
        client_secret: process.env.GITLAB_CLIENT_SECRET!,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    const tok = (await res.json()) as { access_token?: string; error_description?: string };
    if (!tok.access_token) throw new Error(tok.error_description || 'no access token');
    return tok.access_token;
  },

  async whoami(conn) {
    const u = await api(conn, '/user');
    return { login: u.username, name: u.name || u.username };
  },

  /** Projects the user can push to (min_access_level 30 = developer), newest activity first. */
  async listRepos(conn) {
    const list = await api(conn, '/projects?membership=true&min_access_level=30&order_by=last_activity_at&per_page=100');
    return (list || []).map(mapProject);
  },

  async getRepo(conn, fullName) {
    return mapProject(await api(conn, `/projects/${encodePath(fullName)}`));
  },

  async listBranches(conn, fullName) {
    const list = (await api(conn, `/projects/${encodePath(fullName)}/repository/branches?per_page=100`)) as Array<{ name: string }>;
    return (list || []).map((b) => b.name);
  },

  async createRepo(conn, name, opts: CreateRepoOpts) {
    const body: Record<string, unknown> = {
      name,
      path: name,
      visibility: opts.private ? 'private' : 'public',
      // An initial commit from GitLab would make our first push non-fast-forward.
      initialize_with_readme: false,
    };
    if (opts.namespace) body.namespace_id = (await api(conn, `/groups/${encodePath(opts.namespace)}`)).id;
    return mapProject(await api(conn, '/projects', { method: 'POST', body: JSON.stringify(body) }));
  },

  /**
   * Delete a project, and make sure it is actually gone.
   *
   * A single DELETE is not enough: since GitLab 16.0 (Premium/Ultimate) and
   * 18.0 (every tier, personal namespaces included) a delete only *marks* the
   * project, which sits in the group for the instance's retention period —
   * 30 days on GitLab.com. GitLab's own instruction is to delete it a second
   * time, which the API spells `permanently_remove` plus the project's current
   * full path. Without that pass the repo is still in the group weeks after the
   * project left Aldine, which is exactly what "delete" is supposed to prevent.
   *
   * Addressed by numeric id throughout, because marking a project renames it to
   * free the path: keyed by path, the follow-up looks like a 404 and the repo
   * quietly survives.
   */
  async deleteRepo(conn, fullName) {
    const before = await getOrNull(conn, `/projects/${encodePath(fullName)}`);
    if (!before) return { purged: true }; // nothing there — treat as done, not as an error
    await api(conn, `/projects/${before.id}`, { method: 'DELETE' });
    const pending = await getOrNull(conn, `/projects/${before.id}`);
    if (!pending) return { purged: true }; // an instance that deletes outright
    const scheduledFor = pending.marked_for_deletion_on || pending.marked_for_deletion_at || undefined;
    const currentPath = pending.path_with_namespace || fullName;
    const purge = `/projects/${pending.id}?permanently_remove=true&full_path=${encodeURIComponent(currentPath)}`;
    try {
      await api(conn, purge, { method: 'DELETE' });
    } catch (err) {
      // Instances restrict immediate deletion (admin-only on GitLab.com since
      // 2025-09-15). Scheduled is still on its way out, so report the date; a
      // project that is neither gone nor scheduled did not delete at all.
      if (scheduledFor) return { purged: false, scheduledFor };
      throw err;
    }
    const still = await getOrNull(conn, `/projects/${pending.id}`);
    return still ? { purged: false, scheduledFor } : { purged: true };
  },

  async createChangeRequest(conn, fullName, opts) {
    const mr = await api(conn, `/projects/${encodePath(fullName)}/merge_requests`, {
      method: 'POST',
      body: JSON.stringify({
        title: opts.title,
        source_branch: opts.head,
        target_branch: opts.base,
        description: opts.body,
      }),
    });
    return { url: mr.web_url, number: mr.iid };
  },

  tokenUrl: (cloneUrl, token) => injectToken(cloneUrl, 'oauth2', token),
};
