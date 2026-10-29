#!/usr/bin/env node
// Seed a running Aldine instance with the data a self-hoster cannot afford to
// lose, then prove later that it is all still there and still works. Talks to
// ALDINE_URL (default http://localhost:8191) over the public API only, so the
// same two steps check an upgrade (seed on the old release, verify on the new
// one) and a backup restore (seed, back up, wipe, restore, verify).
//
//   node scripts/lifecycle/data.mjs seed   [--state lifecycle-state.json]
//   node scripts/lifecycle/data.mjs verify [--state lifecycle-state.json]
//
// The instance must run with AUTH_ENABLED=1. seed writes everything verify
// compares against into the state file: account passwords, a live session
// cookie and an access token among them, so it is test data only.
//
// Seeded: two password accounts; a project owned by the first with a
// subfolder, a .bib, a binary figure and non-ASCII text; named commits on
// main; a second branch with its own commit; review threads with replies (one
// with a suggestion, one resolved, one on the branch); the project shared
// with the second account; a project-scoped personal access token; a typeset
// that produced a PDF. verify checks, before it changes anything: the old
// session still signs in, both accounts sign in with their passwords, the
// project, its metadata and its share, every file byte for byte on both
// branches, the branch heads and the full history, the comment threads,
// the token (and its scope), the usage tally; then it typesets again.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const BASE = (process.env.ALDINE_URL || 'http://localhost:8191').replace(/\/$/, '');
const WAIT_MS = Number(process.env.LIFECYCLE_WAIT_MS || 180_000);
const mode = process.argv[2];
const stateIdx = process.argv.indexOf('--state');
const STATE = stateIdx > 0 ? process.argv[stateIdx + 1] : 'lifecycle-state.json';
if (mode !== 'seed' && mode !== 'verify') {
  console.error('usage: data.mjs seed|verify [--state <file>]');
  process.exit(2);
}
const tag = `lifecycle ${mode}:`;

function fail(msg) {
  console.error(`${tag} FAIL ${msg}`);
  process.exit(1);
}
function ok(msg) {
  console.log(`${tag} ok  ${msg}`);
}
function check(cond, msg, detail) {
  if (!cond) fail(detail === undefined ? msg : `${msg}\n${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)}`);
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// fetch() against a port that still refuses connections can leave its promise
// unsettled (undici on Node 22/24); with nothing else on the event loop the
// script then exits 13 instead of retrying. The timer must stay referenced
// (no AbortSignal.timeout, which unrefs its timer) until the race settles.
function fetchWithTimeout(url, init, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`fetch ${url} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([fetch(url, init), timeout]).finally(() => clearTimeout(timer));
}

/** One HTTP call. `as` is a session ({ cookie }) or a token ({ token }); `raw` returns bytes. */
async function call(method, path, { as, body, raw = false, timeout = 60_000 } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (as?.cookie) headers.cookie = as.cookie;
  if (as?.token) headers.authorization = `Bearer ${as.token}`;
  const res = await fetchWithTimeout(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, timeout);
  const buf = Buffer.from(await res.arrayBuffer());
  let json;
  if (!raw) { try { json = JSON.parse(buf.toString('utf8')); } catch { json = buf.toString('utf8'); } }
  const setCookie = res.headers.getSetCookie?.() || [];
  return { status: res.status, body: json, bytes: buf, setCookie, headers: res.headers };
}

async function expect200(method, path, opts, what) {
  const r = await call(method, path, opts);
  check(r.status === 200, `${what}: ${method} ${path} returned ${r.status}`, r.body);
  return r.body;
}

function sessionFrom(r) {
  const c = r.setCookie.map((s) => s.split(';')[0]).find((s) => s.startsWith('aldine_session='));
  return c ? { cookie: c } : null;
}

/**
 * A release that confirms sign-up addresses keeps an invitee out until it
 * follows its link. The drill's stack mails nothing, so the link is taken
 * from the app's log the way an operator relays it: `docker logs` of
 * LIFECYCLE_APP_CONTAINER (drill.sh sets it).
 */
async function confirmAddress(account, session) {
  const container = process.env.LIFECYCLE_APP_CONTAINER;
  check(container, `${account.email} has to confirm its address: set LIFECYCLE_APP_CONTAINER to the app container so its log can be read`);
  const pattern = new RegExp(`email confirmation for ${account.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: \\S*[?&]confirm_email=([A-Za-z0-9_-]+)`, 'g');
  let token = null;
  for (let i = 0; i < 10 && !token; i++) {
    const r = spawnSync('docker', ['logs', container], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const found = [...`${r.stdout || ''}\n${r.stderr || ''}`.matchAll(pattern)];
    token = found.length ? found[found.length - 1][1] : null;
    if (!token) await sleep(1000);
  }
  check(token, `no confirmation link for ${account.email} in the log of ${container}`);
  const r = await call('POST', '/api/auth/confirm-email', { as: session, body: { token } });
  check(r.status === 200 && r.body?.user && !r.body.user.emailPending, `confirming ${account.email} returned ${r.status}`, r.body);
}

async function waitForInstance() {
  const until = Date.now() + WAIT_MS;
  let last = '';
  while (Date.now() < until) {
    try {
      const r = await call('GET', '/api/health', { timeout: 10_000 });
      if (r.status === 200 && r.body?.ok === true) break;
      last = `${r.status} ${JSON.stringify(r.body)}`;
    } catch (e) { last = String(e); }
    await sleep(2000);
  }
  if (Date.now() >= until) fail(`/api/health not ok after ${WAIT_MS / 1000}s (last: ${last})`);
  const me = await expect200('GET', '/api/auth/me', {}, 'auth status');
  check(me.authEnabled === true, 'the instance must run with AUTH_ENABLED=1 (accounts, sharing and tokens are what this checks)', me);
  // The compiler sits on the internal network and the app caches a failed
  // probe for a few seconds; give it time to come up.
  let compiler;
  for (let i = 0; i < 40; i++) {
    compiler = (await call('GET', '/api/compiler')).body;
    if (compiler?.ok) break;
    await sleep(3000);
  }
  check(compiler?.ok, 'the compiler is unreachable through the app', compiler);
  ok(`instance at ${BASE} is up, accounts on, compiler TeX Live ${compiler.texlive?.release}`);
}

async function signIn(account) {
  const r = await call('POST', '/api/auth/login', { body: { email: account.email, password: account.password } });
  check(r.status === 200 && r.body?.user?.id === account.id, `${account.email} cannot sign in (${r.status})`, r.body);
  const s = sessionFrom(r);
  check(s, `signing in ${account.email} set no session cookie`);
  return s;
}

/** Wait until neither branch has edits the 20 s autosave debounce has yet to commit. */
async function settle(projectId, branches, as) {
  for (const branch of branches) {
    let paths = null;
    for (let i = 0; i < 60; i++) {
      paths = (await expect200('GET', `/api/projects/${projectId}/changes?branch=${branch}`, { as }, 'pending changes')).paths;
      if (paths.length === 0) break;
      await sleep(1000);
    }
    check(paths.length === 0, `branch ${branch} still has uncommitted paths`, paths);
  }
}

async function typeset(projectId, branch, as) {
  const r = await call('POST', `/api/projects/${projectId}/compile`, { as, body: { branch }, timeout: 240_000 });
  const res = r.body;
  const log = typeof res?.log === 'string' ? res.log : '';
  if (r.status !== 200 || !res?.ok || !res.pdfUrl) {
    console.error(log.slice(-4000));
    fail(`typeset of ${branch} returned ${r.status}, ok=${res?.ok}, errors=${JSON.stringify(res?.errors)}, error=${res?.error}`);
  }
  if (/undefined (references|citations)|Citation .* undefined|Please \(re\)run Biber/i.test(log)) {
    console.error(log.slice(-4000));
    fail(`typeset of ${branch}: the citation did not resolve`);
  }
  const pdf = await call('GET', res.pdfUrl, { as, raw: true });
  check(pdf.status === 200 && pdf.bytes.subarray(0, 5).toString() === '%PDF-', `the PDF of ${branch} did not download (${pdf.status}, ${pdf.bytes.length} bytes)`);
  return { durationMs: res.durationMs, bytes: pdf.bytes.length };
}

/** The fields of a comment thread verify holds a release to; a field a later
 *  release adds is not a change. */
const thread = (c) => ({
  id: c.id, branch: c.branch, file: c.file, anchor: c.anchor, author: c.author, body: c.body,
  suggestion: c.suggestion ?? null, resolved: c.resolved, createdAt: c.createdAt,
  replies: c.replies.map((r) => ({ author: r.author, body: r.body, createdAt: r.createdAt })),
});

/** Everything verify compares, read back from the server rather than assumed. */
async function snapshot(projectId, branches, owner) {
  const files = {};
  const dirs = {};
  const log = {};
  const comments = {};
  for (const branch of branches) {
    const listing = (await expect200('GET', `/api/projects/${projectId}/files?branch=${branch}`, { as: owner }, `file list of ${branch}`)).files;
    files[branch] = {};
    for (const entry of listing.filter((e) => e.type === 'file')) {
      const r = await call('GET', `/api/projects/${projectId}/file?branch=${branch}&path=${encodeURIComponent(entry.path)}`, { as: owner, raw: true });
      check(r.status === 200, `GET ${entry.path} on ${branch} returned ${r.status}`);
      files[branch][entry.path] = { sha256: sha256(r.bytes), size: r.bytes.length };
    }
    dirs[branch] = listing.filter((e) => e.type === 'dir').map((e) => e.path);
    log[branch] = (await expect200('GET', `/api/projects/${projectId}/log?branch=${branch}`, { as: owner }, `history of ${branch}`))
      .map((e) => ({ hash: e.hash, date: e.date, author: e.author, message: e.message }));
    comments[branch] = (await expect200('GET', `/api/projects/${projectId}/comments?branch=${branch}`, { as: owner }, `comments on ${branch}`)).map(thread);
  }
  const branchList = (await expect200('GET', `/api/projects/${projectId}/branches`, { as: owner }, 'branches'))
    .map((b) => ({ name: b.name, head: b.head })).sort((a, b) => a.name.localeCompare(b.name));
  return { files, dirs, log, comments, branches: branchList };
}

// ---------------------------------------------------------------- content

const MAIN_TEX = String.raw`\documentclass{article}
\usepackage[T1]{fontenc}
\usepackage{graphicx}
\usepackage[backend=biber,style=numeric]{biblatex}
\addbibresource{refs.bib}
\begin{document}
\title{Lifecycle check}\author{Aldine CI}\maketitle
\input{sections/intro}
\begin{figure}[h]\centering\includegraphics[width=1cm]{figures/dot.png}\caption{A one-pixel figure.}\end{figure}
\printbibliography
\end{document}
`;
const INTRO_V1 = String.raw`\section{Introduction}
A paragraph to comment on.
`;
// Non-ASCII on purpose: the bytes must come back exactly, whatever the
// encoding path (git, JSON, the restore's tar).
const INTRO_V2 = String.raw`\section{Introduction}
A paragraph to comment on, citing \cite{lifecycle2026}.
Größe, café, naïve, Ærø and a dash — all of them must survive.
`;
const INTRO_BRANCH = String.raw`\section{Introduction}
The revision branch rewrites this paragraph and cites \cite{lifecycle2026}.
`;
const REFS_BIB = `@article{lifecycle2026,
  author  = {Check, Lifecycle},
  title   = {Data that outlives its release},
  journal = {Journal of Upgrades},
  year    = {2026},
}
`;
// 1x1 PNG: the binary path (base64 PUT, raw GET) must be byte-identical too.
const DOT_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// ---------------------------------------------------------------- seed

async function seed() {
  await waitForInstance();
  const stamp = Date.now().toString(36);
  const accounts = {
    owner: { email: `owner-${stamp}@lifecycle.example`, password: `owner-pass-${stamp}`, name: 'Olive Owner' },
    collaborator: { email: `collab-${stamp}@lifecycle.example`, password: `collab-pass-${stamp}`, name: 'Cal Collaborator' },
  };
  const sessions = {};
  for (const [role, a] of Object.entries(accounts)) {
    const r = await call('POST', '/api/auth/register', { body: { email: a.email, password: a.password, name: a.name } });
    check(r.status === 200 && r.body?.user?.id, `registering ${a.email} returned ${r.status}`, r.body);
    a.id = r.body.user.id;
    sessions[role] = sessionFrom(r);
    check(sessions[role], `registering ${a.email} set no session cookie`);
    if (r.body.user.emailPending) await confirmAddress(a, sessions[role]);
  }
  ok(`accounts ${accounts.owner.email} and ${accounts.collaborator.email}`);
  const owner = sessions.owner;
  const collab = sessions.collaborator;

  const created = await expect200('POST', '/api/projects', { as: owner, body: { name: 'Lifecycle paper', files: { 'main.tex': MAIN_TEX, 'sections/intro.tex': INTRO_V1, 'refs.bib': REFS_BIB } } }, 'create project');
  const id = created.id;
  check(id && created.ownerId === accounts.owner.id, 'the new project has no id or the wrong owner', created);
  const p = `/api/projects/${id}`;
  ok(`project ${id}`);

  const put = (branch, path, content, encoding) => expect200('PUT', `${p}/file`, { as: owner, body: { branch, path, content, ...(encoding ? { encoding } : {}) } }, `write ${path} on ${branch}`);
  const commit = async (branch, message) => {
    const r = await expect200('POST', `${p}/commit`, { as: owner, body: { branch, message } }, `commit on ${branch}`);
    check(r.committed, `"${message}" committed nothing`, r);
  };
  await put('main', 'sections/intro.tex', INTRO_V2);
  await commit('main', 'Expand the introduction');
  await put('main', 'figures/dot.png', DOT_PNG, 'base64');
  await commit('main', 'Add a figure');
  await expect200('POST', `${p}/branches`, { as: owner, body: { name: 'revision', from: 'main' } }, 'create branch');
  await put('revision', 'sections/intro.tex', INTRO_BRANCH);
  await commit('revision', 'Rewrite the introduction on a branch');
  ok('commits on main and on branch revision');

  let shared = await expect200('POST', `${p}/share`, { as: owner, body: { mode: 'private', collaborators: [accounts.collaborator.email] } }, 'share');
  // From 1.3 an address on the share list is an invitation until its person
  // accepts it; releases before that share at once and answer no invitations.
  const invitation = shared.invitations?.find((i) => i.to === accounts.collaborator.email);
  if (invitation) {
    await expect200('POST', `/api/invitations/${invitation.id}/accept`, { as: collab }, 'accept the invitation');
    shared = await expect200('GET', p, { as: owner }, 'read the share');
  }
  check(same(shared.share, { mode: 'private', collaborators: [accounts.collaborator.email] }), 'the share did not take', shared.share);
  ok(`shared with ${accounts.collaborator.email}`);

  const anchor = (text, quote) => ({ from: text.indexOf(quote), to: text.indexOf(quote) + quote.length, quote });
  const comment = (as, branch, file, a, body, suggestion) => expect200('POST', `${p}/comments`, { as, body: { branch, file, anchor: a, body, ...(suggestion ? { suggestion } : {}) } }, 'comment');
  const thread = await comment(owner, 'main', 'sections/intro.tex', anchor(INTRO_V2, 'A paragraph to comment on'), 'Is this the right opening?');
  await expect200('POST', `${p}/comments/${thread.id}/reply`, { as: collab, body: { body: 'Yes, keep it — und schön.' } }, 'reply');
  await expect200('POST', `${p}/comments/${thread.id}/reply`, { as: owner, body: { body: 'Keeping it.' } }, 'second reply');
  const suggestion = await comment(collab, 'main', 'main.tex', anchor(MAIN_TEX, 'Lifecycle check'), 'A better title?', 'Lifecycle check, revised');
  const resolved = await comment(owner, 'main', 'refs.bib', anchor(REFS_BIB, 'Journal of Upgrades'), 'Check the journal name.');
  await expect200('POST', `${p}/comments/${resolved.id}/resolve`, { as: owner, body: { resolved: true } }, 'resolve');
  await comment(owner, 'revision', 'sections/intro.tex', anchor(INTRO_BRANCH, 'rewrites this paragraph'), 'Only on the branch.');
  check(suggestion.suggestion === 'Lifecycle check, revised', 'the suggestion was not stored', suggestion);
  ok('review threads with replies, a suggestion, a resolved thread, a branch thread');

  const tokenRes = await expect200('POST', '/api/tokens', { as: owner, body: { name: 'Lifecycle agent', projectIds: [id] } }, 'create access token');
  check(typeof tokenRes.token === 'string' && tokenRes.token.startsWith('aldn_'), 'no token value came back', tokenRes);
  const viaToken = await call('GET', `${p}/file?branch=main&path=main.tex`, { as: { token: tokenRes.token }, raw: true });
  check(viaToken.status === 200 && viaToken.bytes.toString('utf8') === MAIN_TEX, `the fresh token cannot read the project (${viaToken.status})`);
  ok(`access token ${tokenRes.id} scoped to the project`);

  await settle(id, ['main', 'revision'], owner);
  const main = await typeset(id, 'main', owner);
  ok(`typeset main: ${main.bytes}-byte PDF in ${main.durationMs} ms`);

  // Read the expected state back from the server, then check it against what
  // was written, so verify compares against the truth and not an assumption.
  const snap = await snapshot(id, ['main', 'revision'], owner);
  const expectFile = (branch, path, content) => {
    const got = snap.files[branch][path];
    check(got && got.sha256 === sha256(content), `${path} on ${branch} does not read back as written`, got);
  };
  expectFile('main', 'main.tex', Buffer.from(MAIN_TEX));
  expectFile('main', 'sections/intro.tex', Buffer.from(INTRO_V2));
  expectFile('main', 'refs.bib', Buffer.from(REFS_BIB));
  expectFile('main', 'figures/dot.png', Buffer.from(DOT_PNG, 'base64'));
  expectFile('revision', 'sections/intro.tex', Buffer.from(INTRO_BRANCH));
  expectFile('revision', 'figures/dot.png', Buffer.from(DOT_PNG, 'base64'));
  check(snap.log.main.length === 3 && snap.log.revision.length === 4, 'unexpected history length', snap.log);
  check(snap.comments.main.length === 3 && snap.comments.revision.length === 1, 'unexpected comment count', snap.comments);
  const usage = await expect200('GET', '/api/usage', { as: owner }, 'usage');

  const state = {
    seededAt: new Date().toISOString(),
    accounts,
    ownerSession: owner.cookie,
    project: { id, name: created.name, rootFile: created.rootFile, engine: created.engine },
    share: shared.share,
    token: { value: tokenRes.token, id: tokenRes.id, name: tokenRes.name, projectIds: tokenRes.projectIds },
    usage,
    ...snap,
  };
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  ok(`state written to ${STATE}`);
  console.log(`${tag} all seeded`);
}

// ---------------------------------------------------------------- verify

async function verify() {
  const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  await waitForInstance();
  const id = s.project.id;
  const p = `/api/projects/${id}`;
  const branches = Object.keys(s.files);

  // A session from before the upgrade or restore: people stay signed in.
  const me = await expect200('GET', '/api/auth/me', { as: { cookie: s.ownerSession } }, 'old session');
  check(me.user?.id === s.accounts.owner.id, 'the session cookie from before no longer signs the owner in', me);
  ok('the session from before still signs the owner in');

  const owner = await signIn(s.accounts.owner);
  const collab = await signIn(s.accounts.collaborator);
  ok('both accounts sign in with their passwords');

  const anon = await call('GET', `${p}/file?path=main.tex`);
  check(anon.status === 401, `the project answers a signed-out request with ${anon.status}, not 401`);

  // History and branches first: nothing below may commit before they are compared.
  const snap = await snapshot(id, branches, owner);
  check(same(snap.branches, s.branches), 'branches or their heads changed', { before: s.branches, after: snap.branches });
  for (const b of branches) check(same(snap.log[b], s.log[b]), `the history of ${b} changed`, { before: s.log[b], after: snap.log[b] });
  ok(`branches ${s.branches.map((b) => `${b.name}@${b.head}`).join(', ')} and their full history intact`);

  for (const b of branches) {
    const before = s.files[b];
    const after = snap.files[b];
    check(same(Object.keys(after).sort(), Object.keys(before).sort()) && same(snap.dirs[b], s.dirs[b]), `the files on ${b} changed`, { before: [...s.dirs[b], ...Object.keys(before)], after: [...snap.dirs[b], ...Object.keys(after)] });
    for (const path of Object.keys(before)) check(same(after[path], before[path]), `${path} on ${b} is not byte-identical`, { before: before[path], after: after[path] });
  }
  ok(`every file on ${branches.join(' and ')} byte-identical (${branches.map((b) => Object.keys(s.files[b]).length).join(' + ')} files)`);

  for (const b of branches) check(same(snap.comments[b], s.comments[b]), `the review comments on ${b} changed`, { before: s.comments[b], after: snap.comments[b] });
  ok(`review threads intact (${branches.map((b) => s.comments[b].length).join(' + ')}, replies and suggestion included)`);

  const meta = await expect200('GET', p, { as: owner }, 'project metadata');
  for (const k of ['name', 'rootFile', 'engine']) check(meta[k] === s.project[k], `project ${k} changed: ${meta[k]} (was ${s.project[k]})`);
  check(meta.ownerId === s.accounts.owner.id && meta.isOwner === true, 'the owner is no longer the owner', meta);
  check(same(meta.share, s.share), 'the share changed', { before: s.share, after: meta.share });
  const collabList = await expect200('GET', '/api/projects', { as: collab }, "collaborator's project list");
  const listed = collabList.find((x) => x.id === id);
  check(listed && listed.isMember === true && listed.isOwner === false, 'the project is no longer shared with the collaborator', collabList);
  const collabRead = await call('GET', `${p}/file?path=main.tex`, { as: collab, raw: true });
  check(collabRead.status === 200 && sha256(collabRead.bytes) === s.files.main['main.tex'].sha256, `the collaborator cannot read the project (${collabRead.status})`);
  ok(`project metadata and the share with ${s.accounts.collaborator.email} hold`);

  const token = { token: s.token.value };
  const tokenRead = await call('GET', `${p}/file?path=main.tex`, { as: token, raw: true });
  check(tokenRead.status === 200 && sha256(tokenRead.bytes) === s.files.main['main.tex'].sha256, `the access token no longer reads the project (${tokenRead.status})`);
  const tokenMe = await expect200('GET', '/api/auth/me', { as: token }, 'token identity');
  check(tokenMe.user?.id === s.accounts.owner.id, 'the access token resolves to someone else', tokenMe);
  const tokenList = await call('GET', '/api/projects', { as: token });
  check(tokenList.status === 403, `a project-scoped token listed all projects (${tokenList.status}): its scope was lost`);
  const tokens = await expect200('GET', '/api/tokens', { as: owner }, 'token list');
  check(tokens.some((t) => t.id === s.token.id && t.name === s.token.name && same(t.projectIds, s.token.projectIds)), 'the token is missing from Agent access', tokens);
  ok('the access token authenticates, keeps its scope and is listed');

  const usage = await expect200('GET', '/api/usage', { as: owner }, 'usage');
  if (usage.month === s.usage.month) check(usage.seconds >= s.usage.seconds, `compile usage went down: ${usage.seconds}s (was ${s.usage.seconds}s)`);
  ok(`compile usage kept (${usage.seconds}s this month)`);

  for (const b of branches) {
    const r = await typeset(id, b, owner);
    ok(`typeset ${b}: ${r.bytes}-byte PDF in ${r.durationMs} ms`);
  }

  // The project list on this data: why each person sees the project, a last
  // edit (recorded, or read from the history in the background after an
  // upgrade) and the typeset of main just made.
  let row;
  for (const end = Date.now() + 60_000; ; await sleep(500)) {
    row = (await expect200('GET', '/api/projects', { as: owner }, "owner's project list")).find((x) => x.id === id);
    if (row?.lastEdit || Date.now() > end) break;
  }
  check(row?.access === 'owner' && listed.access === 'member', 'the list rows do not say why each person sees the project', { owner: row?.access, collaborator: listed.access });
  check(row.lastEdit && !Number.isNaN(Date.parse(row.lastEdit.at)), 'the project has no last edit on the list', row);
  check(row.compile?.branch === 'main' && ['ok', 'error'].includes(row.compile.status), 'the list does not show the typeset of main', row.compile);
  ok(`project list row: last edit ${row.lastEdit.at} on ${row.lastEdit.branch}, typeset ${row.compile.status}`);
  console.log(`${tag} all checks passed on data seeded at ${s.seededAt}`);
}

await (mode === 'seed' ? seed() : verify());
