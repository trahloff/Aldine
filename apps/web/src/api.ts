export interface AuthUser { id: string; email: string; name: string; provider?: string }
export interface OAuthProviderInfo { id: string; label: string }
export interface ProjectSummary {
  id: string;
  name: string;
  rootFile: string;
  engine: string;
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
  github?: { fullName: string; owner: string; repo: string; remoteBranch: string; cloneUrl: string } | null;
}

export interface GithubRepo { fullName: string; name: string; owner: string; private: boolean; defaultBranch: string; cloneUrl: string; updatedAt: string }
export interface GithubStatus { connected: boolean; login?: string; oauth: boolean }

export interface BranchInfo { name: string; head: string; message: string; date: string }
export interface ProjectDetail extends ProjectSummary { branches: BranchInfo[] }
export interface TreeEntry { path: string; type: 'file' | 'dir'; size?: number; binary?: boolean }
export interface CompileError { type: 'error' | 'warning' | 'typesetting'; line: number | null; message: string }
export interface CompileResult {
  ok: boolean;
  timedOut?: boolean;
  pdf: string | null;
  pdfUrl: string | null;
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

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = ((await res.json()) as { error?: string }).error || msg; } catch { /* keep */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export interface TemplateInfo { id: string; name: string; description?: string; icon?: string }

export const api = {
  listProjects: () => req<ProjectSummary[]>('/api/projects'),
  createProject: (name: string, files?: Record<string, string>, template?: string) =>
    req<ProjectSummary>('/api/projects', { method: 'POST', body: JSON.stringify({ name, files, template }) }),
  templates: () => req<TemplateInfo[]>('/api/templates'),
  importZip: (name: string, zipBase64: string) =>
    req<ProjectSummary>('/api/projects/import', { method: 'POST', body: JSON.stringify({ name, zipBase64 }) }),
  getProject: (id: string) => req<ProjectDetail>(`/api/projects/${id}`),
  patchProject: (id: string, patch: Partial<Pick<ProjectSummary, 'name' | 'rootFile' | 'engine'>>) =>
    req<ProjectSummary>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteProject: (id: string, permanent = false) => req<{ ok: boolean }>(`/api/projects/${id}${permanent ? '?permanent=1' : ''}`, { method: 'DELETE' }),
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

  // GitHub sync
  githubStatus: () => req<GithubStatus>('/api/github/status'),
  githubConnect: (token: string) => req<{ connected: boolean; login: string }>('/api/github/connect', { method: 'POST', body: JSON.stringify({ token }) }),
  githubDisconnect: () => req<{ ok: boolean }>('/api/github/disconnect', { method: 'POST' }),
  githubRepos: () => req<GithubRepo[]>('/api/github/repos'),
  githubImport: (fullName: string) => req<ProjectSummary>('/api/github/import', { method: 'POST', body: JSON.stringify({ fullName }) }),
  projectGithubStatus: (id: string) => req<{ linked: boolean; ahead: number; behind: number; fullName: string }>(`/api/projects/${id}/github/status`),
  githubLink: (id: string, name?: string, priv?: boolean) => req<{ ok: boolean; github: { fullName: string } }>(`/api/projects/${id}/github/link`, { method: 'POST', body: JSON.stringify({ name, private: priv }) }),
  githubPush: (id: string, message?: string, auto?: boolean) => req<{ ok: boolean }>(`/api/projects/${id}/github/push`, { method: 'POST', body: JSON.stringify({ message, auto }) }),
  // conflict-aware: returns { conflict, conflicts } on a 409 instead of throwing
  githubPull: async (id: string): Promise<{ ok?: boolean; conflict?: boolean; conflicts?: string[] }> => {
    const res = await fetch(`/api/projects/${id}/github/pull`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (res.status === 409) return { conflict: true, conflicts: body.conflicts || [] };
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return { ok: true };
  },
  githubResetToRemote: (id: string) => req<{ ok: boolean }>(`/api/projects/${id}/github/reset-to-remote`, { method: 'POST' }),
  githubBranches: (id: string) => req<{ branches: string[]; current: string; default: string }>(`/api/projects/${id}/github/branches`),
  githubSwitchBranch: (id: string, branch: string) => req<{ ok: boolean; branch: string }>(`/api/projects/${id}/github/switch-branch`, { method: 'POST', body: JSON.stringify({ branch }) }),
  githubCreateBranch: (id: string, name: string) => req<{ ok: boolean; branch: string }>(`/api/projects/${id}/github/create-branch`, { method: 'POST', body: JSON.stringify({ name }) }),
  githubOpenPR: (id: string, title?: string) => req<{ url: string; number: number }>(`/api/projects/${id}/github/pr`, { method: 'POST', body: JSON.stringify({ title }) }),
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
