/**
 * Configuration for the cross-process advisory lock used by
 * {@link withFileTransform} and {@link withFileDelete} when `cross` is set.
 */
export type CrossLock = {
  /** Absolute path to the directory where lock files are stored. */
  lockDir: string;
  /** Milliseconds to wait for the lock before throwing a busy error. */
  busyTimeoutMs: number;
};
