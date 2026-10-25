import { describe, expect, it } from 'vitest';
import { matchScore, rankCommands } from '../paletteRank';

const cmd = (group: string, title: string, keywords?: string) => ({ group, title, keywords });

describe('palette matching', () => {
  it('matches the title, not the section it is listed under', () => {
    expect(matchScore('op', 'thesis-ch3-methods')).toBeNull();
    expect(matchScore('op', 'Doomed Project')).toBeNull();
    expect(matchScore('op', 'Open settings')).not.toBeNull();
  });

  it('ranks a match at the start of a word above one inside a word, above a scattered one', () => {
    const atWord = matchScore('set', 'Project settings')!;
    const inside = matchScore('set', 'Typeset document')!;
    const scattered = matchScore('pst', 'Project settings')!;
    expect(atWord).toBeLessThan(inside);
    expect(inside).toBeLessThan(scattered);
  });

  it('takes the words of a query in any order', () => {
    expect(matchScore('claude connect', 'Connect Claude (MCP connector)…')).not.toBeNull();
  });

  it('ignores case and accents', () => {
    expect(matchScore('uber', 'Über die Konvergenz')).toBe(0);
  });

  it('falls back to keywords, ranked below a title match', () => {
    const viaKeyword = matchScore('theme', 'Dark', 'theme appearance');
    expect(viaKeyword).not.toBeNull();
    expect(viaKeyword!).toBeGreaterThan(matchScore('dark', 'Dark')!);
  });
});

describe('palette sections', () => {
  const commands = [
    cmd('New', 'New project…'),
    cmd('New', 'Import a ZIP…'),
    cmd('Projects', 'Neurips submission'),
    cmd('Projects', 'Palette Destination'),
    cmd('More', 'About Aldine and its source code'),
  ];

  it('lists sections in the given order before anything is typed', () => {
    const s = rankCommands(commands, '', ['Projects', 'New', 'More']);
    expect(s.map((x) => x.group)).toEqual(['Projects', 'New', 'More']);
    expect(s[0].items.map((c) => c.title)).toEqual(['Neurips submission', 'Palette Destination']);
  });

  it('puts the section with the best match first once something is typed', () => {
    expect(rankCommands(commands, 'new', ['Projects', 'New', 'More'])[0].group).toBe('New');
    expect(rankCommands(commands, 'palette dest', ['New', 'Projects'])[0].items[0].title).toBe('Palette Destination');
  });

  it('keeps each section once and drops empty ones', () => {
    const s = rankCommands(commands, 'zip');
    expect(s).toHaveLength(1);
    expect(s[0]).toEqual({ group: 'New', items: [commands[1]] });
  });

  it('caps the number of rows across sections', () => {
    const many = Array.from({ length: 100 }, (_, i) => cmd(i % 2 ? 'A' : 'B', `Item ${i}`));
    const s = rankCommands(many, '', [], 30);
    expect(s.reduce((n, x) => n + x.items.length, 0)).toBe(30);
  });

  it('keeps every section in view when one section is long', () => {
    const projects = Array.from({ length: 70 }, (_, i) => cmd('Projects', `Paper ${i}`));
    const s = rankCommands([...projects, ...commands.filter((c) => c.group !== 'Projects')], '', ['Projects', 'New', 'More']);
    expect(s.map((x) => x.group)).toEqual(['Projects', 'New', 'More']);
    expect(s.reduce((n, x) => n + x.items.length, 0)).toBe(60);
    expect(s[1].items.map((c) => c.title)).toEqual(['New project…', 'Import a ZIP…']);
  });

  it('shows a few rows of a section before anything is typed, all of them once something is', () => {
    const projects = Array.from({ length: 70 }, (_, i) => cmd('Projects', `Paper ${i}`));
    const all = [...projects, ...commands];
    expect(rankCommands(all, '', ['Projects', 'New', 'More'], 60, 8)[0].items).toHaveLength(8);
    expect(rankCommands(all, 'paper', ['Projects', 'New', 'More'], 60, 8)[0].items).toHaveLength(60);
  });
});
