export type Reconciler = {
  reconcile(): Promise<void>;
  reconcilePaths(rels: string[]): Promise<void>;
  rebuild(): Promise<void>;
};
