/**
 * Remote git hosting providers (GitHub, GitLab, Gitea/Forgejo). A provider is a thin REST
 * client plus the two facts git needs: how to put a token into a clone URL
 * and what the host calls a change request. Everything git-side lives in
 * gitops and is provider-neutral; everything user-facing (which provider a
 * project is linked to) is stored on the project, never taken from a request.
 */

export type RemoteProviderId = 'github' | 'gitlab' | 'gitea';

export interface RemoteRepo {
  /** Opaque path on the host: `owner/repo` on GitHub, `group/sub/project` on GitLab. */
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  /** Credential-free https clone URL (a file:// URL in tests). */
  cloneUrl: string;
  updatedAt: string;
}

/** Per-user token, kept in the secrets DataStore. `baseUrl` is set for a self-hosted GitLab and for every Gitea/Forgejo instance. */
export interface RemoteConnection { token: string; login: string; name?: string; baseUrl?: string }

export class RemoteApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export interface RemoteProvider {
  id: RemoteProviderId;
  label: string;
  changeRequestLabel: 'pull request' | 'merge request';
  /** Whether the host is a self-hostable product (the connect UI offers a base URL field). */
  selfHosted: boolean;
  /** The host has no canonical instance: a token connect must name one (Gitea/Forgejo). */
  baseUrlRequired?: boolean;
  /** A public instance the connect error names when the URL is missing (hosts with `baseUrlRequired`). */
  baseUrlExample?: string;
  /** The scopes a token needs, as the connect error names them ("repo scope"). */
  tokenScopeHint: string;
  /** What a repository path looks like on this host, as the import error states it. */
  pathHint: string;
  oauthEnabled(): boolean;
  connectUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<string>;
  /** Normalise a user-supplied base URL; throws on anything but https. Undefined for hosts with one URL. */
  normalizeBaseUrl?(raw: string | undefined): string | undefined;
  /** Origin (scheme, host, port) of the instance `conn` talks to; the only origin git may be pointed at for it. */
  instanceOrigin(conn: RemoteConnection): string;
  /** The `*_API_BASE` test override is set: mocks answer with file:// clone URLs, so the origin check is off. */
  apiOverridden(): boolean;
  whoami(conn: RemoteConnection): Promise<{ login: string; name?: string }>;
  listRepos(conn: RemoteConnection): Promise<RemoteRepo[]>;
  getRepo(conn: RemoteConnection, fullName: string): Promise<RemoteRepo>;
  listBranches(conn: RemoteConnection, fullName: string): Promise<string[]>;
  /** `visibility` refines `private` for hosts with more than two levels (GitLab `internal`). */
  createRepo(conn: RemoteConnection, name: string, opts: { private: boolean; namespace?: string; visibility?: 'private' | 'internal' | 'public' }): Promise<RemoteRepo>;
  createChangeRequest(conn: RemoteConnection, fullName: string, opts: { title: string; head: string; base: string; body?: string }): Promise<{ url: string; number: number }>;
  /** `login` is the connection's account name, for hosts that take the token as a basic-auth password. */
  tokenUrl(cloneUrl: string, token: string, login?: string): string;
}

/**
 * Trim, drop trailing slashes, keep the pathname (sub-path installs); https
 * only unless `allowHttp` (a test override pointing at a mock). `label` names
 * the host in the error the user sees. A trailing `apiPath` (`/api/v1`, the
 * URL a swagger page shows) is dropped: the provider appends it itself, and
 * doubled it turns a good token into a "token rejected" error.
 */
export function normalizeInstanceUrl(raw: string | undefined, label: string, allowHttp: boolean, apiPath?: string): string | undefined {
  const s = (raw || '').trim();
  if (!s) return undefined;
  let u: URL;
  try { u = new URL(s); } catch { throw new Error(`${label} URL must be a full https:// URL`); }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw new Error(`${label} URL must use https://`);
  if (u.search || u.hash) throw new Error(`${label} URL must not contain a query or fragment`);
  let pathname = u.pathname.replace(/\/+$/, '');
  if (apiPath && pathname.endsWith(apiPath)) pathname = pathname.slice(0, -apiPath.length).replace(/\/+$/, '');
  return `${u.origin}${pathname}`;
}

/**
 * A clone URL the host returned may only point git at the instance the
 * connection was made on: the host is user-chosen (any https URL for Gitea
 * and self-hosted GitLab), so an instance answering with `file://` or a
 * foreign host would otherwise make the server clone or push any repository
 * it can reach. Returns the URL; throws with a message fit for the client.
 */
export function checkCloneUrl(p: RemoteProvider, conn: RemoteConnection, cloneUrl: string): string {
  if (p.apiOverridden()) return cloneUrl;
  let u: URL;
  try { u = new URL(cloneUrl); } catch { throw new Error(`${p.label} returned an unusable clone URL`); }
  if (u.protocol !== 'https:') throw new Error(`${p.label} returned a clone URL that is not https (${u.protocol.replace(/:$/, '')})`);
  const origin = p.instanceOrigin(conn);
  if (u.origin !== origin) throw new Error(`${p.label} returned a clone URL on ${u.origin}, not on ${origin}`);
  return cloneUrl;
}

/** Shared fetch wrapper: JSON in/out plus the response headers, throws RemoteApiError with the upstream status. */
export async function jsonResponse(url: string, init: RequestInit, label: string): Promise<{ body: any; headers: Headers }> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new RemoteApiError(`${label} API ${res.status}: ${body.slice(0, 200)}`, res.status);
  }
  return { body: res.status === 204 ? null : await res.json(), headers: res.headers };
}

/** `jsonResponse` for callers that need the body only. */
export async function jsonRequest(url: string, init: RequestInit, label: string): Promise<any> {
  return (await jsonResponse(url, init, label)).body;
}
