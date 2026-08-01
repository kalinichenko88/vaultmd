import { MdVaultError } from '@/errors.ts';

// One value, walked to the leaves. `seen` carries every container already
// entered on this map — a repeat is either a cycle or a YAML anchor reused
// across keys, and both are refused (see the design spec: `editFrontmatter`
// cannot round-trip an anchored container, and the JSON projection duplicates
// the sharing anyway).
function isRoundTrippable(value: unknown, seen: Set<object>): boolean {
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
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  // The prototype test is what keeps Date, Map, Set and class instances out
  // now that "is an object" no longer disqualifies a value by itself. Parsed
  // YAML maps carry Object.prototype.
  const proto = Object.getPrototypeOf(value);

  return Array.isArray(value)
    ? value.every((item) => isRoundTrippable(item, seen))
    : (proto === Object.prototype || proto === null) &&
        Object.values(value).every((item) => isRoundTrippable(item, seen));
}

/**
 * Return the top-level keys of `fm` whose values cannot survive a
 * serialize/parse round-trip. An empty result means the whole map is valid.
 *
 * A first-order diagnostic, not an exhaustive list: the walk short-circuits at
 * the first fault, so a map with several unrelated problems may report only
 * some of them. The *verdict* is never affected — a short-circuit can only
 * happen once something has already failed — so
 * {@link isValidFrontmatter} is exact regardless.
 *
 * @param fm Frontmatter map to inspect.
 * @returns The offending top-level keys, in insertion order.
 */
export function invalidKeys(fm: Record<string, unknown>): string[] {
  // ONE set for the whole map, NOT one per key. A fresh set per key cannot see
  // a reference shared BETWEEN two top-level keys, so `{ x: o, y: o }` would
  // pass and the shared-reference rule would do nothing.
  const seen = new Set<object>();

  return Object.keys(fm).filter((key) => !isRoundTrippable(fm[key], seen));
}

/**
 * Return `true` when every value in `fm` survives a serialize/parse round-trip
 * and stays editable afterwards.
 *
 * Scalars (`string`, a finite `number`, `boolean`, `null`), plain maps and
 * arrays all qualify, nested to any depth. Disqualified: `Date`s, `Map`/`Set`
 * and other class instances, non-finite numbers (`NaN`, `Infinity`),
 * `undefined` — none of which round-trip through the YAML core schema — and
 * any container reference repeated within the map, whether that is a cycle or
 * a YAML anchor reused across keys (`editFrontmatter` cannot rewrite one
 * without either throwing or silently unrolling the alias).
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
