/**
 * Sync failures in plain sentences (sync-errors.ts): the stderr git prints
 * and the JSON the three hosts answer with, for the cases a co-author meets,
 * each mapped to a sentence that names the next step and a code the editor
 * turns into its button. Text nobody recognises stays null, so the route
 * keeps its own message.
 */
import { check, eq } from './assert.mjs';

const { explainGitFailure, explainCreateRepoFailure, explainChangeRequestFailure, explainRepoReadFailure, noAnswer } = await import('../src/sync-errors.ts');
const { RemoteApiError } = await import('../src/remote-types.ts');

const ctx = { label: 'GitHub', fullName: 'octo/paper', branch: 'main', op: 'push' };

// ---- the host has commits main lacks ----
for (const stderr of [
  "To https://github.com/octo/paper.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'https://github.com/octo/paper.git'\nhint: Updates were rejected because the remote contains work that you do\nhint: not have locally.",
  " ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs to 'file:///tmp/x.git'",
]) {
  const r = explainGitFailure(stderr, ctx);
  eq(r?.code, 'pull-first', 'a rejected push asks for a pull');
  eq(r?.status, 409, 'as a 409');
  eq(r?.error, 'GitHub has newer commits on main. Pull first, then push.', 'in one sentence');
}
eq(explainGitFailure(' ! [rejected]        main -> main (fetch first)', { ...ctx, op: 'fetch' }), null, 'a fetch never says pull first');

// ---- the token can read but not push ----
for (const stderr of [
  "remote: Permission to octo/paper.git denied to someone.\nfatal: unable to access 'https://github.com/octo/paper.git/': The requested URL returned error: 403",
  "remote: You are not allowed to push code to this project.\nfatal: unable to access 'https://gitlab.com/g/p.git/': The requested URL returned error: 403",
  "remote: User permission denied for writing.\nfatal: unable to access 'https://codeberg.org/o/r.git/': The requested URL returned error: 403",
]) {
  const r = explainGitFailure(stderr, ctx);
  eq(r?.code, 'no-access', `403 on push → no-access (${stderr.slice(0, 30)})`);
  eq(r?.error, 'This token can read octo/paper but not push to it. Replace it in Git access.', 'names the repository and where to fix it');
}
eq(explainGitFailure("fatal: unable to access 'https://x/y.git/': The requested URL returned error: 403", { ...ctx, op: 'fetch' })?.error,
  'GitHub refused this token access to octo/paper. Replace it in Git access.', 'a refused fetch does not claim the token can read');

// ---- protected branches, before the generic refusals ----
{
  const gh = explainGitFailure('remote: error: GH006: Protected branch update failed for refs/heads/main.\nremote: error: Changes must be made through a pull request.\n ! [remote rejected] main -> main (protected branch hook declined)', ctx);
  eq(gh?.code, 'protected-branch', 'GitHub protected branch');
  eq(gh?.error, 'main is protected on GitHub, so this account cannot push to it. Ask a maintainer of octo/paper to allow it.', 'says who can change it');
  const gl = explainGitFailure('remote: GitLab: You are not allowed to push code to protected branches on this project.\n ! [remote rejected] main -> main (pre-receive hook declined)', { ...ctx, label: 'GitLab' });
  eq(gl?.code, 'protected-branch', 'GitLab protected branch, although its text also says "not allowed to push"');
}

// ---- a hook refused: the host's own words, quoted ----
{
  const r = explainGitFailure('remote: pushes are closed        \nTo /tmp/bare.git\n ! [remote rejected] main -> main (pre-receive hook declined)\nerror: failed to push some refs to \'/tmp/bare.git\'', ctx);
  eq(r?.code, 'remote-rejected', 'remote rejected');
  eq(r?.error, 'GitHub refused the push, saying "pushes are closed".', 'quotes the remote line, padding dropped');
  eq(explainGitFailure(' ! [remote rejected] main -> main (pre-receive hook declined)', ctx)?.error, 'GitHub refused the push, saying "pre-receive hook declined".', 'without remote lines, the reason git names');
}

// ---- the host is not answering ----
for (const stderr of [
  "fatal: unable to access 'https://github.com/octo/paper.git/': Could not resolve host: github.com",
  "fatal: unable to access 'https://gitlab.example.org/g/p.git/': Failed to connect to gitlab.example.org port 443 after 3 ms: Connection refused",
  "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 503",
]) {
  const r = explainGitFailure(stderr, { ...ctx, op: 'fetch' });
  eq(r?.code, 'unreachable', `unreachable (${stderr.slice(-30)})`);
  eq(r?.status, 502, 'as a 502');
}
eq(explainGitFailure('Could not resolve host: gitlab.example.org', { ...ctx, label: 'GitLab', host: 'gitlab.example.org' })?.error,
  'Could not reach gitlab.example.org just now. Try again in a moment.', 'a self-hosted instance is named by its host');

// ---- the repository or the branch is gone ----
eq(explainGitFailure("remote: Repository not found.\nfatal: repository 'https://github.com/octo/paper.git/' not found", { ...ctx, op: 'fetch' })?.code, 'repo-missing', 'repository not found');
{
  const r = explainGitFailure("fatal: couldn't find remote ref main", { ...ctx, op: 'fetch' });
  eq(r?.code, 'branch-missing', 'branch gone');
  eq(r?.error, 'GitHub has no branch main. Push to create it, or switch to another branch.', 'says how to bring it back');
}
eq(explainGitFailure('remote: HTTP Basic: Access denied\nfatal: Authentication failed for \'https://gitlab.com/g/p.git/\'', ctx)?.code, 'no-access', 'git refusing the credential');

// ---- anything else is left to the caller ----
eq(explainGitFailure('error: some other trouble', ctx), null, 'unknown text → null');
eq(explainGitFailure('', ctx), null, 'empty → null');

// ---- Import: the clone, before any project has a Git access ----
{
  const clone = { ...ctx, op: 'clone' };
  eq(explainGitFailure("remote: Repository not found.\nfatal: repository 'https://github.com/octo/paper.git/' not found", clone)?.error,
    'GitHub has no repository octo/paper that this token can see. Check the name, or use a token with access to it.', 'a missing repository, with the fix Import has');
  eq(explainGitFailure("fatal: repository '/tmp/gone.git' does not exist", clone)?.code, 'repo-missing', "git's own words for a missing local repository");
  eq(explainGitFailure("fatal: unable to access 'https://github.com/octo/paper.git/': The requested URL returned error: 403", clone)?.error,
    'GitHub refused this token access to octo/paper. Use a token with access to it.', 'a token that cannot read, without Git access');
  eq(explainGitFailure("fatal: Authentication failed for 'https://gitlab.com/g/p.git/'", clone)?.error, 'GitHub did not accept this token for git. Use another token.', 'a refused credential');
  eq(explainGitFailure('Could not resolve host: github.com', clone)?.code, 'unreachable', 'no answer');
}

// ---- Import: reading the repository through the API ----
{
  const read = { label: 'GitLab', fullName: 'grp/sub/paper' };
  const missing = explainRepoReadFailure(new RemoteApiError('GitLab API 404: {"message":"404 Project Not Found"}', 404), read);
  eq(missing?.code, 'repo-missing', '404 → repo-missing');
  eq(missing?.status, 404, 'as a 404');
  eq(missing?.error, 'GitLab has no repository grp/sub/paper that this token can see. Check the name, or use a token with access to it.', 'names the path and the two fixes');
  eq(explainRepoReadFailure(new RemoteApiError('GitLab API 403: {"message":"403 Forbidden"}', 403), read)?.error,
    'This GitLab token cannot read grp/sub/paper. Use a token with access to it.', '403 → no access');
  eq(explainRepoReadFailure(new RemoteApiError('GitLab API 401: {"message":"401 Unauthorized"}', 401), read)?.code, 'token-invalid', '401 → a refused token');
  eq(explainRepoReadFailure(new RemoteApiError('GitLab API 503: <html>', 503), { ...read, host: 'gitlab.example.org' })?.error,
    'gitlab.example.org is not answering right now. Try again in a moment.', '5xx → the instance, by name');
  const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }) });
  check(noAnswer(refused), 'fetch failing with a refused connection is no answer');
  eq(explainRepoReadFailure(refused, read)?.error, 'Could not reach GitLab just now. Try again in a moment.', 'and said so');
  check(!noAnswer(new RemoteApiError('x', 500)) && !noAnswer(new Error('Expected "owner/repo"')), 'a host answer or our own refusal is not');
  eq(explainRepoReadFailure(new Error('Expected "owner/repo"'), read), null, 'a path refused before the network keeps the route message');
  eq(explainRepoReadFailure(new RemoteApiError('GitLab API 422: {}', 422), read), null, 'an answer nobody mapped → null');
}

// ---- Publish ----
const repo = { label: 'GitHub', owner: 'octo', name: 'paper', scopeHint: 'repo scope' };
for (const [status, body] of [
  [422, 'GitHub API 422: {"message":"Repository creation failed.","errors":[{"resource":"Repository","code":"custom","field":"name","message":"name already exists on this account"}]}'],
  [400, 'GitLab API 400: {"message":{"name":["has already been taken"],"path":["has already been taken"]}}'],
  [409, 'Gitea API 409: {"message":"The repository with the same name already exists."}'],
]) {
  const r = explainCreateRepoFailure(new RemoteApiError(body, status), repo);
  eq(r?.code, 'name-taken', `name in use (${status})`);
  eq(r?.error, 'octo already has a repository called paper on GitHub. Pick another name.', 'names owner and name');
}
eq(explainCreateRepoFailure(new RemoteApiError('GitHub API 403: {"message":"You need admin access to the organization before adding a repository to it."}', 403), { ...repo, owner: 'acme' })?.error,
  'This GitHub token cannot create a repository in acme. Check it has repo scope, or pick another owner.', 'an owner the token may not create in');
eq(explainCreateRepoFailure(new RemoteApiError('GitHub API 404: {"message":"Not Found"}', 404), repo), null, 'a 404 keeps the route message');
eq(explainCreateRepoFailure(new Error('boom'), repo), null, 'not a host answer → null');

// ---- pull and merge requests ----
const cr = { label: 'GitHub', noun: 'pull request', head: 'feature-x', base: 'main' };
for (const [status, body] of [
  [422, 'GitHub API 422: {"message":"Validation Failed","errors":[{"resource":"PullRequest","code":"custom","message":"A pull request already exists for octo:feature-x."}]}'],
  [409, 'GitLab API 409: {"message":["Another open merge request already exists for this source branch: !3"]}'],
  [409, 'Gitea API 409: {"message":"pull request already exists for these targets [id: 1, issue_id: 2, head_repo_id: 3, base_repo_id: 3, head_branch: feature-x, base_branch: main]"}'],
]) {
  const r = explainChangeRequestFailure(new RemoteApiError(body, status), cr);
  eq(r?.code, 'change-request-open', `already open (${status})`);
}
{
  const r = explainChangeRequestFailure(new RemoteApiError('GitHub API 422: {"message":"Validation Failed","errors":[{"resource":"PullRequest","code":"custom","message":"No commits between main and feature-x"}]}', 422), cr);
  eq(r?.code, 'nothing-to-compare', 'no commits between');
  eq(r?.error, 'feature-x has nothing that main lacks yet. Change something on feature-x first, then open the pull request.', 'says what to do first');
}
check(explainChangeRequestFailure(new RemoteApiError('GitHub API 500: {}', 500), cr) === null, 'a server error keeps the route message');

console.log('sync-errors: all assertions passed');
