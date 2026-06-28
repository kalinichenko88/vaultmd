/** An outbound link from a note as returned by {@link QueryApi.outboundLinks}. */
export type OutboundLink = {
  /** Normalised link target as stored in the index (stem for wikilinks, vault-relative path for md-links). */
  target: string;
  /**
   * Vault-relative path of the note the link resolves to, or `null` when the
   * target could not be matched to any note in the vault (dangling link).
   */
  resolved: string | null;
};
