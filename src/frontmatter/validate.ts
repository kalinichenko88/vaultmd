import { MdVaultError } from '@/errors.ts';

// Nested containers allowed in one frontmatter value. Frontmatter is note
// metadata, so real blocks are a handful of levels deep at most; the cap exists
// because yaml's emitter and JSON.stringify both recurse, and without it a
// pathological map reaches them and dies with a raw RangeError instead of a
// coded FRONTMATTER_INVALID.
const MAX_DEPTH = 100;

// One value, walked to the leaves. `seen` carries every container already
// entered on this map — a repeat is either a cycle or a YAML anchor reused
// across keys, and both are refused (see the design spec: `editFrontmatter`
// cannot round-trip an anchored container, and the JSON projection duplicates
// the sharing anyway).
function isRoundTrippable(
  value: unknown,
  seen: Set<object>,
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
  if (seen.has(value) || depth >= MAX_DEPTH) {
    return false;
  }
  seen.add(value);
  // The prototype test is what keeps Date, Map, Set and class instances out
  // now that "is an object" no longer disqualifies a value by itself. Parsed
  // YAML maps carry Object.prototype.
  const proto = Object.getPrototypeOf(value);

  return Array.isArray(value)
    ? value.every((item) => isRoundTrippable(item, seen, depth + 1))
    : (proto === Object.prototype || proto === null) &&
        Object.values(value).every((item) =>
          isRoundTrippable(item, seen, depth + 1),
        );
}

// Offending top-level keys, in insertion order; empty means the map is valid.
// A first-order diagnostic, not an exhaustive list — the walk short-circuits at
// the first fault. The verdict is unaffected, so isValidFrontmatter is exact.
export function invalidKeys(fm: Record<string, unknown>): string[] {
  // ONE set per map — a per-key set cannot see `{ x: o, y: o }`.
  const seen = new Set<object>();

  return Object.keys(fm).filter((key) => !isRoundTrippable(fm[key], seen));
}

/**
 * Return `true` when every value in `fm` survives a serialize/parse round-trip
 * and stays editable afterwards.
 *
 * Scalars (`string`, a finite `number`, `boolean`, `null`), plain maps and
 * arrays all qualify, nested up to 100 levels — note metadata never goes that
 * deep, and the bound keeps a pathological value from reaching the YAML
 * emitter, which would fail with an uncoded `RangeError` instead.
 * Disqualified: `Date`s, `Map`/`Set` and other class instances, non-finite
 * numbers (`NaN`, `Infinity`), `undefined` — none of which round-trip through
 * the YAML core schema — and any container reference repeated within the map,
 * whether that is a cycle or a YAML anchor reused across keys
 * (`editFrontmatter` cannot rewrite one without either throwing or silently
 * unrolling the alias).
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
