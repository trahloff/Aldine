#!/usr/bin/env node
// Boots nothing itself: points at a running stack (ALDINE_URL, default
// http://localhost:8080) and proves the published images work the way a
// self-hoster will use them. This is the first time the emitted dist/ and the
// compiler's package set are executed anywhere before a user does.
//
// Checks, in order: the app answers /api/health; the compiler is reachable
// through it and reports a real TeX Live (and the scheme in EXPECT_SCHEME, if
// set: the image reports "unknown" rather than failing when the build arg went
// missing); the SPA and the template gallery are served; a biblatex document
// typesets to a multi-page PDF with its citation resolved, under the compose
// sandbox (no egress, caps dropped).
const BASE = (process.env.ALDINE_URL || 'http://localhost:8080').replace(/\/$/, '');
const EXPECT_SCHEME = process.env.EXPECT_SCHEME || '';
const WAIT_MS = Number(process.env.SMOKE_WAIT_MS || 180_000);

function fail(msg) {
  console.error(`smoke: FAIL ${msg}`);
  process.exit(1);
}
function ok(msg) {
  console.log(`smoke: ok  ${msg}`);
}

async function json(path, init) {
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function waitForHealth() {
  const until = Date.now() + WAIT_MS;
  let last = '';
  while (Date.now() < until) {
    try {
      const r = await json('/api/health');
      if (r.status === 200 && r.body && r.body.ok === true) return r.body;
      last = `${r.status} ${JSON.stringify(r.body)}`;
    } catch (e) {
      last = String(e);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  fail(`/api/health not ok after ${WAIT_MS / 1000}s (last: ${last})`);
}

const health = await waitForHealth();
ok(`/api/health ${JSON.stringify(health)}`);

// The compiler sits on the internal network, so it is only reachable via the
// app, which caches a failed probe for 5 s; give it a few tries.
let compiler;
for (let i = 0; i < 20; i++) {
  compiler = (await json('/api/compiler')).body;
  if (compiler && compiler.ok) break;
  await new Promise((r) => setTimeout(r, 3000));
}
if (!compiler || !compiler.ok) fail(`/api/compiler: compiler unreachable: ${JSON.stringify(compiler)}`);
if (!compiler.texlive || compiler.texlive.release === 'unknown') fail(`/api/compiler: TeX Live release unknown: ${JSON.stringify(compiler)}`);
if (EXPECT_SCHEME && compiler.texlive.scheme !== EXPECT_SCHEME) fail(`/api/compiler: scheme ${compiler.texlive.scheme}, expected ${EXPECT_SCHEME}`);
ok(`/api/compiler TeX Live ${compiler.texlive.release} (${compiler.texlive.scheme})`);

const index = await fetch(BASE + '/');
const html = await index.text();
if (index.status !== 200 || !/<div id="root"|<script/.test(html)) fail(`GET / returned ${index.status} without the SPA shell`);
ok('GET / serves the SPA');

const templates = await json('/api/templates');
if (templates.status !== 200) fail(`/api/templates returned ${templates.status}`);
ok('/api/templates responds');

const mainTex = String.raw`\documentclass{article}
\usepackage[backend=biber,style=numeric]{biblatex}
\addbibresource{refs.bib}
\begin{document}
\title{Release smoke}\author{Aldine CI}\maketitle
A citation that must resolve: \cite{smoke2026}.
\newpage
Second page, so the PDF has more than one.
\printbibliography
\end{document}
`;
const refsBib = `@article{smoke2026,
  author  = {Smoke, Test},
  title   = {A reference that only exists in this test},
  journal = {Journal of Release Checks},
  year    = {2026},
}
`;
const created = await json('/api/projects', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Release smoke', files: { 'main.tex': mainTex, 'refs.bib': refsBib } }),
});
if (created.status !== 200 && created.status !== 201) fail(`POST /api/projects returned ${created.status} ${JSON.stringify(created.body)}`);
const id = created.body.id;
if (!id) fail(`POST /api/projects returned no id: ${JSON.stringify(created.body)}`);
ok(`project ${id} created`);

const compiled = await json(`/api/projects/${id}/compile`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ branch: 'main' }),
});
const result = compiled.body;
const log = typeof result?.log === 'string' ? result.log : '';
if (compiled.status !== 200 || !result || !result.ok) {
  console.error(log.slice(-4000));
  fail(`compile returned ${compiled.status}, ok=${result?.ok}, errors=${JSON.stringify(result?.errors)}`);
}
if (!result.pdfUrl) fail('compile ok but no pdfUrl');
if (/undefined (references|citations)|Citation .* undefined|Please \(re\)run Biber/i.test(log)) {
  console.error(log.slice(-4000));
  fail('the citation did not resolve (biber did not run through)');
}
ok(`compiled in ${result.durationMs} ms`);

const pdfRes = await fetch(BASE + result.pdfUrl);
const pdf = Buffer.from(await pdfRes.arrayBuffer());
if (pdfRes.status !== 200 || pdf.subarray(0, 5).toString() !== '%PDF-') fail(`pdf fetch returned ${pdfRes.status}, ${pdf.length} bytes`);
// pdfTeX compresses its object streams, so the page tree is not greppable in
// the bytes; the engine's own "Output written on … (N pages" line is.
const written = /Output written on [^\n]*\((\d+) pages?/.exec(log);
const pages = written ? Number(written[1]) : 0;
if (pages < 2) fail(`expected a multi-page PDF, log says ${written ? written[0] : 'nothing about pages'}`);
ok(`PDF ${pdf.length} bytes, ${pages} pages`);

console.log('smoke: all checks passed');
