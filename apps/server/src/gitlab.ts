import { injectToken } from './gitops.js';
import { jsonRequest, RemoteApiError, type RemoteConnection, type RemoteProvider, type RemoteRepo } from './remote-types.js';

/**
 * GitLab (gitlab.com or self-hosted) over REST v4. Bearer auth works for
 * personal access tokens and OAuth tokens alike. Scope `api` is required:
 * `write_repository` can push but cannot create projects or merge requests.
 *
 * Which instance: a PAT connection carries its own `baseUrl` (self-hosted,
 * sub-path installs included); OAuth connections use GITLAB_URL. GITLAB_API_BASE
 * replaces the whole `<base>/api/v4` prefix and exists for tests only.
 */

const DEFAULT_URL = 'https://gitlab.com';

function instanceUrl(): string {
  return normalizeBaseUrl(process.env.GITLAB_URL) || DEFAULT_URL;
}

/** Trim, drop trailing slashes, keep the pathname (sub-path installs); https only. */
export function normalizeBaseUrl(raw: string | undefined): string | undefined {
  const s = (raw || '').trim();
  if (!s) return undefined;
  let u: URL;
  try { u = new URL(s); } catch { throw new Error('GitLab URL must be a full https:// URL'); }
  if (u.protocol !== 'https:' && !process.env.GITLAB_API_BASE) throw new Error('GitLab URL must use https://');
  if (u.search || u.hash) throw new Error('GitLab URL must not contain a query or fragment');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

export function apiBase(conn: RemoteConnection): string {
  if (process.env.GITLAB_API_BASE) return process.env.GITLAB_API_BASE.replace(/\/+$/, '');
  return `${conn.baseUrl || instanceUrl()}/api/v4`;
}

/** A project path is one URL segment on the API: every `/` percent-encoded. */
export function encodePath(fullName: string): string {
  return encodeURIComponent(fullName);
}

async function api(conn: RemoteConnection, path: string, init: RequestInit = {}): Promise<any> {
  return jsonRequest(`${apiBase(conn)}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${conn.token}`,
      accept: 'application/json',
      'user-agent': 'aldine',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  }, 'GitLab');
}

export function mapProject(p: any): RemoteRepo {
  const fullName: string = p.path_with_namespace;
  return {
    fullName,
    name: p.path || p.name,
    owner: p.namespace?.full_path || fullName.split('/').slice(0, -1).join('/'),
    private: p.visibility !== 'public',
    defaultBranch: p.default_branch || 'main',
    cloneUrl: p.http_url_to_repo,
    updatedAt: p.last_activity_at || p.created_at || '',
  };
}

/** GitLab project path rules: [a-z0-9_.-], no leading `-`, no `.git`/`.atom` suffix. */
export function slugPath(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').replace(/\.(git|atom)$/, '').slice(0, 100);
}

export interface GitlabGroup { id: number; fullPath: string; name: string }
const mapGroup = (g: any): GitlabGroup => ({ id: g.id, fullPath: g.full_path, name: g.name });

export async function getGroup(conn: RemoteConnection, fullPath: string): Promise<GitlabGroup> {
  return mapGroup(await api(conn, `/groups/${encodePath(fullPath)}`));
}

/** The group and every subgroup below it, the root first. */
export async function listDescendantGroups(conn: RemoteConnection, root: string): Promise<GitlabGroup[]> {
  const top = await getGroup(conn, root);
  const list = (await api(conn, `/groups/${encodePath(root)}/descendant_groups?per_page=100&order_by=path`)) as any[];
  return [top, ...(list || []).map(mapGroup)];
}

export async function createSubgroup(conn: RemoteConnection, parentPath: string, name: string): Promise<GitlabGroup> {
  const parent = await getGroup(conn, parentPath);
  const path = slugPath(name);
  if (!path) throw new Error('group name required');
  return mapGroup(await api(conn, '/groups', { method: 'POST', body: JSON.stringify({ name: name.trim(), path, parent_id: parent.id, visibility: 'private' }) }));
}

/** Raw project JSON, or null when GitLab answers 404. */
export async function getProjectRaw(conn: RemoteConnection, fullName: string): Promise<any | null> {
  try { return await api(conn, `/projects/${encodePath(fullName)}`); }
  catch (err) { if (err instanceof RemoteApiError && err.status === 404) return null; throw err; }
}

/**
 * Delete a project. Groups with delayed deletion only mark it; the second
 * call with `permanently` (and the renamed path GitLab reports) purges it.
 */
export async function deleteProject(conn: RemoteConnection, fullName: string, opts: { permanently?: boolean; fullPath?: string } = {}): Promise<void> {
  const q = opts.permanently ? `?permanently_remove=true&full_path=${encodeURIComponent(opts.fullPath || fullName)}` : '';
  await api(conn, `/projects/${encodePath(fullName)}${q}`, { method: 'DELETE' });
}

export const gitlab: RemoteProvider = {
  id: 'gitlab',
  label: 'GitLab',
  changeRequestLabel: 'merge request',
  selfHosted: true,
  normalizeBaseUrl,

  oauthEnabled() {
    return !!(process.env.GITLAB_CLIENT_ID && process.env.GITLAB_CLIENT_SECRET);
  },

  connectUrl(state, redirectUri) {
    const p = new URLSearchParams({ client_id: process.env.GITLAB_CLIENT_ID!, response_type: 'code', scope: 'api', state, redirect_uri: redirectUri });
    return `${instanceUrl()}/oauth/authorize?${p}`;
  },

  async exchangeCode(code, redirectUri) {
    const res = await fetch(`${instanceUrl()}/oauth/token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GITLAB_CLIENT_ID!,
        client_secret: process.env.GITLAB_CLIENT_SECRET!,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    const tok = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string; error?: string };
    if (!tok.access_token) throw new Error(tok.error_description || tok.error || 'no access token');
    return tok.access_token;
  },

  async whoami(conn) {
    const u = await api(conn, '/user');
    return { login: u.username, name: u.name || u.username };
  },

  async listRepos(conn) {
    const list = (await api(conn, '/projects?membership=true&min_access_level=30&order_by=last_activity_at&sort=desc&per_page=100')) as any[];
    return (list || []).map(mapProject);
  },

  async getRepo(conn, fullName) {
    return mapProject(await api(conn, `/projects/${encodePath(fullName)}`));
  },

  async listBranches(conn, fullName) {
    const list = (await api(conn, `/projects/${encodePath(fullName)}/repository/branches?per_page=100`)) as Array<{ name: string }>;
    return (list || []).map((b) => b.name);
  },

  async createRepo(conn, name, opts) {
    const body: Record<string, unknown> = {
      name,
      path: slugPath(name) || undefined,
      visibility: opts.visibility ?? (opts.private ? 'private' : 'public'),
      initialize_with_readme: false,
    };
    if (opts.namespace) {
      const group = await api(conn, `/groups/${encodePath(opts.namespace)}`).catch((err: RemoteApiError) => {
        throw new RemoteApiError(`group "${opts.namespace}" not found or no access (${err.message})`, err.status ?? 404);
      });
      body.namespace_id = group.id;
    }
    return mapProject(await api(conn, '/projects', { method: 'POST', body: JSON.stringify(body) }));
  },

  async createChangeRequest(conn, fullName, opts) {
    const mr = await api(conn, `/projects/${encodePath(fullName)}/merge_requests`, {
      method: 'POST',
      body: JSON.stringify({ title: opts.title, source_branch: opts.head, target_branch: opts.base, description: opts.body || '' }),
    });
    return { url: mr.web_url, number: mr.iid };
  },

  tokenUrl(cloneUrl, token) {
    return injectToken(cloneUrl, 'oauth2', token);
  },
};
