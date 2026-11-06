/**
 * GitHub Enterprise Server (#250): a connection may name its instance, and
 * the API, OAuth and the allowed clone origin all follow it, never
 * github.com. Run without GITHUB_API_BASE, the test override that would
 * switch the origin check off. GITHUB_URL moves the server's default
 * instance (where its OAuth app lives); without it, github.com.
 */
import { check, eq } from './assert.mjs';

delete process.env.GITHUB_API_BASE;
delete process.env.GITHUB_URL;
process.env.GITHUB_CLIENT_ID = 'gh-client';
process.env.GITHUB_CLIENT_SECRET = 'gh-secret';

const { github, apiBase, normalizeBaseUrl } = await import('../src/github.ts');
const { checkCloneUrl } = await import('../src/remote-types.ts');

const gh = { token: 't', login: 'me' };
const ghe = { token: 't', login: 'me', baseUrl: 'https://github.example.edu' };

// ---- the instance URL as people paste it ----
eq(normalizeBaseUrl('https://github.example.edu/'), 'https://github.example.edu', 'trailing slash dropped');
eq(normalizeBaseUrl('https://github.example.edu/api/v3'), 'https://github.example.edu', 'the API path the docs show is dropped, not doubled');
let refused = '';
try { normalizeBaseUrl('http://github.example.edu'); } catch (err) { refused = err.message; }
eq(refused, 'GitHub Enterprise URL must use https://', 'plain http is refused');
check(github.selfHosted && !github.baseUrlRequired, 'GitHub offers an instance URL, and does not require one');

// ---- API and git origin follow the connection ----
eq(apiBase(gh), 'https://api.github.com', 'github.com: api.github.com');
eq(apiBase(ghe), 'https://github.example.edu/api/v3', 'Enterprise: <instance>/api/v3');
eq(github.instanceOrigin(gh), 'https://github.com', 'github.com connection');
eq(github.instanceOrigin(ghe), 'https://github.example.edu', 'Enterprise connection');
eq(checkCloneUrl(github, ghe, 'https://github.example.edu/lab/paper.git'), 'https://github.example.edu/lab/paper.git', 'a clone URL on the instance is used');
for (const [conn, url] of [[ghe, 'https://github.com/lab/paper.git'], [gh, 'https://github.example.edu/lab/paper.git']]) {
  let msg = '';
  try { checkCloneUrl(github, conn, url); } catch (err) { msg = err.message; }
  check(/not on/.test(msg), `a clone URL on another instance is refused (${url}): ${msg}`);
}

// ---- the token goes into one URL for one operation, on the instance's host ----
const url = github.tokenUrl('https://github.example.edu/lab/paper.git', 'sekret');
eq(new URL(url).host, 'github.example.edu', 'git talks to the instance');
eq(decodeURIComponent(new URL(url).password), 'sekret', 'with the token inline');

// ---- OAuth: github.com unless GITHUB_URL moves the server's default ----
check(github.connectUrl('s', 'https://aldine.example/cb').startsWith('https://github.com/login/oauth/authorize?'), 'OAuth on github.com by default');
eq(github.defaultInstanceUrl(), 'https://github.com', 'default instance');
process.env.GITHUB_URL = 'https://github.example.edu/';
check(github.connectUrl('s', 'https://aldine.example/cb').startsWith('https://github.example.edu/login/oauth/authorize?'), 'GITHUB_URL moves OAuth to the Enterprise instance');
eq(github.instanceOrigin(gh), 'https://github.example.edu', 'and a connection without its own URL with it');
eq(apiBase(gh), 'https://github.example.edu/api/v3', 'API included');
delete process.env.GITHUB_URL;

console.log('github-enterprise: all assertions passed');
