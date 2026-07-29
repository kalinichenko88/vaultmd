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
  /**
   * Last-modified time in milliseconds since the epoch, as recorded in the
   * index — the same value {@link QueryOrder} sorts by with `field: 'mtime_ms'`.
   */
  mtime_ms: number;
  /** File size in bytes, as recorded in the index. */
  size: number;
};
