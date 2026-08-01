import type { ReconcileResult } from '@/note-index/index.ts';
import type { NotesApi } from '@/notes/index.ts';
import type { QueryApi } from '@/query/index.ts';
import type { VaultIo } from '@/vault-io/index.ts';

/** A live vault handle: IO surface, notes CRUD, queries, and lifecycle. */
export type Vault = {
  /** The path-scoped IO chokepoint (allowlists, canonicalization). */
  io: VaultIo;
  /** Notes CRUD surface. See {@link NotesApi}. */
  notes: NotesApi;
  /** Read-only query surface over the index. See {@link QueryApi}. */
  query: QueryApi;
  /**
   * Reconcile the whole index with on-disk state, and report what changed.
   * Poll this to pick up out-of-band edits: they update the index but never
   * fire `onCommit`. See {@link ReconcileResult}.
   */
  reconcile(): Promise<ReconcileResult>;
  /** Reconcile only the given vault-relative paths. */
  reconcilePaths(rels: string[]): Promise<void>;
  /** Drop and rebuild the entire index from disk. */
  rebuild(): Promise<void>;
  /** Close the underlying database. */
  close(): void;
};
