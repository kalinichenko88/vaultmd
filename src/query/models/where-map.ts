/**
 * A map of frontmatter field names to exact-match values used as a filter in
 * {@link QueryApi.queryNotes}. All entries are combined with AND semantics.
 *
 * @example
 * ```ts
 * // notes where status === 'done' AND priority === 1
 * vault.query.queryNotes({ where: { status: 'done', priority: 1 } });
 * ```
 */
export type WhereMap = Record<string, string | number | boolean>;
