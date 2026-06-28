import type { CommitEvent } from './commit-event.ts';
import type { CrossLock } from './cross-lock.ts';

export type TransformOpts = {
  allowCreate?: boolean;
  onCommit?: (e: CommitEvent) => void | Promise<void>;
  maxRetries?: number;
  cross?: CrossLock | false;
};
