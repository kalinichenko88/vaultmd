export type CommitEvent =
  | { op: 'create' | 'update'; path: string; content: string }
  | { op: 'delete'; path: string };

export type CrossLock = { lockDir: string; busyTimeoutMs: number };

export type TransformOpts = {
  allowCreate?: boolean;
  onCommit?: (e: CommitEvent) => void | Promise<void>;
  maxRetries?: number;
  cross?: CrossLock | false;
};

export type TransformResult = {
  content: string | null;
  outcome: 'created' | 'updated' | 'unchanged';
};
