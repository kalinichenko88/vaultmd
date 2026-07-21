import { unlink } from 'node:fs/promises';

import { MdVaultError } from '@/errors.ts';
import {
  exclusiveCreate,
  readConsistent,
  unlinkIfUnchanged,
} from '@/fs-atomic/index.ts';
import { withCrossProcessLock, withFileLock } from '@/locks/index.ts';

import { emitCommit } from './commit.ts';
import type { CommitEvent } from './models/commit-event.ts';
import type { CrossLock } from './models/cross-lock.ts';
import type { MoveTarget } from './models/move-target.ts';

/**
 * Move a vault file byte-for-byte from `from` to `to`, holding BOTH per-file
 * locks (acquired in sorted key order, so opposing moves cannot deadlock). The
 * destination is created exclusively — an occupied path throws rather than
 * being clobbered — and if the source turns out to have changed under us the
 * fresh destination is rolled back, so a failed move never leaves a duplicate.
 *
 * Emits TWO {@link CommitEvent}s on success: `delete` for `from`, then
 * `create` for `to`. There is no dedicated `move` event — the pair describes
 * the same observable end state.
 *
 * @param from Resolved source target — see {@link MoveTarget}.
 * @param to   Resolved destination target — see {@link MoveTarget}.
 * @param opts Optional `onCommit` callback and cross-process lock config.
 * @throws {@link MdVaultError} `VALIDATION_ERROR` if both keys are identical
 * (the lock is serializing, not reentrant), `NOT_FOUND` if the source is
 * absent, `ALREADY_EXISTS` if the destination is taken, or `MTIME_CONFLICT` if
 * the source changed under the move.
 */
export function withFileMove(
  from: MoveTarget,
  to: MoveTarget,
  opts: {
    /** Optional callback invoked after the move commits, once per event. */
    onCommit?: (e: CommitEvent) => void | Promise<void>;
    /** Cross-process lock config, or `false` (default) for in-process only. */
    cross?: CrossLock | false;
  } = {},
): Promise<void> {
  const { onCommit, cross = false } = opts;
  if (from.key === to.key) {
    // Rejection, not a sync throw: the guard fires before any lock is taken,
    // but callers still see it on the promise like every other failure.
    return Promise.reject(
      new MdVaultError(
        'VALIDATION_ERROR',
        `move source and destination are the same note: ${from.relative}`,
      ),
    );
  }

  const run = async (): Promise<void> => {
    const src = await readConsistent(from.full);
    if (src.content === null) {
      throw new MdVaultError('NOT_FOUND', `note not found: ${from.relative}`);
    }
    // exclusiveCreate (temp + link) → ALREADY_EXISTS on clash, never clobbers.
    await exclusiveCreate(to.full, src.content);
    let removed = false;
    try {
      removed = await unlinkIfUnchanged(from.full, src.sig);
    } catch (err) {
      await unlink(to.full).catch(() => {});

      throw err;
    }
    if (!removed) {
      // Source vanished under us (an external writer holding no lock). Roll the
      // destination back — otherwise the move leaves exactly the duplicate note
      // it exists to prevent.
      await unlink(to.full).catch(() => {});

      throw new MdVaultError(
        'MTIME_CONFLICT',
        `source changed under move: ${from.relative}`,
      );
    }
    await emitCommit(onCommit, { op: 'delete', path: from.relative });
    await emitCommit(onCommit, {
      op: 'create',
      path: to.relative,
      content: src.content,
    });
  };

  // Sorted order — two opposing moves (a→b, b→a) queue behind the same key
  // first and cannot deadlock. Both layers nest in that same order.
  const keys = [from.key, to.key].sort();
  const locked = () => withLocks(keys, withFileLock, run);

  if (cross) {
    return withLocks(
      keys,
      (key, fn) =>
        withCrossProcessLock(cross.lockDir, key, cross.busyTimeoutMs, fn),
      locked,
    );
  }

  return locked();
}

// Fold a key list into nested lock acquisitions: keys[0] outermost.
function withLocks<T>(
  keys: string[],
  acquire: (key: string, fn: () => Promise<T>) => Promise<T>,
  fn: () => Promise<T>,
): Promise<T> {
  return keys.reduceRight<() => Promise<T>>(
    (inner, key) => () => acquire(key, inner),
    fn,
  )();
}
