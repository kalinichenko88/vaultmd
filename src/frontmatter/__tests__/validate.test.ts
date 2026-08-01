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

  // Binding one container to two keys is ordinary JS — `fm.aliases = fm.tags`
  // is the obvious way to write that edit — and it round-trips fine, because
  // the value is written out twice rather than as a YAML anchor.
  test('a map shared across two keys -> true', () => {
    const shared = { k: 1 };

    expect(isValidFrontmatter({ x: shared, y: shared })).toBe(true);
  });

  test('an array shared across two keys -> true', () => {
    const shared = [1, 2];

    expect(isValidFrontmatter({ x: shared, y: shared })).toBe(true);
  });

  test('a shared reference nested deeper -> true', () => {
    const shared = { k: 1 };

    expect(isValidFrontmatter({ x: { deep: shared }, y: [shared] })).toBe(true);
  });

  // A wide DAG is walked once per distinct node, not once per path. Without
  // that, 60 diamond levels is 2^60 visits and this test never returns.
  test('a wide DAG validates without blowing up', () => {
    let level: unknown = { leaf: 1 };
    for (let i = 0; i < 60; i++) {
      level = { a: level, b: level };
    }

    expect(isValidFrontmatter({ root: level })).toBe(true);
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

  // Nesting is bounded so a pathological value cannot reach yaml's emitter or
  // JSON.stringify, both of which recurse and would die with a raw RangeError.
  test('nesting at the 100-level bound -> true', () => {
    expect(isValidFrontmatter({ a: nest(100) })).toBe(true);
  });

  test('nesting past the bound -> false', () => {
    expect(isValidFrontmatter({ a: nest(101) })).toBe(false);
    expect(invalidKeys({ ok: 1, a: nest(101) })).toEqual(['a']);
  });

  test('depth is per top-level value, not cumulative', () => {
    expect(isValidFrontmatter({ a: nest(60), b: nest(60) })).toBe(true);
  });

  test('arrays count toward the bound too', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 101; i++) {
      deep = [deep];
    }

    expect(isValidFrontmatter({ a: deep })).toBe(false);
  });
});

// A chain of `levels` nested maps ending in a scalar.
function nest(levels: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: 1 };
  for (let i = 1; i < levels; i++) {
    value = { n: value };
  }

  return value;
}

describe('invalidKeys', () => {
  test('names only the offending top-level keys', () => {
    expect(invalidKeys({ ok: 1, bad: new Date(), also: 'x' })).toEqual(['bad']);
  });

  test('a fault nested deep names its top-level key', () => {
    expect(invalidKeys({ a: { b: { c: new Date() } } })).toEqual(['a']);
  });

  test('a shared reference is not a fault and names nothing', () => {
    const shared = { k: 1 };

    expect(invalidKeys({ x: shared, y: shared })).toEqual([]);
  });

  // A key sharing a reference with a rejected one is judged on its own merits,
  // in either order — the verdict does not depend on which key is walked first.
  test('a fault does not spread to keys sharing a clean reference', () => {
    const shared = { k: 1 };
    expect(invalidKeys({ x: [new Date(), shared], y: shared })).toEqual(['x']);
    const s2 = { k: 1 };
    expect(invalidKeys({ x: [s2, new Date()], y: s2 })).toEqual(['x']);
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
