import { MdVaultError } from '@/errors.ts';

// Nested containers allowed in one frontmatter value. Frontmatter is note
// metadata, so real blocks are a handful of levels deep at most; the cap exists
// because yaml's emitter and JSON.stringify both recurse, and without it a
// pathological map reaches them and dies with a raw RangeError instead of a
// coded FRONTMATTER_INVALID.
const MAX_DEPTH = 100;

// One value, walked to the leaves. A repeated container reference is fine —
// yaml duplicates it on write rather than emitting an anchor — so `cleared`
// exists only to keep a wide graph from being re-walked exponentially, and a
// cycle terminates on MAX_DEPTH rather than on a visited-set.
function isRoundTrippable(
  value: unknown,
  cleared: Set<object>,
  depth = 0,
): boolean {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  // undefined, symbol, function, bigint — none survive YAML -> JSON.
  if (typeof value !== 'object') {
    return false;
  }
  // Checked before `cleared` so a cycle always terminates here.
  if (depth >= MAX_DEPTH) {
    return false;
  }
  if (cleared.has(value)) {
    return true;
  }
  // The prototype test is what keeps Date, Map, Set and class instances out
  // now that "is an object" no longer disqualifies a value by itself. Parsed
  // YAML maps carry Object.prototype.
  const proto = Object.getPrototypeOf(value);
  const ok = Array.isArray(value)
    ? value.every((item) => isRoundTrippable(item, cleared, depth + 1))
    : (proto === Object.prototype || proto === null) &&
      Object.values(value).every((item) =>
        isRoundTrippable(item, cleared, depth + 1),
      );
  if (ok) {
    cleared.add(value);
  }

  return ok;
}

// Offending top-level keys, in insertion order; empty means the map is valid.
// A first-order diagnostic, not an exhaustive list — the walk short-circuits at
// the first fault. The verdict is unaffected, so isValidFrontmatter is exact.
export function invalidKeys(fm: Record<string, unknown>): string[] {
  // Shared across the whole map, so a value reachable from several keys is
  // walked once.
  const cleared = new Set<object>();

  return Object.keys(fm).filter((key) => !isRoundTrippable(fm[key], cleared));
}

/**
 * Return `true` when every value in `fm` survives a serialize/parse round-trip.
 *
 * Scalars (`string`, a finite `number`, `boolean`, `null`), plain maps and
 * arrays all qualify, nested up to 100 levels — note metadata never goes that
 * deep, and the bound keeps a pathological value from reaching the YAML
 * emitter, which would fail with an uncoded `RangeError` instead. A cyclic
 * value is rejected by the same bound.
 *
 * Disqualified: `Date`s, `Map`/`Set` and other class instances, non-finite
 * numbers (`NaN`, `Infinity`), and `undefined` — none of which round-trip
 * through the YAML core schema.
 *
 * Binding one array or object to two keys is fine: it is written out twice
 * rather than as a YAML anchor, which is also how the index stores it. A note
 * whose *file* contains an anchored container is a separate matter — that one
 * cannot be edited in place, and {@link editFrontmatter} reports it.
 *
 * @param fm Frontmatter map to validate.
 * @returns `true` if every value round-trips; `false` otherwise.
 */
export function isValidFrontmatter(fm: Record<string, unknown>): boolean {
  return invalidKeys(fm).length === 0;
}

/**
 * Throw {@link MdVaultError} with code `FRONTMATTER_INVALID` when `fm` contains
 * a value that cannot round-trip, naming the offending keys. A no-op otherwise.
 *
 * @param fm Frontmatter map to validate.
 * @throws {@link MdVaultError} with code `FRONTMATTER_INVALID` when any value
 *   fails {@link isValidFrontmatter}.
 */
export function assertValidFrontmatter(fm: Record<string, unknown>): void {
  const offenders = invalidKeys(fm);
  if (offenders.length > 0) {
    throw new MdVaultError(
      'FRONTMATTER_INVALID',
      `frontmatter is not valid: ${offenders.join(', ')}`,
    );
  }
}
