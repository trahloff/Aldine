import { check } from './assert.mjs';

const { normaliseBaseUrl, mapProject, encodePath, gitlab } = await import('../src/gitlab.ts');

// --- base URL normalisation ---
check(normaliseBaseUrl(undefined) === 'https://gitlab.com', 'defaults to gitlab.com');
check(normaliseBaseUrl('') === 'https://gitlab.com', 'empty defaults to gitlab.com');
check(normaliseBaseUrl('https://git.example.com/') === 'https://git.example.com', 'strips trailing slash');
check(normaliseBaseUrl('  https://git.example.com  ') === 'https://git.example.com', 'trims whitespace');
check(normaliseBaseUrl('https://git.example.com/gitlab') === 'https://git.example.com/gitlab', 'keeps a subpath');

let threw = false;
try { normaliseBaseUrl('not a url'); } catch { threw = true; }
check(threw, 'rejects unparseable base url');

threw = false;
try { normaliseBaseUrl('http://insecure.example.com'); } catch { threw = true; }
check(threw, 'rejects non-https base url');

// --- path encoding ---
check(encodePath('group/sub/repo') === 'group%2Fsub%2Frepo', 'encodes a nested path');
check(encodePath('/group/repo/') === 'group%2Frepo', 'strips surrounding slashes');

// --- project mapping ---
const r = mapProject({
  path_with_namespace: 'grp/sub/paper',
  path: 'paper',
  namespace: { full_path: 'grp/sub' },
  visibility: 'private',
  default_branch: 'trunk',
  http_url_to_repo: 'https://gitlab.com/grp/sub/paper.git',
  last_activity_at: '2026-01-01T00:00:00Z',
});
check(r.fullName === 'grp/sub/paper' && r.name === 'paper' && r.owner === 'grp/sub', 'maps names');
check(r.private === true && r.defaultBranch === 'trunk', 'maps visibility and default branch');
check(r.cloneUrl === 'https://gitlab.com/grp/sub/paper.git', 'maps clone url');
check(r.updatedAt === '2026-01-01T00:00:00Z', 'maps last activity');
check(mapProject({ visibility: 'public' }).private === false, 'public is not private');
check(mapProject({ visibility: 'internal' }).private === true, 'internal counts as private');
check(mapProject({ path_with_namespace: 'a/b/c' }).owner === 'a/b', 'derives owner without a namespace object');
check(mapProject({}).defaultBranch === 'main', 'defaults the branch to main');

// --- token URLs ---
check(gitlab.tokenUrl('https://gitlab.com/a/b.git', 'T') === 'https://oauth2:T@gitlab.com/a/b.git', 'oauth2 token url');
check(gitlab.tokenUrl('file:///tmp/bare.git', 'T') === 'file:///tmp/bare.git', 'local urls pass through untouched');

// --- provider identity ---
check(gitlab.id === 'gitlab' && gitlab.label === 'GitLab', 'provider identity');
check(gitlab.changeRequestLabel === 'merge request', 'GitLab proposes merge requests');

console.log('gitlab-client: ALL PASSED');
