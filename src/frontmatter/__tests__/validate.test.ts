import { describe, expect, test } from 'bun:test';

import { MdVaultError } from '@/errors.ts';

import {
  assertFlatFrontmatter,
  isFlatFrontmatter,
  nonFlatKeys,
} from '../validate.ts';

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

  test('Date value -> false (does not round-trip through YAML)', () => {
    expect(isFlatFrontmatter({ when: new Date() })).toBe(false);
  });

  test('non-finite numbers (NaN / Infinity) -> false', () => {
    expect(isFlatFrontmatter({ a: Number.NaN })).toBe(false);
    expect(isFlatFrontmatter({ a: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isFlatFrontmatter({ a: Number.NEGATIVE_INFINITY })).toBe(false);
  });
});

describe('nonFlatKeys', () => {
  test('returns only the keys whose values are not flat', () => {
    expect(
      nonFlatKeys({ ok: 1, list: ['x'], bad: { x: 1 }, badArr: [{ x: 1 }] }),
    ).toEqual(['bad', 'badArr']);
  });

  test('flat map -> empty array', () => {
    expect(nonFlatKeys({ a: 1, b: 'x' })).toEqual([]);
  });
});

describe('assertFlatFrontmatter', () => {
  test('flat input does not throw', () => {
    expect(() => assertFlatFrontmatter({ a: 1, b: ['x'] })).not.toThrow();
  });

  test('non-flat input throws FRONTMATTER_INVALID naming only offenders', () => {
    let err: MdVaultError | undefined;
    try {
      assertFlatFrontmatter({ ok: 1, bad: { x: 1 } });
    } catch (e) {
      err = e as MdVaultError;
    }
    expect(err).toBeInstanceOf(MdVaultError);
    expect(err?.code).toBe('FRONTMATTER_INVALID');
    expect(err?.message).toContain('bad');
    expect(err?.message).not.toContain('ok');
  });
});
