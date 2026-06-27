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

export function isFlatFrontmatter(fm: Record<string, unknown>): boolean {
  for (const value of Object.values(fm)) {
    if (!isScalarOrArrayOfScalar(value)) {
      return false;
    }
  }

  return true;
}
