/**
 * Shared persistence types + the DataStore interface. This is the seam that
 * lets Aldine run on flat JSON files (slim self-host default) or Postgres
 * (horizontally-scalable cloud) without the rest of the code knowing which.
 *
 * Only relational/metadata state lives here. Project file contents stay in git
 * repos on disk (see store.ts) — that's a separate storage concern.
 */

export interface User {
  id: string;
  /** null for accounts whose identity provider shares no verified address
   *  (ORCID by default). Such accounts cannot use password sign-in, reset
   *  links or email invitations; they are reached by provider subject. */
  email: string | null;
  name: string;
  salt: string;
  hash: string;
  createdAt: string;
  /** Last authenticated request, coarse (touched at most every few minutes).
   *  The basis for "active users"; absent for accounts that never signed in
   *  since the field was introduced. */
  lastSeenAt?: string;
  provider?: string;
  /** Stable provider-scoped identity, `orcid:0000-0002-1825-0097`. Unique. */
  subject?: string;
}

export interface Reply { author: string; body: string; createdAt: string }
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
  replies: Reply[];
}

export interface ProjectMeta {
  id: string;
  name: string;
  rootFile: string;
  engine: 'pdf' | 'xelatex' | 'lualatex';
  /** Pass -halt-on-error: the run stops at the first error and the preview
   *  keeps the previous PDF. Off (default) runs to the end and shows the
   *  complete PDF beside the error list. */
  stopOnFirstError?: boolean;
  createdAt: string;
  /** Soft-delete marker: set when the project is moved to trash; purged after ~30 days. */
  deletedAt?: string;
  ownerId?: string;
  share?: { mode: 'private' | 'link'; collaborators: string[] };
  zotero?: {
    apiKey: string;
    userId: number;
    username?: string;
    libraryPrefix: string;
    collectionKey?: string;
    lastVersion?: number;
    bibFile: string;
    lastSyncedAt?: string;
  };
  /** Remote repository this project syncs with (imported from, or published to). */
  remote?: RemoteLink;
  /**
   * @deprecated Pre-GitLab shape of `remote` for provider 'github'. Read through
   * `store.remoteLink()`, which prefers `remote`; `store.setRemoteLink()` moves
   * a project over on its next write. Removed once no stored meta carries it.
   */
  github?: Omit<RemoteLink, 'provider'>;
}

export interface RemoteLink {
  provider: 'github' | 'gitlab';
  /** Host path of the repository: `owner/repo`, or `group/sub/project` on GitLab. */
  fullName: string;
  owner: string;
  repo: string;
  remoteBranch: string; // the remote branch that local `main` maps to
  cloneUrl: string;     // credential-free https URL
  connectedBy?: string; // user id whose token created the link (for reference)
}

export interface SessionRow { userId: string; exp: number }

/**
 * Every method is async so a network-backed implementation (Postgres) is a
 * drop-in for the file-backed one. Implementations must be safe for concurrent
 * callers (the JSON backend writes atomically; Postgres is transactional).
 */
export interface DataStore {
  /** create tables / ensure directories. Called once at startup. */
  init(): Promise<void>;
  close(): Promise<void>;

  // users
  createUser(u: User): Promise<void>;
  getUser(id: string): Promise<User | null>;
  findUserByEmail(emailLower: string): Promise<User | null>;
  findUserBySubject(subject: string): Promise<User | null>;
  updateUser(u: User): Promise<void>;
  /** Every account, oldest first. Instance administration only. */
  listUsers(): Promise<User[]>;
  /** Record activity without a read-modify-write of the whole row, so a
   *  heartbeat racing a password change can never resurrect the old hash. */
  touchUser(id: string, lastSeenAt: string): Promise<void>;

  // sessions (revocable)
  createSession(sid: string, userId: string, exp: number): Promise<void>;
  getSession(sid: string): Promise<SessionRow | null>;
  deleteSession(sid: string): Promise<void>;
  deleteSessionsForUser(userId: string): Promise<void>;

  // password-reset tokens
  createReset(token: string, userId: string, exp: number): Promise<void>;
  getReset(token: string): Promise<SessionRow | null>;
  deleteReset(token: string): Promise<void>;

  // project metadata
  readMeta(id: string): Promise<ProjectMeta | null>;
  writeMeta(meta: ProjectMeta): Promise<void>;
  listMeta(): Promise<ProjectMeta[]>;
  deleteMeta(id: string): Promise<void>;

  // review comments (stored per project)
  loadComments(projectId: string): Promise<Comment[]>;
  saveComments(projectId: string, list: Comment[]): Promise<void>;

  // compile-time usage metering: seconds consumed per (user, month YYYY-MM)
  getUsageSeconds(userId: string, month: string): Promise<number>;
  addUsageSeconds(userId: string, month: string, seconds: number): Promise<void>;
  /** Instance-wide compile seconds for a month, across every user. */
  totalUsageSeconds(month: string): Promise<number>;

  // per-user external connections (e.g. a GitHub access token). Secrets — kept
  // in the secrets store, never in the compiler-visible projects dir.
  getConnection(userId: string, provider: string): Promise<Record<string, unknown> | null>;
  setConnection(userId: string, provider: string, data: Record<string, unknown>): Promise<void>;
  deleteConnection(userId: string, provider: string): Promise<void>;
}
