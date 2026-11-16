/**
 * Branch names git would refuse, and the sentence that says why. The
 * names git accepts are the `git check-ref-format` rules: no `..`, no
 * doubled, leading or trailing slash, no part starting with a dot or
 * ending in `.lock`, no trailing dot, no `@{`, and none of space
 * `~^:?*[` or backslash. Aldine's own shape rule (`BRANCH_RE`, the
 * length and character set) sits on top in the routes, so a name git
 * accepts but Aldine refuses — `release+hotfix`, and `@` on its own —
 * is null here.
 */
import { check, eq } from './assert.mjs';

const { invalidBranchName } = await import('../src/util.ts');

eq(invalidBranchName('main'), null, 'main is fine');
eq(invalidBranchName('feature/login'), null, 'a slash is fine');
eq(invalidBranchName('fix-1.2_x'), null, 'dots, dashes and underscores are fine');
eq(invalidBranchName('a/b/c'), null, 'several levels are fine');
eq(invalidBranchName('release+hotfix'), null, 'git accepts +, Aldine refuses it in the route');
eq(invalidBranchName('a@b'), null, '@ alone in a name is fine');
eq(invalidBranchName('@'), null, 'git accepts @ as a branch name; the route refuses it');

eq(invalidBranchName(''), 'Branch name cannot be empty', 'empty refused');
eq(invalidBranchName(42), 'Branch name cannot be empty', 'not a string refused');
eq(invalidBranchName('draft.'), 'Branch names cannot end with a dot', 'trailing dot refused');
eq(invalidBranchName('a/'), 'Branch names cannot end with "/"', 'trailing slash refused');
eq(invalidBranchName('/a'), 'Branch names cannot start with "/"', 'leading slash refused');
eq(invalidBranchName('a//b'), 'Branch names cannot contain "//"', 'doubled slash refused');
eq(invalidBranchName('a..b'), 'Branch names cannot contain ".."', 'double dot refused');
eq(invalidBranchName('a/.b'), 'Branch names cannot have a part starting with a dot', 'dot-led part refused');
eq(invalidBranchName('.hidden'), 'Branch names cannot have a part starting with a dot', 'leading dot refused');
eq(invalidBranchName('x.lock'), 'Branch names cannot have a part ending with ".lock"', '.lock refused');
eq(invalidBranchName('a/b.lock'), 'Branch names cannot have a part ending with ".lock"', 'nested .lock refused');
eq(invalidBranchName('a.lock/b'), 'Branch names cannot have a part ending with ".lock"', 'mid-path .lock refused');
eq(invalidBranchName('a@{b}'), 'Branch names cannot contain "@{"', '@{ refused');
eq(invalidBranchName('a b'), 'Branch names cannot contain spaces', 'space refused');
eq(invalidBranchName('a~b'), 'Branch names cannot contain "~"', 'tilde refused');
eq(invalidBranchName('a^b'), 'Branch names cannot contain "^"', 'caret refused');
eq(invalidBranchName('a:b'), 'Branch names cannot contain ":"', 'colon refused');
eq(invalidBranchName('a?b'), 'Branch names cannot contain "?"', 'question mark refused');
eq(invalidBranchName('a*b'), 'Branch names cannot contain "*"', 'asterisk refused');
eq(invalidBranchName('a[b'), 'Branch names cannot contain "["', 'open bracket refused');
eq(invalidBranchName('a\\b'), 'Branch names cannot contain "\\"', 'backslash refused');
eq(invalidBranchName('a\tb'), 'Branch names cannot contain control characters', 'tab refused');

check(invalidBranchName('draft.') !== null, 'the issue example is refused');

console.log('branch-name: all checks passed');
