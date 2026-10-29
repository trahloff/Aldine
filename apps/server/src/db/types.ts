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
  /** Set on a password sign-up until its address is confirmed. Absent means
   *  confirmed: every account from before the field and every single
   *  sign-on account. Invites by email and ALDINE_ADMIN_EMAILS skip an
   *  account while it is set. */
  emailPending?: EmailPending;
  /** When an administrator disabled the account; absent means enabled,
   *  which every account from before the field is. A disabled account has no
   *  session and no credential that works. Only setDisabled changes it. */
  disabledAt?: string;
}

/** The one-time confirmation link of a pending address: `hash` is the
 *  SHA-256 digest of the link's secret, which is never stored. `earlier`
 *  holds links that still work after a new one was issued: only on an
 *  instance that sends no email, where the operator may already have passed
 *  an older link on. */
export interface EmailPending { hash: string; expiresAt: string; earlier?: Array<{ hash: string; expiresAt: string }> }

/** `author` is the display name shown with the text; `authorId` is the
 *  account that wrote it (absent without accounts and on older rows). Names
 *  are free text and not unique, so ownership is decided on the id only. */
export interface Reply { author: string; authorId?: string; body: string; createdAt: string }
export interface Comment {
  id: string;
  branch: string;
  file: string;
  anchor: { from: number; to: number; quote: string };
  author: string;
  authorId?: string;
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
  /** Created through the Agent API. The only projects its `trash_project` tool may trash: a person's own project is never within a tool's reach. */
  createdVia?: 'agent';
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
  /** Server-side push after every autosave on main (default on for provisioned projects). */
  autopush?: boolean;
  /** People commit by hand, with their own message: the edit debounce leaves their changes in the working tree (agent work still commits under its own name). */
  manualCommits?: boolean;
  /** Provisioning into a GitLab group was requested but has not happened yet (host down, or the project was deleted and may be restored). */
  remotePending?: { provider: 'gitlab'; namespace: string };
  /**
   * @deprecated Pre-GitLab shape of `remote` for provider 'github'. Read through
   * `store.remoteLink()`, which prefers `remote`; `store.setRemoteLink()` moves
   * a project over on its next write. Removed once no stored meta carries it.
   */
  github?: Omit<RemoteLink, 'provider'>;
}

export interface RemoteLink {
  provider: 'github' | 'gitlab' | 'gitea';
  /** Host path of the repository: `owner/repo`, or `group/sub/project` on GitLab. */
  fullName: string;
  owner: string;
  repo: string;
  remoteBranch: string; // the remote branch that local `main` maps to
  cloneUrl: string;     // credential-free https URL
  /** Instance the link was made on (self-hosted GitLab, every Gitea/Forgejo instance); absent on a provider's canonical host and on links from before the field. */
  baseUrl?: string;
  connectedBy?: string; // user id whose token created the link (for reference)
  /** Aldine created the repository (auto-provisioning); only then is it deleted with the project. */
  createdByAldine?: boolean;
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
 * How far one person has been shown Claude's work on one branch. `head` is
 * the branch commit they acknowledged; `at` bounds the answer when that
 * commit is no longer on the branch (a reset to a remote, a recreated
 * branch). `promptedHead` is the head of the last prompt raised for them:
 * a second sighting of the identical batch acknowledges it, so an ignored
 * prompt appears twice and never again.
 */
export interface ProjectVisit {
  userId: string;
  projectId: string;
  branch: string;
  head: string;
  at: string;
  promptedHead: string | null;
}

/**
 * One person's own relation to a project on their project list: when they
 * last opened it and on which branch (both null when they never did), and
 * whether they took it off their list. A link visitor's project is listed
 * because this row exists; an invited member's is listed unless `hidden`.
 */
export interface ProjectOpen {
  userId: string;
  projectId: string;
  at: string | null;
  branch: string | null;
  hidden: boolean;
}

/**
 * An owner's invitation to one address or ORCID iD. It grants nothing: the
 * project's share list is the only source of access, and accepting adds
 * `to` there. `id` is the random secret in the invitation link (128 bits, so
 * links cannot be guessed), but it is not a credential: accepting takes a
 * session whose confirmed address, or ORCID iD, is `to`. A pending
 * invitation past `expiresAt` is expired; `respondedAt` is set with any
 * other status. `emailedAt` is the last mail sent for it, null when none.
 */
export interface Invitation {
  id: string;
  projectId: string;
  /** Lowercased email address, or an ORCID iD with an uppercase X. */
  to: string;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'accepted' | 'declined' | 'withdrawn';
  respondedAt: string | null;
  emailedAt: string | null;
}

/** The last change to a project's files, on any branch. `byId` is the
 *  account; agent writes carry the agent's name with a null id; both are null
 *  when nobody is known (read from git history, or a write without accounts). */
export interface LastEdit { at: string; byId: string | null; byName: string | null; branch: string }

/** The last finished typeset of one branch. `errors` counts error rows only. */
export interface CompileMark { status: 'ok' | 'error'; errors: number; at: string }

/** What the project list shows about a project's work, kept apart from its
 *  metadata so a settings write holding an older copy of the metadata can
 *  never take it back. `compile` is keyed by branch. */
export interface ProjectActivity {
  projectId: string;
  lastEdit: LastEdit | null;
  compile: Record<string, CompileMark>;
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
  /** Throws when the store cannot serve reads (/api/health). Postgres has
   *  none: a lost connection fails the query that meets it and recovers. */
  check?(): Promise<void>;

  // users
  createUser(u: User): Promise<void>;
  getUser(id: string): Promise<User | null>;
  findUserByEmail(emailLower: string): Promise<User | null>;
  findUserBySubject(subject: string): Promise<User | null>;
  /** Writes every field but disabledAt, which keeps its stored value: a copy
   *  read before an administrator disabled the account must not enable it
   *  again when a sign-in or password change writes it back. */
  updateUser(u: User): Promise<void>;
  /** Every account, oldest first. Instance administration only. */
  listUsers(): Promise<User[]>;
  /** Record activity without a read-modify-write of the whole row, so a
   *  heartbeat racing a password change can never resurrect the old hash. */
  touchUser(id: string, lastSeenAt: string): Promise<void>;
  /** Set (a new link) or clear (confirmed) emailPending alone, for the same
   *  reason as touchUser. */
  setEmailPending(id: string, pending: EmailPending | null): Promise<void>;
  /** Disable (the time it happened) or enable (null) the account, writing
   *  that field alone. */
  setDisabled(id: string, disabledAt: string | null): Promise<void>;
  /** Remove the account and every row that exists only for it: sessions,
   *  reset links, access and refresh tokens, linked connections, its project
   *  list rows and review marks. Usage seconds stay, they make up the
   *  instance totals. The projects it owns and the shares naming it are the
   *  caller's to settle first. The account row goes last, so a removal cut
   *  short can be run again. */
  deleteUser(id: string): Promise<void>;

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
  /** Revoke every access token and refresh token the user holds, hand-made
   *  and OAuth-minted alike. A refresh token outlives the revocation of its
   *  access token alone (RFC 7009), so walking the token list is not enough.
   *  An earlier revokedAt is kept. */
  revokeCredentialsForUser(userId: string, revokedAt: string): Promise<void>;

  // project metadata
  readMeta(id: string): Promise<ProjectMeta | null>;
  writeMeta(meta: ProjectMeta): Promise<void>;
  listMeta(): Promise<ProjectMeta[]>;
  deleteMeta(id: string): Promise<void>;
  /** Add one entry to a project's share list in a single write that keeps
   *  the rest of the metadata: two accepts landing together must both stay.
   *  False when the project does not exist. */
  addShareEntry(projectId: string, entry: string): Promise<boolean>;

  // review comments (stored per project)
  loadComments(projectId: string): Promise<Comment[]>;
  saveComments(projectId: string, list: Comment[]): Promise<void>;

  // agent-review marks: how far each user has been shown Claude's commits
  getProjectVisit(userId: string, projectId: string, branch: string): Promise<ProjectVisit | null>;
  setProjectVisit(v: ProjectVisit): Promise<void>;
  /** Purge a project's marks; called when the project itself is deleted. */
  deleteProjectVisits(projectId: string): Promise<void>;

  // project list: each person's opens and removals
  listProjectOpens(userId: string): Promise<ProjectOpen[]>;
  getProjectOpen(userId: string, projectId: string): Promise<ProjectOpen | null>;
  setProjectOpen(o: ProjectOpen): Promise<void>;
  deleteProjectOpen(userId: string, projectId: string): Promise<void>;
  /** Point every open of `branch` at main; called when the branch is deleted. */
  resetProjectOpenBranch(projectId: string, branch: string): Promise<void>;
  /** Purge a project's opens; called when the project itself is deleted. */
  deleteProjectOpens(projectId: string): Promise<void>;

  // project list: last edit and last typeset per branch
  listProjectActivity(): Promise<ProjectActivity[]>;
  /** Keeps whichever of the stored and the given edit is newer (by `at`), so
   *  a late write of an older value (a history backfill) never wins. */
  setLastEdit(projectId: string, lastEdit: LastEdit): Promise<void>;
  /** setLastEdit for many projects at once (the history backfill), same rule per row. */
  setLastEdits(entries: Array<{ projectId: string; lastEdit: LastEdit }>): Promise<void>;
  /** Record a branch's last typeset; null forgets it (the branch was deleted). */
  setCompileMark(projectId: string, branch: string, mark: CompileMark | null): Promise<void>;
  /** Purge; called when the project itself is deleted. */
  deleteProjectActivity(projectId: string): Promise<void>;

  // invitations: staged shares, keyed by their link id
  /** Insert or replace by id. */
  setInvitation(inv: Invitation): Promise<void>;
  getInvitation(id: string): Promise<Invitation | null>;
  /** A project's invitations, oldest first. */
  listProjectInvitations(projectId: string): Promise<Invitation[]>;
  /** Invitations to any of `to` (addresses and iDs as stored), oldest first. */
  listInvitationsTo(to: string[]): Promise<Invitation[]>;
  /** Compare-and-set: moves a pending invitation to `status` and reports
   *  whether this call did. An accept racing a decline or a withdrawal must
   *  see exactly one winner. */
  settleInvitation(id: string, status: 'accepted' | 'declined' | 'withdrawn', at: string): Promise<boolean>;
  /** Set the given fields alone, and only while the invitation is pending,
   *  reporting whether it was: a resend or a mail racing an accept must not
   *  write a stale copy over the answer. */
  updatePendingInvitation(id: string, fields: { expiresAt?: string; emailedAt?: string }): Promise<boolean>;
  deleteInvitation(id: string): Promise<void>;
  /** Purge; called when the project itself is deleted. */
  deleteProjectInvitations(projectId: string): Promise<void>;

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
