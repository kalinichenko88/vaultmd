import { MdVaultError } from '@/errors.ts';

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
 * deliberately wider than {@link isFlatFrontmatter}. Nested maps and arrays
 * qualify; a cycle (which yaml anchors can build) and a non-finite number do
 * not.
 *
 * @param fm Frontmatter map to inspect.
 * @returns `true` if the whole map survives projection into the index.
 */
export function isStorableFrontmatter(fm: Record<string, unknown>): boolean {
  try {
    // The gate IS `projectRow`'s stringify, so it cannot drift from it: a cycle
    // throws a TypeError there, aborting the reconcile sweep. The replacer adds
    // the one bad value it would otherwise coerce silently to `null`.
    JSON.stringify(fm, (_key, value) => {
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new RangeError('non-finite');
      }

      return value;
    });

    return true;
  } catch {
    return false;
  }
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
