import { Document } from 'yaml';

import { assertValidFrontmatter } from './validate.ts';

/**
 * Fence one YAML document into a frontmatter block — the single emitter both
 * producers go through, so `serializeFrontmatter` (a fresh map) and
 * `editFrontmatter` (an existing block re-emitted) cannot drift on options or
 * on how the `---` fences are assembled.
 *
 * `blockQuote: false` keeps multi-line values in double-quoted flow scalars
 * rather than `|`/`|+` block scalars — a block scalar whose value ends in a
 * newline is ambiguous against the closing `---` fence and loses that newline
 * on re-parse. It costs an author-written `|` block its styling the first time
 * the note is edited, which is the price of the value surviving the round-trip.
 *
 * `lineWidth: 0` disables folding: yaml's default wraps any scalar past 80
 * columns onto continuation lines, which still round-trips but leaves a long
 * `source:` string or URL spread over several lines, unreadable to anything
 * reading the file as line-oriented text.
 *
 * @param doc The YAML document to emit.
 * @returns The block as `---\n<yaml>\n---\n`.
 */
export function emitFrontmatterBlock(doc: Document): string {
  const block = doc
    .toString({ blockQuote: false, lineWidth: 0 })
    .replace(/\n$/, '');

  return `---\n${block}\n---\n`;
}

/**
 * Build the fenced YAML block for an already-validated frontmatter map.
 * The single source of truth for fresh-block emission, shared with
 * `editFrontmatter`'s no-frontmatter path so the two stay byte-identical.
 *
 * Returns the empty string for an empty map (no block to emit); everything else
 * is {@link emitFrontmatterBlock}'s contract.
 *
 * @param frontmatter Key-value map; the caller must validate it first.
 * @returns `''` for an empty map, otherwise `---\n<yaml>\n---\n`.
 */
export function buildFrontmatterBlock(
  frontmatter: Record<string, unknown>,
): string {
  if (Object.keys(frontmatter).length === 0) {
    return '';
  }

  return emitFrontmatterBlock(new Document(frontmatter));
}

/**
 * Serialize a frontmatter map to a fenced YAML block ready to prepend to a
 * markdown note. The output is byte-identical to the fresh frontmatter block
 * `createNote` / {@link editFrontmatter} emit when a note has no existing block
 * (they preserve an existing block's styling, which this does not reproduce).
 * `parseFrontmatter` is its inverse: every accepted input round-trips.
 *
 * An empty map yields the empty string (no block), matching what `createNote` /
 * {@link editFrontmatter} write for empty frontmatter. Non-empty arrays
 * serialize as block sequences; an empty array serializes as flow `[]`.
 *
 * Folding is off, so a value stays on its key's line however long it is. A
 * value that *contains* a newline is the exception — it has to span lines to
 * carry them — and is emitted as a double-quoted scalar broken at its own line
 * breaks, not at a column limit.
 *
 * @param frontmatter Key-value map. Scalars, plain maps and arrays, nested to
 *   any depth.
 * @returns A string of the form `---\n<yaml>\n---\n`, or `''` for an empty map.
 * @throws {@link MdVaultError} with code `FRONTMATTER_INVALID` when the input
 *   contains a `Date`, a class instance, a non-finite number, `undefined`, or
 *   a container reference repeated within the map — none of which survive a
 *   parse round-trip as written.
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
  assertValidFrontmatter(frontmatter);

  return buildFrontmatterBlock(frontmatter);
}
