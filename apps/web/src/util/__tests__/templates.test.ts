import { describe, expect, it } from 'vitest';
import { pickTemplate, templateToPost } from '../templates';

const blank = { id: 'blank', name: 'Blank' };
const article = { id: 'article', name: 'Article' };
const beamer = { id: 'beamer', name: 'Beamer' };

describe('pickTemplate', () => {
  it('keeps the current pick when the server offers it', () => {
    expect(pickTemplate([blank, article, beamer], 'beamer')).toBe('beamer');
    expect(pickTemplate([blank, article], 'blank')).toBe('blank');
  });
  it('falls back to the first non-blank template', () => {
    expect(pickTemplate([blank, beamer], 'article')).toBe('beamer');
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
});
