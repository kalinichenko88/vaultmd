import type { LinkResolution } from '@/links/index.ts';
import type { CommitEvent } from '@/locked-file/index.ts';
import type { VaultIoConfig } from '@/vault-io/index.ts';

export type CreateVaultConfig = VaultIoConfig & {
  indexPath: string;
  linkResolution?: LinkResolution;
  lazyReconcile?: boolean;
  reconcileTtlMs?: number;
  sqliteBusyTimeoutMs?: number;
  crossProcessWriterLock?: boolean;
  onCommit?: (e: CommitEvent) => void | Promise<void>;
};
