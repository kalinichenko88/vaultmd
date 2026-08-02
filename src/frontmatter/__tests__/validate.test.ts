import { describe, expect, test } from 'bun:test';

import { MdVaultError } from '@/errors.ts';

import {
  assertFlatFrontmatter,
  isFlatFrontmatter,
  isStorableFrontmatter,
  nonFlatKeys,
} from '../validate.ts';

// The WRITE gate. Everything this package emits is flat, because that is what
// `editFrontmatter` can rewrite a key at a time without disturbing the rest of
// the block, and what Obsidian's own Properties editor can represent.
describe('isFlatFrontmatter', () => {
  test('scalars + array-of-scalar + null -> true', () => {
    expect(
      isFlatFrontmatter({ a: 1, b: 'x', c: true, d: ['p', 'q'], e: null }),
    ).toBe(true);
  });

  test('empty object -> true', () => {
    expect(isFlatFrontmatter({})).toBe(true);
  });

  test('empty array -> true', () => {
    expect(isFlatFrontmatter({ a: [] })).toBe(true);
  });

  test('nested map -> false', () => {
    expect(isFlatFrontmatter({ a: 1, meta: { x: 1 } })).toBe(false);
  });

  test('array of maps -> false', () => {
    expect(isFlatFrontmatter({ items: [{ b: 1 }] })).toBe(false);
  });

  test('nested array -> false', () => {
    expect(isFlatFrontmatter({ a: [[1]] })).toBe(false);
  });

  test('Date, Map, NaN, Infinity, undefined -> false', () => {
    expect(isFlatFrontmatter({ a: new Date() })).toBe(false);
    expect(isFlatFrontmatter({ a: new Map() })).toBe(false);
    expect(isFlatFrontmatter({ a: Number.NaN })).toBe(false);
    expect(isFlatFrontmatter({ a: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isFlatFrontmatter({ a: undefined })).toBe(false);
  });
});

// The READ gate. Wider than the write gate: a note whose frontmatter nests is
// still worth indexing and handing to a caller. It only has to survive
// `JSON.stringify` into the index row.
describe('isStorableFrontmatter', () => {
  test('everything flat is storable', () => {
    expect(isStorableFrontmatter({ a: 1, d: ['p', 'q'], e: null })).toBe(true);
  });

  test('nested maps and arrays of maps are storable', () => {
    expect(isStorableFrontmatter({ meta: { x: 1 } })).toBe(true);
    expect(isStorableFrontmatter({ items: [{ b: 1 }, { c: 2 }] })).toBe(true);
    expect(isStorableFrontmatter({ a: { b: [1, { c: [true, null] }] } })).toBe(
      true,
    );
  });

  test('a null-prototype map is storable', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.k = 1;

    expect(isStorableFrontmatter({ a: bare })).toBe(true);
  });

  // A cycle reaches projectRow's JSON.stringify, which throws a raw TypeError
  // out of indexNote and aborts the whole reconcile sweep. This is the check
  // that keeps it away from there.
  test('a cycle is not storable', () => {
    const cyclic: Record<string, unknown> = { k: 1 };
    cyclic.self = cyclic;

    expect(isStorableFrontmatter({ a: cyclic })).toBe(false);
  });

  test('a self-referencing array is not storable', () => {
    const cyclic: unknown[] = [1];
    cyclic.push(cyclic);

    expect(isStorableFrontmatter({ a: cyclic })).toBe(false);
  });

  // An anchored container referenced twice is a DAG, not a cycle, and
  // JSON.stringify writes it out twice without complaint — so the note is
  // readable. Only an ACTIVE ancestor repeating is a cycle. `meta: { x: &v {k:
  // 1}, y: *v }` is the shape yaml produces for that.
  test('a container repeated under one key is storable', () => {
    const shared = { k: 1 };

    expect(isStorableFrontmatter({ meta: { x: shared, y: shared } })).toBe(
      true,
    );
  });

  test('a container repeated across two keys is storable', () => {
    const shared = { k: 1 };

    expect(isStorableFrontmatter({ x: shared, y: shared })).toBe(true);
  });

  // The walk is not memoised, so a wide DAG costs one visit per path. That is
  // affordable because the only caller is parseFrontmatter and yaml refuses to
  // build one: `maxAliasCount` rejects a 5-level diamond outright ("Excessive
  // alias count indicates a resource exhaustion attack"), so a file cannot
  // deliver more fan-out than this.
  test('a small diamond DAG — the widest yaml will parse — is storable', () => {
    let level: unknown = { leaf: 1 };
    for (let i = 0; i < 4; i++) {
      level = { x: level, y: level };
    }

    expect(isStorableFrontmatter({ root: level })).toBe(true);
  });

  // Both the stringifier and yaml's emitter recurse, so an unbounded value
  // dies with an uncoded RangeError rather than a verdict.
  test('nesting at the 100-level bound is storable, past it is not', () => {
    expect(isStorableFrontmatter({ a: nest(100) })).toBe(true);
    expect(isStorableFrontmatter({ a: nest(101) })).toBe(false);
  });

  test('depth is per top-level value, not cumulative', () => {
    expect(isStorableFrontmatter({ a: nest(60), b: nest(60) })).toBe(true);
  });

  test('values that cannot round-trip are not storable', () => {
    expect(isStorableFrontmatter({ a: new Date() })).toBe(false);
    expect(isStorableFrontmatter({ a: new Map() })).toBe(false);
    expect(isStorableFrontmatter({ a: Number.NaN })).toBe(false);
    expect(isStorableFrontmatter({ a: undefined })).toBe(false);
    expect(isStorableFrontmatter({ a: { b: [new Date()] } })).toBe(false);
  });
});

describe('nonFlatKeys', () => {
  test('names only the offending top-level keys', () => {
    expect(nonFlatKeys({ ok: 1, bad: { x: 1 }, also: 'x' })).toEqual(['bad']);
  });

  test('empty result for a flat map', () => {
    expect(nonFlatKeys({ a: 1, b: ['x'] })).toEqual([]);
  });
});

describe('assertFlatFrontmatter', () => {
  test('no-op for a flat map', () => {
    expect(() => assertFlatFrontmatter({ a: 1 })).not.toThrow();
  });

  test('throws FRONTMATTER_INVALID naming the offenders', () => {
    let caught: unknown;
    try {
      assertFlatFrontmatter({ ok: 1, bad: { x: 1 } });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MdVaultError);
    expect((caught as MdVaultError).code).toBe('FRONTMATTER_INVALID');
    expect((caught as MdVaultError).message).toContain('bad');
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
