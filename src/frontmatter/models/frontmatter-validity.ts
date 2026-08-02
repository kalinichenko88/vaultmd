/**
 * Describes how a note's YAML frontmatter block parsed, and what may be done
 * with it:
 * - `'flat'` — present, and every value is a scalar or an array of scalars.
 *   Readable, indexed, and **safe to pass to `editFrontmatter`**.
 * - `'nested'` — present and readable, with at least one map or array-of-maps
 *   value. The keys are returned and indexed, so a caller can read them off
 *   `NoteHit.frontmatter`; `editFrontmatter` refuses the note, because
 *   rewriting one key would mean re-emitting a nested block it did not author.
 * - `'present-but-invalid'` — a block exists but is unparseable YAML, has a
 *   non-map root, or holds a value that cannot be projected into the index: a
 *   cycle (which YAML anchors can build), a non-finite number, or nesting deep
 *   enough to overflow the serializer. Its keys are NOT reported —
 *   `parseFrontmatter` returns an empty map for it.
 * - `'none'` — no frontmatter block found; the whole file is body content.
 */
export type FrontmatterValidity =
  | 'flat'
  | 'nested'
  | 'present-but-invalid'
  | 'none';
