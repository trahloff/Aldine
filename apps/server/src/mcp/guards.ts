import crypto from 'node:crypto';
import * as auth from '../auth.js';
import { readMeta, type ProjectMeta } from '../store.js';
import { canAccess } from '../authz.js';
import { protectedProjects } from '../collab.js';
import { isHiddenPath } from '../util.js';

/**
 * Auth and shared authorization helpers for the MCP surface. Tool handlers
 * receive an `McpIdentity` and must never re-derive identity themselves —
 * this module is the only place a credential is inspected.
 */

/** Identity a tool call runs as. `user` is null only in operator mode
 *  (auth disabled, or the stdio transport's implicit local operator). */
export interface McpIdentity {
  user: auth.PublicUser | null;
  tokenScope: auth.TokenScope | null;
}

/** Constant-time string compare via digests — inputs may differ in length,
 *  and timingSafeEqual throws on unequal-length buffers. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const da = crypto.createHash('sha256').update(a).digest();
  const db = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(da, db);
}

/**
 * Resolve the Authorization header to an identity, per the SECURITY.md rule
 * that the no-credential configuration is unrepresentable:
 * - AUTH_ENABLED → a live `aldn_` PAT is required (scope carried through);
 * - else, an operator-set ALDINE_MCP_TOKEN is required;
 * - neither configured → null for every request (unconditional 401).
 */
export async function authenticateMcp(
  authorizationHeader: string | undefined,
  staticToken: string | undefined,
): Promise<McpIdentity | null> {
  if (auth.AUTH_ENABLED) {
    const hit = await auth.userFromToken(authorizationHeader);
    return hit ? { user: hit.user, tokenScope: hit.tokenScope } : null;
  }
  if (staticToken) {
    const m = /^Bearer\s+(\S+)$/.exec((authorizationHeader || '').trim());
    if (m && timingSafeEqualStr(m[1], staticToken)) return { user: null, tokenScope: null };
    return null;
  }
  return null;
}

/** Authorization failure a tool handler converts into an isError result with
 *  the message as user-fixable prose (UX.md failure etiquette). */
export class McpDenied extends Error {}

/**
 * Resolve + authorize the `project` argument of a tool call using the SAME
 * predicates as REST (SECURITY.md: shared functions, never copies): trash
 * behaves as gone, canAccess gates membership/link mode, and the token's
 * project scope is enforced here because the routes.ts preHandler only covers
 * /api/* — /mcp never passes through it. A token scoped to exactly one
 * project makes `project` optional (the token is the context).
 */
export async function resolveProject(identity: McpIdentity, project: string | undefined): Promise<ProjectMeta> {
  let id = project;
  if (!id) {
    const scoped = identity.tokenScope?.projectIds;
    if (scoped && scoped.length === 1) id = scoped[0];
    else throw new McpDenied('Pass a project id — this token is not scoped to a single project (use list_projects)');
  }
  if (identity.tokenScope?.projectIds && !identity.tokenScope.projectIds.includes(id)) {
    throw new McpDenied('This token does not have access to that project');
  }
  let meta: ProjectMeta;
  try { meta = await readMeta(id); } catch { throw new McpDenied('Project not found'); }
  if (meta.deletedAt) throw new McpDenied('Project not found');
  if (!canAccess(meta, identity.user)) throw new McpDenied('You do not have access to this project');
  return meta;
}

/** Showcase (protected) projects are world-readable, nobody-writable — same
 *  set the REST preHandler and the collab read-only hook enforce. */
export function assertWritableProject(projectId: string): void {
  if (protectedProjects.has(projectId)) throw new McpDenied('That project is read-only');
}

/** Same hidden-path rule as REST file routes (git internals, compile output). */
export function assertVisiblePath(rel: string): void {
  if (!rel || rel.includes('..') || isHiddenPath(rel)) throw new McpDenied('Invalid file path');
}

/**
 * Rate-limit keys, all of which must pass (SECURITY.md: "mcpLimiter per token
 * + IP"). The IP key comes FIRST: the bearer is attacker-chosen and unvalidated
 * at this point, so a token-only key would hand a rotating credential-stuffer a
 * fresh bucket per guess (and grow the bucket map per guess) — the unforgeable
 * IP bucket must gate before any token-keyed bucket is created. The token key
 * is a digest, never the raw secret — limiter keys reach logs and Redis.
 */
export function mcpRateKeys(authorizationHeader: string | undefined, ip: string | undefined): string[] {
  const keys = [`ip:${ip || 'unknown'}`];
  const m = /^Bearer\s+(\S+)$/.exec((authorizationHeader || '').trim());
  if (m) keys.push(`t:${crypto.createHash('sha256').update(m[1]).digest('hex').slice(0, 32)}`);
  return keys;
}
