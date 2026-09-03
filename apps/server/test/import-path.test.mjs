/**
 * ZIP entry names → project paths. Whole `..` segments and absolute names are
 * escapes; `data..csv` is a file name; Windows archives use backslashes.
 */
import { check, eq } from './assert.mjs';

const { importPath } = await import('../src/util.ts');

eq(importPath('main.tex'), 'main.tex', 'plain name');
eq(importPath('paper/sections/a.tex'), 'paper/sections/a.tex', 'nested path');
eq(importPath('./figs/x.png'), 'figs/x.png', 'leading ./ dropped');
eq(importPath('figs//x.png'), 'figs/x.png', 'doubled separator collapsed');
eq(importPath('data..csv'), 'data..csv', 'dots inside a name are not an escape');
eq(importPath('a/..b/c.tex'), 'a/..b/c.tex', '..-prefixed segment is a name');
eq(importPath('figs\\x.png'), 'figs/x.png', 'backslash separators become /');
eq(importPath('paper\\sections\\a.tex'), 'paper/sections/a.tex', 'deep backslash path');

check(importPath('../x.tex') === null, 'leading .. rejected');
check(importPath('a/../../x.tex') === null, 'inner .. rejected');
check(importPath('a\\..\\x.tex') === null, 'backslash .. rejected');
check(importPath('/etc/passwd') === null, 'absolute rejected');
check(importPath('C:\\Users\\x.tex') === null, 'drive letter rejected');
check(importPath('c:/x.tex') === null, 'lower-case drive letter rejected');
check(importPath('') === null, 'empty rejected');
check(importPath('./') === null, 'only dots rejected');
check(importPath('a\0b.tex') === null, 'NUL rejected');

console.log('importPath: all checks passed');
