import * as remotes from './remotes.js';
import * as store from './store.js';
import { explainGitFailure } from './sync-errors.js';
import type { RemoteConnection, RemoteProvider } from './remote-types.js';

/** A project's link to its remote repository, with the connection a sync by `userId` uses. */
export type Linked = {
  meta: store.ProjectMeta;
  link: store.RemoteLink;
  provider: RemoteProvider;
  conn: RemoteConnection;
  source: remotes.ConnectionSource;
  url: string;
  remoteBranch: string;
};

/** Why a project cannot sync: a sentence for the person, and a code where the UI acts on one. */
export type NotLinked = { error: string; code?: string };

/**
 * The link and connection a sync of `meta` by `userId` goes through: the
 * project's own token, the person's, the linker's, then the server's service
 * token. Membership is the caller's check (REST and MCP word it differently).
 */
export async function linkedRemote(meta: store.ProjectMeta, userId: string): Promise<Linked | NotLinked> {
  const link = store.remoteLink(meta);
  if (!link) return { error: 'This project is not linked to a remote repository', code: 'not-linked' };
  const provider = remotes.getProvider(link.provider);
  if (!provider) return { error: `This project is linked to ${link.provider}, which is disabled on this server` };
  const resolved = await remotes.resolveConnectionSource(link, userId, { allowService: true, projectId: meta.id });
  if (!resolved) {
    // A connection to another instance of the same host does not count, so the instance is named.
    const at = provider.selfHosted ? remotes.linkInstance(link) : null;
    return { error: `Connect ${provider.label}${at ? ` on ${at}` : ''} to sync`, code: 'no-connection' };
  }
  const { conn, source } = resolved;
  return { meta, link, provider, conn, source, url: provider.tokenUrl(link.cloneUrl, conn.token, conn.login), remoteBranch: link.remoteBranch };
}

export const isLinked = (l: Linked | NotLinked): l is Linked => 'link' in l;

/** Whose token a sync uses, in words the access dialog and its errors share. */
export const tokenOwnerPhrase = (l: Pick<Linked, 'source' | 'conn'>) => ({
  project: "this project's token",
  own: `your token${l.conn.login ? ` (${l.conn.login})` : ''}`,
  linker: `the token of ${l.conn.login || 'the account that linked this project'}`,
  service: "the server's service token",
})[l.source];

/** A failed push or fetch as one sentence: a refused token with its fix, else a known git failure, else null. */
export async function explainSyncFailure(l: Linked, err: unknown, op: 'push' | 'fetch', branch = l.remoteBranch): Promise<{ error: string; code?: string } | null> {
  if (await remotes.tokenRefused(l.provider, l.conn, err)) {
    const fix = l.source === 'service' ? 'Ask your administrator to replace it.'
      : l.source === 'project' ? 'Replace it to keep syncing.'
      : l.source === 'linker' ? `Connect your own ${l.provider.label} account to keep syncing.`
      : 'Reconnect to keep syncing.';
    return { error: `${l.provider.label} rejected ${tokenOwnerPhrase(l)}. ${fix}`, code: 'token-invalid' };
  }
  const at = l.provider.selfHosted ? remotes.linkInstance(l.link) : null;
  let host: string | undefined;
  try { host = at ? new URL(at).host : undefined; } catch { /* the label alone */ }
  const known = explainGitFailure(String((err as { message?: string })?.message || err), { label: l.provider.label, host, fullName: l.link.fullName, branch, op });
  return known ? { error: known.error, code: known.code } : null;
}
