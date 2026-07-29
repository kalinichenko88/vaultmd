/**
 * Multi-tag matching for the note readers, the plural companion to the single
 * `tag` shorthand. Both fields may be given at once; they are AND-ed, as is a
 * `tag` passed alongside.
 *
 * @example
 * ```ts
 * // tagged both #project and #active, and at least one of #q3 / #q4
 * vault.query.queryNotes({
 *   tags: { all: ['project', 'active'], any: ['q3', 'q4'] },
 * });
 * ```
 */
export type TagFilter = {
  /** Every tag must be present. An empty list constrains nothing. */
  all?: string[];
  /** At least one tag must be present. An empty list matches nothing. */
  any?: string[];
};
