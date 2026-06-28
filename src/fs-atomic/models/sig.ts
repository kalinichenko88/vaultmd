/**
 * A lightweight filesystem signature used for optimistic-concurrency checks.
 * Two files are considered identical when both `mtimeMs` and `size` match.
 */
export type Sig = {
  /** Last-modified time of the file in milliseconds since the Unix epoch. */
  mtimeMs: number;
  /** File size in bytes. */
  size: number;
};
