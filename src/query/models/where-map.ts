/**
 * A scalar frontmatter value usable as a filter operand. Only scalars are
 * comparable: `json_extract` hands back a nested map or array as its JSON
 * *text*, so comparing one is a string comparison against serialized JSON, not
 * a structural match. Filter a leaf, not a subtree.
 */
export type WhereValue = string | number | boolean;

/**
 * The operator form of a {@link WhereMap} entry. Every operator present is
 * applied, AND-ed together, so `{ gte: 1, lt: 10 }` is a half-open range.
 *
 * @example
 * ```ts
 * // due before August, and not already done
 * vault.query.queryNotes({
 *   where: { due: { lt: '2026-08-01' }, status: { ne: 'done' } },
 * });
 * ```
 */
export type WhereCondition = {
  /**
   * Not equal. A note *missing* the field matches, since "unset" is not the
   * value — pair with `exists: true` to require the field as well.
   *
   * Match the operand's type to the stored one. SQLite holds values of
   * different types to be never equal, so `{ ne: '5' }` against a numeric
   * field excludes nothing and quietly returns every note — where the same
   * mismatch on equality or a range would return an obvious empty result.
   */
  ne?: WhereValue;
  /** Less than. */
  lt?: WhereValue;
  /** Less than or equal. */
  lte?: WhereValue;
  /** Greater than. */
  gt?: WhereValue;
  /** Greater than or equal. */
  gte?: WhereValue;
  /** Set membership. An empty list matches nothing. */
  in?: WhereValue[];
  /**
   * Whether the field is present at all. `false` selects notes that lack the
   * field; a field explicitly set to `null` counts as absent.
   */
  exists?: boolean;
};

/**
 * A map of frontmatter field names to filters used by
 * {@link QueryApi.queryNotes} and {@link QueryApi.countNotes}. All entries are
 * combined with AND semantics.
 *
 * A bare value is an equality test; a {@link WhereCondition} object opens up
 * ranges, set membership, negation and presence tests. Comparisons run over the
 * indexed frontmatter JSON, so they follow SQLite's type ordering: compare
 * strings with strings and numbers with numbers (ISO dates sort correctly as
 * strings).
 *
 * @example
 * ```ts
 * vault.query.queryNotes({
 *   where: {
 *     status: 'open',                  // equality
 *     due: { lt: '2026-08-01' },       // range
 *     kind: { in: ['note', 'ref'] },   // set membership
 *     archived: { exists: false },     // field absent
 *   },
 * });
 * ```
 *
 * A key is a **path**: a dot separates segments, so `'meta.status'` matches the
 * `status` key inside a nested `meta` map. Write `\.` for a frontmatter key
 * that literally contains a dot (`'meta\\.status'` in a TypeScript string
 * literal). A stray backslash, an empty segment (`'a..b'`, `'.a'`, `'a.'`) or
 * any character outside `[A-Za-z0-9_.\\-]` throws `VALIDATION_ERROR`.
 *
 * Paths address **object labels only** — they do not descend into arrays.
 * `'items.0.name'` matches nothing rather than reaching the first element.
 * Read arrays back through `NoteHit.frontmatter` instead.
 *
 * @example
 * ```ts
 * vault.query.queryNotes({
 *   where: {
 *     'meta.status': 'open',        // nested path
 *     'meta\\.status': 'open',      // key literally named "meta.status"
 *   },
 * });
 * ```
 */
export type WhereMap = Record<string, WhereValue | WhereCondition>;
