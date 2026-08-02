import { Document } from 'yaml';

import { assertFlatFrontmatter } from './validate.ts';

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

  // aliasDuplicateObjects: false — one array bound to two keys is ordinary JS
  // and stays flat, but the default emits it as an `&a1`/`*a1` anchor pair,
  // and the next edit to that note orphans the alias. Writing the value twice
  // costs a few bytes and keeps the note editable.
  return emitFrontmatterBlock(
    new Document(frontmatter, { aliasDuplicateObjects: false }),
  );
}

/**
 * Serialize a frontmatter map to a fenced YAML block ready to prepend to a
 * markdown note. The output is byte-identical to the fresh frontmatter block
 * `createNote` / {@link editFrontmatter} emit when a note has no existing block
 * (they preserve an existing block's styling, which this does not reproduce).
 * `parseFrontmatter` is its inverse: every accepted input round-trips, and
 * reports the result as `'flat'`.
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
 * @param frontmatter Flat key-value map: scalars (`string`, a finite `number`,
 *   `boolean`, `null`) and arrays of scalars. Nesting is refused — this
 *   package does not author a shape {@link editFrontmatter} cannot then rewrite
 *   one key at a time. A nested block written by something else is still read
 *   and indexed; see {@link FrontmatterValidity}.
 * @returns A string of the form `---\n<yaml>\n---\n`, or `''` for an empty map.
 * @throws {@link MdVaultError} with code `FRONTMATTER_INVALID`, naming the
 *   offending keys, when a value is a nested map or array, an array of
 *   non-scalars, a `Date`, a class instance, a non-finite number, or
 *   `undefined`. Binding one array to two keys is fine: it is written out
 *   twice rather than as a YAML anchor.
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
