/** A tag together with how many in-scope notes carry it. */
export type TagInfo = {
  /** The tag string, exactly as stored (case- and `/`-preserving). */
  tag: string;
  /** Number of notes the instance can read that carry this tag. */
  count: number;
};
