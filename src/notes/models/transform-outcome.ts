/**
 * Result of a {@link NotesApi.transformNote} call:
 * - `'edited'` — the transform returned content differing from the current
 *   file; it was rewritten and reindexed.
 * - `'unchanged'` — the transform returned `null`/`undefined`, or content
 *   byte-identical to the current file; no write occurred.
 *
 * Distinct from {@link EditOutcome}: a free-form transform makes no
 * frontmatter-flatness judgement, so `'unverifiable'` is never returned.
 */
export type TransformOutcome = 'edited' | 'unchanged';
