/**
 * The main document's name ends up on latexmk's command line. Both guards,
 * the server's (settings route) and the compiler's, must refuse anything
 * latexmk could read as an option, and accept the ordinary shapes.
 */
import { createRequire } from 'node:module';
import { check, eq } from './assert.mjs';

const { invalidRootFile: serverGuard } = await import('../src/util.ts');
const { invalidRootFile: compilerGuard, parseLog } = createRequire(import.meta.url)('../../compiler/server.js');

const accepted = ['main.tex', 'paper/main.tex', 'MAIN.TEX', 'my-paper.tex', 'src/v2-final.tex', 'thesis.ltx'];
const refused = [
  '-pdflatex=touch /tmp/x #.tex',
  '--version',
  'paper/-main.tex',
  '-',
  '../main.tex',
  'a/../../b.tex',
  '/etc/main.tex',
  '',
];

for (const p of accepted) {
  eq(serverGuard(p), null, `server accepts ${p}`);
  eq(compilerGuard(p), false, `compiler accepts ${p}`);
}
for (const p of refused) {
  check(typeof serverGuard(p) === 'string', `server refuses ${JSON.stringify(p)}`);
  eq(compilerGuard(p), true, `compiler refuses ${JSON.stringify(p)}`);
}
check(typeof serverGuard(undefined) === 'string', 'server refuses a missing value');
eq(compilerGuard(42), true, 'compiler refuses a non-string');
check(typeof parseLog === 'function', 'the compiler module still exports its parsers');

console.log('rootfile-guard: ok');
