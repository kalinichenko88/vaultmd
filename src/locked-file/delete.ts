import { statSig, unlinkIfUnchanged } from '@/fs-atomic/index.ts';
import { withCrossProcessLock, withFileLock } from '@/locks/index.ts';

import { emitCommit } from './commit.ts';
import type { CommitEvent } from './models/commit-event.ts';
import type { CrossLock } from './models/cross-lock.ts';

/**
 * Delete a vault file inside the per-file lock, emitting a {@link CommitEvent}
 * on success. The delete is idempotent: if the file is already absent the
 * promise resolves with `{ deleted: false }` rather than throwing.
 *
 * @param fullPath     Absolute filesystem path to the target file.
 * @param lockKey      Canonical/case-folded serialization key — pass `VaultIo.toKey(rel)`.
 * @param relForCommit Display path written to `CommitEvent.path` — pass `VaultIo.toVaultRelative(rel)`.
 * @param opts         Optional `onCommit` callback and cross-process lock config.
 * @returns `{ deleted: true }` when the file was removed; `{ deleted: false }` when absent.
 */
export function withFileDelete(
  fullPath: string,
  lockKey: string,
  relForCommit: string,
  opts: {
    /** Optional callback invoked after the file is successfully deleted. */
    onCommit?: (e: CommitEvent) => void | Promise<void>;
    /** Cross-process lock config, or `false` (default) for in-process only. */
    cross?: CrossLock | false;
  } = {},
): Promise<{
  /** `true` if the file was deleted; `false` if it was already absent. */
  deleted: boolean;
}> {
  const { onCommit, cross = false } = opts;

  const run = async (): Promise<{ deleted: boolean }> => {
    const sig = await statSig(fullPath);
    if (sig === null) {
      return { deleted: false };
    }
    const removed = await unlinkIfUnchanged(fullPath, sig);
    if (!removed) {
      return { deleted: false };
    }
    await emitCommit(onCommit, { op: 'delete', path: relForCommit });

    return { deleted: true };
  };

  const locked = () => withFileLock(lockKey, run);

  if (cross) {
    return withCrossProcessLock(
      cross.lockDir,
      lockKey,
      cross.busyTimeoutMs,
      locked,
    );
  }

  return locked();
}
