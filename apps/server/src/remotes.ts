import { db } from './db/index.js';
import { github } from './github.js';
import { gitlab } from './gitlab.js';

/**
 * Git host integrations behind one interface, so a project's remote can live on
 * GitHub or GitLab without the routes or the UI caring which. Adding a host
 * means adding one implementation and pushing it onto `providers` — the same
 * shape `oauth.ts` uses for sign-in providers.
 *
 * Tokens are per user per provider, stored in the secrets DataStore (never in
 * the compiler-visible projects dir), from either an OAuth connect or a PAT.
 *
 * Provider modules import only *types* from here, so this file can import them
 * back for the registry without a runtime cycle.
 */

export interface RemoteRepo {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
  updatedAt: string;
}

export interface RemoteConnection {
  token: string;
  login: string;
  name?: string;
  /** Self-hosted instance base, e.g. https://gitlab.example.com. GitHub ignores it. */
  baseUrl?: string;
}

export interface CreateRepoOpts {
  private: boolean;
  /** Target group/subgroup full path. GitLab only; GitHub ignores it. */
  namespace?: string;
}

export type RemoteProviderId = 'github' | 'gitlab';

/**
 * Outcome of a delete. `purged` false with a date means the host accepted the
 * delete but keeps the repo until then — a host may not allow removing it any
 * sooner, so the caller reports it rather than treating it as a failure.
 */
export interface RepoDeleteResult { purged: boolean; scheduledFor?: string }

export interface RemoteProvider {
  id: RemoteProviderId;
  label: string;
  /** Noun for a proposed change, lowercase for mid-sentence use. */
  changeRequestLabel: string;
  /** Whether OAuth connect is configured. PAT connect always works. */
  oauthEnabled(): boolean;
  connectUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<string>;
  whoami(conn: RemoteConnection): Promise<{ login: string; name?: string }>;
  listRepos(conn: RemoteConnection): Promise<RemoteRepo[]>;
  /**
   * `fullName` rather than (owner, repo): a GitLab project path can be more
   * than two segments, so owner/repo is not a faithful key.
   */
  getRepo(conn: RemoteConnection, fullName: string): Promise<RemoteRepo>;
  listBranches(conn: RemoteConnection, fullName: string): Promise<string[]>;
  createRepo(conn: RemoteConnection, name: string, opts: CreateRepoOpts): Promise<RemoteRepo>;
  /**
   * Delete a repo Aldine created. Optional: GitHub's `repo` scope cannot delete
   * repositories (that needs `delete_repo`), so GitHub deliberately omits this
   * rather than failing every call.
   */
  deleteRepo?(conn: RemoteConnection, fullName: string): Promise<RepoDeleteResult>;
  /** Open a pull request (GitHub) / merge request (GitLab). */
  createChangeRequest(
    conn: RemoteConnection,
    fullName: string,
    opts: { title: string; head: string; base: string; body?: string },
  ): Promise<{ url: string; number: number }>;
  tokenUrl(cloneUrl: string, token: string): string;
}

export async function getConnection(userId: string, provider: string): Promise<RemoteConnection | null> {
  const c = await db().getConnection(userId, provider);
  return c && typeof c.token === 'string' ? (c as unknown as RemoteConnection) : null;
}
export function setConnection(userId: string, provider: string, conn: RemoteConnection): Promise<void> {
  return db().setConnection(userId, provider, conn as unknown as Record<string, unknown>);
}
export function disconnect(userId: string, provider: string): Promise<void> {
  return db().deleteConnection(userId, provider);
}

export const providers: RemoteProvider[] = [github, gitlab];

export function configuredProviders(): RemoteProvider[] {
  return providers;
}
export function getProvider(id: string): RemoteProvider | undefined {
  return providers.find((p) => p.id === id);
}
