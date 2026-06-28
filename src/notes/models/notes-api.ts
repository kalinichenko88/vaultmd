import type { EditOutcome } from '@/frontmatter/index.ts';

import type { ReadNoteResult } from './read-note-result.ts';
import type { UpdateOp } from './update-op.ts';

/**
 * The notes CRUD surface, exposed as `vault.notes`. Every method takes a
 * vault-relative path and runs inside the per-file lock, so the `.md` file and
 * its index row never drift.
 */
export interface NotesApi {
  /**
   * Read a note's parsed frontmatter, tags, body, and frontmatter validity.
   * @param path Vault-relative path to the `.md` file.
   * @param opts When `withLinks` is true, also resolve `outbound` and
   * `backlinks` for the note.
   * @throws MdVaultError `NOT_FOUND` if the file does not exist.
   */
  readNote(
    path: string,
    opts?: { withLinks?: boolean },
  ): Promise<ReadNoteResult>;
  /**
   * Create a new note, writing frontmatter + body. Never clobbers an existing
   * file.
   * @throws MdVaultError `ALREADY_EXISTS` if the path is taken.
   */
  createNote(
    path: string,
    input: { frontmatter?: Record<string, unknown>; body: string },
  ): Promise<void>;
  /**
   * Mutate a note body — either append text or replace a single unique match.
   * @throws MdVaultError `NO_MATCH` / `AMBIGUOUS_MATCH` for `editByMatch`.
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
   * Delete a note and drop its index row.
   * @returns `true` if a file was deleted, `false` if it was already absent.
   */
  deleteNote(path: string): Promise<boolean>;
}
