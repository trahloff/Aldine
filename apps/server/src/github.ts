import { injectToken } from './gitops.js';
import { jsonRequest, normalizeInstanceUrl, type RemoteConnection, type RemoteOwner, type RemoteProvider, type RemoteRepo } from './remote-types.js';

/**
 * GitHub, github.com or a GitHub Enterprise Server, as a remote provider.
 * The token comes from either an OAuth "connect" with repo scope or a pasted
 * PAT.
 *
 * Which instance: a PAT connection may carry its own `baseUrl` (an Enterprise
 * Server, `https://<host>`); OAuth connections and the rest use GITHUB_URL
 * (default github.com), where the server's OAuth app is registered. The REST
 * API is api.github.com for github.com and `<instance>/api/v3` elsewhere; git
 * goes to the clone URL the API returns, which checkCloneUrl holds to the
 * instance. GITHUB_API_BASE replaces the whole API prefix and exists for
 * tests only.
 */

const DEFAULT_URL = 'https://github.com';

export function normalizeBaseUrl(raw: string | undefined): string | undefined {
  return normalizeInstanceUrl(raw, 'GitHub Enterprise', !!process.env.GITHUB_API_BASE, '/api/v3');
}

function instanceUrl(): string {
  return normalizeBaseUrl(process.env.GITHUB_URL) || DEFAULT_URL;
}

export function apiBase(conn: RemoteConnection): string {
  if (process.env.GITHUB_API_BASE) return process.env.GITHUB_API_BASE.replace(/\/+$/, '');
  const at = conn.baseUrl || instanceUrl();
  return new URL(at).host === 'github.com' ? 'https://api.github.com' : `${at}/api/v3`;
}

async function api(conn: RemoteConnection, path: string, init: RequestInit = {}): Promise<any> {
  return jsonRequest(`${apiBase(conn)}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${conn.token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'aldine',
      'x-github-api-version': '2022-11-28',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  }, 'GitHub');
}

function mapRepo(r: any): RemoteRepo {
  return {
    fullName: r.full_name,
    name: r.name,
    owner: r.owner?.login || r.full_name?.split('/')[0],
    private: !!r.private,
    defaultBranch: r.default_branch || 'main',
    cloneUrl: r.clone_url,
    updatedAt: r.updated_at || r.pushed_at || '',
  };
}

/** `owner/repo` → API path segment; anything else is refused before it reaches the network. */
function repoPath(fullName: string): string {
  const parts = fullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('Expected "owner/repo"');
  return `/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
}

export const github: RemoteProvider = {
  id: 'github',
  label: 'GitHub',
  changeRequestLabel: 'pull request',
  selfHosted: true,
  tokenScopeHint: 'repo scope',
  pathHint: 'Expected "owner/repo"',
  normalizeBaseUrl,
  instanceOrigin(conn) { return new URL(conn.baseUrl || instanceUrl()).origin; },
  defaultInstanceUrl() { return instanceUrl(); },
  apiOverridden() { return !!process.env.GITHUB_API_BASE; },

  /** Whether "Connect with GitHub" (OAuth, repo scope) is configured. PAT connect always works. */
  oauthEnabled() {
    return !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
  },

  connectUrl(state, redirectUri) {
    const p = new URLSearchParams({ client_id: process.env.GITHUB_CLIENT_ID!, scope: 'repo', state, redirect_uri: redirectUri });
    return `${instanceUrl()}/login/oauth/authorize?${p}`;
  },

  async exchangeCode(code, redirectUri) {
    const res = await fetch(`${instanceUrl()}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      }),
    });
    const tok = (await res.json()) as { access_token?: string; error_description?: string };
    if (!tok.access_token) throw new Error(tok.error_description || 'no access token');
    return tok.access_token;
  },

  async whoami(conn) {
    const u = await api(conn, '/user');
    return { login: u.login, name: u.name || u.login };
  },

  /** The user's own repositories and the ones they collaborate on, most
   *  recently updated first, one page. Organisation repositories come from
   *  searchRepos: members of large organisations would otherwise see a page
   *  of other people's repositories and miss their own. */
  async listRepos(conn) {
    const list = (await api(conn, '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator')) as any[];
    return (list || []).map(mapRepo);
  },

  /** Name search across the user's account and organisations. The search
   *  API needs the owners named, or it searches every public repository. */
  async searchRepos(conn, query) {
    const orgs = ((await api(conn, '/user/orgs?per_page=100').catch(() => [])) as Array<{ login: string }>).map((o) => o.login);
    const owners = [`user:${conn.login}`];
    // The search query is capped at 256 characters; owners beyond that are left out.
    for (const o of orgs) if ([query, 'in:name', ...owners, `org:${o}`].join(' ').length <= 256) owners.push(`org:${o}`);
    const q = encodeURIComponent([query, 'in:name', ...owners].join(' '));
    const res = (await api(conn, `/search/repositories?q=${q}&sort=updated&per_page=50`)) as { items?: any[] };
    return (res.items || []).map(mapRepo);
  },

  async getRepo(conn, fullName) {
    return mapRepo(await api(conn, repoPath(fullName)));
  },

  async listBranches(conn, fullName) {
    const list = (await api(conn, `${repoPath(fullName)}/branches?per_page=100`)) as Array<{ name: string }>;
    return (list || []).map((b) => b.name);
  },

  /** Create a repo under the authenticated user, or under an organisation when `namespace` is set. */
  async createRepo(conn, name, opts) {
    const path = opts.namespace ? `/orgs/${encodeURIComponent(opts.namespace)}/repos` : '/user/repos';
    return mapRepo(await api(conn, path, {
      method: 'POST',
      body: JSON.stringify({ name, private: opts.private, auto_init: false }),
    }));
  },

  async createChangeRequest(conn, fullName, opts) {
    const pr = await api(conn, `${repoPath(fullName)}/pulls`, { method: 'POST', body: JSON.stringify(opts) });
    return { url: pr.html_url, number: pr.number };
  },

  async findChangeRequest(conn, fullName, opts) {
    const owner = fullName.split('/')[0];
    const q = new URLSearchParams({ state: 'open', head: `${owner}:${opts.head}`, base: opts.base });
    const list = (await api(conn, `${repoPath(fullName)}/pulls?${q}`)) as Array<{ html_url: string; number: number }>;
    return list?.[0] ? { url: list[0].html_url, number: list[0].number } : null;
  },

  async listOwners(conn) {
    const orgs = (await api(conn, '/user/orgs?per_page=100')) as Array<{ login: string }>;
    return [{ path: conn.login, kind: 'user' }, ...(orgs || []).map((o): RemoteOwner => ({ path: o.login, kind: 'org' }))];
  },

  tokenUrl(cloneUrl, token) {
    return injectToken(cloneUrl, 'x-access-token', token);
  },
};
