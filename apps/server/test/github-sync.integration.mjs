import { check } from './assert.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import { execSync } from 'node:child_process';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'aldine-gh-'));
process.env.DATA_DIR = path.join(tmp,'data'); process.env.META_DIR = path.join(tmp,'secrets');

// a bare repo with content = the "GitHub repo"
const bare = path.join(tmp,'hello.git'); execSync(`git init --bare -b main "${bare}"`);
const seed = path.join(tmp,'seed'); execSync(`git clone "${bare}" "${seed}" 2>/dev/null`);
fs.writeFileSync(path.join(seed,'main.tex'),'\\documentclass{article}\\begin{document}From GitHub\\end{document}\n');
fs.writeFileSync(path.join(seed,'README.md'),'# hello\n');
execSync(`cd "${seed}" && git add -A && git -c user.email=a@b.c -c user.name=t commit -q -m init && git push -q origin main`);

const repoJson = { full_name:'octocat/hello', name:'hello', default_branch:'main', clone_url:`file://${bare}`, owner:{login:'octocat'}, private:false, updated_at:'2026-01-01' };
// an organisation repository the first page never returns
const farJson = { ...repoJson, full_name:'acme/far-away', name:'far-away', owner:{login:'acme'} };
const seen = [];
// publish: an organisation repository (a bare repo of its own), and a name already in use
const orgBare = path.join(tmp,'acme-paper.git'); execSync(`git init --bare -q -b main "${orgBare}"`);
const userBare = path.join(tmp,'mine.git'); execSync(`git init --bare -q -b main "${userBare}"`);
const prs = [];
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b ? JSON.parse(b) : {})); });
const mock = http.createServer(async (req,res)=>{ res.setHeader('content-type','application/json'); seen.push(req.url);
  // import failures: no access, no answer, and a repository whose clone URL leads nowhere
  if (req.url==='/repos/octocat/locked') { res.statusCode=403; return res.end(JSON.stringify({ message:'Resource not accessible by personal access token' })); }
  if (req.url==='/repos/octocat/down') return req.socket.destroy();
  if (req.url==='/repos/octocat/gone') return res.end(JSON.stringify({ ...repoJson, full_name:'octocat/gone', name:'gone', clone_url:`file://${path.join(tmp,'gone.git')}` }));
  if (req.url==='/orgs/acme/repos' && req.method==='POST') { const b = await readBody(req); res.statusCode=201; return res.end(JSON.stringify({ ...repoJson, full_name:`acme/${b.name}`, name:b.name, owner:{login:'acme'}, private:b.private, clone_url:`file://${orgBare}` })); }
  if (req.url==='/user/repos' && req.method==='POST') {
    const b = await readBody(req);
    if (b.name==='hello') { res.statusCode=422; return res.end(JSON.stringify({ message:'Repository creation failed.', errors:[{ resource:'Repository', code:'custom', field:'name', message:'name already exists on this account' }] })); }
    res.statusCode=201; return res.end(JSON.stringify({ ...repoJson, full_name:`tester/${b.name}`, name:b.name, owner:{login:'tester'}, clone_url:`file://${userBare}` }));
  }
  if (req.url==='/user') return res.end(JSON.stringify({login:'tester',name:'Tester'}));
  if (req.url.startsWith('/user/repos')) return res.end(JSON.stringify([repoJson]));
  if (req.url.startsWith('/user/orgs')) return res.end(JSON.stringify([{login:'acme'}]));
  if (req.url.startsWith('/search/repositories')) return res.end(JSON.stringify({ items: /far/.test(decodeURIComponent(req.url)) ? [farJson] : [] }));
  if (req.url==='/repos/acme/far-away') return res.end(JSON.stringify(farJson));
  if (req.url==='/repos/octocat/hello') return res.end(JSON.stringify(repoJson));
  if (req.url.startsWith('/repos/octocat/hello/branches')) {
    const names = execSync(`git --git-dir="${bare}" for-each-ref --format='%(refname:short)' refs/heads`).toString().trim().split('\n').filter(Boolean);
    return res.end(JSON.stringify(names.map(n=>({name:n}))));
  }
  if (req.url==='/repos/octocat/hello/pulls' && req.method==='POST') {
    const b = await readBody(req);
    if (prs.some((p) => p.head===b.head && p.base===b.base)) { res.statusCode=422; return res.end(JSON.stringify({ message:'Validation Failed', errors:[{ resource:'PullRequest', code:'custom', message:`A pull request already exists for octocat:${b.head}.` }] })); }
    prs.push(b); return res.end(JSON.stringify({html_url:'https://github.com/octocat/hello/pull/7', number:7}));
  }
  if (req.url.startsWith('/repos/octocat/hello/pulls?')) {
    const q = new URL(req.url,'http://x').searchParams;
    check(q.get('state')==='open' && q.get('head')==='octocat:feature-x' && q.get('base')==='main', 'the lookup asks for the open request of the branch: '+req.url);
    return res.end(JSON.stringify([{ html_url:'https://github.com/octocat/hello/pull/7', number:7 }]));
  }
  res.statusCode=404; res.end('{}');
});
await new Promise(r=>mock.listen(0,r)); process.env.GITHUB_API_BASE=`http://localhost:${mock.address().port}`;

const { initDb } = await import('../src/db/index.ts'); await initDb();
const Fastify = (await import('fastify')).default;
const { registerRoutes } = await import('../src/routes.ts');
const app = Fastify(); await registerRoutes(app);
const J = (r)=>{ try{return JSON.parse(r.body)}catch{return r.body} };

let r = await app.inject({method:'POST',url:'/api/github/connect',payload:{token:'fake'}});
check(r.statusCode===200 && J(r).login==='tester', 'connect ok: '+r.body);
r = await app.inject({url:'/api/github/status'});
check(J(r).connected===true, 'status connected');
r = await app.inject({url:'/api/github/repos'});
check(Array.isArray(J(r)) && J(r)[0].fullName==='octocat/hello', 'repos list');
check(seen.some((u)=>u.startsWith('/user/repos?') && u.includes('affiliation=owner,collaborator') && !u.includes('organization_member')), 'the first page is the user\'s own and collaborator repositories: '+seen.join(' '));
r = await app.inject({url:'/api/github/repos?q=far'});
check(J(r).map((x)=>x.fullName).join()==='acme/far-away', 'a name search finds an organisation repository: '+r.body);
const search = decodeURIComponent(seen.find((u)=>u.startsWith('/search/repositories')) || '');
check(/q=far in:name user:tester org:acme/.test(search), 'the search names the user and their organisations: '+search);
r = await app.inject({url:'/api/github/repos?q='+encodeURIComponent('https://github.com/acme/far-away.git')});
check(J(r)[0]?.fullName==='acme/far-away', 'a pasted clone URL is looked up by its path: '+r.body);
r = await app.inject({url:'/api/github/repos?q=nothing-like-it'});
check(Array.isArray(J(r)) && J(r).length===0, 'no match is an empty list, not an error: '+r.body);
r = await app.inject({method:'POST',url:'/api/github/import',payload:{fullName:'octocat/hello'}});
check(r.statusCode===200, 'import status '+r.body);
const pid = J(r).id; check(pid, 'got project id');
check(J(r).github?.fullName==='octocat/hello', 'meta has github link');
check(fs.existsSync(path.join(process.env.DATA_DIR,'projects',pid,'main.tex')),'imported main.tex present');

// import failures are sentences with the next step, not the host's JSON
r = await app.inject({method:'POST',url:'/api/github/import',payload:{fullName:'octocat/missing'}});
check(r.statusCode===404 && J(r).code==='repo-missing' && J(r).error==='GitHub has no repository octocat/missing that this token can see. Check the name, or use a token with access to it.', 'a missing repository: '+r.body);
r = await app.inject({method:'POST',url:'/api/github/import',payload:{fullName:'octocat/locked'}});
check(r.statusCode===403 && J(r).code==='no-access' && J(r).error==='This GitHub token cannot read octocat/locked. Use a token with access to it.', 'no access: '+r.body);
r = await app.inject({method:'POST',url:'/api/github/import',payload:{fullName:'octocat/down'}});
check(r.statusCode===502 && J(r).code==='unreachable' && J(r).error==='Could not reach GitHub just now. Try again in a moment.', 'no answer: '+r.body);
r = await app.inject({method:'POST',url:'/api/github/import',payload:{fullName:'octocat/gone'}});
check(r.statusCode===404 && J(r).code==='repo-missing' && /^GitHub has no repository octocat\/gone/.test(J(r).error), 'a clone that finds no repository: '+r.body);
check(!J(r).error.includes('API') && !J(r).error.includes('fatal'), 'none of it raw: '+r.body);

// edit + push
fs.writeFileSync(path.join(process.env.DATA_DIR,'projects',pid,'main.tex'),'\\documentclass{article}\\begin{document}EDITED IN ALDINE\\end{document}\n');
r = await app.inject({method:'POST',url:`/api/projects/${pid}/github/push`});
check(r.statusCode===200, 'push status '+r.body);
const onRemote = execSync(`git --git-dir="${bare}" show main:main.tex`).toString();
check(onRemote.includes('EDITED IN ALDINE'),'push reached the remote');

// external change on remote → status behind, pull catches up
execSync(`cd "${seed}" && git pull -q && printf 'EXTERNAL\\n' >> main.tex && git commit -qam ext && git push -q`);
r = await app.inject({url:`/api/projects/${pid}/github/status`});
check(J(r).behind===1, 'behind 1 after external push: '+r.body);
r = await app.inject({method:'POST',url:`/api/projects/${pid}/github/pull`});
check(r.statusCode===200, 'pull ok '+r.body);
check(fs.readFileSync(path.join(process.env.DATA_DIR,'projects',pid,'main.tex'),'utf8').includes('EXTERNAL'),'pulled external change');

// status polls inside the fetch TTL answer from the last fetch (editors poll
// it); pull fetches for itself, so it still brings everything in
r = await app.inject({url:`/api/projects/${pid}/github/status`});
check(J(r).behind===0 && J(r).ahead===0, 'in sync after pull: '+r.body);
execSync(`cd "${seed}" && git pull -q && printf 'EXTERNAL2\\n' >> main.tex && git commit -qam ext2 && git push -q`);
r = await app.inject({url:`/api/projects/${pid}/github/status`});
check(J(r).behind===0, 'a poll within the TTL does not fetch again: '+r.body);
r = await app.inject({method:'POST',url:`/api/projects/${pid}/github/pull`});
check(r.statusCode===200 && fs.readFileSync(path.join(process.env.DATA_DIR,'projects',pid,'main.tex'),'utf8').includes('EXTERNAL2'),'pull still fetches: '+r.body);

// push with a custom commit message → the remote commit subject matches
fs.writeFileSync(path.join(process.env.DATA_DIR,'projects',pid,'main.tex'),'v2\n');
r = await app.inject({method:'POST',url:`/api/projects/${pid}/github/push`,payload:{message:'my custom message'}});
check(r.statusCode===200,'push2 '+r.body);
check(execSync(`git --git-dir="${bare}" log -1 --format=%s main`).toString().trim()==='my custom message','custom commit message on remote');

// a message git cannot take (a NUL fails the spawn) is cleaned, not dropped:
// before, the commit silently failed and the stale HEAD was pushed as a success
fs.writeFileSync(path.join(process.env.DATA_DIR,'projects',pid,'main.tex'),'v3\n');
r = await app.inject({method:'POST',url:`/api/projects/${pid}/github/push`,payload:{message:'nul\u0000inside\tand tab'}});
check(r.statusCode===200,'push3 '+r.body);
check(execSync(`git --git-dir="${bare}" log -1 --format=%s main`).toString().trim()==='nulinside and tab','the cleaned message is the remote commit subject');
check(execSync(`git --git-dir="${bare}" show main:main.tex`).toString()==='v3\n','the edit behind a NUL-bearing message still reached the remote');

// divergent edits to the same line → pull conflicts (409), then take-remote resolves
execSync(`cd "${seed}" && git pull -q && printf 'REMOTE VERSION\\n' > main.tex && git commit -qam remoteedit && git push -q`);
fs.writeFileSync(path.join(process.env.DATA_DIR,'projects',pid,'main.tex'),'LOCAL VERSION\n');
const prepo = path.join(process.env.DATA_DIR,'projects',pid);
r = await app.inject({method:'POST',url:`/api/projects/${pid}/github/pull`});
check(r.statusCode===409,'pull conflicts with 409 (got '+r.statusCode+')');
check(Array.isArray(J(r).conflicts) && J(r).conflicts.includes('main.tex'),'conflict lists main.tex');
const keepAs = J(r).keepAs;
check(/^my-version-\d{4}-\d{2}-\d{2}$/.test(keepAs), 'the conflict names the branch main is saved as first: '+r.body);
// an edit typed while the dialog is open is part of what is kept
fs.writeFileSync(path.join(prepo,'notes.tex'),'TYPED DURING THE DIALOG\n');
r = await app.inject({method:'POST',url:`/api/projects/${pid}/github/reset-to-remote`});
check(r.statusCode===200,'reset-to-remote ok '+r.body);
check(J(r).kept===keepAs, 'main was saved as that branch first: '+r.body);
check(fs.readFileSync(path.join(process.env.DATA_DIR,'projects',pid,'main.tex'),'utf8').trim()==='REMOTE VERSION','took the remote version');
check(execSync(`git -C "${prepo}" show ${keepAs}:main.tex`).toString().trim()==='LOCAL VERSION', 'the kept branch has the local version');
check(execSync(`git -C "${prepo}" show ${keepAs}:notes.tex`).toString().trim()==='TYPED DURING THE DIALOG', 'and the edit made after the pull');
check(!execSync(`git --git-dir="${bare}" for-each-ref --format='%(refname:short)' refs/heads`).toString().includes('my-version'), 'the kept branch never reaches the host');
r = await app.inject({url:`/api/projects/${pid}/branches`});
check(J(r).some((b)=>b.name===keepAs), 'it is listed with the project\'s own branches: '+r.body);
r = await app.inject({url:`/api/projects/${pid}/file?branch=${keepAs}&path=main.tex`});
check(r.statusCode===200 && r.body.trim()==='LOCAL VERSION', 'and opens like any branch, its files there at once: '+r.body);
// a second conflict the same day gets a name of its own
execSync(`cd "${seed}" && git pull -q && printf 'REMOTE AGAIN\n' > main.tex && git commit -qam remoteagain && git push -q`);
fs.writeFileSync(path.join(prepo,'main.tex'),'LOCAL AGAIN\n');
r = await app.inject({method:'POST',url:`/api/projects/${pid}/github/pull`});
check(r.statusCode===409 && J(r).keepAs===`${keepAs}-2`, 'the next conflict names the next free branch: '+r.body);
r = await app.inject({method:'POST',url:`/api/projects/${pid}/github/reset-to-remote`});
check(J(r).kept===`${keepAs}-2` && execSync(`git -C "${prepo}" show ${keepAs}-2:main.tex`).toString().trim()==='LOCAL AGAIN', 'kept as that branch: '+r.body);
// nothing the host lacks: nothing to keep
r = await app.inject({method:'POST',url:`/api/projects/${pid}/github/reset-to-remote`});
check(r.statusCode===200 && J(r).kept===null, 'a main the host already has keeps no branch: '+r.body);

// a push the host refuses because it moved on: a sentence and a code for the Pull button
execSync(`cd "${seed}" && git pull -q && printf 'HOST MOVED\n' > host.tex && git add -A && git commit -qm hostmoved && git push -q`);
fs.writeFileSync(path.join(prepo,'local.tex'),'LOCAL ONLY\n');
r = await app.inject({method:'POST',url:`/api/projects/${pid}/github/push`});
check(r.statusCode===409 && J(r).code==='pull-first' && J(r).error==='GitHub has newer commits on main. Pull first, then push.', 'rejected push → pull-first: '+r.body);
r = await app.inject({url:`/api/projects/${pid}/github/status`});
check(J(r).behind===1, 'the failed push dropped the cached fetch, so the status sees the host\'s commit at once: '+r.body);
r = await app.inject({method:'POST',url:`/api/projects/${pid}/github/pull`});
check(r.statusCode===200, 'pull '+r.body);
r = await app.inject({method:'POST',url:`/api/projects/${pid}/github/push`});
check(r.statusCode===200, 'then the push lands '+r.body);

// branch-level: create a branch → it appears on the remote and becomes current
r = await app.inject({method:'POST',url:`/api/projects/${pid}/github/create-branch`,payload:{name:'feature-x'}});
check(r.statusCode===200,'create-branch '+r.body);
check(execSync(`git --git-dir="${bare}" for-each-ref --format='%(refname:short)' refs/heads`).toString().includes('feature-x'),'remote has feature-x');
r = await app.inject({url:`/api/projects/${pid}/github/branches`});
check(J(r).current==='feature-x' && J(r).branches.includes('main') && J(r).branches.includes('feature-x'),'branches list + current: '+r.body);

// open a PR from the feature branch
r = await app.inject({method:'POST',url:`/api/projects/${pid}/github/pr`,payload:{title:'My PR'}});
check(r.statusCode===200 && J(r).url.includes('/pull/7'),'PR opened: '+r.body);
// a second one for the same branch links to the open one instead of the host's JSON
r = await app.inject({method:'POST',url:`/api/projects/${pid}/github/pr`,payload:{title:'Again'}});
check(r.statusCode===409 && J(r).code==='change-request-open' && J(r).url==='https://github.com/octocat/hello/pull/7' && J(r).number===7, 'PR already open → its link: '+r.body);
check(J(r).error==='A pull request from feature-x into main is already open: #7.', 'in a sentence: '+r.body);

// switch back to main
r = await app.inject({method:'POST',url:`/api/projects/${pid}/github/switch-branch`,payload:{branch:'main'}});
check(r.statusCode===200 && J(r).branch==='main','switch back to main '+r.body);
r = await app.inject({url:`/api/projects/${pid}/github/branches`});
check(J(r).current==='main','current is main after switch');

// ---- GitHub Enterprise Server: the connection names its instance, and the link keeps it ----
r = await app.inject({method:'POST',url:'/api/github/connect',payload:{token:'ghe-token', baseUrl:'https://github.example.edu/api/v3/'}});
check(r.statusCode===200 && J(r).baseUrl==='https://github.example.edu', 'connect to an Enterprise instance, API path dropped: '+r.body);
r = await app.inject({url:'/api/remotes/github/status'});
check(J(r).baseUrl==='https://github.example.edu' && J(r).selfHosted===true, 'status names the instance: '+r.body);
r = await app.inject({method:'POST',url:'/api/remotes/github/import',payload:{fullName:'octocat/hello'}});
check(r.statusCode===200 && J(r).remote?.baseUrl==='https://github.example.edu', 'an import records the instance on the link: '+r.body);
const ghePid = J(r).id;
fs.writeFileSync(path.join(process.env.DATA_DIR,'projects',ghePid,'ghe.tex'),'FROM ENTERPRISE\n');
r = await app.inject({method:'POST',url:`/api/projects/${ghePid}/remote/push`});
check(r.statusCode===200 && execSync(`git --git-dir="${bare}" show main:ghe.tex`).toString()==='FROM ENTERPRISE\n', 'push goes where the link points: '+r.body);
check(!fs.readFileSync(path.join(process.env.DATA_DIR,'projects',ghePid,'.git','config'),'utf8').includes('ghe-token'), 'the token never lands in .git/config');
// a github.com connection does not serve an Enterprise link, and the refusal names the instance
r = await app.inject({method:'POST',url:'/api/github/connect',payload:{token:'fake'}});
check(r.statusCode===200 && J(r).baseUrl===undefined, 'back on github.com: '+r.body);
r = await app.inject({url:`/api/projects/${ghePid}/remote/status`});
check(r.statusCode===400 && J(r).code==='no-connection' && J(r).error==='Connect GitHub on https://github.example.edu to sync', 'github.com cannot sync it: '+r.body);

// publish: where to, a name already in use, and an organisation
r = await app.inject({url:'/api/github/owners'});
check(JSON.stringify(J(r).owners)===JSON.stringify([{path:'tester',kind:'user'},{path:'acme',kind:'org'}]), 'owners: the account, then its organisations: '+r.body);
r = await app.inject({method:'POST',url:'/api/projects',payload:{name:'Taken'}});
const taken = J(r).id;
r = await app.inject({method:'POST',url:`/api/projects/${taken}/remote/link`,payload:{provider:'github',name:'hello'}});
check(r.statusCode===409 && J(r).code==='name-taken' && J(r).error==='tester already has a repository called hello on GitHub. Pick another name.', 'name in use → a sentence: '+r.body);
r = await app.inject({method:'POST',url:`/api/projects/${taken}/remote/link`,payload:{provider:'github',name:'org-paper',namespace:'acme'}});
check(r.statusCode===200 && J(r).remote?.fullName==='acme/org-paper' && J(r).remote?.owner==='acme', 'published into the organisation: '+r.body);
check(seen.includes('/orgs/acme/repos'), 'through the organisation route');
check(execSync(`git --git-dir="${orgBare}" show main:main.tex`).toString().includes('documentclass'), 'the first push landed there');

mock.close(); await app.close(); fs.rmSync(tmp,{recursive:true,force:true});
console.log('GitHub integration (import→push→pull→conflict→keep both→rejected push→branches→PR→switch→publish): ALL PASSED');
