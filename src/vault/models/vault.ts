import type { NotesApi } from '@/notes/index.ts';
import type { QueryApi } from '@/query/index.ts';
import type { VaultIo } from '@/vault-io/index.ts';

export type Vault = {
  io: VaultIo;
  notes: NotesApi;
  query: QueryApi;
  reconcile(): Promise<void>;
  reconcilePaths(rels: string[]): Promise<void>;
  rebuild(): Promise<void>;
  close(): void;
};
