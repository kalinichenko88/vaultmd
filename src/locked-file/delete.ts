import { statSig, unlinkIfUnchanged } from '../fs-atomic/index.ts';
import { withCrossProcessLock, withFileLock } from '../locks/index.ts';
import { emitCommit } from './commit.ts';
import type { CommitEvent, CrossLock } from './types.ts';

/**
 * @param lockKey      Canonical/case-folded serialization key — pass `VaultIo.toKey(rel)`.
 * @param relForCommit Display path written to `CommitEvent.path` — pass `VaultIo.toVaultRelative(rel)`.
 */
export function withFileDelete(
  fullPath: string,
  lockKey: string,
  relForCommit: string,
  opts: {
    onCommit?: (e: CommitEvent) => void | Promise<void>;
    cross?: CrossLock | false;
  } = {},
): Promise<{ deleted: boolean }> {
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
