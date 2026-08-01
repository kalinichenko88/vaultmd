import { describe, expect, test } from 'bun:test';

import { MdVaultError } from '@/errors.ts';

import {
  assertValidFrontmatter,
  invalidKeys,
  isValidFrontmatter,
} from '../validate.ts';

describe('isValidFrontmatter', () => {
  test('scalars + array-of-scalar + null -> true', () => {
    expect(
      isValidFrontmatter({ a: 1, b: 'x', c: true, d: ['p', 'q'], e: null }),
    ).toBe(true);
  });

  test('empty object -> true', () => {
    expect(isValidFrontmatter({})).toBe(true);
  });

  test('nested map -> true', () => {
    expect(isValidFrontmatter({ a: 1, meta: { x: 1 } })).toBe(true);
  });

  test('array of maps -> true', () => {
    expect(isValidFrontmatter({ items: [{ b: 1 }, { c: 2 }] })).toBe(true);
  });

  test('deep mixed nesting -> true', () => {
    expect(isValidFrontmatter({ a: { b: [1, { c: [true, null] }] } })).toBe(
      true,
    );
  });

  test('empty nested containers -> true', () => {
    expect(isValidFrontmatter({ a: {}, b: [] })).toBe(true);
  });

  test('a scalar repeated across keys -> true (a scalar is not a reference)', () => {
    expect(isValidFrontmatter({ a: 'x', b: 'x' })).toBe(true);
  });

  test('two equal-but-distinct maps -> true (identity, not value)', () => {
    expect(isValidFrontmatter({ a: { n: 1 }, b: { n: 1 } })).toBe(true);
  });

  test('a map shared across two keys -> false', () => {
    const shared = { k: 1 };

    expect(isValidFrontmatter({ x: shared, y: shared })).toBe(false);
  });

  test('an array shared across two keys -> false', () => {
    const shared = [1, 2];

    expect(isValidFrontmatter({ x: shared, y: shared })).toBe(false);
  });

  test('a shared reference nested deeper -> false', () => {
    const shared = { k: 1 };

    expect(isValidFrontmatter({ x: { deep: shared }, y: [shared] })).toBe(
      false,
    );
  });

  test('a cycle -> false', () => {
    const cyclic: Record<string, unknown> = { k: 1 };
    cyclic.self = cyclic;

    expect(isValidFrontmatter({ a: cyclic })).toBe(false);
  });

  test('a self-referencing array -> false', () => {
    const cyclic: unknown[] = [1];
    cyclic.push(cyclic);

    expect(isValidFrontmatter({ a: cyclic })).toBe(false);
  });

  test('Date -> false', () => {
    expect(isValidFrontmatter({ a: new Date() })).toBe(false);
  });

  test('Map / Set -> false', () => {
    expect(isValidFrontmatter({ a: new Map() })).toBe(false);
    expect(isValidFrontmatter({ a: new Set() })).toBe(false);
  });

  test('NaN and Infinity -> false', () => {
    expect(isValidFrontmatter({ a: Number.NaN })).toBe(false);
    expect(isValidFrontmatter({ a: Number.POSITIVE_INFINITY })).toBe(false);
  });

  test('undefined -> false', () => {
    expect(isValidFrontmatter({ a: undefined })).toBe(false);
  });

  test('a nested Date -> false', () => {
    expect(isValidFrontmatter({ a: { b: [new Date()] } })).toBe(false);
  });

  test('a null-prototype map -> true', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.k = 1;

    expect(isValidFrontmatter({ a: bare })).toBe(true);
  });
});

describe('invalidKeys', () => {
  test('names only the offending top-level keys', () => {
    expect(invalidKeys({ ok: 1, bad: new Date(), also: 'x' })).toEqual(['bad']);
  });

  test('a fault nested deep names its top-level key', () => {
    expect(invalidKeys({ a: { b: { c: new Date() } } })).toEqual(['a']);
  });

  test('a shared reference names the key where the repeat was found', () => {
    const shared = { k: 1 };

    expect(invalidKeys({ x: shared, y: shared })).toEqual(['y']);
  });

  // The `seen` set MUST be hoisted out of the filter callback. With a fresh
  // set per key, a reference shared BETWEEN two top-level keys is invisible
  // and this returns [] — the whole shared-reference rule silently does
  // nothing. This test is that regression guard.
  test('a shared reference is detected across top-level keys at all', () => {
    const shared = [1, 2];

    expect(invalidKeys({ x: shared, y: shared }).length).toBeGreaterThan(0);
  });

  // Documented first-order-diagnostic contract: `every()` short-circuits, so a
  // fault found early stops the walk before a later shared reference is
  // recorded. The VERDICT is still correct — only the key list is partial.
  test('short-circuit can leave the list partial (documented contract)', () => {
    const shared = { k: 1 };

    expect(invalidKeys({ x: [new Date(), shared], y: shared })).toEqual(['x']);
    const s2 = { k: 1 };
    expect(invalidKeys({ x: [s2, new Date()], y: s2 })).toEqual(['x', 'y']);
  });

  test('empty result for a valid map', () => {
    expect(invalidKeys({ a: 1, b: { c: [2, 3] } })).toEqual([]);
  });
});

describe('assertValidFrontmatter', () => {
  test('no-op for a valid map', () => {
    expect(() => assertValidFrontmatter({ a: { b: 1 } })).not.toThrow();
  });

  test('throws FRONTMATTER_INVALID naming the offenders', () => {
    let caught: unknown;
    try {
      assertValidFrontmatter({ ok: 1, bad: new Date() });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MdVaultError);
    expect((caught as MdVaultError).code).toBe('FRONTMATTER_INVALID');
    expect((caught as MdVaultError).message).toContain('bad');
  });
});
