/**
 * Index field on which {@link QueryApi.queryNotes} results are sorted.
 * - `'mtime_ms'` — last-modified time (default, newest first).
 * - `'path'` — vault-relative path, alphabetical.
 * - `'title'` — derived title, alphabetical.
 */
export type OrderField = 'mtime_ms' | 'path' | 'title';

/** Sort specification for {@link QueryApi.queryNotes}. */
export type QueryOrder = {
  /** The index field to sort by. */
  field: OrderField;
  /** Sort direction: `'asc'` for ascending, `'desc'` for descending. */
  dir: 'asc' | 'desc';
};
