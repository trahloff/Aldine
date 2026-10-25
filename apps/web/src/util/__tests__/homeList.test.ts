import { describe, expect, it } from 'vitest';
import type { ProjectSummary } from '../../api';
import {
  errorLabel, firstName, initials, isUnread, matchSentence, matchesQuery, metaLine, ownerChipShown, parseShow, parseSort, pdfBranch,
  pdfOutputPath, projectHref, sectionsOf, sortProjects,
} from '../homeList';

const NOW = new Date(2026, 9, 25, 15, 30).getTime();
const MIN = 60_000;
const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function p(name: string, o: Partial<ProjectSummary> = {}): ProjectSummary {
  return { id: name, name, rootFile: 'main.tex', engine: 'pdflatex', createdAt: iso(400 * DAY), zotero: null, ...o };
}

describe('sorting', () => {
  const list = [
    p('b', { lastEdit: { at: iso(2 * DAY), byId: null, byName: null, branch: 'main' }, opened: { at: iso(MIN), branch: 'main' } }),
    p('a', { lastEdit: { at: iso(3 * MIN), byId: null, byName: null, branch: 'main' }, createdAt: iso(DAY) }),
    p('c10'),
    p('c9'),
  ];

  it('defaults to the last edit, newest first', () => {
    expect(sortProjects(list, 'edited').map((x) => x.name)).toEqual(['a', 'b', 'c9', 'c10']);
  });

  it('puts projects never opened last under "Last opened by me"', () => {
    expect(sortProjects(list, 'opened').map((x) => x.name)).toEqual(['b', 'a', 'c9', 'c10']);
  });

  it('sorts names the way people count', () => {
    expect(sortProjects(list, 'name').map((x) => x.name)).toEqual(['a', 'b', 'c9', 'c10']);
  });

  it('reads stored choices defensively', () => {
    expect(parseSort('name')).toBe('name');
    expect(parseSort('nonsense')).toBe('edited');
    expect(parseShow('shared', true)).toBe('shared');
    expect(parseShow('shared', false)).toBe('all');
    expect(parseShow('trash', false)).toBe('trash');
  });
});

describe('sections', () => {
  it('appear only under a date sort and from eight projects', () => {
    const few = [p('x', { lastEdit: { at: iso(MIN), byId: null, byName: null, branch: 'main' } })];
    expect(sectionsOf(few, 'edited', NOW)).toEqual([{ key: 'all', label: null, items: few }]);
    const many = Array.from({ length: 8 }, (_, i) => p(`p${i}`, { lastEdit: { at: iso(i < 3 ? MIN : 4 * DAY), byId: null, byName: null, branch: 'main' } }));
    expect(sectionsOf(many, 'edited', NOW).map((s) => [s.label, s.items.length])).toEqual([['Today', 3], ['Previous 7 days', 5]]);
    expect(sectionsOf(many, 'name', NOW)).toHaveLength(1);
  });

  it('folds months and years with few projects into one "Earlier"', () => {
    const at = (d: Date) => ({ lastEdit: { at: d.toISOString(), byId: null, byName: null, branch: 'main' } });
    const list = [
      ...Array.from({ length: 5 }, (_, i) => p(`t${i}`, at(new Date(NOW - MIN)))),
      p('june', at(new Date(2026, 5, 10))),
      ...Array.from({ length: 3 }, (_, i) => p(`may${i}`, at(new Date(2026, 4, 10)))),
      p('old', at(new Date(2025, 2, 1))),
    ];
    expect(sectionsOf(list, 'edited', NOW).map((s) => [s.label, s.items.length])).toEqual([['Today', 5], ['Earlier', 5]]);
    const dense = [...list.filter((x) => x.id !== 'june' && x.id !== 'old'), p('may3', at(new Date(2026, 4, 11)))];
    expect(sectionsOf(sortProjects(dense, 'edited'), 'edited', NOW).map((s) => s.label)).toEqual(['Today', 'May']);
  });
});

describe('the line under a project', () => {
  it('names someone else, and only someone else', () => {
    const mine = p('m', { lastEdit: { at: iso(3 * MIN), byId: 'me', byName: 'Ada Lovelace', branch: 'main' } });
    expect(metaLine(mine, 'me', NOW)).toEqual({ who: null, text: 'Edited 3 minutes ago' });
    const theirs = p('t', { lastEdit: { at: iso(3 * 3600_000), byId: 'grace', byName: 'Grace Hopper', branch: 'main' } });
    expect(metaLine(theirs, 'me', NOW)).toEqual({ who: 'Grace Hopper', text: 'edited 3 hours ago' });
    expect(metaLine(p('old'), 'me', NOW).text).toMatch(/^Created on /);
  });

  it('on a phone: short units and the first name', () => {
    const mine = p('m', { lastEdit: { at: iso(3 * MIN), byId: 'me', byName: 'Ada Lovelace', branch: 'main' } });
    expect(metaLine(mine, 'me', NOW, { short: true })).toEqual({ who: null, text: 'Edited 3 min ago' });
    const theirs = p('t', { lastEdit: { at: iso(3 * 3600_000), byId: 'grace', byName: 'Grace Hopper', branch: 'main' } });
    expect(metaLine(theirs, 'me', NOW, { short: true })).toEqual({ who: 'Grace', text: '· 3 hr ago' });
  });

  it('a recipient sees the owner on a chip, so the owner\'s own edit does not name them twice', () => {
    const edit = { at: iso(3 * 3600_000), byId: 'grace', byName: 'Grace Hopper', branch: 'main' };
    const shared = p('s', { ownerId: 'grace', ownerName: 'Grace Hopper', access: 'link', lastEdit: edit });
    expect(ownerChipShown(shared, true)).toBe(true);
    expect(ownerChipShown(shared, false)).toBe(false);
    expect(ownerChipShown({ ...shared, access: 'owner' }, true)).toBe(false);
    expect(metaLine(shared, 'me', NOW, { ownerOnChip: true })).toEqual({ who: null, text: 'Edited 3 hours ago' });
    // someone else's edit still names them
    const bob = { ...shared, lastEdit: { ...edit, byId: 'bob', byName: 'Bob Barker' } };
    expect(metaLine(bob, 'me', NOW, { ownerOnChip: true })).toEqual({ who: 'Bob Barker', text: 'edited 3 hours ago' });
    expect(firstName('  Grace  Hopper ')).toBe('Grace');
  });

  it('marks a change made since the last open as unread', () => {
    const edit = { at: iso(10 * MIN), byId: 'grace', byName: 'Grace Hopper', branch: 'main' };
    expect(isUnread(p('a', { lastEdit: edit, opened: { at: iso(20 * MIN), branch: 'main' } }), 'me')).toBe(true);
    expect(isUnread(p('a', { lastEdit: edit, opened: { at: iso(MIN), branch: 'main' } }), 'me')).toBe(false);
    expect(isUnread(p('a', { lastEdit: edit, opened: null }), 'me')).toBe(true);
    expect(isUnread(p('a', { lastEdit: { ...edit, byId: 'me' } }), 'me')).toBe(false);
    // the agent writes under its own name
    expect(isUnread(p('a', { lastEdit: { ...edit, byId: null, byName: 'Claude' }, opened: { at: iso(20 * MIN), branch: 'main' } }), null)).toBe(true);
  });
});

describe('small helpers', () => {
  it('searches names, owners and branches', () => {
    const x = p('thesis-ch3-methods', { ownerName: 'Grace Hopper', opened: { at: iso(MIN), branch: 'advisor-comments' } });
    expect(matchesQuery(x, 'thesis methods')).toBe(true);
    expect(matchesQuery(x, 'grace')).toBe(true);
    expect(matchesQuery(x, 'advisor')).toBe(true);
    expect(matchesQuery(x, 'poster')).toBe(false);
    expect(matchesQuery(x, '  ')).toBe(true);
  });

  it('downloads the PDF of the branch that typeset, not the one its thumbnail fell back to', () => {
    const at = iso(MIN);
    // the branch's typeset is fine, but its thumbnail render was skipped: the image is main's
    expect(pdfBranch({ compile: { status: 'ok', errors: 0, at, branch: 'revision-2' }, thumb: { branch: 'main', w: 1, h: 1, v: 'x' }, opened: { at, branch: 'revision-2' } })).toBe('revision-2');
    expect(pdfBranch({ compile: { status: 'error', errors: 2, at, branch: 'revision-2' }, thumb: { branch: 'main', w: 1, h: 1, v: 'x' }, opened: { at, branch: 'revision-2' } })).toBe('main');
    expect(pdfBranch({ compile: null, thumb: null, opened: { at, branch: 'revision-2' } })).toBe('revision-2');
    expect(pdfBranch({ compile: null, thumb: null, opened: null })).toBe('main');
  });

  it('opens a project on the branch it was last open on', () => {
    expect(projectHref({ id: 'x', opened: { at: '', branch: 'camera ready' } })).toBe('/p/x?branch=camera%20ready');
    expect(projectHref({ id: 'x', opened: { at: '', branch: 'main' } })).toBe('/p/x');
    expect(projectHref({ id: 'x', opened: null })).toBe('/p/x');
  });

  it('words counts and names', () => {
    expect(matchSentence(3, 'th')).toBe('3 projects match');
    expect(matchSentence(1, 'th')).toBe('1 project matches');
    expect(matchSentence(0, ' zz ')).toBe('No projects match “zz”');
    expect(errorLabel(4)).toBe('4 errors');
    expect(errorLabel(1)).toBe('1 error');
    expect(errorLabel(0)).toBe('Typeset failed');
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('grace')).toBe('G');
    expect(initials('')).toBe('?');
    expect(pdfOutputPath('main.tex')).toBe('.aldine-out/main.pdf');
    expect(pdfOutputPath('paper/thesis.tex')).toBe('paper/.aldine-out/thesis.pdf');
  });
});
