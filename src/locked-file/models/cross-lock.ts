/**
 * Configuration for the cross-process advisory lock used by
 * {@link withFileTransform} and {@link withFileDelete} when `cross` is set.
 * A holder refreshes its lock file while it holds the lock, and a lock file
 * left by a dead holder is taken over as `crossProcessWriterLock` in
 * {@link CreateVaultConfig} says.
 */
export type CrossLock = {
  /** Absolute path to the directory where lock files are stored. */
  lockDir: string;
  /** Milliseconds to wait for the lock before throwing a busy error. */
  busyTimeoutMs: number;
};
