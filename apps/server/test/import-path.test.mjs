/**
 * ZIP entry names → project paths. Whole `..` segments and absolute names are
 * escapes; `data..csv` is a file name; Windows archives use backslashes.
 * Hidden names (`.git`, `.aldine*`) are screened without regard to letter
 * case or NTFS trailing dots/spaces, since the filesystem may ignore both.
 */
import { check, eq } from './assert.mjs';

const { importPath, isHiddenPath, isHiddenName } = await import('../src/util.ts');

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

check(isHiddenPath('.git/config'), '.git hidden');
check(isHiddenPath('sub/.git/config'), 'nested .git hidden');
check(isHiddenPath('.GIT/config'), '.GIT hidden (case-insensitive filesystems)');
check(isHiddenPath('.Git/hooks/pre-commit'), '.Git hidden');
check(isHiddenPath('.git./config'), '.git. hidden (NTFS trailing dot)');
check(isHiddenPath('.git /config'), '.git with trailing space hidden');
check(isHiddenPath('.git.../config'), 'several trailing dots hidden');
check(isHiddenPath('.aldine-out/main.pdf'), '.aldine-out hidden');
check(isHiddenPath('.ALDINE-OUT/main.pdf'), '.ALDINE-OUT hidden');
check(isHiddenPath('sub\\.GIT\\config'), 'backslash path screened');
check(isHiddenName('.GIT'), 'isHiddenName ignores case');
check(!isHiddenPath('.gitignore'), '.gitignore is not hidden');
check(!isHiddenPath('.gitattributes'), '.gitattributes is not hidden');
check(!isHiddenPath('git/config'), 'git without the dot is a normal name');
check(!isHiddenPath('main.tex'), 'plain file not hidden');
check(!isHiddenPath('.github/workflows/ci.yml'), '.github is a normal directory');
