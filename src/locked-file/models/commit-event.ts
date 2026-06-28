/**
 * Event emitted to the `onCommit` callback after each successful file
 * operation. The union discriminates on `op`: write operations carry the
 * new file `content`; delete operations do not.
 */
export type CommitEvent =
  | {
      /** The operation kind: `'create'` on first write, `'update'` on subsequent writes. */
      op: 'create' | 'update';
      /** Vault-relative path of the affected file. */
      path: string;
      /** The new UTF-8 file content after the write. */
      content: string;
    }
  | {
      /** The operation kind for deletions. */
      op: 'delete';
      /** Vault-relative path of the deleted file. */
      path: string;
    };
