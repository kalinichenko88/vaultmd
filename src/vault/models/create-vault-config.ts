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
   * Applies to both read and write operations.
   */
  sqliteBusyTimeoutMs?: number;
  /**
   * When `true` (default), serialise writes via a cross-process advisory lock
   * stored next to the index file. Set to `false` for single-process scenarios
   * to avoid the lock-file overhead.
   */
  crossProcessWriterLock?: boolean;
  /**
   * Optional callback invoked after each committed file operation. Receives a
   * {@link CommitEvent} describing the `op`, `path`, and (for writes) the new
   * content. Errors thrown here are wrapped in `MdVaultError('COMMIT_FAILED')`.
   */
  onCommit?: (e: CommitEvent) => void | Promise<void>;
};
