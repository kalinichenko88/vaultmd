import type { CommitEvent } from './commit-event.ts';
import type { CrossLock } from './cross-lock.ts';

/** Options for {@link withFileTransform}. */
export type TransformOpts = {
  /**
   * When `true`, the transform may create the file if it does not yet exist.
   * Defaults to `false` — an attempt to write a new file throws
   * `MdVaultError('REFUSE_CREATE')`.
   */
  allowCreate?: boolean;
  /**
   * Optional callback invoked after a successful write or create. Receives a
   * {@link CommitEvent} describing the operation and new content.
   */
  onCommit?: (e: CommitEvent) => void | Promise<void>;
  /**
   * Maximum number of optimistic-concurrency retries on `MTIME_CONFLICT`
   * before the conflict error is re-thrown (default 3).
   */
  maxRetries?: number;
  /**
   * Cross-process lock configuration. Pass a {@link CrossLock} to serialise
   * writes across multiple processes; pass `false` (default) to use only the
   * in-process lock.
   */
  cross?: CrossLock | false;
};
