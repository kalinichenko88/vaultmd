import type { VaultPrefixes } from './vault-prefixes.ts';

/** Configuration passed to {@link createVaultIo}. */
export type VaultIoConfig = {
  /** Absolute (or process-relative) path to the vault root directory. */
  root: string;
  /** Read and write allowlist prefixes that scope the IO surface. */
  prefixes: VaultPrefixes;
  /**
   * Override the filesystem case-sensitivity probe. `true` to treat paths as
   * case-sensitive, `false` to case-fold. When omitted the IO layer probes the
   * volume automatically.
   */
  caseSensitive?: boolean;
  /**
   * Glob patterns for paths to exclude from enumeration and reconciliation.
   * Matched against vault-relative paths (e.g. `['drafts/**', '*.tmp.md']`).
   */
  ignore?: string[];
};
