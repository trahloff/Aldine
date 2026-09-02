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
  email: string;
  name: string;
  salt: string;
  hash: string;
  createdAt: string;
  provider?: string;
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
  /** GitHub remote link (present when the project was imported from / pushed to GitHub). */
  github?: {
    fullName: string;   // owner/repo
    owner: string;
    repo: string;
    remoteBranch: string; // the GitHub branch that local `main` maps to
    cloneUrl: string;     // credential-free https URL
    connectedBy?: string; // user id whose token created the link (for reference)
  };
}

export interface SessionRow { userId: string; exp: number }

/**
 * Personal access token (headless agent credential). `hash` is the SHA-256
 * digest of the secret — the plaintext token is never stored. `projectIds:
 * null` means all of the user's projects; a non-null list restricts the token
 * to exactly those ids.
 */
export interface TokenRecord {
  id: string;
  userId: string;
  name: string;
  hash: string;
  projectIds: string[] | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

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
  updateUser(u: User): Promise<void>;

  // sessions (revocable)
  createSession(sid: string, userId: string, exp: number): Promise<void>;
  getSession(sid: string): Promise<SessionRow | null>;
  deleteSession(sid: string): Promise<void>;
  deleteSessionsForUser(userId: string): Promise<void>;

  // password-reset tokens
  createReset(token: string, userId: string, exp: number): Promise<void>;
  getReset(token: string): Promise<SessionRow | null>;
  deleteReset(token: string): Promise<void>;

  // personal access tokens (looked up by SHA-256 digest on every bearer request)
  createToken(t: TokenRecord): Promise<void>;
  getToken(id: string): Promise<TokenRecord | null>;
  getTokenByHash(hash: string): Promise<TokenRecord | null>;
  listTokensForUser(userId: string): Promise<TokenRecord[]>;
  updateToken(t: TokenRecord): Promise<void>;
  /** Set lastUsedAt alone. Bearer-request bookkeeping must not write a whole
   *  (possibly stale) record back — that could erase a concurrent revocation. */
  touchToken(id: string, lastUsedAt: string): Promise<void>;

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

  // per-user external connections (e.g. a GitHub access token). Secrets — kept
  // in the secrets store, never in the compiler-visible projects dir.
  getConnection(userId: string, provider: string): Promise<Record<string, unknown> | null>;
  setConnection(userId: string, provider: string, data: Record<string, unknown>): Promise<void>;
  deleteConnection(userId: string, provider: string): Promise<void>;
}
