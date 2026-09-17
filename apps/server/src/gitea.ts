import { injectToken } from './gitops.js';
import { jsonResponse, normalizeInstanceUrl, RemoteApiError, type RemoteConnection, type RemoteProvider, type RemoteRepo } from './remote-types.js';

/**
 * Gitea and Forgejo (Codeberg runs Forgejo) share the Gitea REST API under
 * `<instance>/api/v1`, so one provider serves both. Personal access tokens
 * only, no OAuth. Every call below is checked against the swagger each
 * project publishes, https://gitea.com/swagger.v1.json (1.27, rendered at
 * https://docs.gitea.com/api/) and https://codeberg.org/swagger.v1.json
 * (Forgejo 16):
 *  - auth: `Authorization: token <pat>` (securityDefinitions.AuthorizationHeaderToken)
 *  - GET /user → login, full_name
 *  - GET /user/repos?page=&limit=, Repository → full_name, name, owner.login,
 *    private, default_branch, clone_url, updated_at; the server clamps `limit`
 *    to its MAX_RESPONSE_ITEMS (50 by default, operators may set it lower), so
 *    a short page never ends the walk: only the `X-Total-Count` header every
 *    list response carries, or an empty page
 *  - GET /repos/{owner}/{repo}; GET /repos/{owner}/{repo}/branches?page=&limit=
 *  - POST /user/repos and POST /orgs/{org}/repos with CreateRepoOption {name, private, auto_init}
 *  - POST /repos/{owner}/{repo}/pulls with CreatePullRequestOption {title, head, base, body}
 *    → PullRequest {html_url, number}
 * Token scopes: read:user (connect), write:repository (everything else),
 * write:organization only when publishing into an organisation (POST
 * /orgs/{org}/repos sits in the organization scope category, and a POST
 * there needs its write level).
 *
 * Git over https takes the token as the basic-auth password: a non-empty
 * password is looked up as a token and the user name is not checked
 * (services/auth/basic.go, parseAuthBasic), so the account login goes in as
 * the user to keep the credential attributable in the host's logs.
 *
 * There is no canonical instance, so a connection always carries its
 * `baseUrl`, sub-path installs included. GITEA_API_BASE replaces the whole
 * `<base>/api/v1` prefix and exists for tests only.
 */

/** Gitea's default MAX_RESPONSE_ITEMS; asking for more is silently clamped to it. */
const PAGE = 50;
/** Upper bound on pages walked, so a server that never returns an empty page cannot pin the request. */
const MAX_PAGES = 40;

export function normalizeBaseUrl(raw: string | undefined): string | undefined {
  return normalizeInstanceUrl(raw, 'Gitea / Forgejo', !!process.env.GITEA_API_BASE, '/api/v1');
}

export function apiBase(conn: RemoteConnection): string {
  if (process.env.GITEA_API_BASE) return process.env.GITEA_API_BASE.replace(/\/+$/, '');
  if (!conn.baseUrl) throw new Error('Gitea / Forgejo connection has no instance URL');
  return `${conn.baseUrl}/api/v1`;
}

async function apiResponse(conn: RemoteConnection, path: string, init: RequestInit = {}): Promise<{ body: any; headers: Headers }> {
  return jsonResponse(`${apiBase(conn)}${path}`, {
    ...init,
    headers: {
      authorization: `token ${conn.token}`,
      accept: 'application/json',
      'user-agent': 'aldine',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  }, 'Gitea');
}

async function api(conn: RemoteConnection, path: string, init: RequestInit = {}): Promise<any> {
  return (await apiResponse(conn, path, init)).body;
}

/**
 * Walk `path` page by page until `X-Total-Count` entries are in hand or a
 * page comes back empty. Hitting the page cap first is an error, never a
 * silently shortened list: a missing repository would look like no access.
 */
async function pageAll(conn: RemoteConnection, path: string): Promise<any[]> {
  const sep = path.includes('?') ? '&' : '?';
  const all: any[] = [];
  let total: number | null = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { body, headers } = await apiResponse(conn, `${path}${sep}page=${page}&limit=${PAGE}`);
    const list = body as any[] | null;
    const count = headers.get('x-total-count');
    if (count !== null && /^\d+$/.test(count)) total = Number(count);
    if (!list?.length) return all;
    all.push(...list);
    if (total !== null && all.length >= total) return all;
  }
  throw new RemoteApiError(`Gitea lists ${total ?? `more than ${all.length}`} entries, more than the ${all.length} that can be read in one request`, 502);
}

export function mapRepo(r: any): RemoteRepo {
  const fullName: string = r.full_name;
  return {
    fullName,
    name: r.name || fullName.split('/').at(-1) || '',
    owner: r.owner?.login || fullName.split('/')[0],
    private: !!r.private,
    defaultBranch: r.default_branch || 'main',
    cloneUrl: r.clone_url,
    updatedAt: r.updated_at || r.created_at || '',
  };
}

/** `owner/repo` → API path segment; anything else is refused before it reaches the network. */
function repoPath(fullName: string): string {
  const parts = fullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('Expected "owner/repo"');
  return `/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
}

export const gitea: RemoteProvider = {
  id: 'gitea',
  label: 'Gitea / Forgejo',
  changeRequestLabel: 'pull request',
  selfHosted: true,
  baseUrlRequired: true,
  baseUrlExample: 'https://codeberg.org',
  tokenScopeHint: 'read:user and write:repository',
  pathHint: 'Expected "owner/repo"',
  normalizeBaseUrl,
  instanceOrigin(conn) {
    if (!conn.baseUrl) throw new Error('Gitea / Forgejo connection has no instance URL');
    return new URL(conn.baseUrl).origin;
  },
  apiOverridden() { return !!process.env.GITEA_API_BASE; },

  oauthEnabled() { return false; },
  connectUrl() { throw new Error('Gitea / Forgejo connects with a personal access token only'); },
  async exchangeCode() { throw new Error('Gitea / Forgejo connects with a personal access token only'); },

  async whoami(conn) {
    const u = await api(conn, '/user');
    return { login: u.login, name: u.full_name || u.login };
  },

  /** Every repository the token can see, most recently updated first (the API has no stable order of its own). */
  async listRepos(conn) {
    const list = await pageAll(conn, '/user/repos');
    return list.map(mapRepo).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  },

  async getRepo(conn, fullName) {
    return mapRepo(await api(conn, repoPath(fullName)));
  },

  async listBranches(conn, fullName) {
    const list = (await pageAll(conn, `${repoPath(fullName)}/branches`)) as Array<{ name: string }>;
    return list.map((b) => b.name);
  },

  /** Under the authenticated user, or under an organisation when `namespace` is set. Gitea has no `internal` visibility. */
  async createRepo(conn, name, opts) {
    const path = opts.namespace ? `/orgs/${encodeURIComponent(opts.namespace)}/repos` : '/user/repos';
    return mapRepo(await api(conn, path, {
      method: 'POST',
      body: JSON.stringify({ name, private: opts.private, auto_init: false }),
    }));
  },

  async createChangeRequest(conn, fullName, opts) {
    const pr = await api(conn, `${repoPath(fullName)}/pulls`, {
      method: 'POST',
      body: JSON.stringify({ title: opts.title, head: opts.head, base: opts.base, body: opts.body || '' }),
    });
    return { url: pr.html_url, number: pr.number };
  },

  tokenUrl(cloneUrl, token, login) {
    return injectToken(cloneUrl, login || 'aldine', token);
  },
};
