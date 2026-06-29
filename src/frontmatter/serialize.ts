import { Document } from 'yaml';

import { assertFlatFrontmatter } from './validate.ts';

/**
 * Build the fenced YAML block for an already-validated flat frontmatter map.
 * The single source of truth for fresh-block emission, shared with
 * `editFrontmatter`'s no-frontmatter path so the two stay byte-identical.
 *
 * Returns the empty string for an empty map (no block to emit). Strings are
 * emitted with `blockQuote: false`, so multi-line values use double-quoted flow
 * scalars rather than `|`/`|+` block scalars — block scalars whose value ends in
 * a newline are ambiguous against the closing `---` fence and lose data on
 * re-parse.
 *
 * @param frontmatter Flat key-value map; the caller must validate flatness.
 * @returns `''` for an empty map, otherwise `---\n<yaml>\n---\n`.
 */
export function buildFrontmatterBlock(
  frontmatter: Record<string, unknown>,
): string {
  if (Object.keys(frontmatter).length === 0) {
    return '';
  }
  const block = new Document(frontmatter)
    .toString({ blockQuote: false })
    .replace(/\n$/, '');

  return `---\n${block}\n---\n`;
}

/**
 * Serialize a flat frontmatter map to a fenced YAML block ready to prepend to a
 * markdown note. The output is byte-identical to the fresh frontmatter block
 * `createNote` / {@link editFrontmatter} emit when a note has no existing block
 * (they preserve an existing block's styling, which this does not reproduce).
 * `parseFrontmatter` is its inverse: every accepted input round-trips.
 *
 * An empty map yields the empty string (no block), matching what `createNote` /
 * {@link editFrontmatter} write for empty frontmatter. Non-empty arrays
 * serialize as block sequences; an empty array serializes as flow `[]`.
 *
 * @param frontmatter Flat key-value map (scalars and arrays of scalars only).
 * @returns A string of the form `---\n<yaml>\n---\n`, or `''` for an empty map.
 * @throws {@link MdVaultError} with code `FRONTMATTER_INVALID` when the input
 *   contains nested objects, arrays of non-scalars, `Date`s, or non-finite
 *   numbers — none of which survive a parse round-trip.
 *
 * @example
 * ```ts
 * const header = serializeFrontmatter({ title: 'Hello', tags: ['a', 'b'] });
 * // "---\ntitle: Hello\ntags:\n  - a\n  - b\n---\n"
 * ```
 */
export function serializeFrontmatter(
  frontmatter: Record<string, unknown>,
): string {
  assertFlatFrontmatter(frontmatter);

  return buildFrontmatterBlock(frontmatter);
}
