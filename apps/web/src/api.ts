export interface AuthUser { id: string; email: string; name: string; provider?: string }
export interface OAuthProviderInfo { id: string; label: string }
export interface ProjectSummary {
  id: string;
  name: string;
  rootFile: string;
  engine: string;
  stopOnFirstError?: boolean;
  createdAt: string;
  ownerId?: string;
  ownerName?: string;
  isOwner?: boolean;
  /** Owner or invited collaborator — false for someone here via a share link.
   *  Gates the affordances the server restricts to members. */
  isMember?: boolean;
  /** `collaborators` is empty unless you are the owner (the server does not
   *  disclose other people's invite list). */
  share?: { mode: 'private' | 'link'; collaborators: string[] } | null;
  zotero: { libraryPrefix: string; collectionKey?: string; bibFile: string; lastSyncedAt?: string; username?: string } | null;
  remote?: RemoteInfo | null;
  /** Server-side autopush after autocommit. Shared by the project's collaborators. */
  autopush?: boolean;
  /** Set when auto-provisioning to a git host failed; drives the retry banner. */
  remotePending?: { provider: RemoteProviderId; namespace?: string } | null;
  /** Response-only, on create: why the host link could not be made. Never persisted. */
  remoteError?: string;
}

export type RemoteProviderId = 'github' | 'gitlab';
export interface RemoteInfo { provider: RemoteProviderId; fullName: string; owner: string; repo: string; remoteBranch: string; cloneUrl: string }
export interface RemoteRepo { fullName: string; name: string; owner: string; private: boolean; defaultBranch: string; cloneUrl: string; updatedAt: string }
export interface RemoteStatus { connected: boolean; login?: string; oauth: boolean; baseUrl?: string }
export interface RemoteProviderInfo { id: RemoteProviderId; label: string; oauth: boolean }
export interface GitlabNamespace { id: number; fullPath: string; name: string }

export interface BranchInfo { name: string; head: string; message: string; date: string }
export interface ProjectDetail extends ProjectSummary { branches: BranchInfo[] }
export interface TreeEntry { path: string; type: 'file' | 'dir'; size?: number; binary?: boolean }
export interface CompileError { type: 'error' | 'warning' | 'typesetting'; line: number | null; message: string }
export interface CompileResult {
  ok: boolean;
  timedOut?: boolean;
  pdf: string | null;
  pdfUrl: string | null;
  /** The run failed and pdfUrl is the last successful one, unchanged. */
  pdfStale?: boolean;
  /** The run whose PDF pdfUrl serves; sent back with SyncTeX lookups. */
  compileId?: number;
  synctex?: string | null;
  log: string;
  errors: CompileError[];
  durationMs: number;
  error?: string;
}
export interface BibEntry { key: string; type: string; author?: string; authorLabel?: string; title?: string; year?: string; journal?: string; file: string }
export interface LogEntry { hash: string; date: string; message: string; author: string }
export interface PluginManifest { id: string; name: string; description?: string; version: string; entry: string; icon?: string; enabled?: boolean }
export interface CommentReply { author: string; body: string; createdAt: string }
export interface Comment {
  id: string;
  branch: string;
  file: string;
  anchor: { from: number; to: number; quote: string };
  author: string;
  body: string;
  suggestion?: string;
  resolved: boolean;
  createdAt: string;
  replies: CommentReply[];
}

/** Carries the HTTP status so callers can tell a body-limit 413 (proxy or
 *  framework, no JSON `error` text worth quoting) from a route's own message. */
export class ApiError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = ((await res.json()) as { error?: string }).error || msg; } catch { /* keep */ }
    throw new ApiError(msg, res.status);
  }
  return res.json() as Promise<T>;
}

export interface TemplateInfo { id: string; name: string; description?: string; icon?: string; order?: number; source: 'local' | 'gitlab' }

/**
 * A delete also removes the remote repo Aldine created. `remoteDelete` is absent
 * for an unlinked project; when it reports a failure the local project is gone
 * either way, so the UI has to say so rather than swallow it.
 */
export interface DeleteResult {
  ok: boolean;
  remoteDelete?: { deleted: boolean; scheduledFor?: string; reason?: string };
}

export const api = {
  listProjects: () => req<ProjectSummary[]>('/api/projects'),
  createProject: (name: string, files?: Record<string, string>, template?: string, namespace?: string) =>
    req<ProjectSummary>('/api/projects', { method: 'POST', body: JSON.stringify({ name, files, template, namespace }) }),
  templates: () => req<TemplateInfo[]>('/api/templates'),
  importZip: (name: string, zipBase64: string, namespace?: string) =>
    req<ProjectSummary>('/api/projects/import', { method: 'POST', body: JSON.stringify({ name, zipBase64, namespace }) }),
  getProject: (id: string) => req<ProjectDetail>(`/api/projects/${id}`),
  patchProject: (id: string, patch: Partial<Pick<ProjectSummary, 'name' | 'rootFile' | 'engine' | 'stopOnFirstError'>>) =>
    req<ProjectSummary>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteProject: (id: string, permanent = false) => req<DeleteResult>(`/api/projects/${id}${permanent ? '?permanent=1' : ''}`, { method: 'DELETE' }),
  restoreProject: (id: string) => req<{ ok: boolean }>(`/api/projects/${id}/restore`, { method: 'POST' }),
  claimProject: (id: string) => req<ProjectSummary>(`/api/projects/${id}/claim`, { method: 'POST' }),
  listTrash: () => req<{ id: string; name: string; deletedAt: string }[]>('/api/projects/trash'),

  listFiles: (id: string, branch: string) => req<TreeEntry[]>(`/api/projects/${id}/files?branch=${encodeURIComponent(branch)}`),
  readFile: async (id: string, branch: string, path: string) => {
    const res = await fetch(`/api/projects/${id}/file?branch=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  },
  writeFile: (id: string, branch: string, path: string, content: string, encoding: 'utf8' | 'base64' = 'utf8') =>
    req<{ ok: boolean }>(`/api/projects/${id}/file`, { method: 'PUT', body: JSON.stringify({ branch, path, content, encoding }) }),
  createFile: (id: string, branch: string, path: string) =>
    req<{ ok: boolean }>(`/api/projects/${id}/file`, { method: 'PUT', body: JSON.stringify({ branch, path, content: '', createOnly: true }) }),
  deleteFile: (id: string, branch: string, path: string) =>
    req<{ ok: boolean }>(`/api/projects/${id}/file?branch=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  renameFile: (id: string, branch: string, from: string, to: string) =>
    req<{ ok: boolean }>(`/api/projects/${id}/file/rename`, { method: 'POST', body: JSON.stringify({ branch, from, to }) }),

  compile: (id: string, branch: string) =>
    req<CompileResult>(`/api/projects/${id}/compile`, { method: 'POST', body: JSON.stringify({ branch }) }),
  synctex: (id: string, branch: string, payload: Record<string, unknown>) =>
    req<{ ok: boolean; records: Array<Record<string, number | string>> }>(`/api/projects/${id}/synctex`, { method: 'POST', body: JSON.stringify({ branch, ...payload }) }),
  bib: (id: string, branch: string) => req<BibEntry[]>(`/api/projects/${id}/bib?branch=${encodeURIComponent(branch)}`),
  wordcount: (id: string, branch: string) =>
    req<{ rootFile: string; total: number; files: Record<string, number> }>(`/api/projects/${id}/wordcount?branch=${encodeURIComponent(branch)}`),
  labels: (id: string, branch: string) => req<Array<{ label: string; file: string }>>(`/api/projects/${id}/labels?branch=${encodeURIComponent(branch)}`),

  branches: (id: string) => req<BranchInfo[]>(`/api/projects/${id}/branches`),
  createBranch: (id: string, name: string, from: string) =>
    req<{ ok: boolean }>(`/api/projects/${id}/branches`, { method: 'POST', body: JSON.stringify({ name, from }) }),
  deleteBranch: (id: string, name: string) =>
    req<{ ok: boolean }>(`/api/projects/${id}/branches?name=${encodeURIComponent(name)}`, { method: 'DELETE' }),
  commit: (id: string, branch: string, message: string, author?: string) =>
    req<{ committed: boolean; hash?: string }>(`/api/projects/${id}/commit`, { method: 'POST', body: JSON.stringify({ branch, message, author }) }),
  log: (id: string, branch: string) => req<LogEntry[]>(`/api/projects/${id}/log?branch=${encodeURIComponent(branch)}`),
  commitDiff: (id: string, hash: string) => req<{ patch: string; stat: string }>(`/api/projects/${id}/commit/${hash}/diff`),

  // Remote sync (GitHub / GitLab)
  remotes: () => req<RemoteProviderInfo[]>('/api/remotes'),
  remoteStatus: (p: RemoteProviderId) => req<RemoteStatus>(`/api/remotes/${p}/status`),
  remoteConnect: (p: RemoteProviderId, token: string, baseUrl?: string) =>
    req<{ connected: boolean; login: string }>(`/api/remotes/${p}/connect`, { method: 'POST', body: JSON.stringify({ token, baseUrl }) }),
  remoteDisconnect: (p: RemoteProviderId) => req<{ ok: boolean }>(`/api/remotes/${p}/disconnect`, { method: 'POST' }),
  /** Throws with `.tokenInvalid` set when the stored token was revoked, so the UI can prompt a reconnect. */
  remoteRepos: async (p: RemoteProviderId): Promise<RemoteRepo[]> => {
    const res = await fetch(`/api/remotes/${p}/repos`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error || `HTTP ${res.status}`) as Error & { tokenInvalid?: boolean };
      if (body.reason === 'token-invalid') err.tokenInvalid = true;
      throw err;
    }
    return body as RemoteRepo[];
  },
  remoteImport: (p: RemoteProviderId, fullName: string) =>
    req<ProjectSummary>(`/api/remotes/${p}/import`, { method: 'POST', body: JSON.stringify({ fullName }) }),
  projectRemoteStatus: (id: string) => req<{ linked: boolean; ahead: number; behind: number; fullName: string }>(`/api/projects/${id}/remote/status`),
  /** Omit `provider` to retry a pending auto-provision — the server then sends the
   *  project to the group it was originally meant for, not a fresh personal repo. */
  remoteLink: (id: string, provider?: RemoteProviderId, name?: string, priv?: boolean) =>
    req<{ ok: boolean; remote: RemoteInfo }>(`/api/projects/${id}/remote/link`, { method: 'POST', body: JSON.stringify({ provider, name, private: priv }) }),
  remotePush: (id: string, message?: string, auto?: boolean) =>
    req<{ ok: boolean }>(`/api/projects/${id}/remote/push`, { method: 'POST', body: JSON.stringify({ message, auto }) }),
  // conflict-aware: returns { conflict, conflicts } on a 409 instead of throwing
  remotePull: async (id: string): Promise<{ ok?: boolean; conflict?: boolean; conflicts?: string[] }> => {
    const res = await fetch(`/api/projects/${id}/remote/pull`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (res.status === 409) return { conflict: true, conflicts: body.conflicts || [] };
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return { ok: true };
  },
  remoteResetToRemote: (id: string) => req<{ ok: boolean }>(`/api/projects/${id}/remote/reset-to-remote`, { method: 'POST' }),
  remoteBranches: (id: string) => req<{ branches: string[]; current: string; default: string }>(`/api/projects/${id}/remote/branches`),
  remoteSwitchBranch: (id: string, branch: string) =>
    req<{ ok: boolean; branch: string }>(`/api/projects/${id}/remote/switch-branch`, { method: 'POST', body: JSON.stringify({ branch }) }),
  remoteCreateBranch: (id: string, name: string) =>
    req<{ ok: boolean; branch: string }>(`/api/projects/${id}/remote/create-branch`, { method: 'POST', body: JSON.stringify({ name }) }),
  remoteOpenChangeRequest: (id: string, title?: string) =>
    req<{ url: string; number: number }>(`/api/projects/${id}/remote/change-request`, { method: 'POST', body: JSON.stringify({ title }) }),
  remoteAutopush: (id: string, enabled: boolean) =>
    req<{ ok: boolean; autopush: boolean }>(`/api/projects/${id}/remote/autopush`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  // GitLab-only: group nesting has no GitHub analogue. 404 means the deployment
  // has no default group, which the picker reads as "don't render".
  gitlabNamespaces: () => req<{ root: string; namespaces: GitlabNamespace[] }>('/api/remotes/gitlab/namespaces'),
  gitlabCreateSubgroup: (parentPath: string, name: string) =>
    req<{ id: number; fullPath: string }>('/api/remotes/gitlab/subgroups', { method: 'POST', body: JSON.stringify({ parentPath, name }) }),
  merge: (id: string, from: string, into: string, author?: string) =>
    req<{ ok: boolean; conflicts?: string[]; message?: string }>(`/api/projects/${id}/merge`, { method: 'POST', body: JSON.stringify({ from, into, author }) }),

  zoteroValidate: (apiKey: string) =>
    req<{ userID: number; username?: string; groups: Array<{ id: number; name: string }> }>('/api/zotero/validate', { method: 'POST', body: JSON.stringify({ apiKey }) }),
  zoteroCollections: (apiKey: string, libraryPrefix: string) =>
    req<Array<{ key: string; name: string; parent: string | false }>>('/api/zotero/collections', { method: 'POST', body: JSON.stringify({ apiKey, libraryPrefix }) }),
  zoteroLink: (id: string, body: { apiKey: string; libraryPrefix: string; collectionKey?: string; bibFile?: string }) =>
    req<{ ok: boolean; itemCount?: number; bibFile?: string }>(`/api/projects/${id}/zotero/link`, { method: 'POST', body: JSON.stringify(body) }),
  zoteroSync: (id: string, branch: string, force = false) =>
    req<{ synced: boolean; unchanged?: boolean; itemCount?: number; bibFile?: string }>(`/api/projects/${id}/zotero/sync`, { method: 'POST', body: JSON.stringify({ branch, force }) }),
  zoteroUnlink: (id: string) => req<{ ok: boolean }>(`/api/projects/${id}/zotero`, { method: 'DELETE' }),

  plugins: () => req<PluginManifest[]>('/api/plugins'),

  comments: (id: string, branch: string) => req<Comment[]>(`/api/projects/${id}/comments?branch=${encodeURIComponent(branch)}`),
  addComment: (id: string, body: { branch: string; file: string; anchor: { from: number; to: number; quote: string }; body: string; suggestion?: string; author?: string }) =>
    req<Comment>(`/api/projects/${id}/comments`, { method: 'POST', body: JSON.stringify(body) }),
  replyComment: (id: string, cid: string, body: string, author?: string) =>
    req<Comment>(`/api/projects/${id}/comments/${cid}/reply`, { method: 'POST', body: JSON.stringify({ body, author }) }),
  resolveComment: (id: string, cid: string, resolved: boolean) =>
    req<Comment>(`/api/projects/${id}/comments/${cid}/resolve`, { method: 'POST', body: JSON.stringify({ resolved }) }),
  acceptSuggestion: (id: string, cid: string, branch: string) =>
    req<{ ok: boolean }>(`/api/projects/${id}/comments/${cid}/accept`, { method: 'POST', body: JSON.stringify({ branch }) }),
  deleteComment: (id: string, cid: string) =>
    req<{ ok: boolean }>(`/api/projects/${id}/comments/${cid}`, { method: 'DELETE' }),

  me: () => req<{ authEnabled: boolean; passwordAuth: boolean; user: AuthUser | null; providers: OAuthProviderInfo[] }>('/api/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    req<{ ok: boolean }>('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
  resetRequest: (email: string) =>
    req<{ ok: boolean; token?: string }>('/api/auth/reset-request', { method: 'POST', body: JSON.stringify({ email }) }),
  resetPassword: (token: string, newPassword: string) =>
    req<{ ok: boolean }>('/api/auth/reset', { method: 'POST', body: JSON.stringify({ token, newPassword }) }),
  login: (email: string, password: string) =>
    req<{ user: AuthUser }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  register: (email: string, password: string, name?: string) =>
    req<{ user: AuthUser }>('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password, name }) }),
  logout: () => req<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  share: (id: string, mode: 'private' | 'link', collaborators: string[]) =>
    req<ProjectSummary>(`/api/projects/${id}/share`, { method: 'POST', body: JSON.stringify({ mode, collaborators }) }),
};

/** Local identity for presence + commit attribution. */
export function localUser(): { name: string; color: string } {
  let name = localStorage.getItem('aldine.name');
  if (!name) {
    name = `Writer ${Math.floor(100 + Math.random() * 900)}`;
    localStorage.setItem('aldine.name', name);
  }
  const palette = ['#e8554d', '#f0a202', '#2e933c', '#2e62e9', '#8f3ec9', '#d63384', '#0aa2c0'];
  let color = localStorage.getItem('aldine.color');
  if (!color) {
    color = palette[Math.floor(Math.random() * palette.length)];
    localStorage.setItem('aldine.color', color);
  }
  return { name, color };
}
