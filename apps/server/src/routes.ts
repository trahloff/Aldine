import type { FastifyInstance, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as store from './store.js';
import * as gitops from './gitops.js';
import * as zotero from './zotero.js';
import { compileProject, synctexLookup, forgetPdfUrls, compilerInfo } from './compile.js';
import * as usage from './usage.js';
import * as remotes from './remotes.js';
import * as gitlab from './gitlab.js';
import { provisioningEnabled, provisionProject, deprovisionProject, rootGroup, withinRoot, type DeprovisionResult } from './provision.js';
import { scheduleAutopush, cancelAutopush } from './autopush.js';
import { flushBranchDocs, refreshBranchDocsFromDisk, evictDoc, scheduleCommit, closeProjectConnections, bumpContentVersion, contentVersion, applySuggestionToDoc, protectedProjects } from './collab.js';
import { publishProjectEvent } from './events.js';
import { parseBib, bibKeys, BibEntry } from './bib.js';
import { listPlugins, pluginAssetPath } from './plugins.js';
import { listAllTemplates, resolveTemplateSeed, type TemplateSeed } from './templates.js';
import { warmVenueCache } from './catalog.js';
import { fetchBibEntry, searchWorks } from './references.js';
import { latexWordCount, documentFiles } from './wordcount.js';
import { unzip, zipEntryCount, ZipError } from './unzip.js';
import { guessRoot, detectRoot } from './root.js';
import { config } from './config.js';
import { detectEngine, decodeText } from './detect.js';
import { multipartBoundary, parseMultipart } from './multipart.js';
import { aiConfigured, aiModel, diagnose } from './ai.js';
import * as comments from './comments.js';
import * as auth from './auth.js';
import * as oauth from './oauth.js';
import * as email from './email.js';
import { canAccess, isAdmin, isListed, isMember, isOwner, ownerName } from './authz.js';
import { noteActivity, registerAdminRoutes } from './admin.js';
import { loginLimiter, registerLimiter, aiLimiter, refLimiter, compileGate, compileLimiter, clientKey } from './ratelimit.js';
import { safeJoin, isTextFile, importPath, isHiddenPath, overlongPath, pathConflict, seedError, newId, BRANCH_RE, invalidRootFile } from './util.js';

type Q = { branch?: string; path?: string; name?: string; force?: string };

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
/** Public URL of the app root (origin + base path, no trailing slash) for OAuth
 *  redirects — ALDINE_PUBLIC_URL's origin, else derived from the request. */
function publicBase(req: FastifyRequest): string {
  if (config.publicUrl) return config.publicUrl;
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
  return `${proto}://${host}${config.basePath}`;
}

/** Last HEAD we successfully pushed per project — lets auto-sync skip a no-op
 *  network push. In-memory (single-node); cleared on restart → push-when-unsure. */
const lastPushedHead = new Map<string, string>();

/** Raw ZIP size the import route accepts; the web import dialog states the same figure. */
export const IMPORT_MAX_ZIP_BYTES = 60 * 1024 * 1024;
const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));

/** Engines the compiler distinguishes; anything else silently became pdflatex. */
export const ENGINES = ['pdf', 'xelatex', 'lualatex'] as const;

/** A project without a typeset root (blank, or its last .tex deleted) adopts
 *  a root once a .tex appears, ranked like an import (the branch may already
 *  hold .tex files that arrived through git). The root comes from the file
 *  listing, never from the request path, so it always matches the tree.
 *  Returns the new root when one was adopted. */
async function adoptRootIfUnset(id: string, branch: string, rel: string): Promise<string | undefined> {
  if (!/\.tex$/i.test(rel)) return undefined;
  try {
    const meta = await store.readMeta(id);
    if (meta.rootFile) return undefined;
    const root = detectRoot(id, branch);
    if (!root) return undefined;
    meta.rootFile = root;
    await store.writeMeta(meta);
    return root;
  } catch { return undefined; }
}

/** "<root file's dir>/<name>" — where \addbibresource{<name>} actually resolves. */
function rootSiblingPath(rootFile: string, name: string): string {
  const dir = path.dirname(rootFile || 'main.tex');
  return dir === '.' ? name : path.posix.join(dir, name);
}

const isOrcidId = (s: string) => /^\d{4}-\d{4}-\d{4}-\d{3}[\dXx]$/.test(s);

async function publicMeta(meta: store.ProjectMeta, user?: auth.PublicUser | null) {
  const { zotero: z, ownerId, share, github: _legacy, remote: _remote, ...rest } = meta;
  // Older web bundles read `github`; emit it alongside `remote` for github links
  // until the next release, then it goes.
  const link = store.remoteLink(meta);
  // The collaborator roster is the owner's private list of invitee email
  // addresses — never hand it to the other people who can open the project
  // (link visitors most of all). Everyone else sees the mode only.
  const owner = user !== undefined && isOwner(meta, user);
  return {
    ...rest,
    share: share && (owner ? share : { mode: share.mode, collaborators: [] }),
    ownerId,
    ownerName: await ownerName(meta),
    remote: link,
    github: link?.provider === 'github' ? link : undefined,
    isOwner: user !== undefined ? isOwner(meta, user) : undefined,
    isMember: user !== undefined ? isMember(meta, user) : undefined,
    zotero: z ? {
      libraryPrefix: z.libraryPrefix,
      collectionKey: z.collectionKey,
      bibFile: z.bibFile,
      lastSyncedAt: z.lastSyncedAt,
      username: z.username,
    } : null,
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

async function requireOwner(req: any, reply: any, action: string): Promise<store.ProjectMeta | null> {
  const meta = await store.readMeta(req.params.id);
  if (!isOwner(meta, reqUser(req))) {
    reply.code(403).send({ error: `Only the owner can ${action}` });
    return null;
  }
  return meta;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ ok: true, name: 'aldine' }));

  // Showcase projects (ALDINE_PROTECTED_PROJECTS): every visitor may read and
  // typeset them, nobody may change them — a public demo's sample paper must
  // survive launch-day traffic. The collab websocket enforces the same rule
  // via read-only connections (collab.ts onConnect).
  if (protectedProjects.size) {
    app.addHook('preHandler', async (req, reply) => {
      if (req.method === 'GET' || req.method === 'HEAD') return;
      const m = req.url.match(/^\/api\/projects\/([^/?]+)(?:\/([^?]*))?/);
      if (!m || !protectedProjects.has(m[1])) return;
      if (/^(compile|synctex)$/.test(m[2] || '')) return; // reading the doc includes building it
      return reply.code(403).send({ error: 'This is a read-only showcase project — create your own to try editing.' });
    });
  }

  // ---------- auth (env-gated) ----------
  app.get('/api/auth/me', async (req) => {
    const user = reqUser(req);
    return { authEnabled: auth.AUTH_ENABLED, passwordAuth: !auth.SSO_ONLY, user, providers: oauthProviders(), admin: !!user && isAdmin(user) };
  });

  /** 403 when password sign-in is disabled (SSO-only mode). */
  const passwordDisabled = (reply: any) => reply.code(403).send({ error: 'Password sign-in is disabled — use single sign-on.' });

  app.post<{ Body: { email: string; password: string; name?: string } }>('/api/auth/register', async (req, reply) => {
    if (!auth.AUTH_ENABLED) return reply.code(400).send({ error: 'Auth is not enabled' });
    if (auth.SSO_ONLY) return passwordDisabled(reply);
    if (!(await registerLimiter.take(clientKey(req)))) return reply.code(429).send({ error: 'Too many accounts created — try again later' });
    const bad = badCredentials(req.body);
    if (bad) return reply.code(400).send({ error: bad });
    try {
      const user = await auth.register(req.body.email, req.body.password, req.body.name);
      reply.header('set-cookie', auth.sessionCookie(await auth.createSession(user.id)));
      // Fire-and-forget a simple welcome email (no verification step). Never let
      // a mail failure affect the signup response.
      const base = process.env.ALDINE_PUBLIC_URL?.replace(/\/$/, '');
      if (email.emailConfigured() && base && user.email) {
        const greeting = user.name ? `Hi ${user.name},` : 'Hi there,';
        email.sendMail({
          to: user.email,
          subject: 'Welcome to Aldine',
          text: `${greeting}\n\nWelcome to Aldine — write LaTeX together, fast, versioned, and yours.\n\nOpen your workspace: ${base}\n\nStart a blank paper or a template, import a project from GitHub or an Overleaf ZIP, then hit ⌘S to typeset. Invite others and you'll see their cursors live.\n\nHappy writing.`,
          html: `<p>${greeting}</p><p>Welcome to <strong>Aldine</strong> — write LaTeX together, fast, versioned, and yours.</p><p><a href="${base}">Open your workspace</a></p><p>Start a blank paper or a template, import a project from GitHub or an Overleaf ZIP, then hit ⌘S to typeset. Invite others and you'll see their cursors live.</p><p>Happy writing.</p>`,
        }).catch((err) => console.error('[aldine] welcome email failed:', err?.message || err));
      }
      return { user };
    } catch (err: any) { return reply.code(400).send({ error: err.message }); }
  });

  app.post<{ Body: { email: string; password: string } }>('/api/auth/login', async (req, reply) => {
    if (!auth.AUTH_ENABLED) return reply.code(400).send({ error: 'Auth is not enabled' });
    if (auth.SSO_ONLY) return passwordDisabled(reply);
    if (!(await loginLimiter.take(clientKey(req)))) return reply.code(429).send({ error: 'Too many attempts — wait a moment and try again' });
    if (badCredentials(req.body)) return reply.code(400).send({ error: 'Email and password are required' });
    try {
      const user = await auth.login(req.body.email, req.body.password);
      reply.header('set-cookie', auth.sessionCookie(await auth.createSession(user.id)));
      return { user };
    } catch (err: any) { return reply.code(401).send({ error: err.message }); }
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await auth.destroySession(auth.sidFromRequest(req.headers.cookie)); // revoke this session server-side
    reply.header('set-cookie', auth.clearCookie());
    return { ok: true };
  });

  // change password (logged in): revokes all sessions, then re-issues the current one
  app.post<{ Body: { currentPassword: string; newPassword: string } }>('/api/auth/password', async (req, reply) => {
    if (!auth.AUTH_ENABLED) return reply.code(400).send({ error: 'Auth is not enabled' });
    if (auth.SSO_ONLY) return passwordDisabled(reply);
    const user = reqUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in required' });
    try {
      await auth.changePassword(user.id, req.body?.currentPassword || '', req.body?.newPassword || '');
      reply.header('set-cookie', auth.sessionCookie(await auth.createSession(user.id)));
      return { ok: true };
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
        email.sendMail({
          to: r.user.email,
          subject: 'Reset your Aldine password',
          text: `Someone requested a password reset for your Aldine account.\n\nOpen this link to set a new password (expires in 1 hour):\n${link}\n\nOr enter this token manually: ${r.token}\n\nIf you didn't request this, you can ignore this email.`,
          html: `<p>Someone requested a password reset for your Aldine account.</p><p><a href="${link}">Set a new password</a> (expires in 1 hour).</p><p>Or enter this token manually: <code>${r.token}</code></p><p>If you didn't request this, you can ignore this email.</p>`,
        }).catch((err) => console.error('[aldine] reset email failed:', err?.message || err));
      } else {
        // no transport, or no ALDINE_PUBLIC_URL to build a trusted link → don't
        // email a host-derived (poisonable) link; log the token for manual relay
        console.log(`[aldine] password reset for ${r.user.email}: token=${r.token} (set ALDINE_PUBLIC_URL + an email transport to send links; relay manually, expires in 1h)`);
      }
    }
    // never reveal whether the email exists
    return process.env.ALDINE_RESET_ECHO === '1' && r ? { ok: true, token: r.token } : { ok: true };
  });

  app.post<{ Body: { token: string; newPassword: string } }>('/api/auth/reset', async (req, reply) => {
    if (!auth.AUTH_ENABLED) return reply.code(400).send({ error: 'Auth is not enabled' });
    if (auth.SSO_ONLY) return passwordDisabled(reply);
    try {
      await auth.resetPassword(req.body?.token || '', req.body?.newPassword || '');
      return { ok: true };
    } catch (err: any) { return reply.code(400).send({ error: err.message }); }
  });

  // ---------- SSO / OAuth (each provider gated on its client id/secret) ----------
  app.get<{ Params: { provider: string } }>('/api/auth/oauth/:provider', async (req, reply) => {
    const provider = auth.AUTH_ENABLED ? oauth.getProvider(req.params.provider) : undefined;
    if (!provider) return reply.code(404).send({ error: 'This sign-in provider is not configured' });
    const state = crypto.randomBytes(12).toString('hex');
    reply.header('set-cookie', `aldine_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=${auth.COOKIE_PATH}; Max-Age=600${auth.SECURE_COOKIES ? '; Secure' : ''}`);
    const redirect = `${publicBase(req)}/api/auth/oauth/${provider.id}/callback`;
    return reply.redirect(provider.authorizeUrl(state, redirect));
  });

  app.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string } }>(
    '/api/auth/oauth/:provider/callback', async (req, reply) => {
      const provider = auth.AUTH_ENABLED ? oauth.getProvider(req.params.provider) : undefined;
      if (!provider) return reply.code(404).send({ error: 'This sign-in provider is not configured' });
      const cookies = auth.parseCookies(req.headers.cookie);
      if (!req.query.code || !req.query.state || req.query.state !== cookies.aldine_oauth_state) {
        return reply.code(400).send({ error: 'OAuth state mismatch — please try again' });
      }
      try {
        const profile = await provider.exchange(req.query.code, `${publicBase(req)}/api/auth/oauth/${provider.id}/callback`);
        const user = await auth.findOrCreateOAuth(profile, provider.id);
        reply.header('set-cookie', [auth.sessionCookie(await auth.createSession(user.id)), `aldine_oauth_state=; Path=${auth.COOKIE_PATH}; Max-Age=0`]);
        return reply.redirect(`${config.basePath}/`);
      } catch (err: any) {
        return reply.code(400).send({ error: `${provider.label} sign-in failed: ${err.message}` });
      }
    });

  // Resolve the request's user once (awaiting the async datastore) and cache it,
  // so reqUser() is a synchronous read everywhere downstream.
  app.addHook('onRequest', async (req) => {
    const user = auth.AUTH_ENABLED ? await auth.userFromRequest(req.headers.cookie) : null;
    (req as any)._user = user;
    if (user) noteActivity(user.id);
  });
  await registerAdminRoutes(app, reqUser);

  // Global guard: enforce project access when auth is on. Runs after routing,
  // so it uses the DECODED :id param — never a regex over the raw (still
  // percent-encoded) URL, which a `%61bc…` id would slip past.
  app.addHook('preHandler', async (req, reply) => {
    const reqId = (req.params as { id?: string } | undefined)?.id;
    // Trashed projects behave as gone for every route except restore and
    // delete (purge) — works with or without auth.
    if (reqId !== undefined) {
      let m: store.ProjectMeta | null = null;
      try { m = await store.readMeta(reqId); } catch { /* handled below / by the route */ }
      const p = req.url.split('?')[0];
      if (m?.deletedAt && !(p.endsWith('/restore') || (req.method === 'DELETE' && p === `/api/projects/${reqId}`))) {
        return reply.code(404).send({ error: 'project not found' });
      }
    }
    if (!auth.AUTH_ENABLED) return;
    const id = reqId;
    if (id !== undefined) {
      let meta: store.ProjectMeta;
      try { meta = await store.readMeta(id); } catch { return reply.code(404).send({ error: 'project not found' }); }
      const user = reqUser(req);
      if (!user) return reply.code(401).send({ error: 'Sign in required' });
      if (!canAccess(meta, user)) return reply.code(403).send({ error: 'You do not have access to this project' });
      return;
    }
    // non-id routes: require sign-in for the project list / create / import
    const path = req.url.split('?')[0];
    if (/^\/api\/projects(\/import|\/trash)?$/.test(path) && !reqUser(req)) {
      return reply.code(401).send({ error: 'Sign in required' });
    }
  });

  // ---------- projects ----------
  app.get('/api/projects', async (req) => {
    const user = reqUser(req);
    return Promise.all((await store.listProjects()).filter((m) => !m.deletedAt && isListed(m, user)).map((m) => publicMeta(m, user)));
  });

  // Trash: soft-deleted projects the user owns, newest first. Restorable until purge (~30 days).
  app.get('/api/projects/trash', async (req) => {
    const user = reqUser(req);
    const mine = (await store.listProjects()).filter((m) => !!m.deletedAt && (auth.AUTH_ENABLED ? isOwner(m, user) : true));
    mine.sort((a, b) => (b.deletedAt || '').localeCompare(a.deletedAt || ''));
    return mine.map((m) => ({ id: m.id, name: m.name, deletedAt: m.deletedAt }));
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
    const { name = 'Untitled Project', files, template, namespace } = req.body || {};
    let seed: Record<string, string | Buffer> | undefined;
    let resolved: TemplateSeed | undefined;
    if (files !== undefined && files !== null) {
      const bad = seedError(files);
      if (bad) return reply.code(400).send({ error: bad });
      seed = files;
    }    if (template) {
      try {
        resolved = await resolveTemplateSeed(template);
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
    const remoteError = await provisionNew(meta, req, namespace);
    const body = await publicMeta(meta, reqUser(req));
    // A venue kit that could not be downloaded still creates the project (from
    // a skeleton); the client says so rather than the request failing.
    return { ...body, ...(resolved?.venueKit ? { venueKit: resolved.venueKit } : {}), ...(remoteError ? { remoteError } : {}) };
  });

  // ---------- sharing (owner only) ----------
  app.post<{ Params: { id: string }; Body: { mode?: 'private' | 'link'; collaborators?: string[] } }>(
    '/api/projects/:id/share', async (req, reply) => {
      const meta = await store.readMeta(req.params.id);
      if (!isOwner(meta, reqUser(req))) return reply.code(403).send({ error: 'Only the owner can change sharing' });
      const mode = req.body?.mode === 'link' ? 'link' : 'private';
      // An entry is an email address or an ORCID iD (the only way to invite a
      // researcher whose ORCID account shares no email).
      const collaborators = Array.isArray(req.body?.collaborators)
        ? req.body!.collaborators.map((c) => String(c).trim()).map((c) => (isOrcidId(c) ? c.toUpperCase() : c.toLowerCase()))
          .filter((c) => isOrcidId(c) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c)).slice(0, 50)
        : (meta.share?.collaborators || []);
      meta.share = { mode, collaborators };
      await store.writeMeta(meta);
      // Access is checked when a collab socket connects, so a session already
      // in the document would survive being revoked. Drop this project's
      // sockets: clients reconnect and re-authenticate, which re-runs the
      // check — the still-allowed resume, the revoked are refused. The event
      // reaches peer nodes (multi-node deploys) with the same effect.
      closeProjectConnections(meta.id);
      publishProjectEvent({ type: 'access-changed', projectId: meta.id });
      return publicMeta(meta, reqUser(req));
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

  // Asked for at boot so the first gallery request is served from the cache
  // instead of waiting on the compiler.
  warmVenueCache();
  app.get('/api/templates', async () => listAllTemplates());

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
  app.post<{ Body: ImportBody }>('/api/projects/import', { bodyLimit: importBodyLimit }, async (req, reply) => {
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
      if (binFiles.length) await gitops.commitAll(meta.id, 'main', 'aldine: import assets').catch(() => {});
      const root = guessRoot(files);
      // Detection reads the archive bytes, not the transcoded text: the package
      // names it looks for are ASCII either way, and the latexmkrc is never transcoded.
      const detected = detectEngine(files, root);
      if (root) meta.rootFile = root;
      meta.engine = detected.engine;
      await store.writeMeta(meta);
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
      return { ...(await publicMeta(meta, reqUser(req))), branches };
    } catch {
      return reply.code(404).send({ error: 'project not found' });
    }
  });

  app.patch<{ Params: { id: string }; Body: Partial<Pick<store.ProjectMeta, 'name' | 'rootFile' | 'engine' | 'stopOnFirstError'>> }>(
    '/api/projects/:id', async (req, reply) => {
      const meta = await requireMember(req, reply, 'rename or reconfigure this project');
      if (!meta) return;
      const { name, rootFile, engine, stopOnFirstError } = req.body || {};
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
      await store.writeMeta(meta);
      return publicMeta(meta, reqUser(req));
    });

  // Delete = move to trash (restorable ~30 days). ?permanent=1 skips the trash
  // — used by "Delete forever" in the trash UI and by tests that must clean up.
  app.delete<{ Params: { id: string }; Querystring: { permanent?: string } }>('/api/projects/:id', async (req, reply) => {
    const meta = await store.readMeta(req.params.id);
    if (!isOwner(meta, reqUser(req))) return reply.code(403).send({ error: 'Only the owner can delete this project' });
    cancelAutopush(req.params.id);
    // A repository Aldine created goes with the project; an imported one is
    // never touched. A failed remote deletion is reported, never blocking.
    const remote: DeprovisionResult = await deprovisionProject(meta).catch((err) => ({ deleted: false, error: String(err?.message || err) }));
    if (req.query.permanent === '1') await store.deleteProject(req.params.id);
    else await store.softDeleteProject(req.params.id);
    lastPushedHead.delete(req.params.id); // don't leak the push-dedup entry (or reuse a stale hash)
    forgetPdfUrls(req.params.id);
    // Deleting revokes access just like un-sharing: drop live collab sessions
    // (here and on peer nodes) so nobody keeps editing a trashed project.
    closeProjectConnections(req.params.id);
    publishProjectEvent({ type: 'access-changed', projectId: req.params.id });
    return { ok: true, ...(remote.scheduledFor ? { remoteScheduledFor: remote.scheduledFor } : {}), ...(remote.error ? { remoteError: remote.error } : {}) };
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

  // ---------- files ----------
  app.get<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/files', async (req, reply) => {
    const branch = req.query.branch || 'main';
    try {
      await gitops.ensureWorktree(req.params.id, branch);
      return store.listFiles(req.params.id, branch);
    } catch {
      return reply.code(404).send({ error: 'Project or branch not found' });
    }
  });

  app.get<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/file', async (req, reply) => {
    const { branch = 'main', path: rel } = req.query;
    if (!rel) return reply.code(400).send({ error: 'path required' });
    if (isHiddenPath(rel)) return reply.code(403).send({ error: 'forbidden path' });
    try {
      const buf = store.readFile(req.params.id, branch, rel);
      const ext = path.extname(rel).toLowerCase();
      const mime = ext === '.pdf' ? 'application/pdf'
        : ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'].includes(ext)
          ? `image/${ext === '.jpg' ? 'jpeg' : ext.slice(1)}`
          : 'text/plain; charset=utf-8';
      // A committed .svg (or sniffed .html) served on our own origin would run its
      // scripts on top-level navigation, acting as the viewer. nosniff pins the
      // type and the sandbox CSP neutralizes any script while <img> embeds still render.
      return reply
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox")
        .type(mime).send(buf);
    } catch {
      return reply.code(404).send({ error: 'file not found' });
    }
  });

  app.put<{ Params: { id: string }; Body: { branch?: string; path: string; content?: string; encoding?: 'utf8' | 'base64'; createOnly?: boolean } }>(
    '/api/projects/:id/file', async (req, reply) => {
      const { branch = 'main', path: rel, content = '', encoding = 'utf8', createOnly = false } = req.body || {};
      if (!rel) return reply.code(400).send({ error: 'path required' });
      if (isHiddenPath(rel) || rel.includes('..')) return reply.code(403).send({ error: 'Invalid file path' });
      await gitops.ensureWorktree(req.params.id, branch);
      // createOnly (new-file flow): never clobber an existing file with empty content
      if (createOnly && store.fileExists(req.params.id, branch, rel)) {
        return reply.code(409).send({ error: 'A file with that name already exists' });
      }
      try {
        store.writeFile(req.params.id, branch, rel, encoding === 'base64' ? Buffer.from(content, 'base64') : content);
      } catch {
        return reply.code(400).send({ error: 'Could not write that file path' });
      }
      refreshBranchDocsFromDisk(req.params.id, branch);
      scheduleCommit(req.params.id, branch); // non-collab write → still reach git history
      const newRoot = await adoptRootIfUnset(req.params.id, branch, rel);
      return { ok: true, ...(newRoot ? { newRoot } : {}) };
    });

  app.post<{ Params: { id: string }; Body: { branch?: string; from: string; to: string } }>(
    '/api/projects/:id/file/rename', async (req, reply) => {
      const { branch = 'main', from, to } = req.body || {};
      if (!from || !to) return reply.code(400).send({ error: 'from/to required' });
      if (isHiddenPath(from) || isHiddenPath(to)) return reply.code(403).send({ error: 'forbidden path' });
      if (from === to) return { ok: true };
      // never overwrite an existing file — that would destroy both it and the source
      if (store.fileExists(req.params.id, branch, to)) {
        return reply.code(409).send({ error: `A file named "${to}" already exists` });
      }
      if (!store.fileExists(req.params.id, branch, from)) {
        return reply.code(404).send({ error: `No file named "${from}"` });
      }
      // Flush pending edits BEFORE evicting: eviction tombstones the doc and a
      // tombstoned doc is never written, so anything typed inside the autosave
      // debounce window would be renamed away and lost.
      flushBranchDocs(req.params.id, branch);
      // evict the source doc so its final store can't recreate the old file
      evictDoc(req.params.id, branch, from);
      store.renameFile(req.params.id, branch, from, to);
      bumpContentVersion(req.params.id, branch); // bib/label indexes carry file paths
      scheduleCommit(req.params.id, branch);
      // The typeset root keeps its designation through a rename (deletion
      // already re-derives it; a rename must not orphan it). A rename that
      // produces the project's first .tex adopts it, as creation would. The
      // stored path is the normalised one: "./a.tex" must match the tree.
      let newRoot: string | undefined;
      try {
        const meta = await store.readMeta(req.params.id);
        const normTo = importPath(to);
        if (meta.rootFile && meta.rootFile === importPath(from) && normTo) {
          meta.rootFile = normTo;
          await store.writeMeta(meta);
          newRoot = normTo;
        } else if (!meta.rootFile) {
          newRoot = await adoptRootIfUnset(req.params.id, branch, to);
        }
      } catch { /* meta unreadable — leave as-is */ }
      return { ok: true, ...(newRoot ? { newRoot } : {}) };
    });

  app.delete<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/file', async (req, reply) => {
    const { branch = 'main', path: rel } = req.query;
    if (!rel) return reply.code(400).send({ error: 'path required' });
    if (isHiddenPath(rel)) return reply.code(403).send({ error: 'forbidden path' });
    evictDoc(req.params.id, branch, rel); // prevent resurrection via pending store
    store.deleteFile(req.params.id, branch, rel);
    bumpContentVersion(req.params.id, branch);
    scheduleCommit(req.params.id, branch);
    // If the typeset root was deleted, re-point it at the best remaining .tex
    // so the next compile doesn't fail with "root file not found". With no
    // .tex left the root is unset, so the next .tex created becomes it.
    let newRoot: string | undefined;
    try {
      const meta = await store.readMeta(req.params.id);
      if (meta.rootFile && meta.rootFile === importPath(rel)) {
        const root = detectRoot(req.params.id, branch);
        meta.rootFile = root;
        await store.writeMeta(meta);
        newRoot = root || undefined;
      }
    } catch { /* meta unreadable — leave as-is */ }
    return { ok: true, ...(newRoot ? { newRoot } : {}) };
  });

  /** Serve compile artifacts (PDF, synctex) from the branch's .aldine-out. */
  app.get<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/output', async (req, reply) => {
    const { branch = 'main', path: rel } = req.query;
    // artifacts live in a .aldine-out dir (at the project root or beside a subdir'd root file)
    if (!rel || rel.includes('..') || !/(^|\/)\.aldine-out\/[^/]+$/.test(rel)) return reply.code(400).send({ error: 'bad output path' });
    try {
      const abs = safeJoin(store.branchDir(req.params.id, branch), rel);
      fs.accessSync(abs); // throws → 404 below if the artifact is missing
      const type = rel.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';
      // Stream from disk (constant memory) instead of buffering the whole PDF per
      // fetch. No Content-Length: a concurrent recompile can change the file size
      // between stat and read, and a fixed length would then hang/truncate the
      // client — chunked transfer sends exactly what's read and ends cleanly.
      return reply.type(type).header('cache-control', 'no-store').send(fs.createReadStream(abs));
    } catch {
      return reply.code(404).send({ error: 'artifact not found' });
    }
  });

  // ---------- compile ----------
  app.post<{ Params: { id: string }; Body: { branch?: string } }>('/api/projects/:id/compile', async (req, reply) => {
    const branch = req.body?.branch || 'main';
    const user = reqUser(req);
    const key = clientKey(req, user?.id);
    // plan metering: block once a signed-in user is over their monthly compile budget
    if (user && await usage.overQuota(user.id)) {
      return reply.code(402).send({ ok: false, pdf: null, pdfUrl: null, log: '', errors: [], durationMs: 0, error: 'Monthly typeset limit reached — upgrade your plan for more compile time.', quotaExceeded: true });
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
      const result = await compileProject(req.params.id, branch);
      if (user) await usage.recordCompile(user.id, result.durationMs || 0);
      return result;
    } catch (err: any) {
      return reply.code(400).send({ ok: false, pdf: null, pdfUrl: null, log: '', errors: [], durationMs: 0, error: err.message });
    } finally {
      compileGate.release(key);
    }
  });

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

  // ---------- bib + label indexes (for \cite / \ref autocomplete) ----------
  // Both walk the whole branch (readdir + read + parse every .bib/.tex), which
  // used to run on EVERY autocomplete request. Cache per branch, keyed by the
  // content version that every write path bumps (collab.ts) — a hit costs a
  // Map lookup, a miss exactly one walk.
  const bibIndexCache = new Map<string, { v: number; entries: BibEntry[] }>();
  const labelIndexCache = new Map<string, { v: number; labels: Array<{ label: string; file: string }> }>();

  app.get<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/bib', async (req) => {
    const branch = req.query.branch || 'main';
    flushBranchDocs(req.params.id, branch); // may bump the version (pending edits reach disk)
    const key = `${req.params.id}::${branch}`;
    const v = contentVersion(req.params.id, branch);
    const hit = bibIndexCache.get(key);
    if (hit && hit.v === v) return hit.entries;
    const entries: BibEntry[] = [];
    for (const f of store.listFiles(req.params.id, branch)) {
      if (f.type === 'file' && f.path.endsWith('.bib')) {
        try {
          entries.push(...parseBib(store.readFile(req.params.id, branch, f.path).toString('utf8'), f.path));
        } catch { /* skip broken bib */ }
      }
    }
    bibIndexCache.set(key, { v, entries });
    return entries;
  });

  app.get<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/labels', async (req) => {
    const branch = req.query.branch || 'main';
    flushBranchDocs(req.params.id, branch);
    const key = `${req.params.id}::${branch}`;
    const v = contentVersion(req.params.id, branch);
    const hit = labelIndexCache.get(key);
    if (hit && hit.v === v) return hit.labels;
    const labels: Array<{ label: string; file: string }> = [];
    const re = /\\label\{([^}]+)\}/g;
    for (const f of store.listFiles(req.params.id, branch)) {
      if (f.type !== 'file' || !f.path.endsWith('.tex')) continue;
      try {
        const text = store.readFile(req.params.id, branch, f.path).toString('utf8');
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) labels.push({ label: m[1], file: f.path });
      } catch { /* skip */ }
    }
    labelIndexCache.set(key, { v, labels });
    return labels;
  });

  // Whole-document word count: the status bar's per-file count is misleading
  // for multi-file projects (the root is mostly preamble + \input lines), so
  // the client sums the include graph via this endpoint. Same cache discipline
  // as /bib and /labels.
  const wordCountCache = new Map<string, { v: number; body: { rootFile: string; total: number; files: Record<string, number> } }>();
  app.get<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/wordcount', async (req) => {
    const branch = req.query.branch || 'main';
    flushBranchDocs(req.params.id, branch);
    const key = `${req.params.id}::${branch}`;
    const v = contentVersion(req.params.id, branch);
    const hit = wordCountCache.get(key);
    if (hit && hit.v === v) return hit.body;
    const meta = await store.readMeta(req.params.id);
    const read = (p: string): string | null => {
      if (isHiddenPath(p)) return null;
      try { return store.readFile(req.params.id, branch, p).toString('utf8'); } catch { return null; }
    };
    const files: Record<string, number> = {};
    let total = 0;
    for (const f of documentFiles(meta.rootFile, read)) {
      const n = latexWordCount(read(f) ?? '');
      files[f] = n;
      total += n;
    }
    const body = { rootFile: meta.rootFile, total, files };
    wordCountCache.set(key, { v, body });
    return body;
  });

  // ---------- git ----------
  app.get<{ Params: { id: string } }>('/api/projects/:id/branches', async (req) => gitops.listBranches(req.params.id));

  app.post<{ Params: { id: string }; Body: { name: string; from?: string } }>(
    '/api/projects/:id/branches', async (req, reply) => {
      const { name, from = 'main' } = req.body || {};
      if (!name) return reply.code(400).send({ error: 'name required' });
      if (!BRANCH_RE.test(name) || name.includes('..') || /^(refs|heads|remotes)\//.test(name) || /^-/.test(name)) {
        return reply.code(400).send({ error: 'Invalid branch name' });
      }
      // capture latest edits so the new branch starts from what the user sees
      flushBranchDocs(req.params.id, from);
      await gitops.commitAll(req.params.id, from, 'aldine: checkpoint before branching').catch(() => {});
      try {
        await gitops.createBranch(req.params.id, name, from);
      } catch (err) {
        return reply.code(409).send({ error: `Could not create branch: ${(err as Error).message}` });
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
      await gitops.deleteBranch(req.params.id, name);
    } catch (err) {
      return reply.code(409).send({ error: `Could not delete branch: ${(err as Error).message}` });
    }
    forgetPdfUrls(req.params.id, name);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { branch?: string; message?: string; author?: string } }>(
    '/api/projects/:id/commit', async (req) => {
      const { branch = 'main', message = 'aldine: manual commit', author } = req.body || {};
      flushBranchDocs(req.params.id, branch);
      const r = await gitops.commitAll(req.params.id, branch, message, author);
      if (r.committed && branch === 'main') scheduleAutopush(req.params.id);
      return r;
    });

  app.get<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/log', async (req) => {
    return gitops.log(req.params.id, req.query.branch || 'main');
  });

  app.get<{ Params: { id: string; hash: string } }>('/api/projects/:id/commit/:hash/diff', async (req, reply) => {
    try { return await gitops.commitDiff(req.params.id, req.params.hash); }
    catch (err: any) { return reply.code(400).send({ error: err.message }); }
  });

  app.post<{ Params: { id: string }; Body: { from: string; into: string; author?: string } }>(
    '/api/projects/:id/merge', async (req, reply) => {
      const { from, into, author } = req.body || {};
      if (!from || !into) return reply.code(400).send({ error: 'from/into required' });
      flushBranchDocs(req.params.id, from);
      flushBranchDocs(req.params.id, into);
      const result = await gitops.merge(req.params.id, from, into, author);
      if (result.ok) refreshBranchDocsFromDisk(req.params.id, into);
      return result;
    });

  // ---------- zotero ----------
  app.post<{ Body: { apiKey: string } }>('/api/zotero/validate', async (req, reply) => {
    const { apiKey } = req.body || {};
    if (!apiKey) return reply.code(400).send({ error: 'apiKey required' });
    try {
      const info = await zotero.validateKey(apiKey);
      const groups = await zotero.listGroups(apiKey, info.userID);
      return { ...info, groups };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post<{ Body: { apiKey: string; libraryPrefix: string } }>('/api/zotero/collections', async (req, reply) => {
    const { apiKey, libraryPrefix } = req.body || {};
    if (!apiKey || !libraryPrefix) return reply.code(400).send({ error: 'apiKey and libraryPrefix required' });
    try {
      return await zotero.listCollections(apiKey, libraryPrefix);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post<{ Params: { id: string }; Body: { apiKey: string; libraryPrefix: string; collectionKey?: string; bibFile?: string; branch?: string } }>(
    '/api/projects/:id/zotero/link', async (req, reply) => {
      const { apiKey, libraryPrefix, collectionKey, branch = 'main' } = req.body || {};
      const owned = await requireOwner(req, reply, 'link a Zotero library');
      if (!owned) return;
      if (!apiKey || !libraryPrefix) return reply.code(400).send({ error: 'apiKey and libraryPrefix required' });
      try {
        const info = await zotero.validateKey(apiKey);
        const meta = await store.readMeta(req.params.id);
        // default next to the root file — \addbibresource{zotero.bib} resolves
        // relative to its dir, so a project-root default would write a file the
        // document never reads when the root lives in a subdirectory
        const bibFile = req.body?.bibFile || rootSiblingPath(meta.rootFile, 'zotero.bib');
        if (isHiddenPath(bibFile)) return reply.code(403).send({ error: 'forbidden path' });
        meta.zotero = { apiKey, userId: info.userID, username: info.username, libraryPrefix, collectionKey, bibFile };
        await store.writeMeta(meta);
        // sync into the branch the user linked from (the plugin refreshes that branch), not always main
        const sync = await zotero.syncProject(req.params.id, branch, true);
        return { ok: true, ...sync };
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    });

  app.post<{ Params: { id: string }; Body: { branch?: string; force?: boolean } }>(
    '/api/projects/:id/zotero/sync', async (req, reply) => {
      if (!(await requireMember(req, reply, 'sync this Zotero library'))) return;
      try {
        return await zotero.syncProject(req.params.id, req.body?.branch || 'main', !!req.body?.force);
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
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
    try {
      return await zotero.searchItems(meta.zotero.apiKey, meta.zotero.libraryPrefix, req.query.q || '');
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ---------- reference lookup (DOI / arXiv → BibTeX) ----------
  app.post<{ Params: { id: string }; Body: { query: string; branch?: string; bibFile?: string } }>(
    '/api/projects/:id/references/add', async (req, reply) => {
      const { query, branch = 'main' } = req.body || {};
      if (!query) return reply.code(400).send({ error: 'query required' });
      if (!(await refLimiter.take(clientKey(req, reqUser(req)?.id)))) return reply.code(429).send({ error: 'Rate limit reached — please slow down' });
      try {
        // default next to the root file (see zotero/link) so inserted cites
        // land in a .bib the document actually reads
        const bibFile = req.body?.bibFile || rootSiblingPath((await store.readMeta(req.params.id)).rootFile, 'references.bib');
        if (isHiddenPath(bibFile)) return reply.code(403).send({ error: 'forbidden path' });
        const entry = await fetchBibEntry(query.trim());
        if (!entry) return reply.code(404).send({ error: 'No reference found for that DOI/arXiv id' });
        // append to the .bib (create if missing), skipping duplicate keys
        await gitops.ensureWorktree(req.params.id, branch);
        let existing = '';
        try { existing = store.readFile(req.params.id, branch, bibFile).toString('utf8'); } catch { /* new file */ }
        // key-only dedup via the shared bibKeys scanner — consistent with the
        // /bib index (skips @comment/@string) but without parsing every field
        // of every existing entry just to compare keys.
        const key = [...bibKeys(entry)][0];
        if (key && bibKeys(existing).has(key)) {
          return { ok: true, key, duplicate: true };
        }
        store.writeFile(req.params.id, branch, bibFile, existing.trimEnd() + '\n\n' + entry.trim() + '\n');
        refreshBranchDocsFromDisk(req.params.id, branch);
        scheduleCommit(req.params.id, branch);
        return { ok: true, key, bibFile };
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
  app.get<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/comments', async (req) =>
    comments.listComments(req.params.id, req.query.branch || 'main'));  // returns a Promise; Fastify awaits it

  app.post<{ Params: { id: string }; Body: { branch?: string; file: string; anchor: { from: number; to: number; quote: string }; body: string; suggestion?: string; author?: string } }>(
    '/api/projects/:id/comments', async (req, reply) => {
      const b = req.body || ({} as any);
      if (!b.file || !b.anchor) return reply.code(400).send({ error: 'file and anchor required' });
      const branch = b.branch || 'main';
      // the anchor must point at a real span in a real file
      if (!store.fileExists(req.params.id, branch, b.file)) return reply.code(404).send({ error: 'File not found' });
      const { from, to } = b.anchor;
      if (typeof from !== 'number' || typeof to !== 'number' || from < 0 || to <= from) {
        return reply.code(400).send({ error: 'Invalid comment anchor' });
      }
      if (typeof b.body === 'string' && b.body.length > 5000) return reply.code(400).send({ error: 'Comment is too long (max 5000 characters)' });
      if (typeof b.suggestion === 'string' && b.suggestion.length > 20000) return reply.code(400).send({ error: 'Suggestion is too long' });
      return comments.addComment(req.params.id, {
        branch,
        file: b.file,
        anchor: b.anchor,
        author: reqUser(req)?.name || b.author || 'Anonymous',
        body: b.body || '',
        suggestion: b.suggestion,
      });
    });

  app.post<{ Params: { id: string; cid: string }; Body: { body: string; author?: string } }>(
    '/api/projects/:id/comments/:cid/reply', async (req, reply) => {
      const c = await comments.replyComment(req.params.id, req.params.cid, reqUser(req)?.name || req.body?.author || 'Anonymous', req.body?.body || '');
      return c || reply.code(404).send({ error: 'comment not found' });
    });

  app.post<{ Params: { id: string; cid: string }; Body: { resolved?: boolean } }>(
    '/api/projects/:id/comments/:cid/resolve', async (req, reply) => {
      const c = await comments.resolveComment(req.params.id, req.params.cid, req.body?.resolved !== false);
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
      let outcome = applySuggestionToDoc(req.params.id, branch, c.file, c.anchor, c.suggestion);
      if (outcome === 'no-doc') {
        // nobody has the file open — the disk copy is authoritative, edit it directly
        let content: string;
        try { content = store.readFile(req.params.id, branch, c.file).toString('utf8'); } catch {
          return reply.code(404).send({ error: 'File not found' });
        }
        let next: string | null = null;
        if (content.slice(c.anchor.from, c.anchor.to) === c.anchor.quote) {
          next = content.slice(0, c.anchor.from) + c.suggestion + content.slice(c.anchor.to);
        } else if (c.anchor.quote && c.anchor.quote.length === c.anchor.to - c.anchor.from && content.split(c.anchor.quote).length === 2) {
          const suggestion = c.suggestion;
          next = content.replace(c.anchor.quote, () => suggestion);
        }
        if (next === null) { outcome = 'stale'; } else {
          store.writeFile(req.params.id, branch, c.file, next);
          refreshBranchDocsFromDisk(req.params.id, branch);
          outcome = 'applied';
        }
      }
      if (outcome === 'stale') return reply.code(409).send({ error: 'The commented text has changed — apply the suggestion manually.' });
      bumpContentVersion(req.params.id, branch);
      scheduleCommit(req.params.id, branch);
      await comments.resolveComment(req.params.id, req.params.cid, true);
      return { ok: true };
    });

  // Anyone in the document may comment and reply, but clearing someone else's
  // review thread is for the team — a link visitor can only delete their own.
  app.delete<{ Params: { id: string; cid: string }; Querystring: Q }>('/api/projects/:id/comments/:cid', async (req, reply) => {
    const meta = await store.readMeta(req.params.id);
    if (!isMember(meta, reqUser(req))) {
      const all = await comments.listComments(req.params.id, req.query.branch || 'main');
      const mine = all.find((c) => c.id === req.params.cid)?.author === reqUser(req)?.name;
      if (!mine) return reply.code(403).send({ error: 'Only the owner and collaborators can delete this comment' });
    }
    await comments.deleteComment(req.params.id, req.params.cid);
    return { ok: true };
  });

  // ---------- remote providers (GitHub, GitLab): per-user connection ----------
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

  app.get('/api/remotes', async () => remotes.providers().map((p) => ({
    id: p.id, label: p.label, oauth: p.oauthEnabled(), selfHosted: p.selfHosted, changeRequestLabel: p.changeRequestLabel,
  })));

  providerRoute('get', 'status', async (p, req, reply) => {
    if (requireSignIn(req, reply)) return;
    const conn = await remotes.getConnection(remoteUserId(req), p.id);
    return { connected: !!conn, login: conn?.login, baseUrl: conn?.baseUrl, oauth: p.oauthEnabled(), selfHosted: p.selfHosted };
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
    try {
      const me = await p.whoami({ token, login: '', baseUrl });
      await remotes.setConnection(remoteUserId(req), p.id, { token, login: me.login, name: me.name, ...(baseUrl ? { baseUrl } : {}) });
      return { connected: true, login: me.login, baseUrl };
    } catch {
      const scope = p.id === 'github' ? 'repo scope' : 'the api scope';
      return reply.code(400).send({ error: `That token was rejected by ${p.label}. Check it has ${scope}${baseUrl ? ` and that ${baseUrl} is the right instance` : ''}.` });
    }
  });

  providerRoute('post', 'disconnect', async (p, req, reply) => {
    if (requireSignIn(req, reply)) return;
    await remotes.disconnect(remoteUserId(req), p.id);
    return { ok: true };
  });

  // OAuth "Connect with <provider>" — links the signed-in user's account.
  providerRoute('get', 'oauth', async (p, req, reply) => {
    if (!p.oauthEnabled()) return reply.code(404).send({ error: `${p.label} OAuth is not configured` });
    if (auth.AUTH_ENABLED && !reqUser(req)) return reply.code(401).send({ error: 'Sign in required' });
    const state = crypto.randomBytes(12).toString('hex');
    reply.header('set-cookie', `aldine_remote_state=${p.id}.${state}; HttpOnly; SameSite=Lax; Path=${auth.COOKIE_PATH}; Max-Age=600${auth.SECURE_COOKIES ? '; Secure' : ''}`);
    return reply.redirect(p.connectUrl(state, `${publicBase(req)}${oauthCallbackPath(p)}`));
  });

  providerRoute('get', 'oauth/callback', async (p, req, reply) => {
    if (!p.oauthEnabled()) return reply.code(404).send({ error: `${p.label} OAuth is not configured` });
    const cookies = auth.parseCookies(req.headers.cookie);
    const q = req.query as { code?: string; state?: string };
    if (!q.code || !q.state || cookies.aldine_remote_state !== `${p.id}.${q.state}`) {
      return reply.code(400).send({ error: 'OAuth state mismatch — please try again' });
    }
    try {
      const token = await p.exchangeCode(q.code, `${publicBase(req)}${oauthCallbackPath(p)}`);
      const me = await p.whoami({ token, login: '' });
      await remotes.setConnection(remoteUserId(req), p.id, { token, login: me.login, name: me.name });
      reply.header('set-cookie', `aldine_remote_state=; Path=${auth.COOKIE_PATH}; Max-Age=0`);
      return reply.redirect(`${config.basePath}/?remote=${p.id}`);
    } catch (err: any) {
      return reply.code(400).send({ error: `${p.label} connect failed: ${err.message}` });
    }
  });

  providerRoute('get', 'repos', async (p, req, reply) => {
    if (requireSignIn(req, reply)) return;
    const conn = await remotes.getConnection(remoteUserId(req), p.id);
    if (!conn) return reply.code(400).send({ error: `${p.label} is not connected` });
    try { return await p.listRepos(conn); }
    catch (err: any) { return upstreamError(reply, err, p.label); }
  });

  // Import a repository as a new project (the primary create-project flow).
  providerRoute('post', 'import', async (p, req, reply) => {
    if (auth.AUTH_ENABLED && !reqUser(req)) return reply.code(401).send({ error: 'Sign in required' });
    const conn = await remotes.getConnection(remoteUserId(req), p.id);
    if (!conn) return reply.code(400).send({ error: `Connect ${p.label} first` });
    const fullName = String(req.body?.fullName || '').trim().replace(/^\/+|\/+$/g, '');
    if (!fullName.includes('/') || fullName.includes('..')) return reply.code(400).send({ error: p.id === 'github' ? 'Expected "owner/repo"' : 'Expected a project path like "group/project"' });
    let info: remotes.RemoteRepo;
    try { info = await p.getRepo(conn, fullName); }
    catch (err: any) { return reply.code(400).send({ error: `Repository not found or no access: ${err.message}` }); }
    const id = newId();
    try {
      const { remoteBranch } = await gitops.cloneRepo(id, p.tokenUrl(info.cloneUrl, conn.token));
      const rootFile = detectRoot(id, 'main');
      const meta: store.ProjectMeta = {
        id, name: info.name, rootFile, engine: 'pdf', createdAt: new Date().toISOString(),
        remote: { provider: p.id, fullName: info.fullName, owner: info.owner, repo: info.name, remoteBranch, cloneUrl: info.cloneUrl, connectedBy: remoteUserId(req) },
      };
      const ownerId = reqUser(req)?.id;
      if (ownerId) { meta.ownerId = ownerId; meta.share = { mode: 'private', collaborators: [] }; }
      await store.writeMeta(meta);
      return publicMeta(meta, reqUser(req));
    } catch (err: any) {
      fs.rmSync(store.repoDir(id), { recursive: true, force: true });
      return reply.code(400).send({ error: `Import failed: ${err.message}` });
    }
  });

  // ---------- per-project remote sync (provider from the stored link) ----------
  // Syncing pushes the project into the OWNER's repo and can pull remote state
  // over everyone's work, so every remote operation is members-only: link mode
  // grants editing, not control of where the project is mirrored.
  type Linked = { meta: store.ProjectMeta; link: store.RemoteLink; provider: Provider; conn: remotes.RemoteConnection; url: string; remoteBranch: string };
  const linkedRemote = async (req: any, reply: any, action = 'sync this project'): Promise<Linked | null> => {
    const meta = await requireMember(req, reply, action);
    if (!meta) return null;
    const link = store.remoteLink(meta);
    if (!link) { reply.code(400).send({ error: 'This project is not linked to a remote repository' }); return null; }
    const provider = remotes.getProvider(link.provider);
    if (!provider) { reply.code(400).send({ error: `This project is linked to ${link.provider}, which is disabled on this server` }); return null; }
    const conn = await remotes.resolveConnection(link, remoteUserId(req), { allowService: true });
    if (!conn) { reply.code(400).send({ error: `Connect ${provider.label} to sync` }); return null; }
    return { meta, link, provider, conn, url: provider.tokenUrl(link.cloneUrl, conn.token), remoteBranch: link.remoteBranch };
  };
  const projectRoute = (method: 'get' | 'post', tail: string, handler: (req: any, reply: any) => Promise<unknown>, legacyTail = tail) => {
    app[method](`/api/projects/:id/remote/${tail}`, handler);
    app[method](`/api/projects/:id/github/${legacyTail}`, handler);
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
    catch (err: any) { return reply.code(400).send({ error: `Could not create the repository: ${err.message}` }); }
    flushBranchDocs(req.params.id, 'main');
    await gitops.commitAll(req.params.id, 'main', `aldine: publish to ${p.label}`, reqUser(req)?.name).catch(() => {});
    const link: store.RemoteLink = { provider: p.id, fullName: info.fullName, owner: info.owner, repo: info.name, remoteBranch: 'main', cloneUrl: info.cloneUrl, connectedBy: remoteUserId(req) };
    store.setRemoteLink(meta, link);
    await store.writeMeta(meta);
    try { await gitops.pushToRemote(req.params.id, 'main', p.tokenUrl(info.cloneUrl, conn.token)); }
    catch (err: any) {
      // repo exists and the link is stored — the user can retry the push from the sync UI
      return reply.code(502).send({ error: `Repository created but the first push failed: ${err.message}. Use Push to retry.`, ...linkBody(link) });
    }
    return { ok: true, ...linkBody(link) };
  });

  projectRoute('get', 'status', async (req, reply) => {
    const l = await linkedRemote(req, reply); if (!l) return;
    try { return { linked: true, ...l.link, ...(await gitops.remoteStatus(req.params.id, l.remoteBranch, l.url)) }; }
    catch (err: any) { return reply.code(502).send({ error: err.message }); }
  });

  projectRoute('post', 'push', async (req, reply) => {
    const l = await linkedRemote(req, reply); if (!l) return;
    flushBranchDocs(req.params.id, 'main'); // capture unsaved editor content before committing
    const message = String(req.body?.message || '').trim() || 'Update from Aldine';
    const commit = await gitops.commitAll(req.params.id, 'main', message, reqUser(req)?.name).catch(() => ({ committed: false, hash: undefined as string | undefined }));
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
    } catch (err: any) { return reply.code(400).send({ error: `Push failed: ${err.message}` }); }
  });

  projectRoute('post', 'pull', async (req, reply) => {
    const l = await linkedRemote(req, reply); if (!l) return;
    flushBranchDocs(req.params.id, 'main');
    await gitops.commitAll(req.params.id, 'main', 'Local changes before pull', reqUser(req)?.name).catch(() => {});
    try {
      const result = await gitops.pullFromRemote(req.params.id, l.remoteBranch, l.url);
      if (!result.ok) return reply.code(409).send({ error: 'Merge conflict', conflicts: result.conflicts });
      refreshBranchDocsFromDisk(req.params.id, 'main'); // push the merged content into open editors
      return { ok: true };
    } catch (err: any) { return reply.code(400).send({ error: `Pull failed: ${err.message}` }); }
  });

  // Conflict escape hatch: discard local changes and take the remote version.
  // Destroys everyone's unpushed work, so it is the owner's call alone.
  projectRoute('post', 'reset-to-remote', async (req, reply) => {
    if (!(await requireOwner(req, reply, 'discard local changes'))) return;
    const l = await linkedRemote(req, reply); if (!l) return;
    try {
      await gitops.resetToRemote(req.params.id, l.remoteBranch, l.url);
      refreshBranchDocsFromDisk(req.params.id, 'main');
      return { ok: true };
    } catch (err: any) { return reply.code(400).send({ error: `Reset failed: ${err.message}` }); }
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
    } catch (err: any) { return upstreamError(reply, err, l.provider.label); }
  });

  // Switch which remote branch this project tracks. Saves current work (commit +
  // push) first so nothing is lost, then checks out the target branch.
  projectRoute('post', 'switch-branch', async (req, reply) => {
    // Persists the link's remoteBranch — repoints the project for everyone.
    if (!(await requireOwner(req, reply, 'change the tracked remote branch'))) return;
    const l = await linkedRemote(req, reply); if (!l) return;
    const target = String(req.body?.branch || '').trim();
    if (!target) return reply.code(400).send({ error: 'branch required' });
    if (target === l.remoteBranch) return { ok: true };
    flushBranchDocs(req.params.id, 'main');
    try {
      await gitops.commitAll(req.params.id, 'main', 'Save before switching branch', reqUser(req)?.name).catch(() => {});
      await gitops.pushToRemote(req.params.id, l.remoteBranch, l.url).catch(() => {}); // best-effort save
      await gitops.resetToRemote(req.params.id, target, l.url);
      store.setRemoteLink(l.meta, { ...l.link, remoteBranch: target }); await store.writeMeta(l.meta);
      refreshBranchDocsFromDisk(req.params.id, 'main');
      return { ok: true, branch: target };
    } catch (err: any) { return reply.code(400).send({ error: `Switch failed: ${err.message}` }); }
  });

  // Create a new remote branch from the current content and switch to it.
  projectRoute('post', 'create-branch', async (req, reply) => {
    const l = await linkedRemote(req, reply); if (!l) return;
    const name = String(req.body?.name || '').trim();
    // Use the same BRANCH_RE gitops enforces on push/pull, so a name the UI
    // accepts can't later be rejected by git after a stray commit is written.
    if (!BRANCH_RE.test(name) || name.includes('..')) return reply.code(400).send({ error: 'Invalid branch name' });
    flushBranchDocs(req.params.id, 'main');
    try {
      await gitops.commitAll(req.params.id, 'main', `Start branch ${name}`, reqUser(req)?.name).catch(() => {});
      await gitops.pushToRemote(req.params.id, name, l.url); // push creates the remote branch
      store.setRemoteLink(l.meta, { ...l.link, remoteBranch: name }); await store.writeMeta(l.meta);
      return { ok: true, branch: name };
    } catch (err: any) { return reply.code(400).send({ error: `Create branch failed: ${err.message}` }); }
  });

  // Open a pull/merge request from the current branch into the repo's default branch.
  projectRoute('post', 'change-request', async (req, reply) => {
    const l = await linkedRemote(req, reply); if (!l) return;
    const noun = l.provider.changeRequestLabel;
    try {
      flushBranchDocs(req.params.id, 'main'); // capture unsaved editor content before committing (parity with push/pull/switch/create)
      await gitops.commitAll(req.params.id, 'main', `Update before ${noun}`, reqUser(req)?.name).catch(() => {});
      await gitops.pushToRemote(req.params.id, l.remoteBranch, l.url);
      const repo = await l.provider.getRepo(l.conn, l.link.fullName);
      if (l.remoteBranch === repo.defaultBranch) return reply.code(400).send({ error: `You're on the default branch (${repo.defaultBranch}). Create a branch first.` });
      return await l.provider.createChangeRequest(l.conn, l.link.fullName, {
        title: String(req.body?.title || '').trim() || `Update ${l.remoteBranch}`,
        head: l.remoteBranch,
        base: repo.defaultBranch,
      });
    } catch (err: any) {
      if (err instanceof remotes.RemoteApiError) return upstreamError(reply, err, l.provider.label);
      return reply.code(400).send({ error: `Could not open the ${noun}: ${err.message}` });
    }
  }, 'pr');

  // Server-side autopush is the owner's call: it decides what leaves the server and when.
  projectRoute('post', 'autopush', async (req, reply) => {
    if (!(await requireOwner(req, reply, 'change autopush'))) return;
    const meta = await store.readMeta(req.params.id);
    if (!store.remoteLink(meta)) return reply.code(400).send({ error: 'This project is not linked to a remote repository' });
    if (typeof req.body?.enabled !== 'boolean') return reply.code(400).send({ error: 'enabled must be true or false' });
    meta.autopush = req.body.enabled;
    await store.writeMeta(meta);
    if (meta.autopush) scheduleAutopush(req.params.id); else cancelAutopush(req.params.id);
    return { ok: true, autopush: meta.autopush };
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
  app.get('/api/ai/status', async () => ({ configured: aiConfigured(), model: aiModel() }));

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
  app.get('/api/plugins', async () => listPlugins());

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
