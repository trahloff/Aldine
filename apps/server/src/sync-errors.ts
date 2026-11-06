import { RemoteApiError } from './remote-types.js';

/**
 * A failed sync in words a co-author can act on: what happened and the next
 * step, plus a `code` the editor turns into that step's button. Recognises
 * the texts git and the three hosts print for the common failures; anything
 * else is null, and the caller keeps its own message.
 */
export type SyncCode =
  | 'pull-first' | 'no-access' | 'token-invalid' | 'repo-missing' | 'protected-branch' | 'remote-rejected' | 'branch-missing' | 'unreachable'
  | 'name-taken' | 'no-create' | 'change-request-open' | 'nothing-to-compare';

export interface SyncRefusal { status: number; error: string; code: SyncCode }

export interface GitContext {
  /** The host as people call it: "GitHub", "GitLab". */
  label: string;
  /** The instance's host name when it is not the provider's own (self-hosted), for "Could not reach …". */
  host?: string;
  fullName: string;
  branch: string;
  /** A push writes; a fetch (status, pull, reset) only reads; a clone
   *  (Import) reads too, before any project has a Git access to fix it in. */
  op: 'push' | 'fetch' | 'clone';
}

/** What the host printed through git, one line: `remote:` lines, without git's padding. */
function remoteSays(message: string): string {
  return message.split('\n')
    .map((l) => /^remote:\s*(.*)$/.exec(l.trim())?.[1]?.trim() ?? '')
    .filter((l) => l && !/^(error|warning|hint):?$/i.test(l))
    .slice(0, 2)
    .join(' ')
    .replace(/[.\s]+$/, '');
}

export function explainGitFailure(message: string, ctx: GitContext): SyncRefusal | null {
  const m = String(message || '');
  const { label, fullName, branch } = ctx;
  const fix = ctx.op === 'clone' ? 'Use a token with access to it.' : 'Replace it in Git access.';
  if (/Could not resolve host|Failed to connect to|Couldn't connect to server|Connection refused|Connection timed out|Operation timed out|Network is unreachable|returned error: 5\d\d/i.test(m)) {
    return { status: 502, code: 'unreachable', error: `Could not reach ${ctx.host ?? label} just now. Try again in a moment.` };
  }
  if (ctx.op === 'push' && /\[rejected\][^\n]*\((?:fetch first|non-fast-forward)\)|Updates were rejected because/.test(m)) {
    return { status: 409, code: 'pull-first', error: `${label} has newer commits on ${branch}. Pull first, then push.` };
  }
  if (ctx.op === 'push' && /protected branch|GH006/i.test(m)) {
    return { status: 403, code: 'protected-branch', error: `${branch} is protected on ${label}, so this account cannot push to it. Ask a maintainer of ${fullName} to allow it.` };
  }
  if (/returned error: 403|Permission to \S+ denied|not allowed to push|permission denied for writing|write access to repository not granted/i.test(m)) {
    return {
      status: 403, code: 'no-access',
      error: ctx.op === 'push'
        ? `This token can read ${fullName} but not push to it. Replace it in Git access.`
        : `${label} refused this token access to ${fullName}. ${fix}`,
    };
  }
  if (/Authentication failed|returned error: 401|Invalid username or password|HTTP Basic: Access denied/i.test(m)) {
    return { status: 403, code: 'no-access', error: `${label} did not accept this token for git. ${ctx.op === 'clone' ? 'Use another token.' : fix}` };
  }
  if (/Repository not found|repository '[^']*' (?:not found|does not exist)|does not appear to be a git repository|returned error: 404/i.test(m)) {
    return {
      status: 404, code: 'repo-missing',
      error: ctx.op === 'clone'
        ? `${label} has no repository ${fullName} that this token can see. Check the name, or use a token with access to it.`
        : `${label} has no repository ${fullName} that this token can see. It may have been renamed or deleted, or the token has no access; check Git access.`,
    };
  }
  if (/couldn't find remote ref/i.test(m)) {
    return { status: 404, code: 'branch-missing', error: `${label} has no branch ${branch}. Push to create it, or switch to another branch.` };
  }
  const rejected = /\[remote rejected\][^\n]*\(([^)\n]+)\)/.exec(m);
  if (rejected) {
    const said = remoteSays(m) || rejected[1];
    return { status: 403, code: 'remote-rejected', error: `${label} refused the push, saying "${said}".` };
  }
  return null;
}

/** The codes fetch() leaves in `cause` when no answer came at all. */
const NO_ANSWER = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT']);

/** The host gave no answer: fetch() failed before any HTTP status. */
export function noAnswer(err: any): boolean {
  return !(err instanceof RemoteApiError) && (NO_ANSWER.has(err?.cause?.code) || err?.message === 'fetch failed');
}

export interface ReadRepoContext { label: string; host?: string; fullName: string }

/** Reading a repository through the host's API (Import): not there, out of
 *  the token's reach, a refused token, or no answer. */
export function explainRepoReadFailure(err: unknown, ctx: ReadRepoContext): SyncRefusal | null {
  const where = ctx.host ?? ctx.label;
  if (noAnswer(err)) return { status: 502, code: 'unreachable', error: `Could not reach ${where} just now. Try again in a moment.` };
  if (!(err instanceof RemoteApiError)) return null;
  if (err.status === 404) return { status: 404, code: 'repo-missing', error: `${ctx.label} has no repository ${ctx.fullName} that this token can see. Check the name, or use a token with access to it.` };
  if (err.status === 403) return { status: 403, code: 'no-access', error: `This ${ctx.label} token cannot read ${ctx.fullName}. Use a token with access to it.` };
  if (err.status === 401) return { status: 401, code: 'token-invalid', error: `${ctx.label} rejected this token. Connect again, or use another token.` };
  if (err.status >= 500) return { status: 502, code: 'unreachable', error: `${where} is not answering right now. Try again in a moment.` };
  return null;
}

export interface CreateRepoContext { label: string; owner: string; name: string; scopeHint: string }

/** Creating a repository (Publish): a name in use, or an owner the token may not create in. */
export function explainCreateRepoFailure(err: unknown, ctx: CreateRepoContext): SyncRefusal | null {
  if (!(err instanceof RemoteApiError)) return null;
  const m = err.message;
  if ((err.status === 422 && /name already exists/i.test(m)) || (err.status === 400 && /has already been taken/i.test(m)) || (err.status === 409 && /already exists/i.test(m))) {
    return { status: 409, code: 'name-taken', error: `${ctx.owner} already has a repository called ${ctx.name} on ${ctx.label}. Pick another name.` };
  }
  if (err.status === 403) {
    return { status: 403, code: 'no-create', error: `This ${ctx.label} token cannot create a repository in ${ctx.owner}. Check it has ${ctx.scopeHint}, or pick another owner.` };
  }
  return null;
}

export interface ChangeRequestContext { label: string; noun: string; head: string; base: string }

/** Opening a pull or merge request: one is already open, or the branch has nothing to propose. */
export function explainChangeRequestFailure(err: unknown, ctx: ChangeRequestContext): SyncRefusal | null {
  if (!(err instanceof RemoteApiError)) return null;
  const m = err.message;
  if ((err.status === 422 || err.status === 409) && /already exists/i.test(m)) {
    return { status: 409, code: 'change-request-open', error: `A ${ctx.noun} from ${ctx.head} into ${ctx.base} is already open on ${ctx.label}.` };
  }
  if ((err.status === 422 || err.status === 409 || err.status === 400) && /no commits between|no changes between|there are no changes/i.test(m)) {
    return { status: 409, code: 'nothing-to-compare', error: `${ctx.head} has nothing that ${ctx.base} lacks yet. Change something on ${ctx.head} first, then open the ${ctx.noun}.` };
  }
  return null;
}
