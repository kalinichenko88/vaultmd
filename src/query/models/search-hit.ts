/**
 * A note plus the text around what matched — returned by
 * {@link QueryApi.searchText}, {@link QueryApi.unlinkedMentions} and
 * {@link QueryApi.outboundMentions}.
 */
export type SearchHit = {
  /** Vault-relative path of the matching note. */
  path: string;
  /** Derived title of the matching note. */
  title: string;
  /**
   * Excerpt showing where the match sits, with the matched text wrapped in
   * `<b>` and `…` where the excerpt is cut. `searchText` builds it with fts5's
   * `snippet()`; the mention methods build the equivalent around the name they
   * matched. Absent when the caller asked for no snippet.
   */
  snippet?: string;
};
