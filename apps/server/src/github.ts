import { injectToken } from './gitops.js';
import type { RemoteProvider, RemoteRepo, RemoteConnection, CreateRepoOpts } from './remotes.js';

/**
 * GitHub implementation of RemoteProvider. Connection storage and the interface
 * itself live in remotes.ts; only types are imported from there, so the registry
 * can import this module back without a runtime cycle.
 */

/** Read lazily: capturing at module load makes behaviour depend on import
 *  order, which silently sends tests at the real api.github.com. */
const apiBase = () => process.env.GITHUB_API_BASE || 'https://api.github.com';

/** GitHub's REST paths still need the two segments separately. */
function split(fullName: string): [string, string] {
  const [owner, repo] = (fullName || '').trim().split('/');
  if (!owner || !repo) throw new Error('Expected "owner/repo"');
  return [owner, repo];
}

async function api(token: string, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'aldine',
      'x-github-api-version': '2022-11-28',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
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

export const github: RemoteProvider = {
  id: 'github',
  label: 'GitHub',
  changeRequestLabel: 'pull request',

  oauthEnabled: () => !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),

  connectUrl(state, redirectUri) {
    const p = new URLSearchParams({
      client_id: process.env.GITHUB_CLIENT_ID!,
      scope: 'repo',
      state,
      redirect_uri: redirectUri,
    });
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

  async whoami(conn: RemoteConnection) {
    const u = await api(conn.token, '/user');
    return { login: u.login, name: u.name || u.login };
  },

  /** Repos the user can push to, most-recently-updated first. */
  async listRepos(conn) {
    const list = (await api(conn.token, '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member')) as any[];
    return (list || []).map(mapRepo);
  },

  async getRepo(conn, fullName) {
    const [owner, repo] = split(fullName);
    return mapRepo(await api(conn.token, `/repos/${owner}/${repo}`));
  },

  async listBranches(conn, fullName) {
    const [owner, repo] = split(fullName);
    const list = (await api(conn.token, `/repos/${owner}/${repo}/branches?per_page=100`)) as Array<{ name: string }>;
    return (list || []).map((b) => b.name);
  },

  /** Create a repo under the authenticated user (for publishing a local project). */
  async createRepo(conn, name, opts: CreateRepoOpts) {
    return mapRepo(await api(conn.token, '/user/repos', {
      method: 'POST',
      body: JSON.stringify({ name, private: opts.private, auto_init: false }),
    }));
  },

  async createChangeRequest(conn, fullName, opts) {
    const [owner, repo] = split(fullName);
    const pr = await api(conn.token, `/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({ title: opts.title, head: opts.head, base: opts.base, body: opts.body }),
    });
    return { url: pr.html_url, number: pr.number };
  },

  tokenUrl: (cloneUrl, token) => injectToken(cloneUrl, 'x-access-token', token),
};
