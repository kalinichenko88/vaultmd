/**
 * Result of an {@link editFrontmatter} call:
 * - `'edited'` — the mutator produced a change and the frontmatter was rewritten.
 * - `'unchanged'` — the mutator left the frontmatter identical; no write occurred.
 * - `'unverifiable'` — the existing frontmatter does not round-trip, the
 *   mutation would produce a value that cannot, or rewriting the existing YAML
 *   document would orphan a container reference (a duplicate key shadowing a
 *   YAML anchor, or a rewrite of the anchor's owner) — and the edit was
 *   skipped to avoid data loss.
 */
export type EditOutcome = 'edited' | 'unchanged' | 'unverifiable';
