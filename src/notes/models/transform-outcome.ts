/**
 * Result of a {@link NotesApi.transformNote} call:
 * - `'edited'` — the transform returned new content; the file was rewritten.
 * - `'unchanged'` — the transform returned `null`; no write occurred.
 *
 * Distinct from {@link EditOutcome}: a free-form transform makes no
 * frontmatter-flatness judgement, so `'unverifiable'` is never returned.
 */
export type TransformOutcome = 'edited' | 'unchanged';
