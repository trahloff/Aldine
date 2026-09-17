/**
 * Remote git hosting providers (GitHub, GitLab). A provider is a thin REST
 * client plus the two facts git needs: how to put a token into a clone URL
 * and what the host calls a change request. Everything git-side lives in
 * gitops and is provider-neutral; everything user-facing (which provider a
 * project is linked to) is stored on the project, never taken from a request.
 */

export type RemoteProviderId = 'github' | 'gitlab';

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

/** Per-user token, kept in the secrets DataStore. `baseUrl` is set for self-hosted GitLab. */
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
  oauthEnabled(): boolean;
  connectUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<string>;
  /** Normalise a user-supplied base URL; throws on anything but https. Undefined for hosts with one URL. */
  normalizeBaseUrl?(raw: string | undefined): string | undefined;
  whoami(conn: RemoteConnection): Promise<{ login: string; name?: string }>;
  listRepos(conn: RemoteConnection): Promise<RemoteRepo[]>;
  getRepo(conn: RemoteConnection, fullName: string): Promise<RemoteRepo>;
  listBranches(conn: RemoteConnection, fullName: string): Promise<string[]>;
  /** `visibility` refines `private` for hosts with more than two levels (GitLab `internal`). */
  createRepo(conn: RemoteConnection, name: string, opts: { private: boolean; namespace?: string; visibility?: 'private' | 'internal' | 'public' }): Promise<RemoteRepo>;
  createChangeRequest(conn: RemoteConnection, fullName: string, opts: { title: string; head: string; base: string; body?: string }): Promise<{ url: string; number: number }>;
  tokenUrl(cloneUrl: string, token: string): string;
}

/** Shared fetch wrapper: JSON in/out, throws RemoteApiError with the upstream status. */
export async function jsonRequest(url: string, init: RequestInit, label: string): Promise<any> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new RemoteApiError(`${label} API ${res.status}: ${body.slice(0, 200)}`, res.status);
  }
  return res.status === 204 ? null : res.json();
}
