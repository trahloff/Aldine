import { describe, expect, it } from 'vitest';
import { matchPeople, mentionQuery, mentionsIn } from '../../components/MentionTextarea';

const people = [{ id: 'a', name: 'Ada Lovelace' }, { id: 'b', name: 'Bea Reviewer' }, { id: 'c', name: 'Al' }];

describe('mentionQuery', () => {
  it('is the text after an @ at the start or after a space, up to the caret', () => {
    expect(mentionQuery('@ad', 3)).toEqual({ start: 0, query: 'ad' });
    expect(mentionQuery('hi @Ada Lo', 10)).toEqual({ start: 3, query: 'Ada Lo' });
    expect(mentionQuery('hi @', 4)).toEqual({ start: 3, query: '' });
  });
  it('is nothing inside an address, across a line break, or past three words', () => {
    expect(mentionQuery('mail ada@example', 16)).toBeNull();
    expect(mentionQuery('@Ada\nnext', 9)).toBeNull();
    expect(mentionQuery('@one two three four', 19)).toBeNull();
  });
});

describe('matchPeople', () => {
  it('matches the name or any word of it from its start, ignoring case', () => {
    expect(matchPeople(people, 'lov').map((p) => p.id)).toEqual(['a']);
    expect(matchPeople(people, 'a').map((p) => p.id)).toEqual(['a', 'c']);
    expect(matchPeople(people, '').length).toBe(3);
    expect(matchPeople(people, 'view')).toEqual([]);
  });
});

describe('mentionsIn', () => {
  it('names the people whose @Name the text carries', () => {
    expect(mentionsIn('ping @Bea Reviewer and @Ada Lovelace', people)).toEqual(['a', 'b']);
    expect(mentionsIn('Ada Lovelace without the at', people)).toEqual([]);
    expect(mentionsIn('@Alice is someone else', people)).toEqual([]);
    expect(mentionsIn('thanks @Al.', people)).toEqual(['c']);
  });
});
