import type { EditOutcome } from '@/frontmatter/index.ts';

import type { ReadNoteResult } from './read-note-result.ts';
import type { TransformOutcome } from './transform-outcome.ts';
import type { UpdateOp } from './update-op.ts';

/**
 * The notes CRUD surface, exposed as `vault.notes`. Every method takes a
 * vault-relative path; the four mutating methods (`createNote`, `updateNote`,
 * `editFrontmatter`, `deleteNote`) run inside the per-file lock so the `.md`
 * file and its index row never drift. `readNote` is a consistent read and
 * does not acquire the lock.
 */
export type NotesApi = {
  /**
   * Read a note's parsed frontmatter, tags, body, and frontmatter validity.
   * @param path Vault-relative path to the `.md` file.
   * @param opts When `withLinks` is true, also resolve `outbound` and
   * `backlinks` for the note.
   * @throws {@link MdVaultError} `NOT_FOUND` if the file does not exist.
   */
  readNote(
    path: string,
    opts?: { withLinks?: boolean },
  ): Promise<ReadNoteResult>;
  /**
   * Create a new note, writing frontmatter + body. Never clobbers an existing
   * file.
   * @throws {@link MdVaultError} `ALREADY_EXISTS` if the path is taken.
   */
  createNote(
    path: string,
    input: { frontmatter?: Record<string, unknown>; body: string },
  ): Promise<void>;
  /**
   * Mutate a note body — either append text or replace a single unique match.
   * @throws {@link MdVaultError} `NO_MATCH` / `AMBIGUOUS_MATCH` for `editByMatch`.
   */
  updateNote(path: string, op: UpdateOp): Promise<void>;
  /**
   * Edit a note's frontmatter in place via a mutator callback.
   * @returns Whether the frontmatter was `edited`, `unchanged`, or
   * `unverifiable`.
   */
  editFrontmatter(
    path: string,
    mutate: (fm: Record<string, unknown>) => void,
  ): Promise<EditOutcome>;
  /**
   * Run a free-form transform over a note's FULL content inside the per-file
   * lock, with write-through indexing. `allowCreate` is always false:
   *   existing file, transform → string : write + index → `'edited'`
   *   any file,      transform → null   : no write       → `'unchanged'`
   *   MISSING file,  transform → string : throws `REFUSE_CREATE`
   *   MISSING file,  transform → null   : `'unchanged'` (no throw)
   * The callback is RE-INVOKED on each `MTIME_CONFLICT` retry, so it must be a
   * pure function of `current` (side-effects must overwrite, not accumulate).
   * @throws {@link MdVaultError} `REFUSE_CREATE` if asked to write a missing file.
   */
  transformNote(
    path: string,
    transform: (current: string | null) => string | null,
  ): Promise<TransformOutcome>;
  /**
   * Delete a note and drop its index row.
   * @returns `true` if a file was deleted, `false` if it was already absent.
   */
  deleteNote(path: string): Promise<boolean>;
};
