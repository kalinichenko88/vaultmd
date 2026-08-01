import type { ReconcileResult } from './reconcile-result.ts';

export type Reconciler = {
  reconcile(): Promise<ReconcileResult>;
  reconcilePaths(rels: string[]): Promise<void>;
  rebuild(): Promise<void>;
};
