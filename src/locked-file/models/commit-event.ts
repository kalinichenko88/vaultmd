export type CommitEvent =
  | { op: 'create' | 'update'; path: string; content: string }
  | { op: 'delete'; path: string };
