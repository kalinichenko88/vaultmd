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
 * `number`, `boolean`, or `null`) or an array of such scalars. Nested objects,
 * nested arrays, `Date`s, and non-finite numbers (`NaN`, `Infinity`) all
 * disqualify the frontmatter as non-flat — those values cannot survive a
 * serialize/parse round-trip through the YAML core schema.
 *
 * @param fm Frontmatter map to validate.
 * @returns `true` if all values are flat-scalar-safe; `false` otherwise.
 */
export function isFlatFrontmatter(fm: Record<string, unknown>): boolean {
  return nonFlatKeys(fm).length === 0;
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
