import { MdVaultError } from '@/errors.ts';
import {
  atomicWriteIfUnchanged,
  exclusiveCreate,
  readConsistent,
} from '@/fs-atomic/index.ts';
import { withCrossProcessLock, withFileLock } from '@/locks/index.ts';

import { emitCommit } from './commit.ts';
import type { TransformOpts } from './models/transform-opts.ts';
import type { TransformResult } from './models/transform-result.ts';

/**
 * Apply a transform to a vault file inside the per-file lock, with
 * optimistic-concurrency retry when another writer changes the file, or
 * creates it, between the read and the write. The `transform` callback
 * receives the current file content (or `null` if the file is absent) and
 * must return the desired new content, or `null` to leave the file untouched.
 * A create never replaces a file that appeared after the read: the transform
 * runs again on that file's text. When other writers still change or create
 * the file after `maxRetries` retries, it throws `MTIME_CONFLICT`.
 * The write is atomic and keeps the file's mode and, where the OS allows, its
 * group and owner, as `VaultIo.writeVaultFile` says; it fails with
 * `UNSAFE_MODE` when the OS gives the new file a mode that gives the group or
 * the others more access than the file's mode did. It refuses a `fullPath` that is a symlink rather than
 * replace the link; the read follows a link like any read does, so pass paths
 * that `VaultIo` resolved — it refuses a link on every segment.
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
      const create = read.content === null;
      if (create && !allowCreate) {
        throw new MdVaultError(
          'REFUSE_CREATE',
          `refusing to create missing file: ${relForCommit}`,
        );
      }
      if (next === read.content) {
        // Byte-identical result: skip the redundant rewrite (which would bump
        // mtime), the write-through reindex, and the phantom 'update' commit.
        return { content: read.content, outcome: 'unchanged' };
      }
      try {
        if (create) {
          // Not a rename: a file that another writer made after the read is a
          // conflict, as a change under the write is, and the next round
          // transforms its text (#45). ponytail: on NFS a link() that took
          // effect can still fail with EEXIST, and the next round then
          // applies the change twice (#76).
          await exclusiveCreate(fullPath, next).catch((err: unknown) => {
            if (err instanceof MdVaultError && err.code === 'ALREADY_EXISTS') {
              throw new MdVaultError(
                'MTIME_CONFLICT',
                `file created under write: ${relForCommit}`,
                { cause: err },
              );
            }
            throw err;
          });
        } else {
          await atomicWriteIfUnchanged(fullPath, next, read.sig);
        }
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
        op: create ? 'create' : 'update',
        path: relForCommit,
        content: next,
      });

      return { content: next, outcome: create ? 'created' : 'updated' };
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
