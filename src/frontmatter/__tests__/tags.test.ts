import { describe, expect, test } from 'bun:test';

import { deriveTags } from '../tags.ts';

describe('deriveTags', () => {
  test('scalar string -> single tag', () => {
    expect(deriveTags({ tags: 'foo' })).toEqual(['foo']);
  });

  test('comma-separated string -> list', () => {
    expect(deriveTags({ tags: 'a, b, c' })).toEqual(['a', 'b', 'c']);
  });

  test('space-separated string -> list', () => {
    expect(deriveTags({ tags: 'a b c' })).toEqual(['a', 'b', 'c']);
  });

  test('yaml list -> list', () => {
    expect(deriveTags({ tags: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  test('strips leading # and dedups, case-preserving', () => {
    expect(deriveTags({ tags: ['#Foo', '#foo', 'Bar', 'Bar'] })).toEqual([
      'Foo',
      'foo',
      'Bar',
    ]);
  });

  test('falls back to singular "tag" key', () => {
    expect(deriveTags({ tag: 'solo' })).toEqual(['solo']);
  });

  test('absent / empty -> []', () => {
    expect(deriveTags({})).toEqual([]);
    expect(deriveTags({ tags: '' })).toEqual([]);
  });
});
