import type { createNotes } from '../../notes/index.ts';
import type { createQuery } from '../../query/index.ts';
import type { VaultIo } from '../../vault-io/index.ts';

export type Vault = {
  io: VaultIo;
  notes: ReturnType<typeof createNotes>;
  query: ReturnType<typeof createQuery>;
  reconcile(): Promise<void>;
  reconcilePaths(rels: string[]): Promise<void>;
  rebuild(): Promise<void>;
  close(): void;
};
