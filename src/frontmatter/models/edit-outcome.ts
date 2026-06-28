/**
 * Result of an {@link editFrontmatter} call:
 * - `'edited'` — the mutator produced a change and the frontmatter was rewritten.
 * - `'unchanged'` — the mutator left the frontmatter identical; no write occurred.
 * - `'unverifiable'` — the existing frontmatter is not flat-scalar-safe and
 *   the edit was skipped to avoid data loss.
 */
export type EditOutcome = 'edited' | 'unchanged' | 'unverifiable';
