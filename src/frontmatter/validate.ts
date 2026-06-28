function isScalar(value: unknown): boolean {
  return (
    value === null ||
    value instanceof Date ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function isScalarOrArrayOfScalar(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.every(isScalar);
  }

  return isScalar(value);
}

/**
 * Return `true` when every value in `fm` is a scalar (`string`, `number`,
 * `boolean`, `null`, `Date`) or an array of scalars. Nested objects and
 * nested arrays disqualify the frontmatter as non-flat.
 *
 * @param fm Frontmatter map to validate.
 * @returns `true` if all values are flat-scalar-safe; `false` otherwise.
 */
export function isFlatFrontmatter(fm: Record<string, unknown>): boolean {
  for (const value of Object.values(fm)) {
    if (!isScalarOrArrayOfScalar(value)) {
      return false;
    }
  }

  return true;
}
