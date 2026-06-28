function toTagTokens(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(toTagTokens);
  }
  if (typeof value === 'string') {
    return value
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }

  return [];
}

/**
 * Extract and normalise tag tokens from a parsed frontmatter object.
 * Reads either the `tags` or `tag` key (whichever is present), tokenises
 * string values on whitespace and commas, and strips leading `#` characters.
 * Duplicate tokens are removed (first occurrence wins).
 *
 * @param frontmatter Parsed frontmatter key-value map.
 * @returns Ordered, deduplicated array of normalised tag strings.
 */
export function deriveTags(frontmatter: Record<string, unknown>): string[] {
  const source =
    frontmatter.tags !== undefined ? frontmatter.tags : frontmatter.tag;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of toTagTokens(source)) {
    const stripped = token.replace(/^#+/, '');
    if (stripped && !seen.has(stripped)) {
      seen.add(stripped);
      out.push(stripped);
    }
  }

  return out;
}
