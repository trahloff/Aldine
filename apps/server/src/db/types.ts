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
  /** OAuth-minted tokens carry the client's display name and a family id
   *  shared with their refresh tokens (refresh reuse revokes the family).
   *  Both null for hand-made tokens; absent on records written before the
   *  fields existed — readers treat undefined as null. */
  clientName: string | null;
  family: string | null;
}

/** Dynamically registered OAuth client (RFC 7591). Public client: no secret. */
export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  createdAt: string;
  lastUsedAt: string;
}

/**
 * OAuth refresh token. `hash` is the SHA-256 digest of the `aldr_` secret.
 * One `family` per consent; rotation marks the old record `usedAt` and a used
 * token presented again revokes every token in the family. `clientId` binds
 * the token to the public client that obtained it.
 */
export interface RefreshTokenRecord {
  id: string;
  hash: string;
  tokenId: string;
  userId: string;
  clientId: string;
  family: string;
  projectIds: string[] | null;
  clientName: string;
  expiresAt: string;
  usedAt: string | null;
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
  findUserBySubject(subject: string): Promise<User | null>;
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
  /** Also prunes OAuth-minted records (family != null) revoked for over a
   *  week. Expired-but-unrevoked ones must stay — the family's refresh token
   *  may be live and the record is the user's revoke handle. Hand-made tokens
   *  keep their audit trail. */
  createToken(t: TokenRecord): Promise<void>;
  getToken(id: string): Promise<TokenRecord | null>;
  getTokenByHash(hash: string): Promise<TokenRecord | null>;
  listTokensForUser(userId: string): Promise<TokenRecord[]>;
  updateToken(t: TokenRecord): Promise<void>;
  /** Set lastUsedAt alone. Bearer-request bookkeeping must not write a whole
   *  (possibly stale) record back — that could erase a concurrent revocation. */
  touchToken(id: string, lastUsedAt: string): Promise<void>;
  /** Revoke every access token minted in an OAuth family (refresh-token reuse, user revoke). */
  revokeTokensInFamily(family: string, revokedAt: string): Promise<void>;

  // OAuth clients (dynamic registration; capped, least-recently-used eviction)
  createOAuthClient(c: OAuthClient): Promise<void>;
  getOAuthClient(id: string): Promise<OAuthClient | null>;
  touchOAuthClient(id: string, lastUsedAt: string): Promise<void>;
  countOAuthClients(): Promise<number>;
  /** Delete the `n` clients with the oldest lastUsedAt. Returns how many were removed. */
  evictOldestOAuthClients(n: number): Promise<number>;

  // OAuth refresh tokens (looked up by SHA-256 digest at the token endpoint)
  createRefresh(r: RefreshTokenRecord): Promise<void>;
  getRefreshByHash(hash: string): Promise<RefreshTokenRecord | null>;
  /** Compare-and-set: flips usedAt only while it is null and the record is
   *  not revoked, and reports whether this call won. Two concurrent
   *  rotations of one token must see exactly one true — the loser is reuse. */
  markRefreshUsed(id: string, usedAt: string): Promise<boolean>;
  revokeRefreshFamily(family: string, revokedAt: string): Promise<void>;

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
