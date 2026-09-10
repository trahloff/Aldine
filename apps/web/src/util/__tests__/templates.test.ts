import { describe, expect, it } from 'vitest';
import { pickTemplate, templateToPost } from '../templates';

const blank = { id: 'blank', name: 'Blank' };
const article = { id: 'article', name: 'Article' };
const beamer = { id: 'beamer', name: 'Beamer' };
const thesis = { id: 'repo:lab/thesis', name: 'Thesis', source: { kind: 'repo' as const, label: 'Lab' } };

describe('pickTemplate', () => {
  it('keeps the current pick when the server offers it', () => {
    expect(pickTemplate([blank, article, beamer], 'beamer')).toBe('beamer');
    expect(pickTemplate([blank, article], 'blank')).toBe('blank');
  });
  it('falls back to the first non-blank template', () => {
    expect(pickTemplate([blank, beamer], 'article')).toBe('beamer');
  });
  it('treats a repository template id like any other listed id', () => {
    expect(pickTemplate([blank, article, thesis], 'repo:lab/thesis')).toBe('repo:lab/thesis');
    expect(pickTemplate([blank, thesis], 'article')).toBe('repo:lab/thesis');
  });
  it('picks nothing when only blank is offered, so the server default article stays reachable', () => {
    expect(pickTemplate([blank], 'article')).toBe('');
    expect(pickTemplate([], 'article')).toBe('');
  });
});

describe('templateToPost', () => {
  it('posts only an id the server listed', () => {
    expect(templateToPost([blank, article], 'article')).toBe('article');
    expect(templateToPost([blank, article], 'blank')).toBe('blank');
  });
  it('posts nothing for an empty pick or an id the server never offered', () => {
    expect(templateToPost([blank], '')).toBeUndefined();
    expect(templateToPost([], 'article')).toBeUndefined();
    expect(templateToPost([blank], 'article')).toBeUndefined();
  });
  it('posts a repository template id only while the server still lists it', () => {
    expect(templateToPost([blank, thesis], 'repo:lab/thesis')).toBe('repo:lab/thesis');
    // The repository was removed from the config: the stale pick must not reach the server.
    expect(templateToPost([blank, article], 'repo:lab/thesis')).toBeUndefined();
  });
});
