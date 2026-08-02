import { MdVaultError } from '@/errors.ts';

// Nested containers allowed in one frontmatter value. Frontmatter is note
// metadata, so real blocks are a handful of levels deep at most; the cap exists
// because yaml's emitter and JSON.stringify both recurse, and without it a
// pathological block read off disk reaches them and dies with a raw RangeError
// instead of a verdict.
const MAX_DEPTH = 100;

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function isScalarOrArrayOfScalar(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.every(isScalar);
  }

  return isScalar(value);
}

// One value, walked to the leaves, for the READ gate.
//
// `ancestors` holds the containers on the path currently being walked, and is
// popped on the way back up. That distinction is the whole point: a container
// reached twice by DIFFERENT paths is a DAG — `meta: { x: &v {k: 1}, y: *v }`
// is what yaml gives for one — and `JSON.stringify` writes it out twice
// without complaint, so the note is readable. Only a container that is its own
// ancestor is a cycle, which the stringifier refuses.
//
// Not memoised, so a wide DAG costs one visit per path rather than per node.
// Affordable because the only caller is `parseFrontmatter`: yaml's
// `maxAliasCount` refuses to build a document with that much fan-out (a
// 5-level diamond is already rejected as a resource-exhaustion attack), so a
// file cannot deliver one. Depth is bounded separately — both the stringifier
// and yaml's emitter recurse.
function isStorable(
  value: unknown,
  ancestors: Set<object>,
  depth = 0,
): boolean {
  if (isScalar(value)) {
    return true;
  }
  // undefined, symbol, function, bigint, and non-finite numbers — none survive
  // YAML -> JSON.
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (ancestors.has(value) || depth >= MAX_DEPTH) {
    return false;
  }
  ancestors.add(value);
  // The prototype test keeps Date, Map, Set and class instances out now that
  // "is an object" no longer disqualifies a value by itself. Parsed YAML maps
  // carry Object.prototype.
  const proto = Object.getPrototypeOf(value);
  const ok = Array.isArray(value)
    ? value.every((item) => isStorable(item, ancestors, depth + 1))
    : (proto === Object.prototype || proto === null) &&
      Object.values(value).every((item) =>
        isStorable(item, ancestors, depth + 1),
      );
  ancestors.delete(value);

  return ok;
}

/**
 * Return the keys of `fm` whose values are not flat-scalar-safe (i.e. not a
 * scalar or array of scalars). An empty result means the map is flat.
 *
 * @param fm Frontmatter map to inspect.
 * @returns The offending keys, in insertion order.
 */
export function nonFlatKeys(fm: Record<string, unknown>): string[] {
  return Object.keys(fm).filter((key) => !isScalarOrArrayOfScalar(fm[key]));
}

/**
 * Return `true` when every value in `fm` is a scalar (`string`, a finite
 * `number`, `boolean`, or `null`) or an array of such scalars.
 *
 * This is the **write** gate. Everything this package emits is flat, because
 * that is what {@link editFrontmatter} can rewrite one key at a time without
 * re-emitting the rest of the block. A note whose frontmatter nests is still
 * read and indexed — see {@link FrontmatterValidity}'s `'nested'`.
 *
 * @param fm Frontmatter map to validate.
 * @returns `true` if all values are flat-scalar-safe; `false` otherwise.
 */
export function isFlatFrontmatter(fm: Record<string, unknown>): boolean {
  return nonFlatKeys(fm).length === 0;
}

/**
 * Return `true` when `fm` can be stored in the index — the **read** gate,
 * deliberately wider than {@link isFlatFrontmatter}.
 *
 * Nested maps and arrays qualify, to any depth up to 100 levels. Disqualified:
 * a cyclic value, nesting past the bound, `Date`s, `Map`/`Set` and other class
 * instances, non-finite numbers, and `undefined` — each of which either cannot
 * round-trip through the YAML core schema, or cannot reach `JSON.stringify`
 * without throwing.
 *
 * @param fm Frontmatter map to inspect.
 * @returns `true` if the whole map survives projection into the index.
 */
export function isStorableFrontmatter(fm: Record<string, unknown>): boolean {
  return Object.values(fm).every((value) => isStorable(value, new Set()));
}

/**
 * Throw {@link MdVaultError} with code `FRONTMATTER_INVALID` when `fm` is not
 * flat, naming only the offending keys. A no-op when `fm` is flat.
 *
 * @param fm Frontmatter map to validate.
 * @throws {@link MdVaultError} with code `FRONTMATTER_INVALID` when any value is
 *   not a scalar or array of scalars.
 */
export function assertFlatFrontmatter(fm: Record<string, unknown>): void {
  const offenders = nonFlatKeys(fm);
  if (offenders.length > 0) {
    throw new MdVaultError(
      'FRONTMATTER_INVALID',
      `frontmatter is not flat: ${offenders.join(', ')}`,
    );
  }
}
