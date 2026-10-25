import { describe, expect, it } from 'vitest';
import type { TemplateInfo } from '../../api';
import { ALL, galleryGroups, moveInGrid, railEntries, shownTemplates } from '../templateChooser';

const t = (id: string, extra: Partial<TemplateInfo> = {}): TemplateInfo => ({ id, name: id, ...extra });
const list: TemplateInfo[] = [
  t('blank', { category: 'General' }),
  t('article', { category: 'General', description: 'A clean article' }),
  t('repo:lab/thesis', { name: 'Lab thesis', source: { kind: 'repo', label: 'Lab templates' } }),
  t('venue:ieee', { name: 'IEEE conference', category: 'Conferences', source: { kind: 'venue' } }),
];

describe('rail and groups', () => {
  it('lists all first, then the groups with repositories after General', () => {
    const rail = railEntries(galleryGroups(list, []));
    expect(rail.map((r) => r.key)).toEqual([ALL, 'General', 'repo:lab', 'Conferences']);
    expect(rail[0].count).toBe(4);
  });

  it('narrows to the rail group, then by the search', () => {
    expect(shownTemplates(list, [], 'General', '').map((x) => x.id)).toEqual(['blank', 'article']);
    expect(shownTemplates(list, [], 'repo:lab', '').map((x) => x.id)).toEqual(['repo:lab/thesis']);
    expect(shownTemplates(list, [], ALL, 'ieee').map((x) => x.id)).toEqual(['venue:ieee']);
    expect(shownTemplates(list, [], 'General', 'clean').map((x) => x.id)).toEqual(['article']);
  });

  it('an unknown rail key shows everything', () => {
    expect(shownTemplates(list, [], 'Slides', '')).toHaveLength(4);
  });
});

describe('moveInGrid', () => {
  // Two rows of three, then a new group's row of one under the first column.
  const boxes = [
    { left: 0, top: 0, width: 100 }, { left: 110, top: 0, width: 100 }, { left: 220, top: 0, width: 100 },
    { left: 0, top: 200, width: 100 }, { left: 110, top: 200, width: 100 }, { left: 220, top: 200, width: 100 },
    { left: 0, top: 450, width: 100 },
  ];
  it('left and right step through reading order and stop at the ends', () => {
    expect(moveInGrid(boxes, 2, 'ArrowRight')).toBe(3);
    expect(moveInGrid(boxes, 0, 'ArrowLeft')).toBe(-1);
    expect(moveInGrid(boxes, 6, 'ArrowRight')).toBe(-1);
  });
  it('up and down keep the column, across a group heading', () => {
    expect(moveInGrid(boxes, 1, 'ArrowDown')).toBe(4);
    expect(moveInGrid(boxes, 5, 'ArrowDown')).toBe(6);
    expect(moveInGrid(boxes, 6, 'ArrowUp')).toBe(3);
    expect(moveInGrid(boxes, 1, 'ArrowUp')).toBe(-1);
  });
  it('Home and End go to the ends', () => {
    expect(moveInGrid(boxes, 4, 'Home')).toBe(0);
    expect(moveInGrid(boxes, 0, 'End')).toBe(6);
  });
});
