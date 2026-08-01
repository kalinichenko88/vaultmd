/**
 * What one full reconcile sweep changed in the index. Every field holds
 * sorted vault-relative paths, and all three are empty when the sweep found
 * the index already in step with disk. This is the watcher-free change feed:
 * out-of-band edits (an editor, `git checkout`, a sync client) never fire
 * `onCommit`, so polling this result is how a consumer learns about them.
 */
export type ReconcileResult = {
  /** Paths indexed for the first time — no row existed before the sweep. */
  added: string[];
  /** Paths re-indexed because their `(mtime, size)` signature had changed. */
  updated: string[];
  /** Paths dropped from the index because the file is gone from disk. */
  removed: string[];
};
