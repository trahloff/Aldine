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
const mock = http.createServer((req,res)=>{ res.setHeader('content-type','application/json');
  if (req.url==='/user') return res.end(JSON.stringify({login:'tester',name:'Tester'}));
  if (req.url.startsWith('/user/repos')) return res.end(JSON.stringify([repoJson]));
  if (req.url==='/repos/octocat/hello') return res.end(JSON.stringify(repoJson));
  if (req.url.startsWith('/repos/octocat/hello/branches')) {
    const names = execSync(`git --git-dir="${bare}" for-each-ref --format='%(refname:short)' refs/heads`).toString().trim().split('\n').filter(Boolean);
    return res.end(JSON.stringify(names.map(n=>({name:n}))));
  }
  if (req.url==='/repos/octocat/hello/pulls' && req.method==='POST') return res.end(JSON.stringify({html_url:'https://github.com/octocat/hello/pull/7', number:7}));
  res.statusCode=404; res.end('{}');
});
await new Promise(r=>mock.listen(0,r)); process.env.GITHUB_API_BASE=`http://localhost:${mock.address().port}`;

const { initDb } = await import('../src/db/index.ts'); await initDb();
const Fastify = (await import('fastify')).default;
const { registerRoutes } = await import('../src/routes.ts');
const app = Fastify(); await registerRoutes(app);
const J = (r)=>{ try{return JSON.parse(r.body)}catch{return r.body} };

let r = await app.inject({method:'POST',url:'/api/remotes/github/connect',payload:{token:'fake'}});
check(r.statusCode===200 && J(r).login==='tester', 'connect ok: '+r.body);
r = await app.inject({url:'/api/remotes/github/status'});
check(J(r).connected===true, 'status connected');
r = await app.inject({url:'/api/remotes/github/repos'});
check(Array.isArray(J(r)) && J(r)[0].fullName==='octocat/hello', 'repos list');
r = await app.inject({method:'POST',url:'/api/remotes/github/import',payload:{fullName:'octocat/hello'}});
check(r.statusCode===200, 'import status '+r.body);
const pid = J(r).id; check(pid, 'got project id');
check(J(r).remote?.fullName==='octocat/hello' && J(r).remote?.provider==='github', 'meta has the github remote link');
check(fs.existsSync(path.join(process.env.DATA_DIR,'projects',pid,'main.tex')),'imported main.tex present');

// edit + push
fs.writeFileSync(path.join(process.env.DATA_DIR,'projects',pid,'main.tex'),'\\documentclass{article}\\begin{document}EDITED IN ALDINE\\end{document}\n');
r = await app.inject({method:'POST',url:`/api/projects/${pid}/remote/push`});
check(r.statusCode===200, 'push status '+r.body);
const onRemote = execSync(`git --git-dir="${bare}" show main:main.tex`).toString();
check(onRemote.includes('EDITED IN ALDINE'),'push reached the remote');

// external change on remote → status behind, pull catches up
execSync(`cd "${seed}" && git pull -q && printf 'EXTERNAL\\n' >> main.tex && git commit -qam ext && git push -q`);
r = await app.inject({url:`/api/projects/${pid}/remote/status`});
check(J(r).behind===1, 'behind 1 after external push: '+r.body);
r = await app.inject({method:'POST',url:`/api/projects/${pid}/remote/pull`});
check(r.statusCode===200, 'pull ok '+r.body);
check(fs.readFileSync(path.join(process.env.DATA_DIR,'projects',pid,'main.tex'),'utf8').includes('EXTERNAL'),'pulled external change');

// push with a custom commit message → the remote commit subject matches
fs.writeFileSync(path.join(process.env.DATA_DIR,'projects',pid,'main.tex'),'v2\n');
r = await app.inject({method:'POST',url:`/api/projects/${pid}/remote/push`,payload:{message:'my custom message'}});
check(r.statusCode===200,'push2 '+r.body);
check(execSync(`git --git-dir="${bare}" log -1 --format=%s main`).toString().trim()==='my custom message','custom commit message on remote');

// divergent edits to the same line → pull conflicts (409), then take-remote resolves
execSync(`cd "${seed}" && git pull -q && printf 'REMOTE VERSION\\n' > main.tex && git commit -qam remoteedit && git push -q`);
fs.writeFileSync(path.join(process.env.DATA_DIR,'projects',pid,'main.tex'),'LOCAL VERSION\n');
const prepo = path.join(process.env.DATA_DIR,'projects',pid);
r = await app.inject({method:'POST',url:`/api/projects/${pid}/remote/pull`});
check(r.statusCode===409,'pull conflicts with 409 (got '+r.statusCode+')');
check(Array.isArray(J(r).conflicts) && J(r).conflicts.includes('main.tex'),'conflict lists main.tex');
r = await app.inject({method:'POST',url:`/api/projects/${pid}/remote/reset-to-remote`});
check(r.statusCode===200,'reset-to-remote ok '+r.body);
check(fs.readFileSync(path.join(process.env.DATA_DIR,'projects',pid,'main.tex'),'utf8').trim()==='REMOTE VERSION','took the remote version');

// branch-level: create a branch → it appears on the remote and becomes current
r = await app.inject({method:'POST',url:`/api/projects/${pid}/remote/create-branch`,payload:{name:'feature-x'}});
check(r.statusCode===200,'create-branch '+r.body);
check(execSync(`git --git-dir="${bare}" for-each-ref --format='%(refname:short)' refs/heads`).toString().includes('feature-x'),'remote has feature-x');
r = await app.inject({url:`/api/projects/${pid}/remote/branches`});
check(J(r).current==='feature-x' && J(r).branches.includes('main') && J(r).branches.includes('feature-x'),'branches list + current: '+r.body);

// open a PR from the feature branch
r = await app.inject({method:'POST',url:`/api/projects/${pid}/remote/change-request`,payload:{title:'My PR'}});
check(r.statusCode===200 && J(r).url.includes('/pull/7'),'PR opened: '+r.body);

// switch back to main
r = await app.inject({method:'POST',url:`/api/projects/${pid}/remote/switch-branch`,payload:{branch:'main'}});
check(r.statusCode===200 && J(r).branch==='main','switch back to main '+r.body);
r = await app.inject({url:`/api/projects/${pid}/remote/branches`});
check(J(r).current==='main','current is main after switch');

mock.close(); await app.close(); fs.rmSync(tmp,{recursive:true,force:true});
console.log('GitHub integration (import→push→pull→conflict→branches→PR→switch): ALL PASSED');
