/** A single note returned by {@link QueryApi.queryNotes}. */
export type NoteHit = {
  /** Vault-relative path of the note. */
  path: string;
  /** Title derived from the `title` frontmatter field, or the filename stem. */
  title: string;
  /** Full parsed frontmatter key-value map. */
  frontmatter: Record<string, unknown>;
  /** Normalised tag tokens from frontmatter. */
  tags: string[];
};
