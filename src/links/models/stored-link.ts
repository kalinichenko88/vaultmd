/** A normalised outbound link record stored in the index for a note. */
export type StoredLink = {
  /**
   * Normalised link target. For wikilinks: the path stem (no `.md` extension).
   * For relative markdown links: the vault-relative path including `.md`.
   */
  target: string;
  /**
   * The lowercase filename stem of `target`, used for fuzzy wikilink resolution.
   * `null` for relative markdown links where resolution is already exact.
   */
  base: string | null;
  /** The syntax form of the link as it appears in the source file. */
  kind: 'wikilink' | 'embed' | 'mdlink';
};
