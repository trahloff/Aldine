/**
 * Remote-provider plumbing that needs no network: GitLab URL/path helpers,
 * the token-in-URL rule both providers share, the legacy `github` → `remote`
 * shim on project meta, and the REMOTE_PROVIDERS allowlist.
 *
 * Env before any src import: the data/meta roots are read at module load, and
 * GITLAB_API_BASE must be unset for the https rule to apply.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq, throws } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-remotes-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
delete process.env.GITLAB_API_BASE;
delete process.env.GITLAB_URL;
delete process.env.REMOTE_PROVIDERS;

const gitlab = await import('../src/gitlab.ts');
const { github } = await import('../src/github.ts');
const gitops = await import('../src/gitops.ts');
const store = await import('../src/store.ts');
const remotes = await import('../src/remotes.ts');

// ---------- gitlab.normalizeBaseUrl ----------
eq(gitlab.normalizeBaseUrl('  https://gitlab.example.org/  '), 'https://gitlab.example.org', 'trims and strips the trailing slash');
eq(gitlab.normalizeBaseUrl('https://gitlab.example.org///'), 'https://gitlab.example.org', 'strips repeated trailing slashes');
eq(gitlab.normalizeBaseUrl('https://gitlab.example.org/gl/'), 'https://gitlab.example.org/gl', 'keeps a sub-path install');
eq(gitlab.normalizeBaseUrl('https://gitlab.example.org:8443/gl'), 'https://gitlab.example.org:8443/gl', 'keeps a port');
eq(gitlab.normalizeBaseUrl('https://gitlab.com'), 'https://gitlab.com', 'bare origin unchanged');
eq(gitlab.normalizeBaseUrl(undefined), undefined, 'undefined for undefined');
eq(gitlab.normalizeBaseUrl(''), undefined, 'undefined for empty');
eq(gitlab.normalizeBaseUrl('   '), undefined, 'undefined for whitespace');
await throws(() => gitlab.normalizeBaseUrl('http://gitlab.example.org'), 'https://', 'rejects http:// when GITLAB_API_BASE is unset');
await throws(() => gitlab.normalizeBaseUrl('ftp://gitlab.example.org'), 'https://', 'rejects non-http schemes');
await throws(() => gitlab.normalizeBaseUrl('gitlab.example.org'), 'https://', 'rejects a bare host (no scheme)');
await throws(() => gitlab.normalizeBaseUrl('not a url'), 'https://', 'rejects garbage');
await throws(() => gitlab.normalizeBaseUrl('https://gitlab.example.org/?x=1'), 'query', 'rejects a query string');
await throws(() => gitlab.normalizeBaseUrl('https://gitlab.example.org/#top'), 'fragment', 'rejects a fragment');
process.env.GITLAB_API_BASE = 'http://localhost:1';
eq(gitlab.normalizeBaseUrl('http://gitlab.example.org/'), 'http://gitlab.example.org', 'GITLAB_API_BASE (tests) lifts the https rule');
await throws(() => gitlab.normalizeBaseUrl('not a url'), 'https://', 'but garbage is still refused');
delete process.env.GITLAB_API_BASE;

// ---------- gitlab.apiBase ----------
eq(gitlab.apiBase({ token: 't', login: 'u', baseUrl: 'https://gitlab.example.org/gl' }), 'https://gitlab.example.org/gl/api/v4', 'connection baseUrl wins');
eq(gitlab.apiBase({ token: 't', login: 'u' }), 'https://gitlab.com/api/v4', 'defaults to gitlab.com');
process.env.GITLAB_URL = 'https://gl.corp.example/';
eq(gitlab.apiBase({ token: 't', login: 'u' }), 'https://gl.corp.example/api/v4', 'GITLAB_URL for connections without their own base');
delete process.env.GITLAB_URL;
process.env.GITLAB_API_BASE = 'http://localhost:4921/';
eq(gitlab.apiBase({ token: 't', login: 'u', baseUrl: 'https://gitlab.example.org' }), 'http://localhost:4921', 'GITLAB_API_BASE replaces the whole prefix');
delete process.env.GITLAB_API_BASE;

// ---------- gitlab.encodePath ----------
eq(gitlab.encodePath('grp/sub/paper'), 'grp%2Fsub%2Fpaper', 'every slash percent-encoded');
eq(gitlab.encodePath('owner/paper'), 'owner%2Fpaper', 'two segments');
eq(gitlab.encodePath('grp/my paper.tex'), 'grp%2Fmy%20paper.tex', 'other reserved characters encoded too');

// ---------- gitlab.mapProject ----------
const raw = {
  id: 7, path_with_namespace: 'grp/sub/paper', path: 'paper', name: 'Paper',
  namespace: { full_path: 'grp/sub' }, visibility: 'internal', default_branch: 'trunk',
  http_url_to_repo: 'https://gitlab.example.org/grp/sub/paper.git', last_activity_at: '2026-02-02T00:00:00Z',
};
eq(gitlab.mapProject(raw), {
  fullName: 'grp/sub/paper', name: 'paper', owner: 'grp/sub', private: true, defaultBranch: 'trunk',
  cloneUrl: 'https://gitlab.example.org/grp/sub/paper.git', updatedAt: '2026-02-02T00:00:00Z',
}, 'internal project maps to private with the namespace as owner');
check(gitlab.mapProject({ ...raw, visibility: 'private' }).private === true, 'private → private');
check(gitlab.mapProject({ ...raw, visibility: 'public' }).private === false, 'public → not private');
eq(gitlab.mapProject({ ...raw, default_branch: null }).defaultBranch, 'main', 'defaultBranch falls back to main (unborn repo)');
eq(gitlab.mapProject({ ...raw, default_branch: undefined }).defaultBranch, 'main', 'defaultBranch falls back to main (missing)');
eq(gitlab.mapProject({ ...raw, namespace: undefined }).owner, 'grp/sub', 'owner derived from the path when namespace is absent');
eq(gitlab.mapProject({ ...raw, path: undefined }).name, 'Paper', 'name falls back to the display name');
eq(gitlab.mapProject({ ...raw, last_activity_at: undefined, created_at: '2026-01-01' }).updatedAt, '2026-01-01', 'updatedAt falls back to created_at');

// ---------- gitlab.slugPath ----------
eq(gitlab.slugPath('New Paper'), 'new-paper', 'spaces → dashes, lower-case');
eq(gitlab.slugPath('  Neural  Nets!! '), 'neural-nets', 'runs of junk collapse to one dash, none trailing');
eq(gitlab.slugPath('paper.git'), 'paper', 'strips a .git suffix');
eq(gitlab.slugPath('feed.atom'), 'feed', 'strips an .atom suffix');
eq(gitlab.slugPath('-leading'), 'leading', 'no leading dash');
eq(gitlab.slugPath('.hidden'), 'hidden', 'no leading dot');
eq(gitlab.slugPath('keep_under.score-ok'), 'keep_under.score-ok', 'underscore, dot and dash survive');
check(gitlab.slugPath('x'.repeat(200)).length === 100, 'capped at 100 characters');
eq(gitlab.slugPath('!!!'), '', 'nothing usable → empty (caller decides)');

// ---------- gitops.injectToken / stripCreds ----------
eq(gitops.injectToken('https://gitlab.example.org/grp/paper.git', 'oauth2', 'glpat-abc'), 'https://oauth2:glpat-abc@gitlab.example.org/grp/paper.git', 'https gets user:token@');
eq(gitops.injectToken('http://localhost:8929/grp/paper.git', 'oauth2', 'tok'), 'http://oauth2:tok@localhost:8929/grp/paper.git', 'plain http (a local instance) too');
eq(gitops.injectToken('https://github.com/o/r.git', 'x-access-token', 'a/b:c@d e'), 'https://x-access-token:a%2Fb%3Ac%40d%20e@github.com/o/r.git', 'special characters in the token are encoded');
eq(gitops.injectToken('https://gh.example/o/r.git', 'us er', 't'), 'https://us%20er:t@gh.example/o/r.git', 'user is encoded too');
eq(gitops.injectToken('file:///tmp/bare.git', 'oauth2', 'tok'), 'file:///tmp/bare.git', 'file:// passes through unchanged');
eq(gitops.injectToken('git@github.com:o/r.git', 'oauth2', 'tok'), 'git@github.com:o/r.git', 'ssh passes through unchanged');
eq(gitops.injectToken('https://old:secret@gitlab.example.org/grp/paper.git', 'oauth2', 'new'), 'https://oauth2:new@gitlab.example.org/grp/paper.git', 'existing credentials are replaced, not nested');
eq(gitops.stripCreds('https://oauth2:new@gitlab.example.org/grp/paper.git'), 'https://gitlab.example.org/grp/paper.git', 'stripCreds removes them');
eq(gitops.stripCreds('https://gitlab.example.org/grp/paper.git'), 'https://gitlab.example.org/grp/paper.git', 'stripCreds is a no-op without credentials');
check(!gitops.injectToken('https://gitlab.example.org/grp/paper.git', 'oauth2', 's3cret').startsWith('https://oauth2:s3cret@oauth2'), 'inject then strip round-trips');
eq(gitops.stripCreds(gitops.injectToken('https://gitlab.example.org/grp/paper.git', 'oauth2', 's3cret')), 'https://gitlab.example.org/grp/paper.git', 'inject → strip yields the credential-free URL');

// ---------- provider tokenUrl users ----------
eq(github.tokenUrl('https://github.com/o/r.git', 'ghp_x'), 'https://x-access-token:ghp_x@github.com/o/r.git', 'GitHub uses x-access-token');
eq(gitlab.gitlab.tokenUrl('https://gitlab.com/g/p.git', 'glpat-x'), 'https://oauth2:glpat-x@gitlab.com/g/p.git', 'GitLab uses oauth2');
eq(gitlab.gitlab.tokenUrl('file:///bare.git', 'glpat-x'), 'file:///bare.git', 'GitLab tokenUrl leaves file:// alone');
eq(github.tokenUrl('file:///bare.git', 'ghp_x'), 'file:///bare.git', 'GitHub tokenUrl leaves file:// alone');

// ---------- provider descriptors ----------
eq([github.id, github.label, github.changeRequestLabel, github.selfHosted], ['github', 'GitHub', 'pull request', false], 'github descriptor');
eq([gitlab.gitlab.id, gitlab.gitlab.label, gitlab.gitlab.changeRequestLabel, gitlab.gitlab.selfHosted], ['gitlab', 'GitLab', 'merge request', true], 'gitlab descriptor');
check(typeof gitlab.gitlab.normalizeBaseUrl === 'function' && github.normalizeBaseUrl === undefined, 'only GitLab has a configurable base URL');

// ---------- store.remoteLink / setRemoteLink ----------
const ghLink = { fullName: 'octocat/hello', owner: 'octocat', repo: 'hello', remoteBranch: 'main', cloneUrl: 'https://github.com/octocat/hello.git', connectedBy: 'u1' };
const glLink = { provider: 'gitlab', fullName: 'grp/sub/paper', owner: 'grp/sub', repo: 'paper', remoteBranch: 'main', cloneUrl: 'https://gitlab.example.org/grp/sub/paper.git' };
const base = () => ({ id: 'p1', name: 'P', rootFile: 'main.tex', engine: 'pdf', createdAt: '2026-01-01' });

eq(store.remoteLink(base()), null, 'null when neither field is set');
eq(store.remoteLink({ ...base(), github: ghLink }), { provider: 'github', ...ghLink }, 'legacy github wrapped with provider github');
eq(store.remoteLink({ ...base(), remote: glLink }), glLink, 'remote returned as-is');
eq(store.remoteLink({ ...base(), remote: glLink, github: ghLink }), glLink, 'remote wins when both are present');

let meta = { ...base(), github: ghLink };
store.setRemoteLink(meta, { provider: 'github', ...ghLink, remoteBranch: 'dev' });
eq(meta.remote, { provider: 'github', ...ghLink, remoteBranch: 'dev' }, 'setRemoteLink writes remote');
check(!('github' in meta), 'setRemoteLink deletes the legacy github field');
eq(store.remoteLink(meta).remoteBranch, 'dev', 'and remoteLink reads it back');

meta = { ...base(), remote: glLink, github: ghLink };
store.setRemoteLink(meta, null);
check(!('remote' in meta) && !('github' in meta), 'null clears both fields');
eq(store.remoteLink(meta), null, 'cleared meta has no link');

meta = { ...base(), github: ghLink };
store.setRemoteLink(meta, null);
check(!('github' in meta) && !('remote' in meta), 'null on a legacy-only meta removes github too');

// ---------- remotes.providers / getProvider ----------
eq(remotes.providers().map((p) => p.id), ['github', 'gitlab'], 'both by default');
eq(remotes.getProvider('gitlab')?.id, 'gitlab', 'getProvider finds gitlab');
eq(remotes.getProvider('nope'), null, 'getProvider is null for an unknown id');
eq(remotes.getProvider(undefined), null, 'getProvider is null for undefined');
process.env.REMOTE_PROVIDERS = 'github';
eq(remotes.providers().map((p) => p.id), ['github'], 'REMOTE_PROVIDERS=github hides gitlab');
eq(remotes.getProvider('gitlab'), null, 'a hidden provider is unknown to getProvider');
check(remotes.isProviderId('gitlab') === true, 'isProviderId still knows gitlab (stored links stay readable)');
process.env.REMOTE_PROVIDERS = ' GitLab , github ';
eq(remotes.providers().map((p) => p.id), ['github', 'gitlab'], 'allowlist is trimmed and case-insensitive, order fixed');
process.env.REMOTE_PROVIDERS = 'bitbucket';
eq(remotes.providers(), [], 'an allowlist naming no known provider yields none');
delete process.env.REMOTE_PROVIDERS;
eq(remotes.providers().length, 2, 'back to both once the env var is gone');
check(remotes.isProviderId('bitbucket') === false, 'isProviderId rejects unknown ids');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('remotes: all assertions passed');

// A git failure must never carry the token out of gitops: the message git
// prints includes the URL it was given.
{
  const gitops = await import('../src/gitops.ts');
  eq(gitops.stripCreds('fatal: unable to access \'https://oauth2:glpat-abc@gitlab.example.org/g/p.git/\': could not resolve host; also https://x-access-token:tok@github.com/o/r'),
     'fatal: unable to access \'https://gitlab.example.org/g/p.git/\': could not resolve host; also https://github.com/o/r',
     'stripCreds scrubs every credential in a message');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-scrub-'));
  process.env.DATA_DIR = tmp;
  const { newId } = await import('../src/util.ts');
  const { execSync } = await import('node:child_process');
  const id = newId();
  const dir = path.join(tmp, 'projects', id);
  fs.mkdirSync(dir, { recursive: true });
  execSync(`git init -q -b main "${dir}" && git -C "${dir}" -c user.email=a@b -c user.name=t commit -q --allow-empty -m init`);
  let message = '';
  try { await gitops.pushToRemote(id, 'main', 'https://oauth2:glpat-secret@127.0.0.1:9/nowhere.git'); } catch (err) { message = err.message; }
  check(message.length > 0 && !message.includes('glpat-secret'), 'push failure message carries no token: ' + message);
}
