import { MdVaultError } from './errors.ts';
import {
  atomicWrite,
  atomicWriteIfUnchanged,
  readConsistent,
  statSig,
  unlinkIfUnchanged,
  withCrossProcessLock,
  withFileLock,
} from './fs-atomic.ts';

export type CommitEvent =
  | { op: 'create' | 'update'; path: string; content: string }
  | { op: 'delete'; path: string };

export type CrossLock = { lockDir: string; busyTimeoutMs: number };

export type TransformOpts = {
  allowCreate?: boolean;
  onCommit?: (e: CommitEvent) => void | Promise<void>;
  maxRetries?: number;
  cross?: CrossLock | false;
};

export type TransformResult = {
  content: string | null;
  outcome: 'created' | 'updated' | 'unchanged';
};

async function emitCommit(
  onCommit: ((e: CommitEvent) => void | Promise<void>) | undefined,
  event: CommitEvent,
): Promise<void> {
  if (!onCommit) {
    return;
  }
  try {
    await onCommit(event);
  } catch (cause) {
    throw new MdVaultError(
      'COMMIT_FAILED',
      `onCommit failed for ${event.path}`,
      { cause },
    );
  }
}

/**
 * @param lockKey      Canonical/case-folded serialization key — pass `VaultIo.toKey(rel)`.
 * @param relForCommit Display path written to `CommitEvent.path` — pass `VaultIo.toVaultRelative(rel)`.
 */
export function withFileTransform(
  fullPath: string,
  lockKey: string,
  relForCommit: string,
  transform: (current: string | null) => string | null,
  opts: TransformOpts = {},
): Promise<TransformResult> {
  const { allowCreate = false, onCommit, maxRetries = 3, cross = false } = opts;

  const run = async (): Promise<TransformResult> => {
    let attempt = 0;
    for (;;) {
      const read = await readConsistent(fullPath);
      const next = transform(read.content);

      if (next === null) {
        return { content: read.content, outcome: 'unchanged' };
      }
      if (read.content === null) {
        if (!allowCreate) {
          throw new MdVaultError(
            'REFUSE_CREATE',
            `refusing to create missing file: ${relForCommit}`,
          );
        }
        await atomicWrite(fullPath, next);
        await emitCommit(onCommit, {
          op: 'create',
          path: relForCommit,
          content: next,
        });

        return { content: next, outcome: 'created' };
      }
      try {
        await atomicWriteIfUnchanged(fullPath, next, read.sig);
      } catch (err) {
        if (
          err instanceof MdVaultError &&
          err.code === 'MTIME_CONFLICT' &&
          attempt < maxRetries
        ) {
          await Bun.sleep(50 * (attempt + 1));
          attempt++;

          continue;
        }

        throw err;
      }
      await emitCommit(onCommit, {
        op: 'update',
        path: relForCommit,
        content: next,
      });

      return { content: next, outcome: 'updated' };
    }
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
