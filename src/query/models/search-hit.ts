/** A single result returned by {@link QueryApi.searchText}. */
export type SearchHit = {
  /** Vault-relative path of the matching note. */
  path: string;
  /** Derived title of the matching note. */
  title: string;
  /** FTS5-highlighted excerpt showing where the query terms appear in the note body. */
  snippet?: string;
};
