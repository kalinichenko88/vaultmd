import { describe, expect, test } from 'bun:test';

import { isFlatFrontmatter } from '../validate.ts';

describe('isFlatFrontmatter', () => {
  test('scalars + array-of-scalar + null -> true', () => {
    expect(
      isFlatFrontmatter({ a: 1, b: 'x', c: true, d: ['p', 'q'], e: null }),
    ).toBe(true);
  });

  test('empty object -> true', () => {
    expect(isFlatFrontmatter({})).toBe(true);
  });

  test('nested map -> false', () => {
    expect(isFlatFrontmatter({ a: 1, meta: { x: 1 } })).toBe(false);
  });

  test('array-of-object -> false', () => {
    expect(isFlatFrontmatter({ a: [{ x: 1 }] })).toBe(false);
  });
});
