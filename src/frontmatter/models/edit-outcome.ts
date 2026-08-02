/**
 * Result of an {@link editFrontmatter} call:
 * - `'edited'` — the mutator produced a change and the frontmatter was rewritten.
 * - `'unchanged'` — the mutator left the frontmatter identical; no write occurred.
 * - `'unverifiable'` — the edit was skipped to avoid data loss, because the
 *   existing block is nested or unstorable, the mutation would have made it
 *   nested or unstorable, or rewriting the YAML document would orphan a YAML
 *   anchor (a duplicate key shadowing it, or a rewrite of its owner).
 */
export type EditOutcome = 'edited' | 'unchanged' | 'unverifiable';
