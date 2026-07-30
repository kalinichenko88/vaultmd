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
  /**
   * Relevance of this hit, **higher is better**. It is SQLite fts5's BM25 rank
   * negated: fts5 itself scores with *negative* numbers where more negative is
   * the better match (which is why its rank order is ascending), and handing
   * that sign to callers makes every threshold read backwards.
   *
   * Unbounded above, and comparable only **within one query's results**. BM25
   * weighs a term by how rare it is across the vault and how short the matching
   * note is, so the same number means different things for different query
   * strings — a threshold tuned on one query does not transfer to another.
   * Compare hits against each other, or against the top hit, not against a
   * constant carried between searches.
   *
   * Present on every {@link QueryApi.searchText} hit. On
   * {@link QueryApi.unlinkedMentions} it scores the note's *name* as a phrase
   * query against the mentioning note, so hits found through different names of
   * the same note came from different queries and are not mutually comparable;
   * it is absent there for a name fts5 cannot tokenize (one made only of
   * symbols, e.g. a note filed as `📥.md`). Always absent from
   * {@link QueryApi.outboundMentions}, which scans the queried note's body
   * directly and never runs an fts5 query to rank.
   */
  score?: number;
};
