import { injectToken } from './gitops.js';
import { jsonRequest, type RemoteConnection, type RemoteProvider, type RemoteRepo } from './remote-types.js';

/**
 * GitHub as a remote provider. The token comes from either an OAuth "connect"
 * with repo scope or a pasted PAT; GITHUB_API_BASE points the client at a mock
 * in tests.
 */

const API = () => process.env.GITHUB_API_BASE || 'https://api.github.com';

async function api(conn: RemoteConnection, path: string, init: RequestInit = {}): Promise<any> {
  return jsonRequest(`${API()}${path}`, {
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
  selfHosted: false,

  /** Whether "Connect with GitHub" (OAuth, repo scope) is configured. PAT connect always works. */
  oauthEnabled() {
    return !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
  },

  connectUrl(state, redirectUri) {
    const p = new URLSearchParams({ client_id: process.env.GITHUB_CLIENT_ID!, scope: 'repo', state, redirect_uri: redirectUri });
    return `https://github.com/login/oauth/authorize?${p}`;
  },

  async exchangeCode(code, redirectUri) {
    const res = await fetch('https://github.com/login/oauth/access_token', {
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

  /** Repos the user can push to, most-recently-updated first. */
  async listRepos(conn) {
    const list = (await api(conn, '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member')) as any[];
    return (list || []).map(mapRepo);
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

  tokenUrl(cloneUrl, token) {
    return injectToken(cloneUrl, 'x-access-token', token);
  },
};
