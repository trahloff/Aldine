import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as store from './store.js';
import * as gitops from './gitops.js';
import * as zotero from './zotero.js';
import { bibLoadState, addBibLoad, referenceTarget, paperBibFormat } from './bibload.js';
import { compileProject, compileStatus, synctexLookup, forgetPdfUrls, compilerInfo, typesetsSettled, withBranchTypesetsClosed, isBranchClosed, stopTypeset, CompilerUnavailableError } from './compile.js';
import * as usage from './usage.js';
import * as remotes from './remotes.js';
import * as gitlab from './gitlab.js';
import { provisioningEnabled, provisionProject, deprovisionProject, rootGroup, withinRoot, type DeprovisionResult } from './provision.js';
import { scheduleAutopush, cancelAutopush, lastPushedHead } from './autopush.js';
import { pruneImages, restoreImage, saveImage } from './undoImages.js';
import { explainGitFailure, explainCreateRepoFailure, explainChangeRequestFailure, explainRepoReadFailure, noAnswer } from './sync-errors.js';
import { flushBranchDocs, refreshBranchDocsFromDisk, signalCommitted, evictDoc, evictTree, scheduleCommit, closeProjectConnections, markPathsChanged, markTreeChanged, contentVersion, fileVersion, versionConflict, applySuggestionToDoc, protectedProjects, agentSessionActive, docView, withCrlf, locateQuote, bumpCommentsSignal } from './collab.js';
import { publishProjectEvent } from './events.js';
import { trashProject, restorableUntil } from './trash.js';
import { noteEdit, editorOf, forgetBranch, activitySnapshot, backfillLastEdits } from './activity.js';
import type { ProjectActivity } from './db/types.js';
import { db } from './db/index.js';
import { listPlugins, pluginAssetPath } from './plugins.js';
import { listAllTemplates, resolveTemplateSeed, type TemplateSeed } from './templates.js';
import { warmVenueCache } from './catalog.js';
import { startTemplateRepoRefresh, syncAllTemplateRepos, templateRepoStates } from './templaterepos.js';
import { addReference, fetchBibEntry, searchWorks } from './references.js';
import { bibIndex, labelIndex, wordCount } from './indexes.js';
import { unzip, zipEntryCount, ZipError } from './unzip.js';
import { guessRoot, detectRoot, adoptRootIfUnset } from './root.js';
import { config } from './config.js';
import { detectEngine, decodeText } from './detect.js';
import { multipartBoundary, parseMultipart } from './multipart.js';
import { aiAutoFix, aiConfigured, aiModel, diagnose } from './ai.js';
import * as comments from './comments.js';
import * as auth from './auth.js';
import * as oauth from './oauth.js';
import * as email from './email.js';
import { canAccess, canEdit, isAdmin, isMember, isOwner, listingAccess, ownerName, type ListAccess } from './authz.js';
import { noteActivity, registerAdminRoutes } from './admin.js';
import { loginLimiter, registerLimiter, signInBackoff, confirmResendLimiter, aiLimiter, refLimiter, visitLimiter, compileGate, compileLimiter, searchLimiter, replaceLimiter, copyLimiter, inviteLimiter, shareLimiter, shareBurst, clientKey } from './ratelimit.js';
import { invitationMail, newInvitationId, inviteExpiry, stateOf, recipientKeys, isOrcidId, isEmailAddress, normalizeEntry, INVITE_ID_RE, type InviteReport } from './invites.js';
import { searchProject, replaceInProject, SearchError, type ReplaceBody } from './search.js';
import { safeJoin, isTextFile, rawFileType, RAW_FILE_CSP, importPath, wrapperFolder, isHiddenPath, optionLikePath, cleanCommitMessage, overlongPath, pathConflict, seedError, newId, rootSiblingPath, BRANCH_RE, PROJECT_ID_RE, invalidRootFile, publicBase } from './util.js';
import { registerOAuth } from './oauth/routes.js';
import { verifyOutputSignature, isOutputPath } from './output-signing.js';
import { projectThumb, readThumbImage, etagMatches } from './thumbnail.js';
import { readTemplatePreview, withPreviews } from './templatepreviews.js';

type Q = { branch?: string; path?: string; name?: string; force?: string };

/** ASCII file name for a project archive, the fallback beside the UTF-8 one
 *  in the header: anything outside letters, digits, dot, dash and underscore
 *  becomes a dash. */
function archiveFolderName(name: string): string {
  const ascii = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);
  return ascii || 'project';
}

/** Whether a file route's path names a file or folder inside the project.
 *  '.', './' and an absolute path name none: the first two resolve to the
 *  branch directory, which on main is the repository with its .git. */
const namesEntry = (rel: unknown) => typeof rel === 'string' && importPath(rel) !== null;
const NOT_AN_ENTRY = 'Path must name a file or folder in the project';

/**
 * The /api/projects/:id routes an access token may use besides reads: the
 * project's content and settings (files, typesetting, commits and reverts, a
 * new branch, references, comments, restoring from the trash). Sharing,
 * ownership, trash and purge, the remote and Zotero links, merging, deleting
 * a branch and the AI fix take a browser session (docs/AGENT_API.md, "What it
 * cannot do"); so does every route not listed here. Reads exclude remote/*
 * and github/*: those call the provider with the stored connection. Keyed
 * by method and registered route pattern, never by the raw URL.
 */
const TOKEN_PROJECT_WRITES = new Set([
  'PATCH /api/projects/:id',
  'POST /api/projects/:id/restore',
  'PUT /api/projects/:id/file',
  'POST /api/projects/:id/file/rename',
  'DELETE /api/projects/:id/file',
  'POST /api/projects/:id/compile',
  'POST /api/projects/:id/synctex',
  'POST /api/projects/:id/branches',
  'POST /api/projects/:id/commit',
  'POST /api/projects/:id/revert',
  'POST /api/projects/:id/references/add',
  'POST /api/projects/:id/zotero/sync',
  'POST /api/projects/:id/comments',
  'POST /api/projects/:id/comments/:cid/reply',
  'POST /api/projects/:id/comments/:cid/resolve',
  'POST /api/projects/:id/comments/:cid/accept',
  'DELETE /api/projects/:id/comments/:cid',
]);
function tokenMayUseProjectRoute(method: string, route: string | undefined): boolean {
  if (!route) return false;
  if (method === 'GET' || method === 'HEAD') return !/^\/api\/projects\/:id\/(remote|github)\//.test(route);
  return TOKEN_PROJECT_WRITES.has(`${method} ${route}`);
}

/**
 * Current user for a request. Resolved once per request by an onRequest hook
 * (which awaits the async datastore) and cached on the request, so the many
 * call sites stay synchronous.
 */
function reqUser(req: any): auth.PublicUser | null {
  return req._user ?? null;
}

/** Validate an email/password body before it reaches auth (avoids leaking
 *  internal TypeErrors on malformed requests, and caps lengths). Returns an
 *  error message, or null when the shape is acceptable. */
function badCredentials(body: { email?: unknown; password?: unknown } | undefined): string | null {
  const email = body?.email, password = body?.password;
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return 'Email and password are required';
  }
  if (email.length > 254) return 'Email is too long';
  if (password.length > 1024) return 'Password is too long';
  return null;
}

function oauthProviders(): Array<{ id: string; label: string }> {
  return oauth.configuredProviders().map((p) => ({ id: p.id, label: p.label }));
}
/** Last HEAD we successfully pushed per project — lets auto-sync skip a no-op
 *  network push. In-memory (single-node); cleared on restart → push-when-unsure. */

/** Raw ZIP size the import route accepts; the web import dialog states the same figure. */
export const IMPORT_MAX_ZIP_BYTES = 60 * 1024 * 1024;
const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));

/** Collaborators and open invitations a project holds at most, together. */
const MAX_SHARE_ENTRIES = 50;

/** Engines the compiler distinguishes; anything else silently became pdflatex. */
export const ENGINES = ['pdf', 'xelatex', 'lualatex'] as const;

async function publicMeta(meta: store.ProjectMeta, user?: auth.PublicUser | null) {
  const { zotero: z, ownerId, share, github: _legacy, remote: _remote, autopushFailure: _autopushFailure, ...rest } = meta;
  // Older web bundles read `github`; emit it alongside `remote` for github links
  // until the next release, then it goes.
  const link = store.remoteLink(meta);
  // The collaborator roster is the owner's private list of invitee email
  // addresses — never hand it to the other people who can open the project
  // (link visitors most of all). Everyone else sees the mode only.
  const owner = user !== undefined && isOwner(meta, user);
  return {
    ...rest,
    share: share && (owner ? share : { mode: share.mode, collaborators: [], ...(share.linkRole ? { linkRole: share.linkRole } : {}) }),
    ownerId,
    ownerName: await ownerName(meta),
    remote: link,
    github: link?.provider === 'github' ? link : undefined,
    isOwner: user !== undefined ? isOwner(meta, user) : undefined,
    isMember: user !== undefined ? isMember(meta, user) : undefined,
    // False for "Can view": the editor opens read-only, comments stay open.
    canEdit: user !== undefined ? canEdit(meta, user) : undefined,
    zotero: z ? {
      libraryPrefix: z.libraryPrefix,
      collectionKey: z.collectionKey,
      bibFile: z.bibFile,
      lastSyncedAt: z.lastSyncedAt,
      username: z.username,
      libraryName: z.libraryName,
      collectionName: z.collectionName,
    } : null,
    thumb: await projectThumb(meta),
  };
}

/** Whose project list a request reads and writes: the account, or with
 *  accounts off the one implicit user. */
const listUserId = (user: auth.PublicUser | null) => user?.id ?? 'local';

/** A project list row: the project, plus what the list says about the
 *  caller's relation to it and its work. The typeset shown is the one of the
 *  branch the caller last had open. */
async function projectRow(meta: store.ProjectMeta, user: auth.PublicUser | null, open: store.ProjectOpen | null, activity: ProjectActivity | undefined, access: ListAccess) {
  const opened = open?.at ? { at: open.at, branch: open.branch || 'main' } : null;
  const branch = opened?.branch ?? 'main';
  const mark = activity?.compile[branch];
  return {
    ...(await publicMeta(meta, user)),
    lastEdit: activity?.lastEdit ?? null,
    opened,
    compile: mark ? { ...mark, branch } : null,
    thumb: await projectThumb(meta, branch),
    access,
  };
}

/**
 * Guards for routes the global preHandler's canAccess is too weak for. Link
 * mode says "anyone signed in with the link can edit" — the document, not the
 * project. Reconfiguring it, or reaching through it into the owner's linked
 * Zotero/GitHub accounts, needs membership or ownership. Both return null
 * after replying 403, so callers do: `const meta = await requireX(...); if
 * (!meta) return;`
 */
async function requireMember(req: any, reply: any, action: string): Promise<store.ProjectMeta | null> {
  const meta = await store.readMeta(req.params.id);
  if (!isMember(meta, reqUser(req))) {
    reply.code(403).send({ error: `Only the owner and collaborators can ${action}` });
    return null;
  }
  return meta;
}

/** What a person who can only view (authz.canEdit) may still send: building
 *  the document, their own project list and copy (like downloading it), and
 *  review comments. Every other write answers VIEW_ONLY, so a route added
 *  later is closed to viewers until it is listed here. */
const VIEWER_WRITES = new Set([
  '/api/projects/:id/compile', '/api/projects/:id/synctex',
  '/api/projects/:id/opened', '/api/projects/:id/listing', '/api/projects/:id/copy',
  '/api/projects/:id/comments', '/api/projects/:id/comments/:cid/reply', '/api/projects/:id/comments/:cid/resolve', '/api/projects/:id/comments/:cid',
  '/api/projects/:id/agent-activity/seen',
]);
/** Reads closed to viewers: they reach the owner's linked accounts only to
 *  change the document (a citation search inserts what it finds). */
const VIEWER_READS_REFUSED = new Set(['/api/projects/:id/zotero/search']);
const viewerMay = (method: string, route: string | undefined) => (method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
  ? !VIEWER_READS_REFUSED.has(route ?? '')
  : VIEWER_WRITES.has(route ?? ''));
const VIEW_ONLY = 'You can view this project, not change it. Ask its owner for edit access.';

/** The Zotero link runs on the owner's own API key: an account an
 *  administrator disabled lends it to nobody. */
async function ownerDisabled(meta: store.ProjectMeta): Promise<boolean> {
  return !!meta.ownerId && !!(await auth.getUser(meta.ownerId).catch(() => null))?.disabledAt;
}
const ZOTERO_OWNER_DISABLED = 'The owner\'s account is disabled, so the project\'s Zotero library cannot be used.';

async function requireOwner(req: any, reply: any, action: string): Promise<store.ProjectMeta | null> {
  const meta = await store.readMeta(req.params.id);
  if (!isOwner(meta, reqUser(req))) {
    reply.code(403).send({ error: `Only the owner can ${action}` });
    return null;
  }
  return meta;
}


/** A repository as typed or pasted into the import search: `owner/repo`, a
 *  name, or the repository's web or clone URL, reduced to its path (a
 *  GitHub /tree/… or GitLab /-/… suffix dropped). */
export function repoQuery(raw: unknown): string {
  let q = String(raw ?? '').trim().slice(0, 200);
  const url = q.match(/^https?:\/\/[^/]+\/(.+)$/) || q.match(/^(?:ssh:\/\/)?git@[^:/]+[:/](.+)$/);
  if (url) q = url[1].replace(/\/-\/.*$/, '').replace(/\/(tree|blob|pulls?|issues|merge_requests)(\/.*)?$/, '');
  return q.replace(/\.git$/, '').replace(/^\/+|\/+$/g, '');
}
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async (req, reply) => {
    try {
      await db().check?.();
    } catch (err) {
      req.log.error({ err }, 'datastore unreadable');
      return reply.code(503).send({ ok: false, name: 'aldine', error: 'The datastore cannot be read; the server log names the file' });
    }
    return { ok: true, name: 'aldine' };
  });

  // Showcase projects (ALDINE_PROTECTED_PROJECTS): every visitor may read and
  // typeset them, nobody may change them — a public demo's sample paper must
  // survive launch-day traffic. The collab websocket enforces the same rule
  // via read-only connections (collab.ts onConnect). Decided on the decoded
  // :id and the matched route pattern, which are what the handler acts on.
  if (protectedProjects.size) {
    app.addHook('preHandler', async (req, reply) => {
      if (req.method === 'GET' || req.method === 'HEAD') return;
      const id = (req.params as { id?: string } | undefined)?.id;
      const route = req.routeOptions.url;
      if (id === undefined || !route?.startsWith('/api/projects/:id') || !protectedProjects.has(id)) return;
      if (route === '/api/projects/:id/compile' || route === '/api/projects/:id/synctex') return; // reading the doc includes building it
      // The caller's own list and a copy of their own leave the showcase as it is.
      if (route === '/api/projects/:id/opened' || route === '/api/projects/:id/listing' || route === '/api/projects/:id/copy') return;
      return reply.code(403).send({ error: 'This is a read-only showcase project — create your own to try editing.' });
    });
  }

  // ---------- auth (env-gated) ----------
  // mcpEnabled/publicUrl let the Agent access card say whether the connector
  // URL it shows is served at all, and whether claude.ai could reach it.
  // sendsEmail: confirmation and reset links go out by mail; without it they
  // are in the server log for the operator to pass on. signup: ALDINE_SIGNUP,
  // so the sign-up form can say up front that new accounts wait for approval.
  app.get('/api/auth/me', async (req) => {
    const user = reqUser(req);
    return {
      authEnabled: auth.AUTH_ENABLED, passwordAuth: !auth.SSO_ONLY, user, providers: oauthProviders(), admin: !!user && isAdmin(user),
      mcpEnabled: process.env.ALDINE_MCP === '1', publicUrl: config.publicUrl || null, sendsEmail: sendsEmail(), signup: auth.SIGNUP_MODE,
    };
  });

  // The account's display name. Session only: an access token is the
  // agent's, not the person.
  app.patch<{ Body: { name?: unknown } }>('/api/auth/me', async (req, reply) => {
    if (!auth.AUTH_ENABLED) return reply.code(400).send({ error: 'Auth is not enabled' });
    if ((req as any)._tokenScope) return reply.code(403).send({ error: 'Access tokens cannot change the account — sign in to do this' });
    const user = reqUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in required' });
    if (!(await visitLimiter.take(clientKey(req, user.id)))) return reply.code(429).send({ error: 'Rate limit reached — please slow down' });
    try {
      return { user: await auth.setName(user.id, req.body?.name) };
    } catch (err: any) { return reply.code(400).send({ error: err.message }); }
  });

  /** Author for a human commit (checkpoint, merge, revert): the account name
   *  whenever there is one — the browser's anonymous "Writer N" identity is
   *  only right without accounts, and the audit trail must name the person
   *  who undid Claude's work. */
  const commitAuthor = (req: any, fallback?: string): string | undefined => {
    const u = reqUser(req);
    return (auth.AUTH_ENABLED && u && (u.name || u.email)) || fallback;
  };

  /** 403 when password sign-in is disabled (SSO-only mode). */
  const passwordDisabled = (reply: any) => reply.code(403).send({ error: 'Password sign-in is disabled — use single sign-on.' });

  // Links are built from the CONFIGURED public URL only, never from the
  // request's Host, which an attacker controls (see reset-request).
  const sendsEmail = () => email.emailConfigured() && !!config.publicUrl;
  /** Last confirmation link logged per address; read by the test hook only. */
  const loggedConfirmations = new Map<string, string>();
  /** Mail the confirmation link, or log it for the operator. True when mailed.
   *  `waiting`: the account waits for an administrator's approval.
   *  `returnTo`: the invitation page the link leads back to (inviteReturn). */
  const deliverConfirmation = (to: string, token: string, signUp: boolean, waiting = false, returnTo: string | null = null): boolean => {
    const link = `${config.publicUrl || config.basePath}${returnTo ?? '/'}?confirm_email=${encodeURIComponent(token)}`;
    if (sendsEmail()) {
      // Nothing but the address comes from the request: the address is
      // unconfirmed, so a name would put the signer's own text and links in
      // a mail this instance sends to anyone.
      const intro = signUp
        ? `Welcome to Aldine — write LaTeX together, fast, versioned, and yours. Someone, probably you, just created an account at ${config.publicUrl} with this address.`
        : `Here is a new link to confirm the address of your Aldine account at ${config.publicUrl}.`;
      const why = waiting
        ? 'Confirm the address, then an administrator of this server approves the account. Aldine asks you to sign in to confirm it, and emails you once the account is approved.'
        : returnTo
          ? 'Confirm the address to accept the invitation you signed up from: the link brings you back to it. If you are not signed in, Aldine asks you to sign in first.'
          : 'Confirm the address to see the projects people share with you by email. If you are not signed in, Aldine asks you to sign in first.';
      email.sendMail({
        to,
        subject: 'Confirm your email address for Aldine',
        text: `Hi there,\n\n${intro}\n\n${why}\n\nConfirm your email address (the link expires in ${auth.CONFIRM_TTL_DAYS} days):\n${link}\n\nIf you did not create this account, ignore this email: the address stays unconfirmed.`,
        html: `<p>Hi there,</p><p>${intro}</p><p>${why}</p><p><a href="${link}">Confirm your email address</a> (the link expires in ${auth.CONFIRM_TTL_DAYS} days).</p><p>If you did not create this account, ignore this email: the address stays unconfirmed.</p>`,
      }).catch((err) => console.error('[aldine] confirmation email failed:', err?.message || err));
      return true;
    }
    const where = config.publicUrl ? '' : ", after this instance's address";
    console.log(`[aldine] email confirmation for ${to}: ${link} (relay it to them${where}; expires in ${auth.CONFIRM_TTL_DAYS} days. Set ALDINE_PUBLIC_URL + an email transport to mail links instead)`);
    if (process.env.ALDINE_TEST_HOOKS === '1') loggedConfirmations.set(to, link);
    return false;
  };
  /** The invitation page a confirmation link leads back to: only one that
   *  was sent to that very address, so the mail links nowhere its reader was
   *  not already invited to. */
  const inviteReturn = async (invite: unknown, to: string | null): Promise<string | null> => {
    if (!to || typeof invite !== 'string' || !INVITE_ID_RE.test(invite)) return null;
    const inv = await store.getInvitation(invite).catch(() => null);
    return inv && inv.to === to.toLowerCase() ? `/invite/${inv.id}` : null;
  };
  /** The per-account backoff key: this browser's device entry for the typed
   *  email when it has one, else the email itself (hashed, account or not). */
  const accountKey = (typed: string) => `a:${auth.secretDigest(typed.trim().toLowerCase())}`;
  const tooManyForAccount = (reply: any, ms: number) => {
    const s = Math.max(1, Math.ceil(ms / 1000));
    return reply.code(429).header('retry-after', String(s)).send({ error: `Too many failed sign-ins to this account. Try again in ${s} ${s === 1 ? 'second' : 'seconds'}.` });
  };

  // `invite`: signed up on that invitation's page, where the confirmation link returns.
  app.post<{ Body: { email: string; password: string; name?: string; invite?: unknown } }>('/api/auth/register', async (req, reply) => {
    if (!auth.AUTH_ENABLED) return reply.code(400).send({ error: 'Auth is not enabled' });
    if (auth.SSO_ONLY) return passwordDisabled(reply);
    if (!(await registerLimiter.take(clientKey(req)))) return reply.code(429).send({ error: 'Too many accounts created — try again later' });
    const bad = badCredentials(req.body);
    if (bad) return reply.code(400).send({ error: bad });
    try {
      const { user, confirmToken, awaiting } = await auth.signUp(req.body.email, req.body.password, req.body.name);
      // An account waiting for approval gets no session: it could not use one.
      if (!awaiting) reply.header('set-cookie', auth.sessionCookie(await auth.createSession(user.id)));
      // In the background: a mail failure never fails the sign-up.
      const mailed = !!user.email && deliverConfirmation(user.email, confirmToken, true, awaiting, awaiting ? null : await inviteReturn(req.body.invite, user.email));
      if (awaiting) {
        const confirm = mailed ? `Confirm your email address with the link we sent to ${user.email}. ` : '';
        return { user, awaitingApproval: true, message: `Your account is created. ${confirm}${auth.AWAITING_APPROVAL}` };
      }
      return { user };
    } catch (err: any) { return reply.code(400).send({ error: err.message }); }
  });

  // `confirmToken`: the confirmation link the sign-in page was opened with
  // (see auth.passwordSignIn).
  app.post<{ Body: { email: string; password: string; confirmToken?: string } }>('/api/auth/login', async (req, reply) => {
    if (!auth.AUTH_ENABLED) return reply.code(400).send({ error: 'Auth is not enabled' });
    if (auth.SSO_ONLY) return passwordDisabled(reply);
    if (!(await loginLimiter.take(clientKey(req)))) return reply.code(429).send({ error: 'Too many attempts — wait a moment and try again' });
    if (badCredentials(req.body)) return reply.code(400).send({ error: 'Email and password are required' });
    const account = accountKey(req.body.email);
    const device = await auth.trustedDevice(req.headers.cookie, req.body.email);
    const key = device ? `d:${device}` : account;
    const wait = await signInBackoff.attempt(key);
    if (wait > 0) return tooManyForAccount(reply, wait);
    try {
      const confirmToken = typeof req.body.confirmToken === 'string' && req.body.confirmToken.length <= 256 ? req.body.confirmToken : undefined;
      const { user, emailConfirmed } = await auth.passwordSignIn(req.body.email, req.body.password, confirmToken);
      await signInBackoff.clear(key);
      if (key !== account) await signInBackoff.clear(account);
      const trust = await auth.deviceCookie(req.headers.cookie, user.id);
      reply.header('set-cookie', [auth.sessionCookie(await auth.createSession(user.id)), ...(trust ? [trust] : [])]);
      return emailConfirmed ? { user, emailConfirmed } : { user };
    } catch (err: any) {
      if (err instanceof auth.AwaitingApprovalError) {
        // Thrown only after the password matched: a person who keeps asking
        // whether they are approved yet is not guessing it.
        await signInBackoff.clear(key);
        if (key !== account) await signInBackoff.clear(account);
        return reply.code(403).send({ error: err.message, code: err.code });
      }
      return reply.code(401).send({ error: err.message });
    }
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await auth.destroySession(auth.sidFromRequest(req.headers.cookie)); // revoke this session server-side
    reply.header('set-cookie', auth.clearCookie());
    return { ok: true };
  });

  // change password (logged in): revokes all sessions and agent credentials,
  // then re-issues the current session
  app.post<{ Body: { currentPassword: string; newPassword: string } }>('/api/auth/password', async (req, reply) => {
    if (!auth.AUTH_ENABLED) return reply.code(400).send({ error: 'Auth is not enabled' });
    if (auth.SSO_ONLY) return passwordDisabled(reply);
    const user = reqUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in required' });
    if (!(await loginLimiter.take(clientKey(req, user.id)))) return reply.code(429).send({ error: 'Too many attempts — wait a moment and try again' });
    try {
      const revokedTokens = await auth.changePassword(user.id, req.body?.currentPassword || '', req.body?.newPassword || '');
      const trust = await auth.deviceCookie(req.headers.cookie, user.id);
      reply.header('set-cookie', [auth.sessionCookie(await auth.createSession(user.id)), ...(trust ? [trust] : [])]);
      return { ok: true, revokedTokens };
    } catch (err: any) { return reply.code(400).send({ error: err.message }); }
  });

  // forgot-password: issue a reset token. Emailed if SMTP is configured; otherwise
  // logged server-side and (when ALDINE_RESET_ECHO=1) returned for self-host relay.
  app.post<{ Body: { email: string } }>('/api/auth/reset-request', async (req, reply) => {
    if (!auth.AUTH_ENABLED) return reply.code(400).send({ error: 'Auth is not enabled' });
    if (auth.SSO_ONLY) return passwordDisabled(reply);
    if (!(await loginLimiter.take(clientKey(req)))) return reply.code(429).send({ error: 'Too many attempts — wait a moment' });
    const r = await auth.requestReset(req.body?.email || '');
    if (r) {
      // Build the reset link from the CONFIGURED public URL only — never the
      // request Host/X-Forwarded-Host, which an attacker controls and could use
      // to redirect the victim's valid token to their own domain (takeover).
      const base = config.publicUrl;
      const link = `${base}/?reset_token=${encodeURIComponent(r.token)}`;
      if (email.emailConfigured() && base && r.user.email) {
        // send in the background so the response time doesn't leak whether the
        // address exists, and a slow SMTP/SES call can't hang the request
        email.sendMail(email.resetMail(r.user.email, link, r.token))
          .catch((err) => console.error('[aldine] reset email failed:', err?.message || err));
      } else {
        // no transport, or no ALDINE_PUBLIC_URL to build a trusted link → don't
        // email a host-derived (poisonable) link; log the token for manual relay
        console.log(`[aldine] password reset for ${r.user.email}: token=${r.token} (set ALDINE_PUBLIC_URL + an email transport to send links; relay manually, expires in 1h)`);
      }
    }
    // never reveal whether the email exists
    return process.env.ALDINE_RESET_ECHO === '1' && r ? { ok: true, token: r.token } : { ok: true };
  });

  // Confirming takes the session of the account the link was sent for: a
  // person who follows the link for an account someone else created with
  // their address confirms nothing (they reset the password instead, which
  // proves the address and ends the other sessions).
  app.post<{ Body: { token?: string } }>('/api/auth/confirm-email', async (req, reply) => {
    if (!auth.AUTH_ENABLED) return reply.code(400).send({ error: 'Auth is not enabled' });
    const user = reqUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in to confirm your email address' });
    try {
      return { user: await auth.confirmEmail(user.id, typeof req.body?.token === 'string' ? req.body.token : '') };
    } catch (err: any) { return reply.code(400).send({ error: err.message }); }
  });

  app.post<{ Body: { invite?: unknown } }>('/api/auth/confirm-email/resend', async (req, reply) => {
    if (!auth.AUTH_ENABLED) return reply.code(400).send({ error: 'Auth is not enabled' });
    const user = reqUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in required' });
    if (!user.emailPending) return { ok: true, confirmed: true };
    if (!(await confirmResendLimiter.take(clientKey(req, user.id)))) {
      return reply.code(429).send({ error: 'You asked for several links already. Use the newest one, or ask again in 10 minutes.' });
    }
    // Without email the operator may be relaying an older link right now, so
    // asking again must not cancel it.
    const r = await auth.reissueConfirmation(user.id, !sendsEmail());
    if (!r?.user.email) return { ok: true, confirmed: true };
    return { ok: true, sent: deliverConfirmation(r.user.email, r.token, false, false, await inviteReturn(req.body?.invite, r.user.email)) };
  });

  // Test hook (never in production): the link the server would have the
  // operator relay, so the e2e suite can follow it.
  if (process.env.ALDINE_TEST_HOOKS === '1') {
    app.get<{ Querystring: { email?: string } }>('/api/test/confirmation-link', async (req, reply) => {
      const link = loggedConfirmations.get(String(req.query.email || '').trim().toLowerCase());
      return link ? { link } : reply.code(404).send({ error: 'No confirmation link was logged for that address' });
    });
    // The caller's session and its cookie as if signed in `days` (or
    // `minutes`) earlier: what only an older session sees (renewals, the
    // Sign-in methods password check).
    app.post<{ Body: { days?: number; minutes?: number } }>('/api/test/age-session', async (req, reply) => {
      const sid = auth.sidFromRequest(req.headers.cookie);
      const s = sid ? await db().getSession(sid) : null;
      const shift = req.body?.minutes != null ? Number(req.body.minutes) * 60_000 : Number(req.body?.days) * 864e5;
      if (!sid || !s || !(shift > 0)) return reply.code(400).send({ error: 'Send a session cookie and a number of days or minutes' });
      await db().deleteSession(sid);
      await db().createSession(sid, s.userId, s.exp - shift, s.createdAt - shift);
      reply.header('set-cookie', auth.sessionCookie(sid, Math.floor((s.exp - shift - Date.now()) / 1000)));
      return { ok: true };
    });
  }

  app.post<{ Body: { token: string; newPassword: string } }>('/api/auth/reset', async (req, reply) => {
    if (!auth.AUTH_ENABLED) return reply.code(400).send({ error: 'Auth is not enabled' });
    if (auth.SSO_ONLY) return passwordDisabled(reply);
    try {
      const revokedTokens = await auth.resetPassword(req.body?.token || '', req.body?.newPassword || '');
      return { ok: true, revokedTokens };
    } catch (err: any) { return reply.code(400).send({ error: err.message }); }
  });

  // ---------- SSO / OAuth (each provider gated on its client id/secret) ----------
  // The state cookie carries `<state>.<attempt secret>`: the secret derives
  // the PKCE verifier and OIDC nonce, so they are bound to this state, never
  // leave the browser except to us, and expire with the cookie.
  const STATE_COOKIE = 'aldine_oauth_state';
  const clearState = `${STATE_COOKIE}=; HttpOnly; SameSite=Lax; Path=${auth.COOKIE_PATH}; Max-Age=0${auth.SECURE_COOKIES ? '; Secure' : ''}`;
  const callbackUrl = (req: FastifyRequest, id: string) => `${publicBase(req)}/api/auth/oauth/${id}/callback`;
  // "Google sign-in failed", but "Single sign-on failed" rather than "Single sign-on sign-in failed".
  const signInName = (label: string) => (/sign[- ]?(on|in)|log[- ]?in/i.test(label) ? label : `${label} sign-in`);
  const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  // These routes are browser navigations: a person who lands here from the
  // IdP gets a page with a way back, API clients keep the JSON body. No free
  // text from the request URL reaches the page (only an RFC 6749 error code).
  const signInFailed = (req: FastifyRequest, reply: FastifyReply, code: number, error: string, title = 'Sign-in failed', backTo = { href: '/', label: 'Back to sign-in' }) => {
    if (!/\btext\/html\b/.test(String(req.headers.accept || ''))) return reply.code(code).send({ error });
    const back = `${config.basePath}${backTo.href}`;
    return reply.code(code)
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
      .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · Aldine</title><style>
:root{color-scheme:light dark;--bg:#f7f6f3;--fg:#1d1c1a;--muted:#6b6862;--card:#fff;--line:#e3e0da;--accent:#2f5d8a}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#ecebe8;--muted:#a3a09a;--card:#1f1f1c;--line:#34332f;--accent:#8fb5dc}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:0 16px}
main{max-width:30rem;width:100%;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:24px 28px}
h1{font-size:1.1rem;margin:0 0 .5rem}p{margin:0 0 1.25rem;color:var(--muted);overflow-wrap:anywhere}a{color:var(--accent);font-weight:600}
</style></head><body><main><h1>${escapeHtml(title)}</h1><p data-testid="sign-in-error">${escapeHtml(error)}</p><a data-testid="sign-in-error-back" href="${escapeHtml(back)}">${escapeHtml(backTo.label)}</a></main></body></html>`);
  };

  app.get<{ Params: { provider: string } }>('/api/auth/oauth/:provider', async (req, reply) => {
    const provider = auth.AUTH_ENABLED ? oauth.getProvider(req.params.provider) : undefined;
    if (!provider) return signInFailed(req, reply, 404, 'This sign-in provider is not configured');
    const state = crypto.randomBytes(12).toString('hex');
    const secret = oauth.newAttemptSecret();
    let url: string;
    try {
      url = await provider.authorizeUrl(state, callbackUrl(req, provider.id), oauth.attemptFrom(secret));
    } catch (err: any) {
      req.log.warn({ provider: provider.id, err: err?.message }, 'sign-in provider unavailable');
      return signInFailed(req, reply, 502, `${signInName(provider.label)} is unavailable: ${err.message}`);
    }
    reply.header('set-cookie', `${STATE_COOKIE}=${provider.id}.${state}.${secret}; HttpOnly; SameSite=Lax; Path=${auth.COOKIE_PATH}; Max-Age=600${auth.SECURE_COOKIES ? '; Secure' : ''}`);
    return reply.redirect(url);
  });

  app.get<{ Params: { provider: string }; Querystring: Record<string, string | undefined> }>(
    '/api/auth/oauth/:provider/callback', async (req, reply) => {
      const provider = auth.AUTH_ENABLED ? oauth.getProvider(req.params.provider) : undefined;
      if (!provider) return signInFailed(req, reply, 404, 'This sign-in provider is not configured');
      // The attempt names its provider, so a state minted for one provider's
      // sign-in cannot carry another provider's code through this callback.
      // A connect (see /api/auth/sign-in-methods) adds `link` and the
      // binding to the session that started it.
      const [cookieProvider, cookieState, secret, purpose, binding, extra] = (auth.parseCookies(req.headers.cookie)[STATE_COOKIE] || '').split('.');
      const q = req.query;
      if (typeof q.state !== 'string' || !q.state || !cookieState || !secret || q.state !== cookieState || cookieProvider !== provider.id
        || extra !== undefined || (purpose !== undefined && purpose !== 'link')) {
        return signInFailed(req, reply, 400, 'OAuth state mismatch — please try again');
      }
      const linking = purpose === 'link';
      const connectFailed = (code: number, error: string) => signInFailed(req, reply, code, error, `Couldn’t connect ${provider.label}`, { href: '/?account=sign-in', label: 'Back to account settings' });
      const sid = auth.sidFromRequest(req.headers.cookie);
      // The session's own account, not a bearer token's: the binding is to the session.
      const linkUser = linking && sid ? await auth.verifyToken(sid) : null;
      if (linking && (!linkUser || !sid || !auth.linkBindingMatches(binding, sid, provider.id, cookieState))) {
        reply.header('set-cookie', clearState);
        return connectFailed(400, `You were signed out, or signed in to another account, while connecting ${provider.label}. Sign in again and connect it from Account settings.`);
      }
      // One callback per attempt: a replayed or second callback finds no cookie.
      reply.header('set-cookie', clearState);
      if (typeof q.error === 'string' && q.error) {
        const why = /^[a-z_]{1,40}$/.test(q.error) ? q.error : 'error';
        if (linking) return connectFailed(400, `${signInName(provider.label)} was cancelled or refused (${why}). Nothing was connected.`);
        return signInFailed(req, reply, 400, `${signInName(provider.label)} was cancelled or refused (${why}) — please try again`);
      }
      if (typeof q.code !== 'string' || !q.code) return signInFailed(req, reply, 400, 'OAuth state mismatch — please try again');
      if (linkUser) {
        let profile: oauth.OAuthProfile;
        try {
          const callback = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => typeof e[1] === 'string'));
          profile = await provider.exchange(q.code, callbackUrl(req, provider.id), oauth.attemptFrom(secret), callback);
        } catch (err: any) {
          return connectFailed(400, `${signInName(provider.label)} failed: ${err.message}`);
        }
        try {
          await auth.linkSignIn(linkUser.id, provider.id, profile);
        } catch (err: any) {
          return connectFailed(409, err.message);
        }
        return reply.redirect(`${config.basePath}/?account=sign-in&connected=${encodeURIComponent(provider.id)}`);
      }
      try {
        const callback = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => typeof e[1] === 'string'));
        const profile = await provider.exchange(q.code, callbackUrl(req, provider.id), oauth.attemptFrom(secret), callback);
        const user = await auth.findOrCreateOAuth(profile, provider.id);
        reply.header('set-cookie', auth.sessionCookie(await auth.createSession(user.id)));
        return reply.redirect(`${config.basePath}/`);
      } catch (err: any) {
        if (err instanceof auth.AwaitingApprovalError) return signInFailed(req, reply, 403, err.message, 'Waiting for approval');
        return signInFailed(req, reply, 400, `${signInName(provider.label)} failed: ${err.message}`);
      }
    });

  // ---------- sign-in methods: connect single sign-on to a password account ----------
  // Session-cookie only: the /api/auth guard below refuses bearer tokens here.
  const methodsUser = (req: any, reply: any): auth.PublicUser | null => {
    if (!auth.AUTH_ENABLED) { reply.code(404).send({ error: 'not found' }); return null; }
    const user = reqUser(req);
    if (!user) { reply.code(401).send({ error: 'Sign in required' }); return null; }
    return user;
  };

  app.get('/api/auth/sign-in-methods', async (req, reply) => {
    const user = methodsUser(req, reply);
    if (!user) return;
    return { ...(await auth.signInMethods(user.id, auth.sidFromRequest(req.headers.cookie))), providers: oauthProviders() };
  });

  // Starts the provider's flow for the signed-in account. The answer is the
  // URL to go to; the state cookie it sets names the purpose and is bound to
  // this session, so nothing in the callback's query decides that it links.
  app.post<{ Params: { provider: string }; Body: { password?: string } }>('/api/auth/sign-in-methods/:provider', async (req, reply) => {
    const user = methodsUser(req, reply);
    if (!user) return;
    const provider = oauth.getProvider(req.params.provider);
    if (!provider) return reply.code(404).send({ error: 'This sign-in provider is not configured' });
    if (!(await loginLimiter.take(clientKey(req, user.id)))) return reply.code(429).send({ error: 'Too many attempts — wait a moment and try again' });
    const sid = auth.sidFromRequest(req.headers.cookie)!;
    try {
      await auth.confirmForLink(user.id, sid, req.body?.password);
    } catch (err: any) {
      if (err instanceof auth.ReauthRequiredError) return reply.code(403).send({ error: err.message, code: err.code });
      return reply.code(400).send({ error: err.message });
    }
    const state = crypto.randomBytes(12).toString('hex');
    const secret = oauth.newAttemptSecret();
    let url: string;
    try {
      url = await provider.authorizeUrl(state, callbackUrl(req, provider.id), oauth.attemptFrom(secret));
    } catch (err: any) {
      req.log.warn({ provider: provider.id, err: err?.message }, 'sign-in provider unavailable');
      return reply.code(502).send({ error: `${signInName(provider.label)} is unavailable: ${err.message}` });
    }
    const value = `${provider.id}.${state}.${secret}.link.${auth.linkBinding(sid, provider.id, state)}`;
    reply.header('set-cookie', `${STATE_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=${auth.COOKIE_PATH}; Max-Age=600${auth.SECURE_COOKIES ? '; Secure' : ''}`);
    return { url };
  });

  app.delete<{ Params: { provider: string } }>('/api/auth/sign-in-methods/:provider', async (req, reply) => {
    const user = methodsUser(req, reply);
    if (!user) return;
    try {
      await auth.unlinkSignIn(user.id, req.params.provider);
      return { ok: true };
    } catch (err: any) { return reply.code(400).send({ error: err.message }); }
  });

  // Resolve the request's user once (awaiting the async datastore) and cache it,
  // so reqUser() is a synchronous read everywhere downstream.
  app.addHook('onRequest', async (req, reply) => {
    const header = req.headers.authorization;
    if (auth.AUTH_ENABLED && typeof header === 'string' && header.startsWith(`Bearer ${auth.TOKEN_PREFIX}`)) {
      // A presented bearer token is authoritative: when it doesn't resolve the
      // request stays anonymous — an invalid token must not silently borrow
      // the browser session's identity from the cookie.
      const t = await auth.userFromToken(header);
      (req as any)._user = t?.user ?? null;
      (req as any)._tokenScope = t?.tokenScope ?? null;
      if (t?.user) noteActivity(t.user.id);
      return;
    }
    // Renewed on API requests only: a shared cache may store the public
    // response of a static file, Set-Cookie and all.
    const session = auth.AUTH_ENABLED ? await auth.resumeSession(req.headers.cookie, req.url.startsWith('/api/')) : null;
    const user = session?.user ?? null;
    (req as any)._user = user;
    // A route that sets the session cookie itself (sign-in, sign-out, a
    // password change) sets it after this, and the browser keeps the last.
    if (session?.cookie) reply.header('set-cookie', session.cookie);
    if (user) noteActivity(user.id);
  });
  await registerAdminRoutes(app, reqUser);

  // Global guard: enforce project access when auth is on. Runs after routing,
  // so it uses the DECODED :id param and the matched route pattern — never a
  // regex over the raw (still percent-encoded) URL, which `%61bc…` or
  // `/api/pr%6Fjects` would slip past while the router still matches.
  app.addHook('preHandler', async (req, reply) => {
    const reqId = (req.params as { id?: string } | undefined)?.id;
    const route = req.routeOptions.url;
    // Trashed projects behave as gone for every route except restore and
    // delete (purge) — works with or without auth.
    if (reqId !== undefined) {
      let m: store.ProjectMeta | null = null;
      try { m = await store.readMeta(reqId); } catch { /* handled below / by the route */ }
      // The trash shows its owner each project's thumbnail.
      const trashView = (meta: store.ProjectMeta) => route === '/api/projects/:id/thumbnail' && isOwner(meta, reqUser(req));
      if (m?.deletedAt && !(route === '/api/projects/:id/restore' || (req.method === 'DELETE' && route === '/api/projects/:id') || trashView(m))) {
        // Someone the project was open to learns why it went; anyone else
        // learns nothing about it.
        const user = reqUser(req);
        if (canAccess(m, user)) {
          return reply.code(404).send({ error: isOwner(m, user) ? 'This project is in the trash' : 'The owner moved this project to the trash', code: 'trashed' });
        }
        return reply.code(404).send({ error: 'project not found' });
      }
    }
    // A signed /output link authorized itself in the route's onRequest hook
    // (output-signing.ts) — the only route where the cookie guard yields.
    if ((req as any)._signedOutput) return;
    if (!auth.AUTH_ENABLED) return;
    const id = reqId;
    if (id !== undefined) {
      let meta: store.ProjectMeta;
      try { meta = await store.readMeta(id); } catch { return reply.code(404).send({ error: 'project not found' }); }
      const user = reqUser(req);
      if (!user) return reply.code(401).send({ error: 'Sign in required' });
      if (!canAccess(meta, user)) return reply.code(403).send({ error: 'You do not have access to this project' });
      // Project-scoped tokens: enforce the scope here, in the one shared guard,
      // so no per-route copy can drift.
      const scope = (req as any)._tokenScope as auth.TokenScope | null;
      if (scope?.projectIds && !scope.projectIds.includes(id)) {
        return reply.code(403).send({ error: 'This token does not have access to this project' });
      }
      if (scope && !tokenMayUseProjectRoute(req.method, req.routeOptions.url)) {
        return reply.code(403).send({ error: 'Access tokens cannot use this route — sign in to do this' });
      }
      if (!viewerMay(req.method, route) && !canEdit(meta, user)) return reply.code(403).send({ error: VIEW_ONLY });
      return;
    }
    // non-id routes: require sign-in for the project list / create / import
    const projectsRoute = route === '/api/projects' || route === '/api/projects/import' || route === '/api/projects/trash';
    if (projectsRoute && !reqUser(req)) {
      return reply.code(401).send({ error: 'Sign in required' });
    }
    // Bearer tokens are project credentials, not the account. Off the
    // /api/projects/:id surface (scope-checked above) they reach only
    // project-neutral read routes. Account surfaces stay session-only:
    // /api/auth mutations (an OAuth account's empty password hash lets
    // changePassword skip current-password verification, so a leaked token
    // could set a password and mint itself a session), the GitHub connection
    // (stored PAT), and token CRUD. A project-scoped token must not enumerate
    // projects beyond its scope either (db/types.ts: projectIds restricts the
    // token to exactly those ids).
    const scope = (req as any)._tokenScope as auth.TokenScope | null;
    if (scope && route?.startsWith('/api/')) {
      const neutral = ['/api/health', '/api/auth/me', '/api/templates', '/api/templates/preview', '/api/plugins', '/api/ai/status', '/api/usage', '/api/references/search'].includes(route);
      const allProjects = !scope.projectIds && projectsRoute;
      if (!neutral && !allProjects) {
        return reply.code(403).send({ error: 'Access tokens cannot use this route — sign in to do this' });
      }
    }
  });

  // OAuth 2.1 authorization server for the MCP connector (src/oauth/). Wired
  // here, after the hooks above, so /api/oauth/* sees the resolved user and the
  // bearer-scope guard like every other /api route.
  await registerOAuth(app);

  // ---------- personal access tokens (agent credentials) ----------
  // Session-cookie auth ONLY: a leaked token must not be able to mint, list,
  // or revoke tokens, so bearer-authenticated requests are refused outright.
  const tokenRouteUser = (req: any, reply: any): auth.PublicUser | null => {
    if (!auth.AUTH_ENABLED) { reply.code(404).send({ error: 'not found' }); return null; }
    if ((req as any)._tokenScope) { reply.code(403).send({ error: 'Access tokens cannot manage tokens — sign in to do this' }); return null; }
    const user = reqUser(req);
    if (!user) { reply.code(401).send({ error: 'Sign in required' }); return null; }
    return user;
  };

  app.get('/api/tokens', async (req, reply) => {
    const user = tokenRouteUser(req, reply);
    if (!user) return;
    return auth.listAccessTokens(user.id);
  });

  app.post<{ Body: { name?: string; projectIds?: string[]; expiresAt?: string } }>('/api/tokens', async (req, reply) => {
    const user = tokenRouteUser(req, reply);
    if (!user) return;
    const name = (req.body?.name || '').trim();
    if (!name) return reply.code(400).send({ error: 'Token name is required' });
    if (name.length > 100) return reply.code(400).send({ error: 'Token name is too long (max 100 characters)' });
    let projectIds: string[] | null = null;
    if (req.body?.projectIds !== undefined) {
      const ids = req.body.projectIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || ids.some((p) => typeof p !== 'string' || !PROJECT_ID_RE.test(p))) {
        return reply.code(400).send({ error: 'projectIds must be a list of project ids' });
      }
      projectIds = ids;
    }
    let expiresAt: string | null = null;
    if (req.body?.expiresAt !== undefined) {
      const exp = Date.parse(String(req.body.expiresAt));
      if (Number.isNaN(exp)) return reply.code(400).send({ error: 'expiresAt must be an ISO 8601 date' });
      if (exp <= Date.now()) return reply.code(400).send({ error: 'Expiry must be in the future' });
      expiresAt = new Date(exp).toISOString();
    }
    const { token, record } = await auth.createAccessToken(user.id, name, projectIds, expiresAt);
    // Success-metric line (deploy/README.md): a connection exists from here on.
    console.log(`[metric] agent_connect user=${user.id} via=pat scope=${projectIds ? projectIds.length : 'all'}`);
    // the plaintext token appears in this response and never again
    return { token, ...record };
  });

  app.delete<{ Params: { tokenId: string } }>('/api/tokens/:tokenId', async (req, reply) => {
    const user = tokenRouteUser(req, reply);
    if (!user) return;
    if (!(await auth.revokeAccessToken(user.id, req.params.tokenId))) {
      return reply.code(404).send({ error: 'Token not found' });
    }
    return { ok: true };
  });

  // ---------- projects ----------
  // Most recently edited first. Three store reads for the whole list and no
  // git call: a project with no recorded edit is backfilled from its history
  // in the background and sorts by its creation until then.
  // ?archived=1: the rows taken off the list instead, an owner's archive and
  // the shared projects a member removed (a link visitor's row is deleted).
  app.get<{ Querystring: { archived?: string } }>('/api/projects', async (req) => {
    const user = reqUser(req);
    const archived = req.query.archived === '1';
    const [metas, opens, activity] = await Promise.all([store.listProjects(), store.listProjectOpens(listUserId(user)), activitySnapshot()]);
    const openOf = new Map(opens.map((o) => [o.projectId, o]));
    const rows = await Promise.all(metas.filter((m) => !m.deletedAt).flatMap((m) => {
      const open = openOf.get(m.id) ?? null;
      const access = archived
        ? (open?.hidden ? (isOwner(m, user) ? 'owner' : isMember(m, user) ? 'member' : null) : null)
        : listingAccess(m, user, open);
      return access ? [projectRow(m, user, open, activity.get(m.id), access)] : [];
    }));
    const unknown = rows.filter((r) => !r.lastEdit).map((r) => r.id);
    if (unknown.length) backfillLastEdits(unknown);
    const recency = (r: { lastEdit: { at: string } | null; createdAt: string }) => r.lastEdit?.at ?? r.createdAt;
    return rows.sort((a, b) => recency(b).localeCompare(recency(a)) || b.createdAt.localeCompare(a.createdAt));
  });

  // Trash: soft-deleted projects the user owns, newest first. Restorable until
  // purgeAt; the daily sweep removes them on its first run after it.
  app.get('/api/projects/trash', async (req) => {
    const user = reqUser(req);
    const mine = (await store.listProjects()).filter((m) => !!m.deletedAt && (auth.AUTH_ENABLED ? isOwner(m, user) : true));
    mine.sort((a, b) => (b.deletedAt || '').localeCompare(a.deletedAt || ''));
    return Promise.all(mine.map(async (m) => {
      const at = Date.parse(m.deletedAt!);
      return { id: m.id, name: m.name, deletedAt: m.deletedAt, purgeAt: Number.isNaN(at) ? null : restorableUntil(new Date(at)), thumb: await projectThumb(m) };
    }));
  });

  // Auto-provisioning (GITLAB_TOKEN + GITLAB_DEFAULT_GROUP): a new project is
  // also created on GitLab. Failure never fails the request: the project
  // exists locally, `remotePending` marks it, and the error rides along.
  const provisionNew = async (meta: store.ProjectMeta, req: any, namespace?: string): Promise<string | undefined> => {
    if (!provisioningEnabled()) return undefined;
    try {
      const r = await provisionProject(meta, { userId: reqUser(req)?.id || 'local', namespace });
      return r.ok ? undefined : r.error;
    } catch (err: any) {
      // provisionProject is written not to throw; if it ever does, the local
      // project must still be answered, never deleted or 500ed over GitLab.
      req.log.error({ err }, 'provisioning threw');
      return `GitLab provisioning failed: ${err?.message || err}`;
    }
  };

  // No `files` and no `template` seeds the default article; `files: {}` or
  // `template: "blank"` creates a project with no files at all.
  app.post<{ Body: { name?: string; files?: Record<string, string> | null; template?: string; namespace?: string } }>('/api/projects', async (req, reply) => {
    // With accounts on, an ownerless project would be every user's (isMember).
    if (auth.AUTH_ENABLED && !reqUser(req)) return reply.code(401).send({ error: 'Sign in required' });
    const { name = 'Untitled project', files, template, namespace } = req.body || {};
    let seed: Record<string, string | Buffer> | undefined;
    let resolved: TemplateSeed | undefined;
    if (files !== undefined && files !== null) {
      const bad = seedError(files);
      if (bad) return reply.code(400).send({ error: bad });
      seed = files;
    }    if (template) {
      try {
        resolved = await resolveTemplateSeed(template, { projectName: name, author: reqUser(req)?.name });
        seed = resolved.files;
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    }
    // Every path shape the caller controls is screened by seedError and
    // kitSeedProblem, so a write that still fails here is this server's fault
    // (a full disk, a read-only data directory) and answers 5xx. The errno
    // text names DATA_DIR, so it is logged and not returned.
    let meta: Awaited<ReturnType<typeof store.createProject>>;
    try {
      meta = await store.createProject(name, seed, reqUser(req)?.id);
    } catch (err: any) {
      req.log.error({ err }, 'createProject failed');
      return reply.code(500).send({ error: 'Could not create the project' });
    }
    noteEdit(meta.id, 'main', editorOf(reqUser(req)));
    const remoteError = await provisionNew(meta, req, namespace);
    const body = await publicMeta(meta, reqUser(req));
    // A venue kit that could not be downloaded still creates the project (from
    // a skeleton); the client says so rather than the request failing.
    return { ...body, ...(resolved?.venueKit ? { venueKit: resolved.venueKit } : {}), ...(remoteError ? { remoteError } : {}) };
  });

  const isListedInvitation = (i: store.Invitation) => ['pending', 'declined', 'expired'].includes(stateOf(i));
  /** A share as stored: roles only where they differ from "Can edit". */
  const shareOf = (mode: 'private' | 'link', collaborators: string[], viewers: string[] | undefined, linkRole: 'edit' | 'view' | undefined): NonNullable<store.ProjectMeta['share']> => ({
    mode, collaborators, ...(viewers?.length ? { viewers } : {}), ...(linkRole === 'view' ? { linkRole } : {}),
  });
  /** `viewers` kept to the entries in `keep`, with each of `set` given `role`. */
  const withRoles = (viewers: string[] | undefined, keep: string[], set: string[], role: 'edit' | 'view'): string[] => {
    const next = new Set((viewers ?? []).map(normalizeEntry).filter((c) => keep.includes(c)));
    for (const c of set) { if (role === 'view') next.add(c); else next.delete(c); }
    return [...next];
  };

  // ---------- sharing (owner only) ----------
  // The share list is the only source of access. With accounts on, an address
  // or ORCID iD added to it becomes an invitation instead, and joins the list
  // when its person accepts (POST /api/invitations/:invite/accept).
  // `linkRole` sets what link visitors may do (kept when absent); `role` is
  // the role of the entries this save adds (edit when absent).
  app.post<{ Params: { id: string }; Body: { mode?: 'private' | 'link'; collaborators?: string[]; previous?: string[]; linkRole?: 'edit' | 'view'; role?: 'edit' | 'view' } }>(
    '/api/projects/:id/share', async (req, reply) => {
      const meta = await store.readMeta(req.params.id);
      const user = reqUser(req);
      if (!isOwner(meta, user)) return reply.code(403).send({ error: 'Only the owner can change sharing' });
      const mode = req.body?.mode === 'link' ? 'link' : 'private';
      const linkRole = req.body?.linkRole === 'view' || req.body?.linkRole === 'edit' ? req.body.linkRole : (meta.share?.linkRole ?? 'edit');
      const role = req.body?.role === 'view' ? 'view' : 'edit';
      const prev = (meta.share?.collaborators || []).map(normalizeEntry);
      // An entry is an email address or an ORCID iD (the only way to invite a
      // researcher whose ORCID account shares no email).
      const requested = Array.isArray(req.body?.collaborators)
        ? [...new Set(req.body!.collaborators.map((c) => normalizeEntry(String(c).trim())).filter((c) => isOrcidId(c) || isEmailAddress(c)))].slice(0, MAX_SHARE_ENTRIES)
        : prev;
      const added = requested.filter((c) => !prev.includes(c));
      // Gaining access needs no socket to reconnect: only a share that lets
      // fewer people in drops them (below).
      const narrows = (list: string[]) => (meta.share?.mode === 'link' && mode !== 'link') || prev.some((c) => !list.includes(c))
        || (mode === 'link' && (meta.share?.linkRole ?? 'edit') !== linkRole);
      if (!auth.AUTH_ENABLED || !user) {
        // Nobody signs in to accept anything: the list is the share.
        const revoke = narrows(requested);
        meta.share = shareOf(mode, requested, withRoles(meta.share?.viewers, requested, added, role), linkRole);
        await store.writeMeta(meta);
        if (revoke) {
          closeProjectConnections(meta.id);
          publishProjectEvent({ type: 'access-changed', projectId: meta.id });
        }
        return { ...(await publicMeta(meta, user)), invited: 0, notEmailed: added.filter((c) => !isOrcidId(c)), reason: 'accounts-off' };
      }
      const own = new Set([...recipientKeys(user), ...(user.email ? [user.email.toLowerCase()] : [])]);
      // `previous` is the list the owner's dialog started from: only what they
      // took off it goes, so someone who accepted while it was open stays.
      const previous = Array.isArray(req.body?.previous) ? new Set(req.body!.previous.map((c) => normalizeEntry(String(c).trim()))) : null;
      const kept = previous ? prev.filter((c) => requested.includes(c) || !previous.has(c)) : requested.filter((c) => prev.includes(c));
      const invitations = await store.listProjectInvitations(meta.id);
      const open = invitations.filter((i) => stateOf(i) === 'pending');
      const fresh = added.filter((c) => !own.has(c) && !open.some((i) => i.to === c));
      if (kept.length + open.length + fresh.length > MAX_SHARE_ENTRIES) {
        return reply.code(400).send({ error: `A project has room for ${MAX_SHARE_ENTRIES} collaborators and open invitations together; this would make ${kept.length + open.length + fresh.length}` });
      }
      // The whole change or none of it: a list cut short at the limit would
      // drop people the owner typed without them noticing.
      if (fresh.length && !(await shareLimiter.take(`u:${user.id}`, Date.now(), fresh.length))) {
        return reply.code(429).send({ error: `You can invite at most ${shareBurst} people an hour, so nothing was saved. Invite fewer people at once, or try again later.` });
      }
      const revoke = narrows(kept);
      // A role stays with its entry while the entry is shared, or invited on
      // the dialog's list (Invite again keeps it).
      const viewers = withRoles(meta.share?.viewers, [...kept, ...invitations.filter((i) => isListedInvitation(i)).map((i) => i.to)], fresh, role);
      meta.share = shareOf(mode, kept, viewers, linkRole);
      await store.writeMeta(meta);
      // Access is checked when a collab socket connects, so a session already
      // in the document would survive being revoked. Drop this project's
      // sockets: clients reconnect and re-authenticate, which re-runs the
      // check — the still-allowed resume, the revoked are refused. The event
      // reaches peer nodes (multi-node deploys) with the same effect.
      if (revoke) {
        closeProjectConnections(meta.id);
        publishProjectEvent({ type: 'access-changed', projectId: meta.id });
      }
      const staged = await stageInvitations(meta, user, fresh);
      const report = await sendInvitations(staged, meta, user);
      return { ...(await publicMeta(meta, user)), ...report, invitations: await ownerInvitations(req, meta.id) };
    });

  // Take one person off the share list, and nothing else: unlike a save of
  // the whole list, a dialog holding an older list cannot re-invite someone
  // removed elsewhere. With a link share they can still open the project
  // through the link.
  app.delete<{ Params: { id: string; entry: string } }>('/api/projects/:id/collaborators/:entry', async (req, reply) => {
    const meta = await store.readMeta(req.params.id);
    const user = reqUser(req);
    if (!isOwner(meta, user)) return reply.code(403).send({ error: 'Only the owner can change sharing' });
    const entry = normalizeEntry(req.params.entry.trim());
    const list = meta.share?.collaborators || [];
    if (!list.some((c) => normalizeEntry(c) === entry)) return reply.code(404).send({ error: `${entry} has no access to remove` });
    meta.share = shareOf(meta.share?.mode || 'private', list.filter((c) => normalizeEntry(c) !== entry), meta.share?.viewers?.filter((c) => normalizeEntry(c) !== entry), meta.share?.linkRole);
    await store.writeMeta(meta);
    // As in the share route: drop the sockets so the removed person's
    // session re-authenticates and is refused.
    closeProjectConnections(meta.id);
    publishProjectEvent({ type: 'access-changed', projectId: meta.id });
    return publicMeta(meta, user);
  });

  // "Can edit" or "Can view" for one person with access or with an open
  // invitation. Their sockets reconnect under the new role at once.
  app.put<{ Params: { id: string; entry: string }; Body: { role?: unknown } }>('/api/projects/:id/collaborators/:entry', async (req, reply) => {
    const meta = await store.readMeta(req.params.id);
    const user = reqUser(req);
    if (!isOwner(meta, user)) return reply.code(403).send({ error: 'Only the owner can change sharing' });
    const role = req.body?.role;
    if (role !== 'edit' && role !== 'view') return reply.code(400).send({ error: 'role must be "edit" or "view"' });
    const entry = normalizeEntry(req.params.entry.trim());
    const shared = (meta.share?.collaborators || []).some((c) => normalizeEntry(c) === entry);
    const invited = !shared && (await store.listProjectInvitations(meta.id)).some((i) => i.to === entry && isListedInvitation(i));
    if (!shared && !invited) return reply.code(404).send({ error: `${entry} has no access or open invitation` });
    const viewers = withRoles(meta.share?.viewers, (meta.share?.viewers ?? []).map(normalizeEntry), [entry], role);
    const changed = viewers.length !== (meta.share?.viewers ?? []).length;
    meta.share = shareOf(meta.share?.mode || 'private', meta.share?.collaborators || [], viewers, meta.share?.linkRole);
    await store.writeMeta(meta);
    if (changed && shared) {
      closeProjectConnections(meta.id);
      publishProjectEvent({ type: 'access-changed', projectId: meta.id });
    }
    return publicMeta(meta, user);
  });

  /** The address an invitation link is copied with: the configured public
   *  URL, else this request's origin, base path included either way. */
  const inviteLink = (req: FastifyRequest, id: string) => `${publicBase(req)}/invite/${id}`;
  /** What the share dialog lists: open, declined and expired invitations.
   *  An accepted one is a share entry by now; a withdrawn one is gone. */
  const ownerInvitations = async (req: FastifyRequest, projectId: string) => (await store.listProjectInvitations(projectId))
    .filter((i) => isListedInvitation(i))
    .map((i) => ({ id: i.id, to: i.to, state: stateOf(i), createdAt: i.createdAt, expiresAt: i.expiresAt, emailedAt: i.emailedAt, respondedAt: i.respondedAt, link: inviteLink(req, i.id) }));

  /** A new invitation for each entry. An earlier one to the same entry that
   *  is no longer open is replaced, and its link stops working. */
  const stageInvitations = async (meta: store.ProjectMeta, owner: auth.PublicUser, to: string[]): Promise<store.Invitation[]> => {
    if (!to.length) return [];
    const existing = await store.listProjectInvitations(meta.id);
    const now = Date.now();
    const staged: store.Invitation[] = [];
    for (const entry of to) {
      for (const old of existing) if (old.to === entry) await store.deleteInvitation(old.id);
      const inv: store.Invitation = {
        id: newInvitationId(), projectId: meta.id, to: entry, invitedBy: owner.id, createdAt: new Date(now).toISOString(),
        expiresAt: inviteExpiry(now), status: 'pending', respondedAt: null, emailedAt: null,
      };
      await store.setInvitation(inv);
      staged.push(inv);
    }
    return staged;
  };

  /** One invitation from the owner's hourly budget, for inviting one person
   *  (again or for the first time); false after replying. */
  const takeInvite = async (owner: auth.PublicUser, reply: any): Promise<boolean> => {
    if (await shareLimiter.take(`u:${owner.id}`)) return true;
    reply.code(429).send({ error: `You can invite at most ${shareBurst} people an hour. Try again later.` });
    return false;
  };

  /** Mail each invitation to an address once, within the owner's mail
   *  budget. Never throws: the invitation is saved before this runs, and one
   *  that cannot be mailed is reported for the owner to send the link
   *  themselves. ORCID iDs have no address to mail and are not reported. */
  const sendInvitations = async (invs: store.Invitation[], meta: store.ProjectMeta, owner: auth.PublicUser): Promise<InviteReport> => {
    const to = invs.filter((i) => !isOrcidId(i.to));
    if (to.length === 0) return { invited: 0, notEmailed: [] };
    const skip = (reason: InviteReport['reason'], addrs = to.map((i) => i.to)): InviteReport => ({ invited: 0, notEmailed: addrs, reason });
    if (!sendsEmail()) return skip('no-mail');
    // An unconfirmed address is whatever the person typed at sign-up: a
    // throwaway account must not get this instance to mail strangers.
    if (owner.emailPending) return skip('unconfirmed');
    const ownerLabel = owner.name || owner.email || '';
    const allowed: store.Invitation[] = [];
    const limited: string[] = [];
    for (const inv of to) {
      if (limited.length === 0 && await inviteLimiter.take(`u:${owner.id}`)) allowed.push(inv);
      else limited.push(inv.to);
    }
    // SMTP/SES can hang; past the wait the mail still goes out, it is just
    // not reported as failed.
    const results = await Promise.all(allowed.map((inv) => {
      const sent = email.sendMail(invitationMail(inv.to, ownerLabel, meta.name, `${config.publicUrl}/invite/${inv.id}`)).then(() => true, (err) => {
        console.error(`[aldine] invitation email to ${inv.to} failed:`, err?.message || err);
        return false;
      });
      return Promise.race([sent, new Promise<boolean>((r) => setTimeout(() => r(true), 10_000).unref?.())]);
    }));
    const at = new Date().toISOString();
    for (const [i, inv] of allowed.entries()) if (results[i]) await store.updatePendingInvitation(inv.id, { emailedAt: at });
    const failed = allowed.filter((_, i) => !results[i]).map((i) => i.to);
    const invited = allowed.length - failed.length;
    if (limited.length) return { invited, notEmailed: [...failed, ...limited], reason: 'limit' };
    if (failed.length) return { invited, notEmailed: failed, reason: 'failed' };
    return { invited, notEmailed: [] };
  };

  /** The owner's own invitation of this project, or null after replying. */
  const ownedInvitation = async (req: any, reply: any): Promise<{ meta: store.ProjectMeta; inv: store.Invitation } | null> => {
    const meta = await requireOwner(req, reply, 'manage invitations');
    if (!meta) return null;
    if (!auth.AUTH_ENABLED) { reply.code(404).send({ error: 'Invitations need accounts' }); return null; }
    const inv = await store.getInvitation(String(req.params.invite));
    if (!inv || inv.projectId !== meta.id) { reply.code(404).send({ error: 'No such invitation on this project' }); return null; }
    return { meta, inv };
  };

  app.get<{ Params: { id: string } }>('/api/projects/:id/invitations', async (req, reply) => {
    const meta = await requireOwner(req, reply, 'see its invitations');
    if (!meta) return;
    return auth.AUTH_ENABLED ? ownerInvitations(req, meta.id) : [];
  });

  // Invite one address or iD: a new person, or again after a decline or expiry.
  // `role` sets the invited entry's role; absent keeps the one it had (Invite again).
  app.post<{ Params: { id: string }; Body: { to?: string; role?: 'edit' | 'view' } }>('/api/projects/:id/invitations', async (req, reply) => {
    const meta = await requireOwner(req, reply, 'invite people');
    if (!meta) return;
    const user = reqUser(req);
    if (!auth.AUTH_ENABLED || !user) return reply.code(404).send({ error: 'Invitations need accounts' });
    const entry = normalizeEntry(String(req.body?.to ?? '').trim());
    if (!isOrcidId(entry) && !isEmailAddress(entry)) return reply.code(400).send({ error: 'Not an email address or ORCID iD' });
    if (recipientKeys(user).includes(entry) || entry === user.email?.toLowerCase()) return reply.code(400).send({ error: 'That is you: you own this project' });
    const kept = meta.share?.collaborators || [];
    if (kept.includes(entry)) return reply.code(409).send({ error: `${entry} already has access` });
    const open = (await store.listProjectInvitations(meta.id)).filter((i) => stateOf(i) === 'pending');
    if (open.some((i) => i.to === entry)) return reply.code(409).send({ error: `${entry} already has an open invitation` });
    if (kept.length + open.length + 1 > MAX_SHARE_ENTRIES) return reply.code(400).send({ error: `A project has room for ${MAX_SHARE_ENTRIES} collaborators and open invitations together` });
    if (!(await takeInvite(user, reply))) return;
    const role = req.body?.role;
    if (role === 'edit' || role === 'view') {
      meta.share = shareOf(meta.share?.mode || 'private', kept, withRoles(meta.share?.viewers, (meta.share?.viewers ?? []).map(normalizeEntry), [entry], role), meta.share?.linkRole);
      await store.writeMeta(meta);
    }
    const staged = await stageInvitations(meta, user, [entry]);
    const report = await sendInvitations(staged, meta, user);
    return { ...report, invitations: await ownerInvitations(req, meta.id) };
  });

  // Mail an open invitation again, and give it a fresh 14 days. An expired
  // one opens again under the same link.
  app.post<{ Params: { id: string; invite: string } }>('/api/projects/:id/invitations/:invite/resend', async (req, reply) => {
    const found = await ownedInvitation(req, reply);
    if (!found) return;
    const { meta, inv } = found;
    if (inv.status !== 'pending') return reply.code(409).send({ error: inv.status === 'declined' ? `${inv.to} declined this invitation: invite them again instead` : 'This invitation is no longer open' });
    if (stateOf(inv) === 'expired') {
      const open = (await store.listProjectInvitations(meta.id)).filter((i) => stateOf(i) === 'pending');
      if ((meta.share?.collaborators.length ?? 0) + open.length + 1 > MAX_SHARE_ENTRIES) return reply.code(400).send({ error: `A project has room for ${MAX_SHARE_ENTRIES} collaborators and open invitations together` });
    }
    if (!(await store.updatePendingInvitation(inv.id, { expiresAt: inviteExpiry() }))) return reply.code(409).send({ error: 'This invitation was answered a moment ago' });
    const report = await sendInvitations([inv], meta, reqUser(req)!);
    return { ...report, invitations: await ownerInvitations(req, meta.id) };
  });

  // Withdraw an open invitation (its link then says so), or clear a declined
  // or expired one from the list.
  app.delete<{ Params: { id: string; invite: string } }>('/api/projects/:id/invitations/:invite', async (req, reply) => {
    const found = await ownedInvitation(req, reply);
    if (!found) return;
    const { meta, inv } = found;
    if (inv.status === 'accepted') return reply.code(409).send({ error: `${inv.to} accepted already: remove them from the people with access instead` });
    if (inv.status === 'pending') {
      if (!(await store.settleInvitation(inv.id, 'withdrawn', new Date().toISOString()))) return reply.code(409).send({ error: `${inv.to} answered this invitation a moment ago` });
    } else await store.deleteInvitation(inv.id);
    return { invitations: await ownerInvitations(req, meta.id) };
  });

  // ---------- invitations (the invitee's side) ----------
  // The link is not a credential: each of these takes a signed-in account
  // whose confirmed address, or ORCID iD, is the one invited. A bearer token
  // never reaches them (the guard above refuses tokens off the project
  // surface): accepting is the person's decision, not an agent's.
  /** The invitation behind a link, with its project, or null after replying.
   *  A trashed project's invitations behave as gone, like the project. */
  const linkedInvitation = async (req: any, reply: any): Promise<{ inv: store.Invitation; meta: store.ProjectMeta } | null> => {
    const id = String(req.params.invite);
    const inv = auth.AUTH_ENABLED && INVITE_ID_RE.test(id) ? await store.getInvitation(id) : null;
    const meta = inv ? await store.readMeta(inv.projectId).catch(() => null) : null;
    if (!inv || !meta || meta.deletedAt) {
      reply.code(404).send({ error: 'This invitation does not exist. The owner may have sent a newer one, or deleted the project.' });
      return null;
    }
    return { inv, meta };
  };
  /** How the signed-in account relates to an invitation. */
  const relation = (inv: store.Invitation, user: auth.PublicUser | null): 'signed-out' | 'match' | 'unconfirmed' | 'other' => {
    if (!user) return 'signed-out';
    if (recipientKeys(user).includes(inv.to)) return 'match';
    if (user.emailPending && user.email?.toLowerCase() === inv.to) return 'unconfirmed';
    return 'other';
  };
  const mismatch = (reply: any, inv: store.Invitation, rel: string, user: auth.PublicUser | null) => {
    if (rel === 'signed-out') return reply.code(401).send({ error: 'Sign in to answer this invitation' });
    if (rel === 'unconfirmed') return reply.code(403).send({ error: `Confirm your email address (${inv.to}) first, then answer the invitation` });
    return reply.code(403).send({ error: `This invitation is for ${inv.to}, and you are signed in as ${user?.email || user?.orcid || user?.name}` });
  };
  const closed = (reply: any, state: string) => reply.code(410).send({
    error: state === 'expired' ? 'This invitation expired. Ask the owner to send a new one.'
      : state === 'withdrawn' ? 'The owner withdrew this invitation.'
      : state === 'declined' ? 'You declined this invitation. Ask the owner to invite you again.'
      : 'This invitation was used already. Ask the owner to invite you again.',
    state,
  });

  // Pending invitations to the signed-in account, for its Home page.
  app.get('/api/invitations', async (req, reply) => {
    const user = reqUser(req);
    if (!auth.AUTH_ENABLED) return [];
    if (!user) return reply.code(401).send({ error: 'Sign in required' });
    const keys = recipientKeys(user);
    const now = Date.now();
    const rows = await Promise.all((keys.length ? await store.listInvitationsTo(keys) : []).filter((i) => stateOf(i, now) === 'pending').map(async (inv) => {
      const meta = await store.readMeta(inv.projectId).catch(() => null);
      if (!meta || meta.deletedAt) return null;
      return { id: inv.id, to: inv.to, state: 'pending' as const, createdAt: inv.createdAt, expiresAt: inv.expiresAt, project: { id: meta.id, name: meta.name }, ownerName: (await ownerName(meta)) ?? null };
    }));
    return rows.filter((r) => r !== null);
  });

  // What the invitation page shows. The project's name only to the person
  // invited: a link that reached someone else names the owner, never the work.
  app.get<{ Params: { invite: string } }>('/api/invitations/:invite', async (req, reply) => {
    const found = await linkedInvitation(req, reply);
    if (!found) return;
    const { inv, meta } = found;
    const user = reqUser(req);
    const rel = relation(inv, user);
    return {
      id: inv.id,
      to: inv.to,
      state: stateOf(inv),
      expiresAt: inv.expiresAt,
      ownerName: (await ownerName(meta)) ?? null,
      relation: rel,
      signedInAs: user ? (user.email || user.orcid || user.name) : null,
      ...(rel === 'match' ? { project: { id: meta.id, name: meta.name }, member: isMember(meta, user) } : {}),
    };
  });

  app.post<{ Params: { invite: string } }>('/api/invitations/:invite/accept', async (req, reply) => {
    const found = await linkedInvitation(req, reply);
    if (!found) return;
    const { inv } = found;
    const user = reqUser(req);
    const rel = relation(inv, user);
    if (rel !== 'match') return mismatch(reply, inv, rel, user);
    const state = stateOf(inv);
    const settled = state === 'pending' && await store.settleInvitation(inv.id, 'accepted', new Date().toISOString());
    if (settled) {
      // Gaining access needs no socket to reconnect, so no access-changed event.
      try {
        if (!(await store.addShareEntry(inv.projectId, inv.to))) return reply.code(404).send({ error: 'The project of this invitation was deleted' });
      } catch (err) {
        await store.setInvitation(inv);
        throw err;
      }
      // Taken off the list earlier: accepting puts it back.
      const open = await store.getProjectOpen(user!.id, inv.projectId);
      if (open?.hidden) await store.setProjectOpen({ ...open, hidden: false });
      return { ok: true, projectId: inv.projectId };
    }
    if (state === 'pending') {
      // Lost the race to an accept from another tab (only this identity can
      // accept), or to a decline or withdrawal.
      if ((await store.getInvitation(inv.id))?.status === 'accepted' && await store.addShareEntry(inv.projectId, inv.to)) return { ok: true, projectId: inv.projectId, already: true };
      return reply.code(409).send({ error: 'This invitation was answered or withdrawn a moment ago. Reload the page.' });
    }
    if (state === 'accepted' && isMember(await store.readMeta(inv.projectId), user)) return { ok: true, projectId: inv.projectId, already: true };
    return closed(reply, state);
  });

  app.post<{ Params: { invite: string } }>('/api/invitations/:invite/decline', async (req, reply) => {
    const found = await linkedInvitation(req, reply);
    if (!found) return;
    const { inv } = found;
    const user = reqUser(req);
    const rel = relation(inv, user);
    if (rel !== 'match') return mismatch(reply, inv, rel, user);
    const state = stateOf(inv);
    if (state === 'declined') return { ok: true };
    if (state === 'accepted') return reply.code(409).send({ error: 'You accepted this invitation already. To leave the project, ask its owner to remove you.' });
    if (state !== 'pending') return closed(reply, state);
    if (!(await store.settleInvitation(inv.id, 'declined', new Date().toISOString()))) {
      return reply.code(409).send({ error: 'This invitation was answered or withdrawn a moment ago. Reload the page.' });
    }
    return { ok: true };
  });

  // Claim an ownerless legacy project (created before auth was enabled).
  // First successful claim wins: the claimer becomes owner, sharing resets to
  // private (any pre-existing share config was authorless), and everyone
  // else's access ends — live sessions included, on every node.
  const claiming = new Set<string>(); // in-process mutex: one node resolves races deterministically
  app.post<{ Params: { id: string } }>('/api/projects/:id/claim', async (req, reply) => {
    if (!auth.AUTH_ENABLED) return reply.code(400).send({ error: 'Claiming applies only when accounts are enabled' });
    const user = reqUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in required' });
    if (claiming.has(req.params.id)) return reply.code(409).send({ error: 'Someone else is claiming this project' });
    claiming.add(req.params.id);
    try {
      const meta = await store.readMeta(req.params.id); // re-read inside the mutex
      if (meta.ownerId) return reply.code(409).send({ error: 'This project already has an owner' });
      meta.ownerId = user.id;
      meta.share = { mode: 'private', collaborators: [] };
      await store.writeMeta(meta);
      closeProjectConnections(meta.id);
      publishProjectEvent({ type: 'access-changed', projectId: meta.id });
      return publicMeta(meta, user);
    } finally {
      claiming.delete(req.params.id);
    }
  });

  // Test hook (never in production): strip ownership so the e2e suite can
  // fabricate the pre-auth legacy state against a fully materialized project.
  // Same env-gating idiom as ALDINE_RESET_ECHO.
  if (process.env.ALDINE_TEST_HOOKS === '1') {
    app.post<{ Params: { id: string } }>('/api/projects/:id/disown', async (req) => {
      const meta = await store.readMeta(req.params.id);
      delete meta.ownerId;
      delete meta.share;
      await store.writeMeta(meta);
      return { ok: true };
    });
  }

  // Test hook (never in production): make a project a showcase at runtime.
  // The collab sockets and GET project follow the set as it is; the REST
  // write guard above exists only when the set was non-empty at boot.
  if (process.env.ALDINE_TEST_HOOKS === '1') {
    app.post<{ Params: { id: string } }>('/api/test/showcase/:id', async (req) => {
      protectedProjects.add(req.params.id);
      return { ok: true };
    });
    app.delete<{ Params: { id: string } }>('/api/test/showcase/:id', async (req) => {
      protectedProjects.delete(req.params.id);
      return { ok: true };
    });
  }

  // Asked for at boot so the first gallery request is served from the cache
  // instead of waiting on the compiler.
  warmVenueCache();
  startTemplateRepoRefresh();
  app.get('/api/templates', async () => withPreviews(await listAllTemplates()));
  /**
   * Page 1 of a template, as the chooser shows it (templatepreviews.ts). With
   * accounts on it is for signed-in users, like creating a project from it: a
   * template repository can be private to the operator's group. A `v` that is
   * not the current version is answered uncacheable, so a year-long cache
   * entry always holds the image its `v` names.
   */
  app.get<{ Querystring: { id?: string; v?: string } }>('/api/templates/preview', async (req, reply) => {
    if (auth.AUTH_ENABLED && !reqUser(req)) return reply.code(401).send({ error: 'Sign in required' });
    const img = typeof req.query.id === 'string' ? readTemplatePreview(req.query.id) : null;
    if (!img) return reply.code(404).send({ error: 'No preview: this template has not been typeset yet' });
    const etag = `"${img.v}"`;
    const scope = auth.AUTH_ENABLED ? 'private' : 'public';
    reply
      .header('etag', etag)
      .header('cache-control', req.query.v === img.v ? `${scope}, max-age=31536000, immutable` : `${scope}, no-cache`)
      .header('x-content-type-options', 'nosniff');
    if (etagMatches(req.headers['if-none-match'], etag)) return reply.code(304).send();
    return reply.type('image/jpeg').send(img.bytes);
  });
  // Template repositories: their sync state, and a forced refresh. With auth
  // on, refreshing is for signed-in users; one sync per repository runs at a
  // time, so a burst of clicks costs one fetch.
  app.get('/api/templates/repos', async () => ({ repos: templateRepoStates() }));
  app.post('/api/templates/repos/refresh', async (req, reply) => {
    if (auth.AUTH_ENABLED && !reqUser(req)) return reply.code(401).send({ error: 'Sign in required' });
    return { repos: await syncAllTemplateRepos() };
  });

  // What the connected compiler runs. Not project-scoped, so it is not behind
  // the project auth hook; it discloses nothing beyond a TeX Live release.
  app.get('/api/compiler', async () => compilerInfo());

  // Import an Overleaf/project ZIP as a new project. Two body shapes: JSON
  // { name, zipBase64 } for API clients, and multipart/form-data with a `zip`
  // file part (what the web client sends, so the browser holds one copy of
  // the archive instead of file + base64 + JSON string + request body).
  // Base64 is 4/3 of the raw size, so the route needs its own body limit: the
  // global 32 MB one would cap imports at ~24 MB while the UI promises
  // IMPORT_MAX_ZIP_BYTES. deploy/nginx.conf's client_max_body_size must stay
  // >= this figure.
  const importBodyLimit = Math.ceil(IMPORT_MAX_ZIP_BYTES * 4 / 3) + 1024 * 1024;
  app.addContentTypeParser('multipart/form-data', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
    try {
      const boundary = multipartBoundary(req.headers['content-type']);
      if (!boundary) throw new Error('multipart/form-data without a boundary');
      const parsed: ImportBody = {};
      for (const part of parseMultipart(body, boundary)) {
        if (part.filename !== undefined || part.name === 'zip') { parsed.zip = part.data; parsed.zipName = part.filename; }
        else if (part.name === 'name') parsed.name = part.data.toString('utf8');
        else if (part.name === 'namespace') parsed.namespace = part.data.toString('utf8');
      }
      done(null, parsed);
    } catch (err: any) {
      done(Object.assign(err, { statusCode: 400 }), undefined);
    }
  });
  type ImportBody = { name?: string; zipBase64?: string; zip?: Buffer; zipName?: string; namespace?: string };
  // With accounts on, an ownerless project would be every user's (isMember).
  // Refused in onRequest, before the body is read: a preHandler sees an
  // anonymous upload only after all of it (up to importBodyLimit) is in memory.
  const signedInFirst = async (req: any, reply: any) => {
    if (auth.AUTH_ENABLED && !reqUser(req)) return reply.code(401).send({ error: 'Sign in required' });
  };
  app.post<{ Body: ImportBody }>('/api/projects/import', { bodyLimit: importBodyLimit, onRequest: signedInFirst }, async (req, reply) => {
    const body = req.body || {};
    let buf: Buffer;
    if (Buffer.isBuffer(body.zip)) buf = body.zip;
    else if (typeof body.zipBase64 === 'string' && body.zipBase64) buf = Buffer.from(body.zipBase64, 'base64');
    else return reply.code(400).send({ error: 'zipBase64 (JSON) or a zip file part (multipart/form-data) required' });
    const name = body.name || (body.zipName ? body.zipName.replace(/\.zip$/i, '') : '') || 'Imported project';
    // Every failure is one info line with what a self-hoster needs to debug an
    // import without the archive: the reason, its size and entry count. Never
    // an entry's contents.
    let entryCount: number | null | undefined;
    const fail = (status: number, error: string) => {
      if (entryCount === undefined) entryCount = zipEntryCount(buf);
      req.log.info({ import: { reason: error, zipBytes: buf.length, entries: entryCount, multipart: Buffer.isBuffer(body.zip) } }, 'ZIP import failed');
      return reply.code(status).send({ error });
    };
    if (buf.length > IMPORT_MAX_ZIP_BYTES) {
      return fail(413, `ZIP is ${mb(buf.length)} MB; the limit is ${mb(IMPORT_MAX_ZIP_BYTES)} MB`);
    }
    let created: store.ProjectMeta | null = null;
    try {
      const entries = unzip(buf);
      entryCount = Object.keys(entries).length;
      // Every entry is placed (or rejected) before the project exists, so a bad
      // path can never leave a half-imported project behind.
      const files: Record<string, Buffer> = {};
      for (const [entry, data] of Object.entries(entries)) {
        const p = importPath(entry);
        if (p === null) return fail(400, `ZIP entry "${entry}" points outside the project`);
        if (p.startsWith('__MACOSX/') || isHiddenPath(p)) continue;
        // Screened here, not at the write: fs would answer ENAMETOOLONG with
        // the server's absolute path in the message, and the catch below
        // would hand that to the caller.
        const tooLong = overlongPath(p);
        if (tooLong) return fail(400, `ZIP entry "${entry}" has ${tooLong}`);
        files[p] = data;
      }
      if (!Object.keys(files).length) return fail(400, 'ZIP had no usable files');
      const wrapper = wrapperFolder(Object.keys(files));
      if (wrapper) {
        const inside = Object.entries(files).map(([p, data]) => [p.slice(wrapper.length + 1), data] as const);
        for (const p of Object.keys(files)) delete files[p];
        for (const [p, data] of inside) files[p] = data;
      }
      const clash = pathConflict(Object.keys(files));
      if (clash) return fail(400, `The archive uses "${clash}" as both a file and a directory`);
      // create with text files seeded; write binaries as buffers afterward
      const textFiles: Record<string, string> = {};
      const binFiles: string[] = [];
      const transcoded: string[] = [];
      for (const [p, data] of Object.entries(files)) {
        // treat as text only if the extension says so AND there's no NUL byte in the head
        const looksBinary = data.subarray(0, 8000).includes(0);
        if (isTextFile(p) && !looksBinary) {
          const decoded = decodeText(data);
          textFiles[p] = decoded.text;
          if (decoded.transcoded) transcoded.push(p);
        } else binFiles.push(p);
      }
      const meta = await store.createProject(name, textFiles, reqUser(req)?.id);
      created = meta;
      for (const p of binFiles) store.writeFile(meta.id, 'main', p, files[p]);
      if (binFiles.length) await gitops.autoCommit(meta.id, 'main', 'aldine: import assets').catch(() => {});
      const root = guessRoot(files);
      // Detection reads the archive bytes, not the transcoded text: the package
      // names it looks for are ASCII either way, and the latexmkrc is never transcoded.
      const detected = detectEngine(files, root);
      if (root) meta.rootFile = root;
      meta.engine = detected.engine;
      await store.writeMeta(meta);
      noteEdit(meta.id, 'main', editorOf(reqUser(req)));
      const remoteError = await provisionNew(meta, req, body.namespace);
      return { ...(await publicMeta(meta, reqUser(req))), import: { engine: detected.engine, engineReason: detected.reason, transcoded }, ...(remoteError ? { remoteError } : {}) };
    } catch (err: any) {
      if (created) await store.deleteProject(created.id).catch(() => {});
      if (err instanceof ZipError && err.entryCount !== undefined) entryCount = err.entryCount;
      // A ZipError names the entry and the reason and is the caller's to fix;
      // anything else is a server fault whose message may carry on-disk paths.
      if (err instanceof ZipError) return fail(400, `Could not import ZIP: ${err.message}`);
      req.log.error({ err }, 'ZIP import failed unexpectedly');
      return fail(500, 'Could not import the ZIP. Try again, or send the archive to the instance operator.');
    }
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    try {
      const meta = await store.readMeta(req.params.id);
      const branches = await gitops.listBranches(meta.id);
      // readOnly: a showcase, whose collab sockets drop every edit.
      return { ...(await publicMeta(meta, reqUser(req))), branches, readOnly: protectedProjects.has(meta.id) };
    } catch {
      return reply.code(404).send({ error: 'project not found' });
    }
  });

  app.patch<{ Params: { id: string }; Body: Partial<Pick<store.ProjectMeta, 'name' | 'rootFile' | 'engine' | 'stopOnFirstError' | 'manualCommits'>> }>(
    '/api/projects/:id', async (req, reply) => {
      const meta = await requireMember(req, reply, 'rename or reconfigure this project');
      if (!meta) return;
      const { name, rootFile, engine, stopOnFirstError, manualCommits } = req.body || {};
      if (name !== undefined) {
        const trimmed = String(name).trim();
        if (!trimmed) return reply.code(400).send({ error: 'Project name cannot be empty' });
        if (trimmed.length > 200) return reply.code(400).send({ error: 'Project name is too long (max 200 characters)' });
        meta.name = trimmed;
      }
      if (rootFile) {
        const bad = invalidRootFile(rootFile);
        if (bad) return reply.code(400).send({ error: bad });
        meta.rootFile = rootFile;
      }
      if (engine !== undefined) {
        if (!(ENGINES as readonly string[]).includes(engine as string)) {
          return reply.code(400).send({ error: `Unknown engine "${String(engine)}" — use one of ${ENGINES.join(', ')}` });
        }
        meta.engine = engine;
      }
      if (stopOnFirstError !== undefined) {
        if (typeof stopOnFirstError !== 'boolean') return reply.code(400).send({ error: 'stopOnFirstError must be true or false' });
        meta.stopOnFirstError = stopOnFirstError;
      }
      if (manualCommits !== undefined) {
        if (typeof manualCommits !== 'boolean') return reply.code(400).send({ error: 'manualCommits must be true or false' });
        meta.manualCommits = manualCommits;
      }
      await store.writeMeta(meta);
      return publicMeta(meta, reqUser(req));
    });

  // Delete = move to trash (restorable ~30 days). ?permanent=1 skips the trash
  // — used by "Delete forever" in the trash UI and by tests that must clean up.
  app.delete<{ Params: { id: string }; Querystring: { permanent?: string } }>('/api/projects/:id', async (req, reply) => {
    const meta = await store.readMeta(req.params.id);
    if (!isOwner(meta, reqUser(req))) return reply.code(403).send({ error: 'Only the owner can delete this project' });
    const { remote } = await trashProject(meta);
    let purgeAt: string | undefined;
    if (req.query.permanent === '1') {
      // Opening the editor starts a typeset; one still writing .aldine-out
      // makes the removal fail. The trash above already refuses new ones.
      await typesetsSettled(req.params.id);
      await store.deleteProject(req.params.id);
    } else {
      const at = Date.parse((await store.readMeta(req.params.id).catch(() => null))?.deletedAt || '');
      if (!Number.isNaN(at)) purgeAt = restorableUntil(new Date(at));
    }
    return { ok: true, ...(purgeAt ? { purgeAt } : {}), ...(remote.scheduledFor ? { remoteScheduledFor: remote.scheduledFor } : {}), ...(remote.error ? { remoteError: remote.error } : {}) };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/restore', async (req, reply) => {
    const meta = await store.readMeta(req.params.id);
    if (!isOwner(meta, reqUser(req))) return reply.code(403).send({ error: 'Only the owner can restore this project' });
    if (!meta.deletedAt) return reply.code(400).send({ error: 'Project is not in the trash' });
    const restored = await store.restoreProject(req.params.id);
    // A provisioned project that was deleted on GitLab with the trash comes back there too.
    const remoteError = restored.remotePending && provisioningEnabled()
      ? await provisionNew(restored, req, restored.remotePending.namespace)
      : undefined;
    return { ok: true, ...(remoteError ? { remoteError } : {}) };
  });

  // ---------- the caller's project list ----------
  // Session only (not in TOKEN_PROJECT_WRITES): the list is the person's, an
  // agent's token neither puts projects on it nor takes them off.

  // The editor reports each open and each branch switch. For someone who is
  // here through a share link this is what puts the project on their list,
  // and for a member it undoes an earlier "Remove from my list". An owner's
  // archive stays until they unarchive: opening a finished paper to look at
  // it does not put it back on the list.
  app.post<{ Params: { id: string }; Body: { branch?: unknown } }>('/api/projects/:id/opened', async (req, reply) => {
    const branch = typeof req.body?.branch === 'string' && req.body.branch ? req.body.branch : 'main';
    if (!BRANCH_RE.test(branch) || branch.includes('..')) return reply.code(400).send({ error: 'invalid branch name' });
    const user = reqUser(req);
    if (!(await visitLimiter.take(clientKey(req, user?.id)))) return reply.code(429).send({ error: 'Rate limit reached — please slow down' });
    // Only a branch that exists: the list opens the project on it.
    if (!(await gitops.branchHead(req.params.id, branch))) return reply.code(404).send({ error: 'Project or branch not found' });
    const at = new Date().toISOString();
    const userId = listUserId(user);
    const archived = isOwner(await store.readMeta(req.params.id), user) && !!(await store.getProjectOpen(userId, req.params.id))?.hidden;
    await store.setProjectOpen({ userId, projectId: req.params.id, at, branch, hidden: archived });
    return { ok: true, opened: { at, branch } };
  });

  // "Remove from my list", or "Archive" for the owner. A link visitor's row
  // goes; an invited member keeps access and the project stays off their list
  // until they open it again; the owner's stays off until they unarchive it.
  // Nobody else's list changes.
  app.delete<{ Params: { id: string } }>('/api/projects/:id/listing', async (req, reply) => {
    let meta: store.ProjectMeta;
    try { meta = await store.readMeta(req.params.id); } catch { return reply.code(404).send({ error: 'project not found' }); }
    const user = reqUser(req);
    const userId = listUserId(user);
    if (isOwner(meta, user) || isMember(meta, user)) {
      const prev = await store.getProjectOpen(userId, meta.id);
      await store.setProjectOpen({ userId, projectId: meta.id, at: prev?.at ?? null, branch: prev?.branch ?? null, hidden: true });
    } else {
      await store.deleteProjectOpen(userId, meta.id);
    }
    return { ok: true };
  });

  // Undo of "Remove from my list", and "Unarchive": puts the row back as it was, without
  // counting as an open, so what changed since the last open stays unread.
  // A link visitor's row was deleted, so the client hands back its open;
  // it can only name a time already past and a branch that exists.
  app.put<{ Params: { id: string }; Body: { opened?: { at?: unknown; branch?: unknown } | null } }>('/api/projects/:id/listing', async (req, reply) => {
    let meta: store.ProjectMeta;
    try { meta = await store.readMeta(req.params.id); } catch { return reply.code(404).send({ error: 'project not found' }); }
    const user = reqUser(req);
    if (isOwner(meta, user)) {
      const prev = await store.getProjectOpen(listUserId(user), meta.id);
      if (prev?.hidden) await store.setProjectOpen({ ...prev, hidden: false });
      return { ok: true };
    }
    // Each call may look up a branch in git and writes the datastore: the same budget as an open.
    if (!(await visitLimiter.take(clientKey(req, user?.id)))) return reply.code(429).send({ error: 'Rate limit reached — please slow down' });
    const userId = listUserId(user);
    const prev = await store.getProjectOpen(userId, meta.id);
    let at = prev?.at ?? null;
    let branch = prev?.branch ?? null;
    const given = req.body?.opened;
    if (!prev && given) {
      const t = typeof given.at === 'string' ? Date.parse(given.at) : NaN;
      if (!Number.isNaN(t) && t <= Date.now()) at = new Date(t).toISOString();
      const b = typeof given.branch === 'string' ? given.branch : '';
      if (b && BRANCH_RE.test(b) && !b.includes('..') && (await gitops.branchHead(meta.id, b))) branch = b;
      else if (at) branch = 'main';
    }
    await store.setProjectOpen({ userId, projectId: meta.id, at, branch, hidden: false });
    return { ok: true };
  });

  // Duplicate: anyone who may download the source may copy it, and owns the
  // copy. The source's main working tree, no history (store.copyProject).
  app.post<{ Params: { id: string }; Body: { name?: unknown } }>('/api/projects/:id/copy', async (req, reply) => {
    let source: store.ProjectMeta;
    try { source = await store.readMeta(req.params.id); } catch { return reply.code(404).send({ error: 'project not found' }); }
    const raw = req.body?.name;
    if (raw !== undefined && raw !== null && typeof raw !== 'string') return reply.code(400).send({ error: 'Project name must be text' });
    const name = (typeof raw === 'string' && raw.trim()) || `${source.name.trim().slice(0, 195)} copy`;
    if (name.length > 200) return reply.code(400).send({ error: 'Project name is too long (max 200 characters)' });
    const user = reqUser(req);
    if (!(await copyLimiter.take(clientKey(req, user?.id)))) return reply.code(429).send({ error: 'Duplicate rate limit reached — please slow down' });
    let meta: store.ProjectMeta;
    try {
      meta = await gitops.withRepoLock(source.id, () => {
        flushBranchDocs(source.id, 'main');
        return store.copyProject(source, name, user?.id);
      });
    } catch (err: any) {
      if (err instanceof store.CopyTooLargeError) {
        return reply.code(413).send({ error: `This project is larger than ${Math.round(store.COPY_MAX_BYTES / (1024 * 1024))} MB, too large to duplicate. Download it as a ZIP instead.` });
      }
      req.log.error({ err }, 'copyProject failed');
      return reply.code(500).send({ error: 'Could not copy the project' });
    }
    noteEdit(meta.id, 'main', editorOf(user));
    const remoteError = await provisionNew(meta, req);
    const row = await projectRow(meta, user, null, (await activitySnapshot()).get(meta.id), 'owner');
    return { ...row, ...(remoteError ? { remoteError } : {}) };
  });

  // ---------- files ----------
  app.get<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/files', async (req, reply) => {
    const branch = req.query.branch || 'main';
    try {
      await gitops.ensureWorktree(req.params.id, branch);
      // Flush before reading the version so it matches what a subsequent
      // GET /file (which also flushes) will serve — otherwise a pending edit
      // would bump the version between the two calls and fake a conflict.
      flushBranchDocs(req.params.id, branch);
      return { files: store.listFiles(req.params.id, branch), contentVersion: contentVersion(req.params.id, branch) };
    } catch {
      return reply.code(404).send({ error: 'Project or branch not found' });
    }
  });

  app.get<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/file', async (req, reply) => {
    const { branch = 'main', path: rel } = req.query;
    if (!rel) return reply.code(400).send({ error: 'path required' });
    if (isHiddenPath(rel)) return reply.code(403).send({ error: 'forbidden path' });
    // Flush open docs first: the disk copy is up to ~8 s (maxDebounce) behind
    // the live editor, and REST read-modify-write is racy on a stale read.
    flushBranchDocs(req.params.id, branch);
    try {
      const buf = store.readFile(req.params.id, branch, rel);
      // A committed .svg (or sniffed .html) served on our own origin would run its
      // scripts on top-level navigation, acting as the viewer. nosniff pins the
      // type and the sandbox CSP neutralizes any script while <img> embeds still render.
      // content-version is the branch version a caller passes back as
      // baseVersion; file-version is when this file itself last changed (PUT
      // refuses only when that moved past baseVersion).
      return reply
        .header('x-aldine-content-version', String(contentVersion(req.params.id, branch)))
        .header('x-aldine-file-version', String(fileVersion(req.params.id, branch, rel)))
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', RAW_FILE_CSP)
        .type(rawFileType(rel)).send(buf);
    } catch {
      return reply.code(404).send({ error: 'file not found' });
    }
  });

  // The project's source as a ZIP a person can keep, send to a journal or
  // import again: the branch's tracked tree from git archive, after the live
  // documents are flushed and committed so it matches the editor.
  app.get<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/archive', async (req, reply) => {
    const branch = req.query.branch || 'main';
    if (!BRANCH_RE.test(branch)) return reply.code(400).send({ error: 'invalid branch name' });
    let meta: store.ProjectMeta;
    try { meta = await store.readMeta(req.params.id); await gitops.ensureWorktree(req.params.id, branch); }
    catch { return reply.code(404).send({ error: 'Project or branch not found' }); }
    flushBranchDocs(req.params.id, branch);
    // A download is not a commit: with manual commits the ZIP is the working
    // tree, and the uncommitted edits stay uncommitted.
    let tree = branch;
    if (meta.manualCommits) tree = await gitops.workingTreeId(req.params.id, branch);
    else await gitops.autoCommit(req.params.id, branch, 'aldine: autosave', reqUser(req)?.name).catch(() => {});
    const folder = archiveFolderName(meta.name);
    const zip = await gitops.archiveZip(req.params.id, branch, tree);
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${folder}.zip"; filename*=UTF-8''${encodeURIComponent(`${meta.name.trim() || 'project'}.zip`)}`)
      .header('cache-control', 'no-store')
      .send(zip);
  });

  app.put<{ Params: { id: string }; Body: { branch?: string; path: string; content?: string; encoding?: 'utf8' | 'base64'; createOnly?: boolean; baseVersion?: number } }>(
    '/api/projects/:id/file', async (req, reply) => {
      const { branch = 'main', path: rel, content = '', encoding = 'utf8', createOnly = false, baseVersion } = req.body || {};
      if (!rel) return reply.code(400).send({ error: 'path required' });
      if (!namesEntry(rel)) return reply.code(400).send({ error: NOT_AN_ENTRY });
      if (isHiddenPath(rel) || rel.includes('..')) return reply.code(403).send({ error: 'Invalid file path' });
      if (optionLikePath(rel)) return reply.code(400).send({ error: 'File name cannot start with "-"' });
      await gitops.ensureWorktree(req.params.id, branch);
      // Flush open docs BEFORE writing: the store debounce means up to ~8 s of
      // a live collaborator's typing exists only in memory, and writing over
      // the stale disk copy would refresh those keystrokes away.
      flushBranchDocs(req.params.id, branch);
      // Optimistic concurrency: a caller that read at baseVersion writes only
      // if THIS file did not change since. Checked after the flush so pending
      // typing in this file counts as a change, not a silent overwrite; a
      // change to any other file on the branch does not (per-file by design).
      // A base newer than the branch knows is refused as unknowable.
      if (baseVersion !== undefined) {
        const conflict = versionConflict(req.params.id, branch, rel, baseVersion);
        if (conflict) return reply.code(409).send(conflict);
      }
      // createOnly (new-file flow): never clobber an existing file with empty content
      if (createOnly && store.fileExists(req.params.id, branch, rel)) {
        return reply.code(409).send({ error: 'A file with that name already exists' });
      }
      try {
        store.writeFile(req.params.id, branch, rel, encoding === 'base64' ? Buffer.from(content, 'base64') : content);
      } catch {
        return reply.code(400).send({ error: 'Could not write that file path' });
      }
      refreshBranchDocsFromDisk(req.params.id, branch, [rel]);
      scheduleCommit(req.params.id, branch); // non-collab write → still reach git history
      noteEdit(req.params.id, branch, editorOf(reqUser(req)));
      const newRoot = await adoptRootIfUnset(req.params.id, branch, rel);
      return { ok: true, ...(newRoot ? { newRoot } : {}) };
    });

  app.post<{ Params: { id: string }; Body: { branch?: string; from: string; to: string } }>(
    '/api/projects/:id/file/rename', async (req, reply) => {
      const { branch = 'main', from, to } = req.body || {};
      if (!from || !to) return reply.code(400).send({ error: 'from/to required' });
      if (!namesEntry(from) || !namesEntry(to)) return reply.code(400).send({ error: NOT_AN_ENTRY });
      if (isHiddenPath(from) || isHiddenPath(to)) return reply.code(403).send({ error: 'forbidden path' });
      if (optionLikePath(to)) return reply.code(400).send({ error: 'File name cannot start with "-"' });
      if (from === to) return { ok: true };
      // never overwrite an existing file — that would destroy both it and the source
      if (store.fileExists(req.params.id, branch, to)) {
        return reply.code(409).send({ error: `A file named "${to}" already exists` });
      }
      if (!store.fileExists(req.params.id, branch, from)) {
        return reply.code(404).send({ error: `No file named "${from}"` });
      }
      const wasDir = store.isDirectory(req.params.id, branch, from);
      const normFrom = importPath(from);
      const normTo = importPath(to);
      if (wasDir && normFrom && normTo?.startsWith(`${normFrom}/`)) {
        return reply.code(400).send({ error: `"${from}" cannot move into a folder inside itself` });
      }
      // Flush pending edits BEFORE evicting: eviction tombstones the doc and a
      // tombstoned doc is never written, so anything typed inside the autosave
      // debounce window would be renamed away and lost.
      flushBranchDocs(req.params.id, branch);
      // evict the source doc so its final store can't recreate the old file
      if (wasDir && normFrom) evictTree(req.params.id, branch, normFrom, store.listFiles(req.params.id, branch).map((f) => f.path));
      else evictDoc(req.params.id, branch, from);
      store.renameFile(req.params.id, branch, from, to);
      // bib/label indexes carry file paths; a directory rename moves every child
      if (wasDir) markTreeChanged(req.params.id, branch);
      else markPathsChanged(req.params.id, branch, [from, to]);
      scheduleCommit(req.params.id, branch);
      noteEdit(req.params.id, branch, editorOf(reqUser(req)));
      // The typeset root keeps its designation through a rename (deletion
      // already re-derives it; a rename must not orphan it). A rename that
      // produces the project's first .tex adopts it, as creation would. The
      // stored path is the normalised one: "./a.tex" must match the tree. A
      // root inside a renamed folder moves with it.
      let newRoot: string | undefined;
      try {
        const meta = await store.readMeta(req.params.id);
        const moved = meta.rootFile && normFrom && normTo
          ? meta.rootFile === normFrom ? normTo
            : wasDir && meta.rootFile.startsWith(`${normFrom}/`) ? normTo + meta.rootFile.slice(normFrom.length) : null
          : null;
        if (moved) {
          meta.rootFile = moved;
          await store.writeMeta(meta);
          newRoot = moved;
        } else if (!meta.rootFile) {
          newRoot = await adoptRootIfUnset(req.params.id, branch, to);
        }
      } catch { /* meta unreadable — leave as-is */ }
      // Review threads name their file; left on the old path they lose their
      // highlights and Accept edits a file that no longer exists.
      if (normFrom && normTo) {
        try {
          if (await comments.movePath(req.params.id, branch, normFrom, normTo, wasDir)) bumpCommentsSignal(req.params.id, branch);
        } catch (err) { req.log.warn({ err }, 'moving review comments with a rename failed'); }
      }
      return { ok: true, ...(newRoot ? { newRoot } : {}) };
    });

  app.delete<{ Params: { id: string }; Querystring: Q & { author?: string } }>('/api/projects/:id/file', async (req, reply) => {
    const { branch = 'main', path: rel } = req.query;
    if (!rel) return reply.code(400).send({ error: 'path required' });
    if (!namesEntry(rel)) return reply.code(400).send({ error: NOT_AN_ENTRY });
    if (isHiddenPath(rel)) return reply.code(403).send({ error: 'forbidden path' });
    const wasDir = store.isDirectory(req.params.id, branch, rel);
    const existed = store.fileExists(req.params.id, branch, rel);
    const norm = importPath(rel);
    const listed = store.listFiles(req.params.id, branch).map((f) => f.path);
    // The deletion lands as its own commit, so reverting it is the undo. With
    // manual commits it waits for the person's commit like any other edit.
    const manual = await store.readMeta(req.params.id).then((m) => m.manualCommits === true, () => false);
    const own = existed && !!norm && !manual;
    const remove = () => {
      // prevent resurrection via pending store
      if (wasDir && norm) evictTree(req.params.id, branch, norm, listed);
      else evictDoc(req.params.id, branch, rel);
      store.deleteFile(req.params.id, branch, rel);
    };
    let commit: string | null = null;
    let undo: string | null = null;
    if (existed && norm && manual) {
      // No commit to revert: what the files held is kept for the undo instead.
      flushBranchDocs(req.params.id, branch);
      const files = wasDir ? listed.filter((p) => p.startsWith(`${norm}/`) && !store.isDirectory(req.params.id, branch, p)) : [norm];
      undo = await saveImage(req.params.id, branch, files.map((p) => ({ path: p, before: store.readFile(req.params.id, branch, p), after: null }))).catch(() => null);
    }
    if (own) {
      // the last typing in these files must be on disk for the checkpoint below
      flushBranchDocs(req.params.id, branch);
      await gitops.withRepoLock(req.params.id, async () => {
        // What the files held a moment ago is committed first, so the undo
        // brings back their latest text, not the last autosave's.
        await gitops.checkpointPathsHeld(req.params.id, branch, wasDir ? listed.filter((p) => p.startsWith(`${norm}/`)) : [norm!]).catch(() => {});
        remove();
        const r = await gitops.commitRemovalHeld(req.params.id, branch, norm!, `Delete ${wasDir ? `folder ${norm}` : norm}`, commitAuthor(req, req.query.author)).catch(() => null);
        if (r?.committed && r.hash) commit = r.hash.slice(0, 7);
      });
    } else {
      remove();
    }
    // a directory delete removes every child, which a single path mark would miss
    if (wasDir) markTreeChanged(req.params.id, branch);
    else markPathsChanged(req.params.id, branch, [rel]);
    // what an autosave of the deletion would have set off
    if (commit) {
      signalCommitted(req.params.id, branch);
      if (branch === 'main') scheduleAutopush(req.params.id);
    } else {
      scheduleCommit(req.params.id, branch);
    }
    if (existed) noteEdit(req.params.id, branch, editorOf(reqUser(req)));
    // If the typeset root was deleted, re-point it at the best remaining .tex
    // so the next compile doesn't fail with "root file not found". With no
    // .tex left the root is unset, so the next .tex created becomes it.
    let newRoot: string | undefined;
    try {
      const meta = await store.readMeta(req.params.id);
      if (meta.rootFile && norm && (meta.rootFile === norm || (wasDir && meta.rootFile.startsWith(`${norm}/`)))) {
        const root = detectRoot(req.params.id, branch);
        meta.rootFile = root;
        await store.writeMeta(meta);
        newRoot = root || undefined;
      }
    } catch { /* meta unreadable — leave as-is */ }
    return { ok: true, ...(newRoot ? { newRoot } : {}), commit, pending: existed && manual, ...(manual ? { undo } : {}) };
  });

  // ---------- search and replace across the branch ----------
  type SearchQ = { branch?: string; q?: string; case?: string; word?: string; regex?: string };
  const flag = (v: unknown) => v === '1' || v === 'true';
  const branchReady = async (id: string, branch: string): Promise<boolean> => {
    try { await store.readMeta(id); await gitops.ensureWorktree(id, branch); return true; } catch { return false; }
  };

  // A GET, so a showcase project can be searched: its guard refuses every
  // other method. Reads the live documents and never flushes.
  app.get<{ Params: { id: string }; Querystring: SearchQ }>('/api/projects/:id/search', async (req, reply) => {
    const branch = req.query.branch || 'main';
    if (!BRANCH_RE.test(branch) || branch.includes('..')) return reply.code(400).send({ error: 'invalid branch name' });
    if (!(await branchReady(req.params.id, branch))) return reply.code(404).send({ error: 'Project or branch not found' });
    const key = clientKey(req, reqUser(req)?.id);
    if (!(await searchLimiter.take(key))) return reply.code(429).send({ error: 'Search rate limit reached — please slow down' });
    const { q, case: matchCase, word, regex } = req.query;
    try {
      return await searchProject(req.params.id, branch, { q, caseSensitive: flag(matchCase), wholeWord: flag(word), regex: flag(regex) }, key);
    } catch (err) {
      if (err instanceof SearchError) return reply.code(err.status).send(err.body);
      throw err;
    }
  });

  // Write access is the same as PUT /file's: the showcase guard and the
  // view-only guard (VIEWER_WRITES) already refuse this POST.
  app.post<{ Params: { id: string }; Body: ReplaceBody }>('/api/projects/:id/replace', async (req, reply) => {
    const body: ReplaceBody = req.body && typeof req.body === 'object' ? req.body : {};
    const branch = typeof body.branch === 'string' && body.branch ? body.branch : 'main';
    if (!BRANCH_RE.test(branch) || branch.includes('..')) return reply.code(400).send({ error: 'invalid branch name' });
    if (!(await branchReady(req.params.id, branch))) return reply.code(404).send({ error: 'Project or branch not found' });
    const key = clientKey(req, reqUser(req)?.id);
    if (!(await replaceLimiter.take(key))) return reply.code(429).send({ error: 'Replace rate limit reached — please slow down' });
    const author = commitAuthor(req, typeof body.author === 'string' ? body.author : undefined);
    try {
      const result = await replaceInProject(req.params.id, branch, body, author, key);
      if (result.replaced > 0) noteEdit(req.params.id, branch, editorOf(reqUser(req)));
      return result;
    } catch (err) {
      if (err instanceof SearchError) return reply.code(err.status).send(err.body);
      throw err;
    }
  });

  /**
   * Signed-link authorization for /output ONLY (SECURITY.md risk #5). Runs in
   * onRequest, before the global preHandler's cookie/token guard, and only
   * when the link carries a signature: a valid one marks the request so the
   * guard yields; a bad or expired one is refused here rather than falling
   * through to cookie auth, so a tampered link never quietly succeeds on a
   * signed-in browser. Links without a signature take the cookie path as
   * before. The MCP App viewer fetches from a sandboxed origin, so signed
   * responses also answer CORS — the link is the credential, `*` adds no
   * exposure a curl of the same URL would not have.
   */
  type OutputQ = Q & { exp?: string; sig?: string };
  const verifySignedOutput = async (req: FastifyRequest<{ Params: { id: string }; Querystring: OutputQ }>, reply: FastifyReply) => {
    const { branch = 'main', path: rel = '', exp, sig } = req.query;
    if (exp === undefined && sig === undefined) return;
    const status = verifyOutputSignature(req.params.id, branch, rel, exp, sig);
    // The refusals answer CORS as well: without the header a cross-origin
    // fetch rejects opaquely and the viewer cannot tell "expired" from "down".
    reply.header('access-control-allow-origin', '*');
    if (status === 'expired') return reply.code(403).send({ error: 'This PDF link has expired — typeset again or ask for a fresh link' });
    if (status !== 'ok') return reply.code(403).send({ error: 'invalid signature' });
    (req as any)._signedOutput = true;
  };

  /** Serve compile artifacts (PDF, synctex) from the branch's .aldine-out. */
  app.get<{ Params: { id: string }; Querystring: OutputQ }>('/api/projects/:id/output', { onRequest: verifySignedOutput }, async (req, reply) => {
    const { branch = 'main', path: rel } = req.query;
    if (!rel || !isOutputPath(rel)) return reply.code(400).send({ error: 'bad output path' });
    try {
      const abs = safeJoin(store.branchDir(req.params.id, branch), rel);
      fs.accessSync(abs); // throws → 404 below if the artifact is missing
      const type = rel.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';
      // Stream from disk (constant memory) instead of buffering the whole PDF per
      // fetch. No Content-Length: a concurrent recompile can change the file size
      // between stat and read, and a fixed length would then hang/truncate the
      // client — chunked transfer sends exactly what's read and ends cleanly.
      // TeX writes whatever names the document asks for here (\openout), so
      // the type is pinned against sniffing as on the project files' route.
      return reply.type(type).header('cache-control', 'no-store').header('x-content-type-options', 'nosniff').send(fs.createReadStream(abs));
    } catch {
      return reply.code(404).send({ error: 'artifact not found' });
    }
  });

  /** Whether the branch's typeset wrote `path`, so Share links only the
   *  outputs that are there: a 404 per missing file would read as an error. */
  app.get<{ Params: { id: string }; Querystring: OutputQ }>('/api/projects/:id/output/exists', async (req, reply) => {
    const { branch = 'main', path: rel } = req.query;
    if (!rel || !isOutputPath(rel)) return reply.code(400).send({ error: 'bad output path' });
    try {
      fs.accessSync(safeJoin(store.branchDir(req.params.id, branch), rel));
      return { exists: true };
    } catch {
      return { exists: false };
    }
  });

  /**
   * Page 1 of the branch's last successful typeset (thumbnail.ts). Authorized
   * like an unsigned /output link, by the global guard alone: no signed link
   * reaches this route. A `v` that is not the version of the bytes on disk
   * (a render landed after the list was read) is answered uncacheable, so a
   * year-long cache entry always holds the image its `v` names.
   */
  app.get<{ Params: { id: string }; Querystring: { branch?: string; v?: string } }>('/api/projects/:id/thumbnail', async (req, reply) => {
    let img: Awaited<ReturnType<typeof readThumbImage>> = null;
    try {
      const meta = await store.readMeta(req.params.id);
      img = await readThumbImage(meta.id, req.query.branch || 'main', meta.rootFile);
    } catch { /* an unknown project or branch has no thumbnail */ }
    if (!img) return reply.code(404).send({ error: 'No thumbnail: this branch has no successful typeset yet' });
    const etag = `"${img.v}"`;
    reply
      .header('etag', etag)
      .header('cache-control', req.query.v === img.v ? 'private, max-age=31536000, immutable' : 'private, no-cache')
      .header('x-content-type-options', 'nosniff');
    if (etagMatches(req.headers['if-none-match'], etag)) return reply.code(304).send();
    return reply.type('image/jpeg').send(img.bytes);
  });

  // CORS preflight for signed links only: pdf.js probes with a Range header,
  // which is not a safelisted header and so triggers one. An unsigned
  // preflight has nothing to allow.
  app.options<{ Params: { id: string }; Querystring: OutputQ }>('/api/projects/:id/output', { onRequest: verifySignedOutput }, async (req, reply) => {
    if (!(req as any)._signedOutput) return reply.code(403).send({ error: 'invalid signature' });
    return reply.code(204)
      .header('access-control-allow-methods', 'GET')
      .header('access-control-allow-headers', 'range')
      .header('access-control-max-age', '600')
      .send();
  });

  // ---------- compile ----------
  // `reason` only decides whether the branch's other clients are told about
  // this run; it grants nothing and is not trusted for anything else.
  app.post<{ Params: { id: string }; Body: { branch?: string; reason?: string; mode?: string } }>('/api/projects/:id/compile', async (req, reply) => {
    const branch = req.body?.branch || 'main';
    const agent = req.body?.reason === 'agent';
    const user = reqUser(req);
    const key = clientKey(req, user?.id);
    // plan metering: block once a signed-in user is over their monthly compile budget
    if (user && await usage.overQuota(user.id)) {
      return reply.code(402).send({ ok: false, pdf: null, pdfUrl: null, log: '', errors: [], durationMs: 0, error: 'Monthly typeset limit reached — upgrade your plan for more compile time.', quotaExceeded: true });
    }
    // Refused before the budget so a typeset that cannot run spends none of it.
    if (isBranchClosed(req.params.id, branch)) {
      return reply.code(400).send({ ok: false, pdf: null, pdfUrl: null, log: '', errors: [], durationMs: 0, error: 'This branch is being deleted' });
    }
    // optional per-client budget (public demo hardening) — checked before the
    // concurrency gate so a rejected request never holds a slot
    if (compileLimiter && !(await compileLimiter.take(key))) {
      return reply.code(429).send({ ok: false, pdf: null, pdfUrl: null, log: '', errors: [], durationMs: 0, error: 'Typeset budget reached for this minute — try again shortly' });
    }
    if (!compileGate.tryAcquire(key)) {
      return reply.code(429).send({ ok: false, pdf: null, pdfUrl: null, log: '', errors: [], durationMs: 0, error: 'Too many typesets in flight — let the current ones finish' });
    }
    try {
      const result = await compileProject(req.params.id, branch, { agent, draft: req.body?.mode === 'draft' });
      if (user) await usage.recordCompile(user.id, result.durationMs || 0);
      return result;
    } catch (err: any) {
      return reply.code(err instanceof CompilerUnavailableError ? 503 : 400).send({ ok: false, pdf: null, pdfUrl: null, log: '', errors: [], durationMs: 0, error: err.message });
    } finally {
      compileGate.release(key);
    }
  });

  // Ends the branch's typeset, running or queued, and nothing else. Whoever
  // may open the branch in the editor may stop it: the shared preHandler
  // checks project access as for the compile route, an access token is
  // refused (it is no route of the Agent API), and so is a showcase visitor.
  app.post<{ Params: { id: string }; Body: { branch?: string } }>('/api/projects/:id/compile/stop', async (req, reply) => {
    try {
      await stopTypeset(req.params.id, req.body?.branch || 'main');
      return { ok: true };
    } catch (err: any) {
      return reply.code(err instanceof CompilerUnavailableError ? 503 : 400).send({ error: err.message });
    }
  });

  // What the branch's last typeset was, so a client can adopt a run somebody
  // else's browser or the agent made instead of rebuilding the same PDF. The
  // shared preHandler above already enforces project access and token scope
  // for every /api/projects/:id/* route, and this handler is an in-memory map
  // read — it must stay one (no disk stat, no compiler call, no git call), so
  // it cannot become a cheap amplification target.
  app.get<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/compile-status', async (req) =>
    compileStatus(req.params.id, req.query.branch || 'main'));

  // per-user plan usage (compile-minutes this month) — for a billing/plan UI
  app.get('/api/usage', async (req, reply) => {
    const user = reqUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in required' });
    return { metering: usage.meteringEnabled(), ...(await usage.usageFor(user.id)) };
  });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> & { branch?: string } }>(
    '/api/projects/:id/synctex', async (req, reply) => {
      const { branch = 'main', ...payload } = req.body || {};
      const res = await synctexLookup(req.params.id, branch, payload);
      if (res.stale) return reply.code(409).send({ error: res.error });
      return res;
    });

  // ---------- bib + label indexes (for \cite / \ref autocomplete), word count ----------
  // Implementations live in indexes.ts, shared with the MCP tools.
  app.get<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/bib', async (req) =>
    bibIndex(req.params.id, req.query.branch || 'main'));

  app.get<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/labels', async (req) =>
    labelIndex(req.params.id, req.query.branch || 'main'));

  app.get<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/wordcount', async (req) =>
    wordCount(req.params.id, req.query.branch || 'main'));

  // ---------- git ----------
  app.get<{ Params: { id: string } }>('/api/projects/:id/branches', async (req) => gitops.listBranches(req.params.id));

  // `checkpoint`: the person's message for the edits still waiting on `from`
  // (manual commits), which the new branch starts from.
  app.post<{ Params: { id: string }; Body: { name: string; from?: string; checkpoint?: string; author?: string } }>(
    '/api/projects/:id/branches', async (req, reply) => {
      const { name, from = 'main', checkpoint, author: claimed } = req.body || {};
      if (!name) return reply.code(400).send({ error: 'name required' });
      if (!BRANCH_RE.test(name) || name.includes('..') || /^(refs|heads|remotes)\//.test(name) || /^-/.test(name)) {
        return reply.code(400).send({ error: 'Invalid branch name' });
      }
      // capture latest edits so the new branch starts from what the user sees
      flushBranchDocs(req.params.id, from);
      await gitops.autoCommit(req.params.id, from, cleanCommitMessage(String(checkpoint ?? ''), 'aldine: checkpoint before branching'), checkpoint ? commitAuthor(req, claimed) : undefined).catch(() => {});
      try {
        await gitops.createBranch(req.params.id, name, from);
      } catch (err) {
        return reply.code(409).send({ error: `Could not create branch: ${(err as Error).message}` });
      }
      // A recreated name must not inherit the deleted branch's version log:
      // a base_version read before the delete would otherwise pass the
      // per-file conflict check against a tree it never saw.
      markTreeChanged(req.params.id, name);
      // The branch starts at `from`'s head, so the Claude work this person
      // reviewed there is reviewed here too; with no row the first open would
      // prompt for every Claude commit in the history. The browser copies its
      // own mark without accounts (agentSeen.ts).
      const user = reqUser(req);
      if (auth.AUTH_ENABLED && user) {
        const mark = await store.getProjectVisit(user.id, req.params.id, from).catch(() => null);
        if (mark) await store.setProjectVisit({ ...mark, branch: name }).catch(() => {});
      }
      return { ok: true };
    });

  // What deleting a branch would discard, so the client can ask properly.
  app.get<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/branches/unmerged', async (req, reply) => {
    const { name } = req.query;
    if (!name) return reply.code(400).send({ error: 'name required' });
    if (name === 'main') return { count: 0, newest: null };
    try {
      return await gitops.unmergedCommits(req.params.id, name);
    } catch (err) {
      return reply.code(404).send({ error: `No such branch: ${(err as Error).message}` });
    }
  });

  app.delete<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/branches', async (req, reply) => {
    const { name } = req.query;
    if (!name) return reply.code(400).send({ error: 'name required' });
    if (name === 'main') return reply.code(400).send({ error: 'Cannot delete the main branch' });
    try {
      await withBranchTypesetsClosed(req.params.id, name, () => gitops.deleteBranch(req.params.id, name));
    } catch (err) {
      return reply.code(409).send({ error: `Could not delete branch: ${(err as Error).message}` });
    }
    markTreeChanged(req.params.id, name); // see the create route
    forgetPdfUrls(req.params.id, name);
    forgetBranch(req.params.id, name);
    await store.resetProjectOpenBranch(req.params.id, name);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { branch?: string; message?: string; author?: string } }>(
    '/api/projects/:id/commit', async (req) => {
      const { branch = 'main', message, author: claimed } = req.body || {};
      const author = commitAuthor(req, claimed);
      flushBranchDocs(req.params.id, branch);
      // autoCommit, not commitAll: a person's checkpoint inside the agent's
      // debounce window must not sign Claude's pending delta with their name.
      const r = await gitops.autoCommit(req.params.id, branch, cleanCommitMessage(message, 'aldine: manual commit'), author);
      if (r.committed) signalCommitted(req.params.id, branch);
      if (r.committed && branch === 'main') scheduleAutopush(req.params.id);
      if (r.committed) void pruneImages(req.params.id).catch(() => {});
      return r;
    });

  // Revert a set of commits (newest-first) as one new commit — the session
  // toast's "Revert these changes". Additive history only, never a rewrite.
  // `checkpoint` titles the commit of edits still waiting (manual commits).
  app.post<{ Params: { id: string }; Body: { branch?: string; hashes?: string[]; message?: string; author?: string; checkpoint?: string } }>(
    '/api/projects/:id/revert', async (req, reply) => {
      const { branch = 'main', hashes, message: rawMessage, author: claimed, checkpoint } = req.body || {};
      const author = commitAuthor(req, claimed);
      const message = cleanCommitMessage(rawMessage, 'Revert agent changes');
      if (!Array.isArray(hashes) || hashes.length === 0) return reply.code(400).send({ error: 'hashes required' });
      // capture pending edits first so the revert never collides with a dirty tree
      flushBranchDocs(req.params.id, branch);
      await gitops.autoCommit(req.params.id, branch, cleanCommitMessage(String(checkpoint ?? ''), 'aldine: checkpoint before revert'), author).catch(() => {});
      try {
        const result = await gitops.revertCommits(req.params.id, branch, hashes, message, author);
        if (result.ok) {
          refreshBranchDocsFromDisk(req.params.id, branch);
          noteEdit(req.params.id, branch, editorOf(reqUser(req)));
          // Success-metric line (docs/plans/agent-api/00-overview.md, "% of
          // agent commits reverted"): only reverts that undo Claude's work.
          const agentCommits = (await gitops.commitAuthors(req.params.id, hashes).catch(() => [])).filter((a) => a === gitops.AGENT_COMMIT_AUTHOR).length;
          if (agentCommits) console.log(`[metric] agent_revert user=${reqUser(req)?.id ?? 'operator'} project=${req.params.id} commits=${agentCommits}`);
        }
        return { ...result, author: author ?? null };
      } catch (err) {
        return reply.code(err instanceof gitops.RevertRefusedError ? 400 : 409).send({ error: (err as Error).message });
      }
    });

  // Newest first, `limit` (at most 250) entries after the first `skip`, each
  // with its parent count and changed paths.
  // The undo of a Replace all or a delete that made no commit (manual
  // commits): puts back the files that still hold what the action left.
  app.post<{ Params: { id: string }; Body: { branch?: string; token?: string } }>('/api/projects/:id/undo', async (req, reply) => {
    const branch = typeof req.body?.branch === 'string' && req.body.branch ? req.body.branch : 'main';
    if (!BRANCH_RE.test(branch) || branch.includes('..')) return reply.code(400).send({ error: 'invalid branch name' });
    const r = await restoreImage(req.params.id, branch, String(req.body?.token ?? ''));
    if ('gone' in r) {
      return reply.code(410).send({
        error: r.gone === 'committed' ? 'This can no longer be undone: a commit landed since'
          : r.gone === 'expired' ? 'This can no longer be undone: it was more than a day ago'
            : 'This can no longer be undone',
      });
    }
    if (r.restored.length) noteEdit(req.params.id, branch, editorOf(reqUser(req)));
    return { ok: true, ...r };
  });

  app.get<{ Params: { id: string }; Querystring: Q & { skip?: string; limit?: string } }>('/api/projects/:id/log', async (req) => {
    const int = (v: string | undefined, fallback: number, max: number) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : fallback;
    };
    return gitops.log(req.params.id, req.query.branch || 'main', Math.max(1, int(req.query.limit, 50, 250)), { skip: int(req.query.skip, 0, 1_000_000), details: true });
  });

  // What the next commit would take. Flushes open docs first, or a change
  // typed in the last second would be missing from the list.
  app.get<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/changes', async (req, reply) => {
    const branch = req.query.branch || 'main';
    if (!BRANCH_RE.test(branch)) return reply.code(400).send({ error: 'invalid branch name' });
    flushBranchDocs(req.params.id, branch);
    try { return { paths: await gitops.uncommittedPaths(req.params.id, branch) }; }
    catch { return reply.code(404).send({ error: 'Project or branch not found' }); }
  });

  app.get<{ Params: { id: string; hash: string } }>('/api/projects/:id/commit/:hash/diff', async (req, reply) => {
    try { return await gitops.commitDiff(req.params.id, req.params.hash); }
    catch (err: any) { return reply.code(400).send({ error: err.message }); }
  });

  /** `all=1`: every Claude commit the scan reaches, whatever the mark says —
   *  it can only show more than the prompt would, never less. */
  type AgentActivityQ = { branch?: string; sinceHead?: string; sinceAt?: string; all?: string };

  // What Claude changed on this branch since the caller last acknowledged it.
  // Read-only: no flush, no commit, no repo lock (see gitops.agentActivitySince).
  app.get<{ Params: { id: string }; Querystring: AgentActivityQ }>('/api/projects/:id/agent-activity', async (req, reply) => {
    const branch = req.query.branch || 'main';
    if (!BRANCH_RE.test(branch) || branch.includes('..')) return reply.code(400).send({ error: 'bad branch name' });
    const user = reqUser(req);
    // With accounts the mark is the server's, per user: honouring a
    // client-supplied one would let anything holding a session — or the
    // agent's own token — hide the audit prompt.
    let mark: { head: string; at: string } | null = null;
    if (req.query.all === '1') {
      mark = null;
    } else if (auth.AUTH_ENABLED && user) {
      const row = await store.getProjectVisit(user.id, req.params.id, branch);
      mark = row ? { head: row.head, at: row.at } : null;
      // Someone else's project opened for the first time (an invitation, a
      // link) starts its review here: what Claude did before they came is
      // not theirs to review, nor to revert. The owner's first open keeps the
      // whole branch, so a project Claude made is reviewed when it is first
      // opened. A token never sets a person's mark (see /seen below).
      if (!row && !(req as any)._tokenScope && !isOwner(await store.readMeta(req.params.id), user)) {
        const head = await gitops.branchHead(req.params.id, branch);
        if (head) {
          mark = { head, at: new Date().toISOString() };
          await store.setProjectVisit({ userId: user.id, projectId: req.params.id, branch, head, at: mark.at, promptedHead: null });
        }
      }
    } else {
      const h = req.query.sinceHead;
      const a = req.query.sinceAt;
      if (typeof h === 'string' && /^[0-9a-f]{4,40}$/.test(h) && typeof a === 'string' && !Number.isNaN(Date.parse(a))) mark = { head: h, at: a };
    }
    // sessionActive rides along so a page that just (re)loaded can tell a
    // session still running — the live prompt's to report when it ends — from
    // one that ended while nobody watched, before any awareness has reached it.
    try { return { ...(await gitops.agentActivitySince(req.params.id, branch, mark)), sessionActive: agentSessionActive(req.params.id, branch) }; }
    catch (err: any) { return reply.code(400).send({ error: err.message }); }
  });

  // Records the visit. Session-cookie only (not in TOKEN_PROJECT_WRITES): an
  // agent's own token must never be able to clear the human's review prompt
  // (plan SECURITY.md §1).
  app.post<{ Params: { id: string }; Body: { branch?: string; head?: string; kind?: 'prompted' | 'acknowledged' } }>(
    '/api/projects/:id/agent-activity/seen', async (req, reply) => {
      const branch = req.body?.branch || 'main';
      if (!BRANCH_RE.test(branch) || branch.includes('..')) return reply.code(400).send({ error: 'bad branch name' });
      const head = String(req.body?.head || '');
      if (!/^[0-9a-f]{4,40}$/.test(head)) return reply.code(400).send({ error: 'head required' });
      const user = reqUser(req);
      // Without accounts there is no user to key a mark on; the browser keeps
      // its own (apps/web/src/util/agentSeen.ts) and `stored` says so.
      if (!auth.AUTH_ENABLED || !user) return { ok: true, stored: false };
      if (!(await visitLimiter.take(clientKey(req, user.id)))) return reply.code(429).send({ error: 'Rate limit reached — please slow down' });
      // A row is only ever keyed on a branch that exists: a made-up branch
      // name must not grow the visit table.
      if (!(await gitops.branchHead(req.params.id, branch))) return reply.code(404).send({ error: 'branch not found' });
      const kind = req.body?.kind === 'acknowledged' ? 'acknowledged' : 'prompted';
      const prev = await store.getProjectVisit(user.id, req.params.id, branch);
      // A second sighting of the identical batch acknowledges it: an ignored
      // prompt is raised twice and then never again.
      const acknowledge = kind === 'acknowledged' || prev?.promptedHead === head;
      await store.setProjectVisit({
        userId: user.id,
        projectId: req.params.id,
        branch,
        head: acknowledge ? head : (prev?.head ?? ''),
        // A first sighting records no time: a fresh mark stamped "now" would
        // bound the next answer to commits newer than the prompt, hiding the
        // very batch it was raised for.
        at: acknowledge ? new Date().toISOString() : (prev?.at ?? ''),
        promptedHead: head,
      });
      return { ok: true, stored: true, acknowledged: acknowledge };
    });

  // `keepConflicts`: a conflicted merge commits with both versions marked in
  // each file instead of stopping — only into a branch other than main, where
  // the person settles them before merging back. `checkpoint` titles the
  // commit of edits still waiting on either branch (manual commits).
  app.post<{ Params: { id: string }; Body: { from: string; into: string; author?: string; keepConflicts?: boolean; checkpoint?: string } }>(
    '/api/projects/:id/merge', async (req, reply) => {
      const { from, into, author: claimed, keepConflicts, checkpoint } = req.body || {};
      const author = commitAuthor(req, claimed);
      if (!from || !into) return reply.code(400).send({ error: 'from/into required' });
      if ([from, into].some((b) => typeof b !== 'string' || !BRANCH_RE.test(b) || b.includes('..'))) {
        return reply.code(400).send({ error: 'Invalid branch name' });
      }
      if (keepConflicts === true && into === 'main') return reply.code(400).send({ error: 'Conflicts can only be kept on a branch other than main' });
      flushBranchDocs(req.params.id, from);
      flushBranchDocs(req.params.id, into);
      const { changed, ...result } = await gitops.merge(req.params.id, from, into, author, {
        keepConflicts: keepConflicts === true,
        checkpoint: cleanCommitMessage(String(checkpoint ?? ''), 'aldine: checkpoint before merge'),
      });
      if (result.ok) {
        refreshBranchDocsFromDisk(req.params.id, into);
        if (changed) noteEdit(req.params.id, into, editorOf(reqUser(req)));
      }
      return result;
    });

  // ---------- zotero ----------
  // The key is the account's (zotero.savedKey): pasted once, used for every
  // project it links, and never sent back. With accounts on, only a
  // signed-in person has one; without, the one implicit user does.
  const zoteroAccount = (req: any, reply: any): string | null => {
    if (auth.AUTH_ENABLED && !reqUser(req)) { reply.code(401).send({ error: 'Sign in required' }); return null; }
    return reqUser(req)?.id || 'local';
  };
  const NO_ZOTERO_KEY = 'Paste a Zotero API key first';
  /** A key pasted with the request, else the account's saved key, else — for
   *  the project's owner — the key its link holds. */
  const zoteroKey = async (req: any, account: string, apiKey: unknown, projectId: unknown): Promise<string | null> => {
    if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();
    const saved = await zotero.savedKey(account);
    if (saved) return saved.apiKey;
    if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) return null;
    const meta = await store.readMeta(projectId).catch(() => null);
    return meta?.zotero && !meta.deletedAt && isOwner(meta, reqUser(req)) ? meta.zotero.apiKey : null;
  };

  app.get('/api/zotero/key', async (req, reply) => {
    const account = zoteroAccount(req, reply);
    if (!account) return;
    const saved = await zotero.savedKey(account);
    return saved ? { saved: true, userID: saved.userID, username: saved.username ?? null } : { saved: false };
  });
  app.put<{ Body: { apiKey?: unknown } }>('/api/zotero/key', async (req, reply) => {
    const account = zoteroAccount(req, reply);
    if (!account) return;
    const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
    if (!apiKey || apiKey.length > 200) return reply.code(400).send({ error: NO_ZOTERO_KEY });
    try {
      const info = await zotero.validateKey(apiKey);
      await zotero.saveKey(account, { apiKey, userID: info.userID, username: info.username });
      const groups = await zotero.listGroups(apiKey, info.userID);
      return { saved: true, userID: info.userID, username: info.username ?? null, groups };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });
  app.delete('/api/zotero/key', async (req, reply) => {
    const account = zoteroAccount(req, reply);
    if (!account) return;
    await zotero.forgetKey(account);
    return { ok: true };
  });

  app.post<{ Body: { apiKey?: string; projectId?: string } }>('/api/zotero/validate', async (req, reply) => {
    const account = zoteroAccount(req, reply);
    if (!account) return;
    const apiKey = await zoteroKey(req, account, req.body?.apiKey, req.body?.projectId);
    if (!apiKey) return reply.code(400).send({ error: NO_ZOTERO_KEY });
    try {
      const info = await zotero.validateKey(apiKey);
      const groups = await zotero.listGroups(apiKey, info.userID);
      return { ...info, groups };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // `path`: the collection under the ones it sits in ("CRDT Research / Sync").
  app.post<{ Body: { apiKey?: string; libraryPrefix: string; projectId?: string } }>('/api/zotero/collections', async (req, reply) => {
    const account = zoteroAccount(req, reply);
    if (!account) return;
    const { libraryPrefix } = req.body || {};
    if (!libraryPrefix) return reply.code(400).send({ error: 'libraryPrefix required' });
    const apiKey = await zoteroKey(req, account, req.body?.apiKey, req.body?.projectId);
    if (!apiKey) return reply.code(400).send({ error: NO_ZOTERO_KEY });
    try {
      const list = await zotero.listCollections(apiKey, libraryPrefix);
      return list.map((c) => ({ ...c, path: zotero.collectionPath(list, c.key) ?? c.name }));
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Without `apiKey`, the link runs on the owner's saved key, or on the key
  // the link already holds (a change of library or collection).
  app.post<{ Params: { id: string }; Body: { apiKey?: string; libraryPrefix: string; collectionKey?: string; bibFile?: string; branch?: string } }>(
    '/api/projects/:id/zotero/link', async (req, reply) => {
      const { libraryPrefix, collectionKey, branch = 'main' } = req.body || {};
      const owned = await requireOwner(req, reply, 'link a Zotero library');
      if (!owned) return;
      if (!libraryPrefix) return reply.code(400).send({ error: 'libraryPrefix required' });
      const apiKey = await zoteroKey(req, reqUser(req)?.id || 'local', req.body?.apiKey, req.params.id);
      if (!apiKey) return reply.code(400).send({ error: NO_ZOTERO_KEY });
      try {
        const info = await zotero.validateKey(apiKey);
        const meta = await store.readMeta(req.params.id);
        // default next to the root file — \addbibresource{zotero.bib} resolves
        // relative to its dir, so a project-root default would write a file the
        // document never reads when the root lives in a subdirectory
        const bibFile = req.body?.bibFile || meta.zotero?.bibFile || rootSiblingPath(meta.rootFile, 'zotero.bib');
        if (isHiddenPath(bibFile)) return reply.code(403).send({ error: 'forbidden path' });
        const names = await zotero.linkNames(apiKey, info.userID, libraryPrefix, collectionKey);
        const link = { apiKey, userId: info.userID, username: info.username, libraryPrefix, collectionKey, ...names, bibFile };
        // sync into the branch the user linked from (the plugin refreshes that branch), not always main
        const sync = await zotero.syncProject(req.params.id, branch, true, link);
        if (sync.synced) noteEdit(req.params.id, branch, editorOf(reqUser(req)));
        return { ok: true, ...sync };
      } catch (err: any) {
        if (err instanceof zotero.ZoteroAccessError) req.log.warn({ status: err.status, libraryPrefix }, 'Zotero refused the export');
        return reply.code(400).send({ error: err.message });
      }
    });

  // `olderThan` (seconds): sync only when the last one is older, or its
  // export no longer fits the paper (`fresh` when it skipped).
  app.post<{ Params: { id: string }; Body: { branch?: string; force?: boolean; olderThan?: unknown } }>(
    '/api/projects/:id/zotero/sync', async (req, reply) => {
      const meta = await requireMember(req, reply, 'sync this Zotero library');
      if (!meta) return;
      if (await ownerDisabled(meta)) return reply.code(403).send({ error: ZOTERO_OWNER_DISABLED });
      const branch = req.body?.branch || 'main';
      const olderThan = typeof req.body?.olderThan === 'number' && req.body.olderThan > 0 ? req.body.olderThan : undefined;
      try {
        const sync = await zotero.syncProject(req.params.id, branch, !!req.body?.force, undefined, olderThan);
        if (sync.synced) noteEdit(req.params.id, branch, editorOf(reqUser(req)));
        return sync;
      } catch (err: any) {
        if (err instanceof zotero.ZoteroAccessError) {
          req.log.warn({ status: err.status, libraryPrefix: meta.zotero?.libraryPrefix }, 'Zotero refused the export');
          return reply.code(400).send({ error: 'This Zotero key can\'t read the linked library any more. In Zotero, give the key read access to it, then sync again.' });
        }
        return reply.code(400).send({ error: err.message });
      }
    });

  // Whether the paper reads the linked .bib (bibload.ts): without the line,
  // every citation from it is undefined. POST adds the line where one edit
  // clearly does; it is an edit to the paper like any other, so anyone who
  // may edit the paper may make it.
  const bibLoadTarget = async (req: any, reply: any, branch: string) => {
    if (!BRANCH_RE.test(branch)) { reply.code(400).send({ error: 'invalid branch name' }); return null; }
    let meta: store.ProjectMeta;
    try { meta = await store.readMeta(req.params.id); } catch { reply.code(404).send({ error: 'project not found' }); return null; }
    if (!meta.zotero) { reply.code(400).send({ error: 'no Zotero link' }); return null; }
    try { await gitops.ensureWorktree(req.params.id, branch); } catch { reply.code(404).send({ error: 'Branch not found' }); return null; }
    return { rootFile: meta.rootFile, bibFile: meta.zotero.bibFile, syncedFormat: meta.zotero.format ?? 'biblatex' };
  };
  // `format`: the export the paper reads (BibTeX or biblatex fields);
  // `syncedFormat`: the one the .bib holds. They differ until the next sync.
  app.get<{ Params: { id: string }; Querystring: { branch?: string } }>('/api/projects/:id/zotero/bib-load', async (req, reply) => {
    const branch = req.query.branch || 'main';
    const t = await bibLoadTarget(req, reply, branch);
    if (!t) return;
    return { ...bibLoadState(req.params.id, branch, t.rootFile, t.bibFile), format: paperBibFormat(req.params.id, branch), syncedFormat: t.syncedFormat };
  });
  app.post<{ Params: { id: string }; Body: { branch?: string } }>('/api/projects/:id/zotero/bib-load', async (req, reply) => {
    const branch = req.body?.branch || 'main';
    const t = await bibLoadTarget(req, reply, branch);
    if (!t) return;
    const { added, state } = addBibLoad(req.params.id, branch, t.rootFile, t.bibFile);
    if (added) noteEdit(req.params.id, branch, editorOf(reqUser(req)));
    return { ok: true, added, ...state };
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id/zotero', async (req, reply) => {
    const meta = await requireOwner(req, reply, 'unlink the Zotero library');
    if (!meta) return;
    delete meta.zotero;
    await store.writeMeta(meta);
    return { ok: true };
  });

  // Searches run on the OWNER's stored API key and reach their whole personal
  // library, so this is members-only — a link visitor may edit the paper, not
  // read the owner's Zotero account.
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>('/api/projects/:id/zotero/search', async (req, reply) => {
    const meta = await requireMember(req, reply, 'search this Zotero library');
    if (!meta) return;
    if (!meta.zotero) return reply.code(400).send({ error: 'no Zotero link' });
    if (await ownerDisabled(meta)) return reply.code(403).send({ error: ZOTERO_OWNER_DISABLED });
    try {
      return await zotero.searchItems(meta.zotero.apiKey, meta.zotero.libraryPrefix, req.query.q || '');
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ---------- reference lookup (DOI / arXiv → BibTeX) ----------
  // Implementation in references.ts (addReference), shared with the MCP tool.
  app.post<{ Params: { id: string }; Body: { query: string; branch?: string; bibFile?: string } }>(
    '/api/projects/:id/references/add', async (req, reply) => {
      const { query, branch = 'main' } = req.body || {};
      if (!query) return reply.code(400).send({ error: 'query required' });
      if (!(await refLimiter.take(clientKey(req, reqUser(req)?.id)))) return reply.code(429).send({ error: 'Rate limit reached — please slow down' });
      try {
        // Without a file named: a .bib the paper reads (not the Zotero one,
        // which every sync rewrites), else references.bib beside the root
        // file; `loaded` says whether the paper reads it.
        const meta = await store.readMeta(req.params.id);
        const fallback = rootSiblingPath(meta.rootFile, 'references.bib');
        let bibFile = req.body?.bibFile;
        let chosen: ReturnType<typeof referenceTarget> | null = null;
        if (!bibFile) {
          if (!BRANCH_RE.test(branch)) return reply.code(400).send({ error: 'invalid branch name' });
          await gitops.ensureWorktree(req.params.id, branch);
          chosen = referenceTarget(req.params.id, branch, meta.rootFile, meta.zotero?.bibFile ?? null, fallback, (p) => !isHiddenPath(p));
          bibFile = chosen.bibFile;
        }
        if (isHiddenPath(bibFile)) return reply.code(403).send({ error: 'forbidden path' });
        const added = await addReference(req.params.id, branch, query, bibFile, undefined, undefined, chosen?.others ?? []);
        if (!added) return reply.code(404).send({ error: 'No reference found for that DOI/arXiv id' });
        if (!added.duplicate) noteEdit(req.params.id, branch, editorOf(reqUser(req)));
        if (!chosen) return { ok: true, ...added };
        const loaded = chosen.loaded || added.bibFile !== bibFile;
        const entry = path.posix.relative(path.posix.dirname(meta.rootFile || 'main.tex'), added.bibFile);
        const loadLine = chosen.format === 'bibtex' ? `\\bibliography{${entry.replace(/\.bib$/i, '')}}` : `\\addbibresource{${entry}}`;
        return { ok: true, ...added, loaded, rootFile: meta.rootFile, ...(loaded ? {} : { loadLine }) };
      } catch (err: any) {
        return reply.code(502).send({ error: err.message });
      }
    });

  // ---------- reference search (OpenAlex) ----------
  app.get<{ Querystring: { q?: string } }>('/api/references/search', async (req, reply) => {
    const q = (req.query.q || '').trim();
    if (q.length < 3) return [];
    if (!(await refLimiter.take(clientKey(req, reqUser(req)?.id)))) return reply.code(429).send({ error: 'Search rate limit reached — please slow down' });
    try {
      return await searchWorks(q);
    } catch (err: any) {
      return reply.code(502).send({ error: err.message });
    }
  });

  // ---------- review comments ----------
  /** Someone who can only view has a read-only socket, so their client's bump
   *  of the comments signal never reaches the others: the server bumps it. */
  const signalViewerComment = async (req: any, branch: string) => {
    if (!canEdit(await store.readMeta(req.params.id), reqUser(req))) bumpCommentsSignal(req.params.id, branch);
  };
  app.get<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/comments', async (req) =>
    comments.listComments(req.params.id, req.query.branch || 'main'));  // returns a Promise; Fastify awaits it

  app.post<{ Params: { id: string }; Body: { branch?: string; file: string; anchor: { from: number; to: number; quote: string }; body: string; suggestion?: string; author?: string } }>(
    '/api/projects/:id/comments', async (req, reply) => {
      const b = req.body || ({} as any);
      if (!b.file || !b.anchor) return reply.code(400).send({ error: 'file and anchor required' });
      const branch = b.branch || 'main';
      // the anchor must point at a real span in a real file; accepting a
      // suggestion writes that file
      if (!namesEntry(b.file)) return reply.code(400).send({ error: NOT_AN_ENTRY });
      if (isHiddenPath(b.file)) return reply.code(403).send({ error: 'forbidden path' });
      if (!store.fileExists(req.params.id, branch, b.file)) return reply.code(404).send({ error: 'File not found' });
      const { from, to } = b.anchor;
      if (typeof from !== 'number' || typeof to !== 'number' || from < 0 || to <= from) {
        return reply.code(400).send({ error: 'Invalid comment anchor' });
      }
      if (typeof b.body === 'string' && b.body.length > comments.MAX_COMMENT_TEXT) return reply.code(400).send({ error: `Comment is too long (max ${comments.MAX_COMMENT_TEXT.toLocaleString('en-US')} characters)` });
      if (typeof b.suggestion === 'string' && b.suggestion.length > comments.MAX_COMMENT_TEXT) return reply.code(400).send({ error: `Suggestion is too long (max ${comments.MAX_COMMENT_TEXT.toLocaleString('en-US')} characters)` });
      const added = await comments.addComment(req.params.id, {
        branch,
        file: b.file,
        anchor: b.anchor,
        author: reqUser(req)?.name || b.author || 'Anonymous',
        ...(reqUser(req) ? { authorId: reqUser(req)!.id } : {}),
        body: b.body || '',
        suggestion: b.suggestion,
      });
      await signalViewerComment(req, branch);
      return added;
    });

  app.post<{ Params: { id: string; cid: string }; Body: { body: string; author?: string } }>(
    '/api/projects/:id/comments/:cid/reply', async (req, reply) => {
      if (typeof req.body?.body === 'string' && req.body.body.length > comments.MAX_COMMENT_TEXT) return reply.code(400).send({ error: `Reply is too long (max ${comments.MAX_COMMENT_TEXT.toLocaleString('en-US')} characters)` });
      const c = await comments.replyComment(req.params.id, req.params.cid, reqUser(req)?.name || req.body?.author || 'Anonymous', req.body?.body || '', reqUser(req)?.id);
      if (c) await signalViewerComment(req, c.branch);
      return c || reply.code(404).send({ error: 'comment not found' });
    });

  app.post<{ Params: { id: string; cid: string }; Body: { resolved?: boolean } }>(
    '/api/projects/:id/comments/:cid/resolve', async (req, reply) => {
      const c = await comments.resolveComment(req.params.id, req.params.cid, req.body?.resolved !== false);
      if (c) await signalViewerComment(req, c.branch);
      return c || reply.code(404).send({ error: 'comment not found' });
    });

  // Accept a suggestion server-side. The client used to read the disk copy,
  // string-replace, and write it back — which rebuilt the live doc from a
  // stale snapshot and destroyed every collaborator's unflushed edits, and
  // failed spuriously whenever the commented text hadn't autosaved yet.
  app.post<{ Params: { id: string; cid: string }; Body: { branch?: string } }>(
    '/api/projects/:id/comments/:cid/accept', async (req, reply) => {
      const branch = req.body?.branch || 'main';
      const all = await comments.listComments(req.params.id, branch);
      const c = all.find((x) => x.id === req.params.cid);
      if (!c) return reply.code(404).send({ error: 'comment not found' });
      if (c.suggestion === undefined) return reply.code(400).send({ error: 'This comment has no suggestion to apply' });
      if (!namesEntry(c.file) || isHiddenPath(c.file)) return reply.code(403).send({ error: 'forbidden path' });
      let outcome = applySuggestionToDoc(req.params.id, branch, c.file, c.anchor, c.suggestion);
      if (outcome === 'no-doc') {
        // nobody has the file open — the disk copy is authoritative, edit it directly
        let raw: string;
        try { raw = store.readFile(req.params.id, branch, c.file).toString('utf8'); } catch {
          return reply.code(404).send({ error: 'File not found' });
        }
        // the anchor counts in the editor's text, which holds LF only
        const { text: content, crlf } = docView(raw);
        const suggestion = c.suggestion.replace(/\r\n?/g, '\n');
        const at = locateQuote(content, c.anchor);
        const next = at ? content.slice(0, at.from) + suggestion + content.slice(at.to) : null;
        if (next === null) { outcome = 'stale'; } else {
          store.writeFile(req.params.id, branch, c.file, crlf ? withCrlf(next) : next);
          refreshBranchDocsFromDisk(req.params.id, branch, [c.file]);
          outcome = 'applied';
        }
      }
      if (outcome === 'stale') return reply.code(409).send({ error: 'The commented text has changed — apply the suggestion manually.' });
      markPathsChanged(req.params.id, branch, [c.file]);
      scheduleCommit(req.params.id, branch);
      noteEdit(req.params.id, branch, editorOf(reqUser(req)));
      await comments.resolveComment(req.params.id, req.params.cid, true);
      return { ok: true };
    });

  // Anyone in the document may comment and reply, but clearing someone else's
  // review thread is for the team's editors — a link visitor, and a person
  // who can only view, can only delete their own, by account id (a comment
  // without one is no visitor's).
  app.delete<{ Params: { id: string; cid: string }; Querystring: Q }>('/api/projects/:id/comments/:cid', async (req, reply) => {
    const meta = await store.readMeta(req.params.id);
    if (!isMember(meta, reqUser(req)) || !canEdit(meta, reqUser(req))) {
      const all = await comments.listComments(req.params.id, req.query.branch || 'main');
      const authorId = all.find((c) => c.id === req.params.cid)?.authorId;
      const mine = !!authorId && authorId === reqUser(req)?.id;
      if (!mine) return reply.code(403).send({ error: 'Only the owner and collaborators can delete this comment' });
    }
    await comments.deleteComment(req.params.id, req.params.cid);
    await signalViewerComment(req, req.query.branch || 'main');
    return { ok: true };
  });

  // ---------- remote providers (GitHub, GitLab, Gitea/Forgejo): per-user connection ----------
  // In no-auth (single-tenant) mode there's no user, so connections hang off a
  // fixed 'local' id. The provider comes from the URL for account-level routes
  // (`/api/remotes/:provider/*`) and from the stored link for project routes
  // (`/api/projects/:id/remote/*`): a request can never point a project at a
  // different host than the one it was linked to.
  //
  // Compatibility: `/api/github/*` and `/api/projects/:id/github/*` keep
  // answering as aliases with provider fixed to GitHub. Operators registered
  // `/api/github/oauth/callback` in their GitHub OAuth app, so that URL stays
  // the redirect target for GitHub; other providers use the generic path.
  const remoteUserId = (req: any) => reqUser(req)?.id || 'local';
  // When auth is on, connections are per signed-in user; without this the
  // anonymous fallback ('local') would let unauthenticated callers share one
  // connection bucket — one user's PAT readable by the next.
  const requireSignIn = (req: any, reply: any): boolean => {
    if (auth.AUTH_ENABLED && !reqUser(req)) { reply.code(401).send({ error: 'Sign in required' }); return true; }
    return false;
  };
  type Provider = remotes.RemoteProvider;
  type ProviderReq = FastifyRequest<{ Params: { provider?: string; id?: string }; Body?: any; Querystring?: any }>;
  /** Resolve `:provider`, or the fixed alias provider; replies 404 (and returns null) for unknown or disabled ids. */
  const providerOf = (req: ProviderReq, reply: any, fixed?: remotes.RemoteProviderId): Provider | null => {
    const p = remotes.getProvider(fixed ?? req.params.provider);
    if (!p) { reply.code(404).send({ error: 'Unknown remote provider' }); return null; }
    return p;
  };
  const oauthCallbackPath = (p: Provider) => p.id === 'github' ? '/api/github/oauth/callback' : `/api/remotes/${p.id}/oauth/callback`;
  /** A connect started in a project's editor returns there, and only there:
   *  anything but `/p/<id>` is dropped, so the state cookie can never carry
   *  another origin or path the callback would redirect to. */
  const oauthReturnPath = (raw: unknown): string | null => typeof raw === 'string' && /^\/p\/[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : null;
  /** The editor dialog the connect started from, reopened on the way back:
   *  one of these names or nothing, never text from the request. */
  const OAUTH_REOPEN = ['publish', 'access'];
  const oauthReopen = (raw: unknown): string | null => typeof raw === 'string' && OAUTH_REOPEN.includes(raw) ? raw : null;
  /** Upstream failures: an expired or revoked token gets a reason the UI can act on (reconnect), the rest is a 502. */
  const upstreamError = (reply: any, err: any, label: string) => {
    if (err instanceof remotes.RemoteApiError && err.status === 401) {
      return reply.code(401).send({ error: `${label} rejected the stored token. Reconnect to continue.`, reason: 'token-invalid' });
    }
    return reply.code(502).send({ error: err?.message || String(err) });
  };
  /** Register `handler` under the generic provider path and, for GitHub, the pre-GitLab alias. */
  const providerRoute = (method: 'get' | 'post', tail: string, handler: (p: Provider, req: any, reply: any) => Promise<unknown>) => {
    app[method](`/api/remotes/:provider/${tail}`, async (req: any, reply) => { const p = providerOf(req, reply); if (!p) return; return handler(p, req, reply); });
    app[method](`/api/github/${tail}`, async (req: any, reply) => { const p = providerOf(req, reply, 'github'); if (!p) return; return handler(p, req, reply); });
  };

  // `provisioning` tells the new-project dialog whether to ask for a group at
  // all, so an instance without a service token never requests namespaces.
  app.get('/api/remotes', async () => remotes.providers().map((p) => ({
    id: p.id, label: p.label, oauth: p.oauthEnabled(), selfHosted: p.selfHosted, baseUrlRequired: !!p.baseUrlRequired, changeRequestLabel: p.changeRequestLabel,
    provisioning: p.id === 'gitlab' && provisioningEnabled(),
  })));

  providerRoute('get', 'status', async (p, req, reply) => {
    if (requireSignIn(req, reply)) return;
    const conn = await remotes.getConnection(remoteUserId(req), p.id);
    return { connected: !!conn, login: conn?.login, baseUrl: conn?.baseUrl, instanceUrl: p.defaultInstanceUrl?.(), oauth: p.oauthEnabled(), selfHosted: p.selfHosted, baseUrlRequired: !!p.baseUrlRequired };
  });

  providerRoute('post', 'connect', async (p, req, reply) => {
    if (requireSignIn(req, reply)) return;
    const token = String(req.body?.token || '').trim();
    if (!token) return reply.code(400).send({ error: `A ${p.label} token is required` });
    let baseUrl: string | undefined;
    if (req.body?.baseUrl !== undefined && req.body?.baseUrl !== '') {
      if (!p.normalizeBaseUrl) return reply.code(400).send({ error: `${p.label} has no configurable URL` });
      try { baseUrl = p.normalizeBaseUrl(String(req.body.baseUrl)); }
      catch (err: any) { return reply.code(400).send({ error: err.message }); }
    }
    if (p.baseUrlRequired && !baseUrl) return reply.code(400).send({ error: `The ${p.label} instance URL is required${p.baseUrlExample ? `, ${p.baseUrlExample} for example` : ''}` });
    try {
      const me = await p.whoami({ token, login: '', baseUrl });
      await remotes.setConnection(remoteUserId(req), p.id, { token, login: me.login, name: me.name, ...(baseUrl ? { baseUrl } : {}) });
      return { connected: true, login: me.login, baseUrl };
    } catch {
      return reply.code(400).send({ error: `That token was rejected by ${p.label}. Check it has ${p.tokenScopeHint}${baseUrl ? ` and that ${baseUrl} is the right instance` : ''}.` });
    }
  });

  providerRoute('post', 'disconnect', async (p, req, reply) => {
    if (requireSignIn(req, reply)) return;
    await remotes.disconnect(remoteUserId(req), p.id);
    return { ok: true };
  });

  // What a Disconnect stops: the projects this account linked. They sync
  // through its token for everyone without a connection of their own, and
  // autopush through it alone. A project with its own token is unaffected.
  providerRoute('get', 'linked', async (p, req, reply) => {
    if (requireSignIn(req, reply)) return;
    const me = remoteUserId(req);
    const out: Array<{ id: string; name: string; autopush: boolean; createdAt: string }> = [];
    for (const meta of await store.listProjects()) {
      const link = store.remoteLink(meta);
      if (meta.deletedAt || link?.provider !== p.id || link.connectedBy !== me || !isMember(meta, reqUser(req))) continue;
      if (await remotes.getProjectConnection(meta.id, p.id)) continue;
      out.push({ id: meta.id, name: meta.name, autopush: meta.autopush === true, createdAt: meta.createdAt });
    }
    // Newest first: the warning names the first few.
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(({ createdAt: _c, ...row }) => row);
  });

  // Where Publish may create the repository: the account, then its
  // organisations or groups. A host that will not list them (a Gitea token
  // without read:organization) leaves the account alone.
  providerRoute('get', 'owners', async (p, req, reply) => {
    if (requireSignIn(req, reply)) return;
    const conn = await remotes.getConnection(remoteUserId(req), p.id);
    if (!conn) return reply.code(400).send({ error: `${p.label} is not connected` });
    try { return { owners: await p.listOwners(conn) }; }
    catch (err: any) {
      if (err instanceof remotes.RemoteApiError && err.status === 401) return upstreamError(reply, err, p.label);
      return { owners: [{ path: conn.login, kind: 'user' }] };
    }
  });

  // OAuth "Connect with <provider>" — links the signed-in user's account.
  providerRoute('get', 'oauth', async (p, req, reply) => {
    if (!p.oauthEnabled()) return reply.code(404).send({ error: `${p.label} OAuth is not configured` });
    if (auth.AUTH_ENABLED && !reqUser(req)) return reply.code(401).send({ error: 'Sign in required' });
    const state = crypto.randomBytes(12).toString('hex');
    const back = oauthReturnPath(req.query?.return);
    const reopen = back ? oauthReopen(req.query?.reopen) : null;
    reply.header('set-cookie', `aldine_remote_state=${p.id}.${state}${back ? `.${encodeURIComponent(back)}${reopen ? `.${reopen}` : ''}` : ''}; HttpOnly; SameSite=Lax; Path=${auth.COOKIE_PATH}; Max-Age=600${auth.SECURE_COOKIES ? '; Secure' : ''}`);
    return reply.redirect(p.connectUrl(state, `${publicBase(req)}${oauthCallbackPath(p)}`));
  });

  providerRoute('get', 'oauth/callback', async (p, req, reply) => {
    if (!p.oauthEnabled()) return reply.code(404).send({ error: `${p.label} OAuth is not configured` });
    const cookies = auth.parseCookies(req.headers.cookie);
    const q = req.query as { code?: string; state?: string };
    // A valid return path has no dot, so a cookie with more parts than these four is not ours.
    const [cookieProvider, cookieState, cookieBack = '', cookieReopen, ...extra] = (cookies.aldine_remote_state || '').split('.');
    if (!q.code || !q.state || cookieProvider !== p.id || cookieState !== q.state) {
      return reply.code(400).send({ error: 'OAuth state mismatch — please try again' });
    }
    const back = extra.length ? null : oauthReturnPath(cookieBack);
    const reopen = back ? oauthReopen(cookieReopen) : null;
    try {
      const token = await p.exchangeCode(q.code, `${publicBase(req)}${oauthCallbackPath(p)}`);
      const me = await p.whoami({ token, login: '' });
      await remotes.setConnection(remoteUserId(req), p.id, { token, login: me.login, name: me.name });
      reply.header('set-cookie', `aldine_remote_state=; Path=${auth.COOKIE_PATH}; Max-Age=0`);
      return reply.redirect(back ? `${config.basePath}${back}${reopen ? `?remote=${p.id}&reopen=${reopen}` : ''}` : `${config.basePath}/?remote=${p.id}`);
    } catch (err: any) {
      return reply.code(400).send({ error: `${p.label} connect failed: ${err.message}` });
    }
  });

  // Without `q`, the first page of the user's repositories. With it, the
  // host is asked: an exact path (or a pasted URL) is looked up directly,
  // whoever owns it, and the rest is a name search, so a repository outside
  // the first page can always be found without listing them all.
  providerRoute('get', 'repos', async (p, req, reply) => {
    if (requireSignIn(req, reply)) return;
    const conn = await remotes.getConnection(remoteUserId(req), p.id);
    if (!conn) return reply.code(400).send({ error: `${p.label} is not connected` });
    const q = repoQuery(req.query?.q);
    try {
      if (!q) return await p.listRepos(conn);
      const found = new Map<string, remotes.RemoteRepo>();
      if (q.includes('/')) {
        // Not found or no access is an ordinary miss here; the search may still match.
        const exact = await p.getRepo(conn, q).catch(() => null);
        if (exact) found.set(exact.fullName, exact);
      }
      const needle = q.toLowerCase();
      const more = p.searchRepos
        ? await p.searchRepos(conn, q.split('/').pop() || q)
        : (await p.listRepos(conn)).filter((r) => r.fullName.toLowerCase().includes(needle));
      for (const r of more) if (!found.has(r.fullName)) found.set(r.fullName, r);
      return [...found.values()];
    } catch (err: any) { return upstreamError(reply, err, p.label); }
  });

  /** The instance an import talks to, as its host name; the label when that is unknown. */
  const importHost = (p: Provider, conn: remotes.RemoteConnection) => {
    try { return new URL(p.instanceOrigin(conn)).host; } catch { return p.label; }
  };

  // Import a repository as a new project (the primary create-project flow).
  // With `token` in the body the repository is cloned with that token instead
  // of the account's connection, and the token stays with the new project
  // only: a repository of another account, or a token scoped to one repository.
  providerRoute('post', 'import', async (p, req, reply) => {
    if (auth.AUTH_ENABLED && !reqUser(req)) return reply.code(401).send({ error: 'Sign in required' });
    const ownToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    let conn: remotes.RemoteConnection | null;
    if (ownToken) {
      let baseUrl: string | undefined;
      if (req.body?.baseUrl) {
        if (!p.normalizeBaseUrl) return reply.code(400).send({ error: `${p.label} has no configurable URL` });
        try { baseUrl = p.normalizeBaseUrl(String(req.body.baseUrl)); }
        catch (err: any) { return reply.code(400).send({ error: err.message }); }
      }
      if (p.baseUrlRequired && !baseUrl) return reply.code(400).send({ error: `The ${p.label} instance URL is required${p.baseUrlExample ? `, ${p.baseUrlExample} for example` : ''}` });
      conn = { token: ownToken, login: '', ...(baseUrl ? { baseUrl } : {}) };
      try { const me = await p.whoami(conn); conn.login = me.login; conn.name = me.name; }
      catch (err) {
        if (noAnswer(err)) return reply.code(502).send({ error: `Could not reach ${baseUrl ? importHost(p, conn) : p.label} just now. Try again in a moment.`, code: 'unreachable' });
        return reply.code(400).send({ error: `That token was rejected by ${p.label}. Check it has ${p.tokenScopeHint}${baseUrl ? ` and that ${baseUrl} is the right instance` : ''}.` });
      }
    } else {
      conn = await remotes.getConnection(remoteUserId(req), p.id);
      if (!conn) return reply.code(400).send({ error: `Connect ${p.label} first` });
    }
    const fullName = (ownToken ? repoQuery(req.body?.fullName) : String(req.body?.fullName || '').trim()).replace(/^\/+|\/+$/g, '');
    if (!fullName.includes('/') || fullName.includes('..')) return reply.code(400).send({ error: p.pathHint });
    let info: remotes.RemoteRepo;
    try { info = await p.getRepo(conn, fullName); }
    catch (err: any) {
      const known = explainRepoReadFailure(err, { label: p.label, host: conn.baseUrl ? importHost(p, conn) : undefined, fullName });
      if (known) return reply.code(known.status).send({ error: known.error, code: known.code, ...(known.code === 'token-invalid' ? { reason: 'token-invalid' } : {}) });
      return reply.code(400).send({ error: `Repository not found or no access: ${err.message}` });
    }
    try { remotes.checkCloneUrl(p, conn, info.cloneUrl); }
    catch (err: any) { return reply.code(502).send({ error: err.message }); }
    const id = newId();
    try {
      const { remoteBranch } = await gitops.cloneRepo(id, p.tokenUrl(info.cloneUrl, conn.token, conn.login));
      const rootFile = detectRoot(id, 'main');
      const meta: store.ProjectMeta = {
        id, name: info.name, rootFile, engine: 'pdf', createdAt: new Date().toISOString(),
        remote: { provider: p.id, fullName: info.fullName, owner: info.owner, repo: info.name, remoteBranch, cloneUrl: info.cloneUrl, ...(conn.baseUrl ? { baseUrl: conn.baseUrl } : {}), connectedBy: remoteUserId(req) },
      };
      const ownerId = reqUser(req)?.id;
      if (ownerId) { meta.ownerId = ownerId; meta.share = { mode: 'private', collaborators: [] }; }
      await store.writeMeta(meta);
      if (ownToken) await remotes.setProjectConnection(id, p.id, conn);
      noteEdit(meta.id, 'main', editorOf(reqUser(req)));
      return publicMeta(meta, reqUser(req));
    } catch (err: any) {
      fs.rmSync(store.repoDir(id), { recursive: true, force: true });
      const known = explainGitFailure(String(err?.message || err), { label: p.label, host: conn.baseUrl ? importHost(p, conn) : undefined, fullName: info.fullName, branch: info.defaultBranch, op: 'clone' });
      if (known) return reply.code(known.status).send({ error: known.error, code: known.code });
      return reply.code(400).send({ error: `Import failed: ${err.message}` });
    }
  });

  // ---------- per-project remote sync (provider from the stored link) ----------
  // Syncing pushes the project into the OWNER's repo and can pull remote state
  // over everyone's work, so every remote operation is members-only: link mode
  // grants editing, not control of where the project is mirrored.
  type Linked = { meta: store.ProjectMeta; link: store.RemoteLink; provider: Provider; conn: remotes.RemoteConnection; source: remotes.ConnectionSource; url: string; remoteBranch: string };
  const linkedRemote = async (req: any, reply: any, action = 'sync this project'): Promise<Linked | null> => {
    const meta = await requireMember(req, reply, action);
    if (!meta) return null;
    const link = store.remoteLink(meta);
    if (!link) { reply.code(400).send({ error: 'This project is not linked to a remote repository' }); return null; }
    const provider = remotes.getProvider(link.provider);
    if (!provider) { reply.code(400).send({ error: `This project is linked to ${link.provider}, which is disabled on this server` }); return null; }
    const resolved = await remotes.resolveConnectionSource(link, remoteUserId(req), { allowService: true, projectId: meta.id });
    if (!resolved) {
      // A connection to another instance of the same host does not count, so the instance is named.
      const at = provider.selfHosted ? remotes.linkInstance(link) : null;
      reply.code(400).send({ error: `Connect ${provider.label}${at ? ` on ${at}` : ''} to sync`, code: 'no-connection' });
      return null;
    }
    const { conn, source } = resolved;
    return { meta, link, provider, conn, source, url: provider.tokenUrl(link.cloneUrl, conn.token, conn.login), remoteBranch: link.remoteBranch };
  };
  /** Whose token a sync uses, in words the access dialog and its errors share. */
  const tokenOwnerPhrase = (l: Pick<Linked, 'source' | 'conn'>) => ({
    project: "this project's token",
    own: `your token${l.conn.login ? ` (${l.conn.login})` : ''}`,
    linker: `the token of ${l.conn.login || 'the account that linked this project'}`,
    service: "the server's service token",
  })[l.source];
  const syncFailed = async (reply: any, l: Linked, err: any, fallback: () => unknown) => {
    if (!(await remotes.tokenRefused(l.provider, l.conn, err))) return fallback();
    const fix = l.source === 'service' ? 'Ask your administrator to replace it.'
      : l.source === 'project' ? 'Replace it to keep syncing.'
      : l.source === 'linker' ? `Connect your own ${l.provider.label} account to keep syncing.`
      : 'Reconnect to keep syncing.';
    return reply.code(401).send({ error: `${l.provider.label} rejected ${tokenOwnerPhrase(l)}. ${fix}`, reason: 'token-invalid', code: 'token-invalid', source: l.source });
  };
  const gitContext = (l: Linked, op: 'push' | 'fetch', branch = l.remoteBranch) => {
    const at = l.provider.selfHosted ? remotes.linkInstance(l.link) : null;
    let host: string | undefined;
    try { host = at ? new URL(at).host : undefined; } catch { /* the label alone */ }
    return { label: l.provider.label, host, fullName: l.link.fullName, branch, op };
  };
  /** A failed git operation of a linked project: a refused token, else a
   *  known failure as a sentence with its code, else `fallback`. */
  const gitFailed = (reply: any, l: Linked, err: any, op: 'push' | 'fetch', fallback: () => unknown, branch?: string) =>
    syncFailed(reply, l, err, () => {
      const known = explainGitFailure(String(err?.message || err), gitContext(l, op, branch));
      return known ? reply.code(known.status).send({ error: known.error, code: known.code }) : fallback();
    });
  const projectRoute = (method: 'get' | 'post', tail: string, handler: (req: any, reply: any) => Promise<unknown>, legacyTail = tail) => {
    app[method](`/api/projects/:id/remote/${tail}`, handler);
    app[method](`/api/projects/:id/github/${legacyTail}`, handler);
  };
  /** What a reset to the remote saves main as first, by the server's date. */
  const keepName = () => {
    const d = new Date();
    return `my-version-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  /** Response shape of a link: `remote`, plus `github` for web bundles from before GitLab. */
  const linkBody = (link: store.RemoteLink) => ({ remote: link, ...(link.provider === 'github' ? { github: link } : {}) });

  // Publish a locally-created project to a fresh repository. This is the only
  // way an unlinked project gains an off-server copy, so the editor nudges
  // toward it. Creates the repo under the connected account (or the given
  // namespace), commits the current state, pushes main, and stores the link
  // (same shape as an import).
  projectRoute('post', 'link', async (req, reply) => {
    const meta = await store.readMeta(req.params.id);
    if (auth.AUTH_ENABLED && !isOwner(meta, reqUser(req))) return reply.code(403).send({ error: 'Only the owner can publish this project' });
    if (store.remoteLink(meta)) return reply.code(400).send({ error: 'This project is already linked to a remote repository' });
    if (!req.body?.provider && !req.url.includes('/github/') && meta.remotePending) {
      // Retry of a provisioning that failed at create time: same namespace, service token.
      const r = await provisionProject(meta, { userId: remoteUserId(req), namespace: meta.remotePending.namespace });
      if (!r.ok) return reply.code(502).send({ error: r.error, remotePending: meta.remotePending });
      return { ok: true, ...linkBody(r.link) };
    }
    const providerId = req.body?.provider ?? (req.url.includes('/github/') ? 'github' : undefined);
    const p = remotes.getProvider(providerId);
    if (!p) return reply.code(400).send({ error: 'Choose a remote provider' });
    const conn = await remotes.getConnection(remoteUserId(req), p.id);
    if (!conn) return reply.code(400).send({ error: `Connect ${p.label} first` });
    const name = String(req.body?.name || meta.name).trim()
      .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
    if (!name) return reply.code(400).send({ error: 'Repository name required' });
    const namespace = typeof req.body?.namespace === 'string' && req.body.namespace.trim() ? req.body.namespace.trim() : undefined;
    let info: remotes.RemoteRepo;
    try { info = await p.createRepo(conn, name, { private: req.body?.private !== false, namespace }); }
    catch (err: any) {
      const known = explainCreateRepoFailure(err, { label: p.label, owner: namespace ?? conn.login, name, scopeHint: p.tokenScopeHint });
      if (known) return reply.code(known.status).send({ error: known.error, code: known.code });
      return reply.code(400).send({ error: `Could not create the repository: ${err.message}` });
    }
    try { remotes.checkCloneUrl(p, conn, info.cloneUrl); }
    catch (err: any) { return reply.code(502).send({ error: err.message }); }
    flushBranchDocs(req.params.id, 'main');
    await gitops.autoCommit(req.params.id, 'main', `aldine: publish to ${p.label}`, reqUser(req)?.name).catch(() => {});
    const link: store.RemoteLink = { provider: p.id, fullName: info.fullName, owner: info.owner, repo: info.name, remoteBranch: 'main', cloneUrl: info.cloneUrl, ...(conn.baseUrl ? { baseUrl: conn.baseUrl } : {}), connectedBy: remoteUserId(req) };
    store.setRemoteLink(meta, link);
    await store.writeMeta(meta);
    try { await gitops.pushToRemote(req.params.id, 'main', p.tokenUrl(info.cloneUrl, conn.token, conn.login)); }
    catch (err: any) {
      // repo exists and the link is stored — the user can retry the push from the sync UI
      const why = explainGitFailure(String(err?.message || err), { label: p.label, fullName: info.fullName, branch: 'main', op: 'push' })?.error ?? `${err.message}.`;
      return reply.code(502).send({ error: `Repository created but the first push failed: ${why} Use Push to retry.`, code: 'linked-push-failed', ...linkBody(link) });
    }
    return { ok: true, ...linkBody(link) };
  });

  // `autopushPaused`: why the last server-side pushes failed, until one lands.
  projectRoute('get', 'status', async (req, reply) => {
    const l = await linkedRemote(req, reply); if (!l) return;
    const autopushPaused = l.meta.autopush === true ? l.meta.autopushFailure ?? null : null;
    try { return { linked: true, ...l.link, ...(await gitops.remoteStatus(req.params.id, l.remoteBranch, l.url)), autopushPaused }; }
    catch (err: any) { return gitFailed(reply, l, err, 'fetch', () => reply.code(502).send({ error: err.message })); }
  });

  projectRoute('post', 'push', async (req, reply) => {
    const l = await linkedRemote(req, reply); if (!l) return;
    flushBranchDocs(req.params.id, 'main'); // capture unsaved editor content before committing
    const message = cleanCommitMessage(req.body?.message, 'Update from Aldine');
    const commit = await gitops.autoCommit(req.params.id, 'main', message, reqUser(req)?.name).catch(() => ({ committed: false, hash: undefined as string | undefined }));
    // HEAD is the commit hash we just made (when we committed), else look it up.
    const head = commit.committed ? commit.hash ?? null : await gitops.headCommit(req.params.id).catch(() => null);
    // Auto-sync (client sends auto:true, fires ~every 20s) skips the full git-push
    // round-trip when nothing was committed and HEAD is unchanged since our last
    // successful push. A MANUAL push always pushes — so a user pushing to restore
    // content after a remote-side rollback isn't wrongly skipped. In-memory,
    // single-node (see docs/SCALING); defaults to pushing whenever unsure.
    if (req.body?.auto && !commit.committed && head && lastPushedHead.get(req.params.id) === head) {
      return { ok: true, skipped: true };
    }
    try {
      await gitops.pushToRemote(req.params.id, l.remoteBranch, l.url);
      if (head) lastPushedHead.set(req.params.id, head);
      return { ok: true };
    } catch (err: any) { return gitFailed(reply, l, err, 'push', () => reply.code(400).send({ error: `Push failed: ${err.message}` })); }
  });

  projectRoute('post', 'pull', async (req, reply) => {
    const l = await linkedRemote(req, reply); if (!l) return;
    flushBranchDocs(req.params.id, 'main');
    await gitops.autoCommit(req.params.id, 'main', cleanCommitMessage(String(req.body?.checkpoint ?? ''), 'Local changes before pull'), reqUser(req)?.name).catch(() => {});
    try {
      const before = await gitops.branchHead(req.params.id, 'main');
      const result = await gitops.pullFromRemote(req.params.id, l.remoteBranch, l.url);
      // `keepAs`: the branch "Keep both" would save main as, for the dialog to name.
      if (!result.ok) return reply.code(409).send({ error: 'Merge conflict', conflicts: result.conflicts, keepAs: await gitops.freeBranchName(req.params.id, keepName()).catch(() => null) });
      refreshBranchDocsFromDisk(req.params.id, 'main'); // push the merged content into open editors
      if ((await gitops.branchHead(req.params.id, 'main')) !== before) noteEdit(req.params.id, 'main', editorOf(reqUser(req)));
      return { ok: true };
    } catch (err: any) { return gitFailed(reply, l, err, 'fetch', () => reply.code(400).send({ error: `Pull failed: ${err.message}` })); }
  });

  // Conflict escape hatch: main takes the remote version. Everyone's work the
  // host lacks is kept first, on a branch `kept` that only this server has
  // (my-version-<date>), but main changes for everyone: the owner's call alone.
  projectRoute('post', 'reset-to-remote', async (req, reply) => {
    if (!(await requireOwner(req, reply, 'discard local changes'))) return;
    const l = await linkedRemote(req, reply); if (!l) return;
    flushBranchDocs(req.params.id, 'main');
    await gitops.autoCommit(req.params.id, 'main', `Local changes before taking ${l.provider.label}'s version`, reqUser(req)?.name).catch(() => {});
    try {
      const { changed, kept } = await gitops.keepThenResetToRemote(req.params.id, l.remoteBranch, l.url, keepName());
      if (kept) markTreeChanged(req.params.id, kept);
      refreshBranchDocsFromDisk(req.params.id, 'main');
      if (changed) noteEdit(req.params.id, 'main', editorOf(reqUser(req)));
      return { ok: true, kept };
    } catch (err: any) { return gitFailed(reply, l, err, 'fetch', () => reply.code(400).send({ error: `Reset failed: ${err.message}` })); }
  });

  // ---------- remote branches + change requests ----------
  projectRoute('get', 'branches', async (req, reply) => {
    const l = await linkedRemote(req, reply); if (!l) return;
    try {
      const [branches, repo] = await Promise.all([
        l.provider.listBranches(l.conn, l.link.fullName),
        l.provider.getRepo(l.conn, l.link.fullName),
      ]);
      return { branches, current: l.remoteBranch, default: repo.defaultBranch };
    } catch (err: any) { return syncFailed(reply, l, err, () => upstreamError(reply, err, l.provider.label)); }
  });

  // Switch which remote branch this project tracks. Saves current work (commit +
  // push) first, then checks out the target branch.
  projectRoute('post', 'switch-branch', async (req, reply) => {
    // Persists the link's remoteBranch — repoints the project for everyone.
    if (!(await requireOwner(req, reply, 'change the tracked remote branch'))) return;
    const l = await linkedRemote(req, reply); if (!l) return;
    const target = String(req.body?.branch || '').trim();
    if (!target) return reply.code(400).send({ error: 'branch required' });
    if (target === l.remoteBranch) return { ok: true };
    flushBranchDocs(req.params.id, 'main');
    try {
      // The hard reset below drops uncommitted edits and every commit of main
      // the host lacks, so a save that does not land stops the switch, unless
      // main has nothing the host lacks.
      try { await gitops.autoCommit(req.params.id, 'main', cleanCommitMessage(String(req.body?.checkpoint ?? ''), 'Save before switching branch'), reqUser(req)?.name); }
      catch { return reply.code(409).send({ error: 'Could not save the latest edits before switching, so nothing changed. Try again in a moment.', code: 'save-failed' }); }
      try { await gitops.pushToRemote(req.params.id, l.remoteBranch, l.url); }
      catch (err: any) {
        gitops.forgetRemoteStatus(req.params.id);
        const s = await gitops.remoteStatus(req.params.id, l.remoteBranch, l.url).catch(() => null);
        if (!s || s.ahead > 0) {
          return syncFailed(reply, l, err, () => reply.code(409).send(s?.behind
            ? { error: `${l.provider.label} has newer commits on ${l.remoteBranch}. Pull first, then switch.`, code: 'pull-first' }
            : { error: `Could not push to ${l.provider.label} before switching, so nothing changed: ${explainGitFailure(String(err?.message || err), gitContext(l, 'push'))?.error ?? err.message}`, code: 'push-failed' }));
        }
      }
      const changed = await gitops.resetToRemote(req.params.id, target, l.url);
      store.setRemoteLink(l.meta, { ...l.link, remoteBranch: target }); await store.writeMeta(l.meta);
      refreshBranchDocsFromDisk(req.params.id, 'main');
      if (changed) noteEdit(req.params.id, 'main', editorOf(reqUser(req)));
      return { ok: true, branch: target };
    } catch (err: any) { return syncFailed(reply, l, err, () => reply.code(400).send({ error: `Switch failed: ${err.message}` })); }
  });

  // Create a new remote branch from the current content and switch to it.
  projectRoute('post', 'create-branch', async (req, reply) => {
    // Repoints the link's remoteBranch like switch-branch, so the same rule.
    if (!(await requireOwner(req, reply, 'start a branch on the git host'))) return;
    const l = await linkedRemote(req, reply); if (!l) return;
    const name = String(req.body?.name || '').trim();
    // Use the same BRANCH_RE gitops enforces on push/pull, so a name the UI
    // accepts can't later be rejected by git after a stray commit is written.
    if (!BRANCH_RE.test(name) || name.includes('..')) return reply.code(400).send({ error: 'Invalid branch name' });
    flushBranchDocs(req.params.id, 'main');
    try {
      await gitops.autoCommit(req.params.id, 'main', cleanCommitMessage(String(req.body?.checkpoint ?? ''), `Start branch ${name}`), reqUser(req)?.name).catch(() => {});
      await gitops.pushToRemote(req.params.id, name, l.url); // push creates the remote branch
      store.setRemoteLink(l.meta, { ...l.link, remoteBranch: name }); await store.writeMeta(l.meta);
      return { ok: true, branch: name };
    } catch (err: any) { return gitFailed(reply, l, err, 'push', () => reply.code(400).send({ error: `Create branch failed: ${err.message}` }), name); }
  });

  // Open a pull/merge request from the current branch into the repo's default branch.
  // A request already open for the branch is answered with its link (409
  // `change-request-open`, `url`, `number`), not as an error of the host.
  projectRoute('post', 'change-request', async (req, reply) => {
    const l = await linkedRemote(req, reply); if (!l) return;
    const noun = l.provider.changeRequestLabel;
    let base = '';
    try {
      flushBranchDocs(req.params.id, 'main'); // capture unsaved editor content before committing (parity with push/pull/switch/create)
      await gitops.autoCommit(req.params.id, 'main', cleanCommitMessage(String(req.body?.checkpoint ?? ''), `Update before ${noun}`), reqUser(req)?.name).catch(() => {});
      await gitops.pushToRemote(req.params.id, l.remoteBranch, l.url);
      const repo = await l.provider.getRepo(l.conn, l.link.fullName);
      base = repo.defaultBranch;
      if (l.remoteBranch === repo.defaultBranch) return reply.code(400).send({ error: `You're on the default branch (${repo.defaultBranch}). Create a branch first.` });
      return await l.provider.createChangeRequest(l.conn, l.link.fullName, {
        title: String(req.body?.title || '').trim() || `Update ${l.remoteBranch}`,
        head: l.remoteBranch,
        base: repo.defaultBranch,
      });
    } catch (err: any) {
      const known = base ? explainChangeRequestFailure(err, { label: l.provider.label, noun, head: l.remoteBranch, base }) : null;
      if (known?.code === 'change-request-open') {
        const open = await l.provider.findChangeRequest(l.conn, l.link.fullName, { head: l.remoteBranch, base }).catch(() => null);
        return reply.code(known.status).send(open
          ? { error: `A ${noun} from ${l.remoteBranch} into ${base} is already open: #${open.number}.`, code: known.code, url: open.url, number: open.number }
          : { error: known.error, code: known.code });
      }
      if (known) return reply.code(known.status).send({ error: known.error, code: known.code });
      return syncFailed(reply, l, err, () => {
        if (err instanceof remotes.RemoteApiError) return upstreamError(reply, err, l.provider.label);
        const pushed = explainGitFailure(String(err?.message || err), gitContext(l, 'push'));
        return pushed ? reply.code(pushed.status).send({ error: pushed.error, code: pushed.code }) : reply.code(400).send({ error: `Could not open the ${noun}: ${err.message}` });
      });
    }
  }, 'pr');

  // Server-side autopush is the owner's call: it decides what leaves the server and when.
  projectRoute('post', 'autopush', async (req, reply) => {
    if (!(await requireOwner(req, reply, 'change autopush'))) return;
    const meta = await store.readMeta(req.params.id);
    if (!store.remoteLink(meta)) return reply.code(400).send({ error: 'This project is not linked to a remote repository' });
    if (typeof req.body?.enabled !== 'boolean') return reply.code(400).send({ error: 'enabled must be true or false' });
    meta.autopush = req.body.enabled;
    delete meta.autopushFailure;
    await store.writeMeta(meta);
    if (meta.autopush) scheduleAutopush(req.params.id); else cancelAutopush(req.params.id);
    return { ok: true, autopush: meta.autopush };
  });

  // ---------- the token a linked project syncs with ----------
  // The owner may store a token on the project itself: one scoped to this
  // repository, or one of an account other than their own. The ladder tries it
  // before anyone's account connection. Members learn whose token syncs, never
  // the token.
  app.get<{ Params: { id: string } }>('/api/projects/:id/remote/access', async (req, reply) => {
    const meta = await requireMember(req, reply, 'see how this project syncs'); if (!meta) return;
    const link = store.remoteLink(meta);
    if (!link) return reply.code(400).send({ error: 'This project is not linked to a remote repository' });
    const resolved = await remotes.resolveConnectionSource(link, remoteUserId(req), { allowService: true, projectId: meta.id });
    const project = await remotes.getProjectConnection(meta.id, link.provider);
    return {
      provider: link.provider,
      source: resolved?.source ?? null,
      login: resolved?.conn.login ?? null,
      projectToken: project ? { login: project.login } : null,
    };
  });

  app.post<{ Params: { id: string }; Body: { token?: string } }>('/api/projects/:id/remote/access/token', async (req, reply) => {
    const meta = await requireOwner(req, reply, "change the token this project syncs with"); if (!meta) return;
    const link = store.remoteLink(meta);
    if (!link) return reply.code(400).send({ error: 'This project is not linked to a remote repository' });
    const p = remotes.getProvider(link.provider);
    if (!p) return reply.code(400).send({ error: `This project is linked to ${link.provider}, which is disabled on this server` });
    const token = String(req.body?.token || '').trim();
    if (!token) return reply.code(400).send({ error: `A ${p.label} token is required` });
    // The link's instance, so the token is checked where the repository lives.
    const conn: remotes.RemoteConnection = { token, login: '', ...(link.baseUrl ? { baseUrl: link.baseUrl } : {}) };
    try { const me = await p.whoami(conn); conn.login = me.login; conn.name = me.name; }
    catch { return reply.code(400).send({ error: `That token was rejected by ${p.label}. Check it has ${p.tokenScopeHint}.` }); }
    try { await p.getRepo(conn, link.fullName); }
    catch { return reply.code(400).send({ error: `That token belongs to ${conn.login}, who cannot see ${link.fullName}. Give it access to that repository.` }); }
    await remotes.setProjectConnection(meta.id, p.id, conn);
    return { ok: true, login: conn.login };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/remote/access/token/remove', async (req, reply) => {
    const meta = await requireOwner(req, reply, "change the token this project syncs with"); if (!meta) return;
    await remotes.clearProjectConnections(meta.id);
    return { ok: true };
  });

  // Account connections, for the account dialog's list of git hosts.
  app.get('/api/remotes/connections', async (req, reply) => {
    if (requireSignIn(req, reply)) return;
    const out = [];
    for (const p of remotes.providers()) {
      const conn = await remotes.getConnection(remoteUserId(req), p.id);
      if (conn) out.push({ provider: p.id, login: conn.login, ...(conn.baseUrl ? { baseUrl: conn.baseUrl } : {}) });
    }
    return out;
  });

  // ---------- GitLab group provisioning (GITLAB_TOKEN + GITLAB_DEFAULT_GROUP) ----------
  // Namespaces come from the service account and are limited to the root
  // group's subtree; nothing here lists what a user's own token could see.
  app.get('/api/remotes/gitlab/namespaces', async (req, reply) => {
    if (!provisioningEnabled()) return reply.code(404).send({ error: 'GitLab provisioning is not configured' });
    if (requireSignIn(req, reply)) return;
    try {
      const groups = await gitlab.listDescendantGroups(remotes.serviceConnection()!, rootGroup());
      return { root: rootGroup(), namespaces: groups.map((g) => ({ fullPath: g.fullPath, name: g.name })) };
    } catch (err: any) { return reply.code(502).send({ error: err.message }); }
  });

  app.post<{ Body: { parentPath?: string; name?: string } }>('/api/remotes/gitlab/subgroups', async (req, reply) => {
    if (!provisioningEnabled()) return reply.code(404).send({ error: 'GitLab provisioning is not configured' });
    if (requireSignIn(req, reply)) return;
    const parent = String(req.body?.parentPath || rootGroup()).trim().replace(/^\/+|\/+$/g, '');
    const name = String(req.body?.name || '').trim();
    if (!name) return reply.code(400).send({ error: 'Group name required' });
    if (!withinRoot(parent, rootGroup())) return reply.code(400).send({ error: `"${parent}" is outside the configured group "${rootGroup()}"` });
    try {
      const g = await gitlab.createSubgroup(remotes.serviceConnection()!, parent, name);
      return { fullPath: g.fullPath, name: g.name };
    } catch (err: any) { return reply.code(400).send({ error: `Could not create the group: ${err.message}` }); }
  });

  // ---------- AI error fix ----------
  app.get('/api/ai/status', async () => ({ configured: aiConfigured(), model: aiModel(), autoFix: aiAutoFix() }));

  app.post<{ Params: { id: string }; Body: { branch?: string; errors?: Array<{ type: string; line: number | null; message: string; file?: string }>; log?: string } }>(
    '/api/projects/:id/ai/fix', async (req, reply) => {
      if (!aiConfigured()) return reply.code(400).send({ error: 'AI is not configured. Set an ANTHROPIC_API_KEY or OPENROUTER_API_KEY on the server to enable it.' });
      if (!(await aiLimiter.take(clientKey(req, reqUser(req)?.id)))) return reply.code(429).send({ error: 'AI rate limit reached — please slow down' });
      const { branch = 'main', errors = [], log = '' } = req.body || {};
      const meta = await store.readMeta(req.params.id);
      flushBranchDocs(req.params.id, branch);
      const files: Array<{ path: string; content: string }> = [];
      for (const f of store.listFiles(req.params.id, branch)) {
        if (f.type === 'file' && f.path.endsWith('.tex')) {
          try { files.push({ path: f.path, content: store.readFile(req.params.id, branch, f.path).toString('utf8') }); } catch { /* skip */ }
        }
      }
      try {
        const result = await diagnose({ rootFile: meta.rootFile, files, errors, log });
        return { ok: true, ...result };
      } catch (err: any) {
        return reply.code(502).send({ error: `AI request failed: ${err.message}` });
      }
    });

  // ---------- plugins ----------
  // The AI fix runs on the server's key: without one its tab would only say
  // so to people who cannot set it.
  app.get('/api/plugins', async () => listPlugins().map((p) => (p.id === 'aifix' && !aiConfigured() ? { ...p, enabled: false } : p)));

  app.get<{ Params: { pluginId: string; '*': string } }>('/plugins/:pluginId/*', async (req, reply) => {
    const abs = pluginAssetPath(req.params.pluginId, req.params['*']);
    if (!abs) return reply.code(404).send({ error: 'not found' });
    const ext = path.extname(abs);
    const type = ext === '.js' || ext === '.mjs' ? 'text/javascript'
      : ext === '.css' ? 'text/css'
      : ext === '.json' ? 'application/json'
      : 'application/octet-stream';
    return reply.type(type).send(fs.readFileSync(abs));
  });
}
