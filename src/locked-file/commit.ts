import { MdVaultError } from '../errors.ts';
import type { CommitEvent } from './models/commit-event.ts';

export async function emitCommit(
  onCommit: ((e: CommitEvent) => void | Promise<void>) | undefined,
  event: CommitEvent,
): Promise<void> {
  if (!onCommit) {
    return;
  }
  try {
    await onCommit(event);
  } catch (cause) {
    throw new MdVaultError(
      'COMMIT_FAILED',
      `onCommit failed for ${event.path}`,
      { cause },
    );
  }
}
