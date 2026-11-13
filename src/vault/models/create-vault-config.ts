import type { LinkResolution } from '@/links/index.ts';
import type { CommitEvent } from '@/locked-file/index.ts';
import type { VaultIoConfig } from '@/vault-io/index.ts';

/**
 * Configuration passed to {@link createVault}. Extends {@link VaultIoConfig}
 * with index, link-resolution, and lifecycle settings.
 */
export type CreateVaultConfig = VaultIoConfig & {
  /** Absolute path to the SQLite index file (created automatically if absent). */
  indexPath: string;
  /**
   * How outbound links are resolved when building the index.
   * `'wikilink'` (default) resolves `[[Target]]` by filename; `'relative'`
   * resolves standard `[text](./path.md)` markdown links.
   */
  linkResolution?: LinkResolution;
  /**
   * When `true` (default), the first read after each TTL window kicks a
   * background reconcile sweep instead of blocking. Set to `false` to
   * disable background reconciliation entirely.
   */
  lazyReconcile?: boolean;
  /**
   * Minimum time in milliseconds between lazy reconcile sweeps (default 2000).
   * Has no effect when `lazyReconcile` is `false`.
   */
  reconcileTtlMs?: number;
  /**
   * Milliseconds to wait for a busy SQLite lock before throwing (default 5000).
   * Applies to both read and write operations, and is also how long a write
   * waits for the cross-process lock (see `crossProcessWriterLock` for the 3
   * seconds more that a stale lock can take). With `crossProcessWriterLock`
   * on, keep it below 20000: a writer refreshes its lock from the event loop,
   * so a SQLite wait or other synchronous work that blocks the loop for about
   * 30 seconds can let another process take the writer's lock.
   */
  sqliteBusyTimeoutMs?: number;
  /**
   * When `true` (default), serialise writes via a cross-process advisory lock
   * stored next to the index file. Set to `false` for single-process scenarios
   * to avoid the lock-file overhead. A writer refreshes its lock while it
   * holds it. A lock is taken over once nobody has refreshed it for 30
   * seconds and the waiting write has seen it stay so for 3 more; that write
   * waits for those 3 seconds even past `sqliteBusyTimeoutMs`. Until a dead
   * writer's lock is taken over, writes to that note fail with
   * `MTIME_CONFLICT`: about 33 seconds, or, when the clock was stepped back
   * after the writer died, until the clock is 30 seconds past the lock's last
   * refresh. The lock's pid and host name are not checked: they do
   * not tell a live writer in another PID namespace (as another container
   * with the same host name) from a dead one.
   */
  crossProcessWriterLock?: boolean;
  /**
   * Optional callback invoked after each committed file operation. Receives a
   * {@link CommitEvent} describing the `op`, `path`, and (for writes) the new
   * content. Errors thrown here are wrapped in `MdVaultError('COMMIT_FAILED')`.
   *
   * This is not a change feed: it reports only writes made through this vault
   * instance. Edits made out of band — in an editor, by `git checkout`, by a
   * sync client — surface in the index through reconcile, without an event.
   */
  onCommit?: (e: CommitEvent) => void | Promise<void>;
};
