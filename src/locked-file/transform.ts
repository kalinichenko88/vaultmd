import { MdVaultError } from '@/errors.ts';
import {
  atomicWrite,
  atomicWriteIfUnchanged,
  readConsistent,
} from '@/fs-atomic/index.ts';
import { withCrossProcessLock, withFileLock } from '@/locks/index.ts';

import { emitCommit } from './commit.ts';
import type { TransformOpts } from './models/transform-opts.ts';
import type { TransformResult } from './models/transform-result.ts';

/**
 * Apply a transform to a vault file inside the per-file lock, with
 * optimistic-concurrency retry on mtime conflicts. The `transform` callback
 * receives the current file content (or `null` if the file is absent) and
 * must return the desired new content, or `null` to leave the file untouched.
 *
 * @param fullPath     Absolute filesystem path to the target file.
 * @param lockKey      Canonical/case-folded serialization key — pass `VaultIo.toKey(rel)`.
 * @param relForCommit Display path written to `CommitEvent.path` — pass `VaultIo.toVaultRelative(rel)`.
 * @param transform    Pure function from current content to desired content, or `null` for no-op.
 * @param opts         Optional behaviour overrides — see {@link TransformOpts}.
 * @returns A {@link TransformResult} describing the outcome and final content.
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
      if (next === read.content) {
        // Byte-identical result: skip the redundant rewrite (which would bump
        // mtime), the write-through reindex, and the phantom 'update' commit.
        return { content: read.content, outcome: 'unchanged' };
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
