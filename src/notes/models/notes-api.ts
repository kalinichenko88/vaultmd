import type { EditOutcome } from '@/frontmatter/index.ts';

import type { ReadNoteResult } from './read-note-result.ts';
import type { TransformOutcome } from './transform-outcome.ts';
import type { UpdateOp } from './update-op.ts';

/**
 * The notes CRUD surface, exposed as `vault.notes`. Every method takes a
 * vault-relative path; the six mutating methods (`createNote`, `updateNote`,
 * `editFrontmatter`, `transformNote`, `deleteNote`, `moveNote`) run inside the
 * per-file lock so the `.md` file and its index row never drift (`moveNote`
 * holds both ends' locks). `readNote`, `readSection`, and `exists` are
 * consistent reads and do not acquire the lock.
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
   * Read the body of the section opened by a heading — everything after the
   * heading line up to the next heading of the same or a shallower level, or
   * the end of the file. Subsections are included; blank lines directly after
   * the heading and directly before the next one are not, so the result can be
   * written straight back with `updateNote({ setSection })` without disturbing
   * the file's spacing.
   *
   * The heading is matched by exact, case-sensitive text against a CLOSED
   * frontmatter block's body; an unterminated `---` is not frontmatter and its
   * headings are addressable like any other content.
   *
   * This is a plain read and takes no lock. Pairing it with `setSection` is
   * therefore last-writer-wins across the two calls — use `transformNote` with
   * `extractHeadings` when a concurrent writer must not be lost.
   *
   * @param path Vault-relative path to the `.md` file.
   * @param heading Exact heading text, without the leading `#` characters.
   * @returns The section body, verbatim, or `''` when the section is empty.
   * @throws {@link MdVaultError} `NOT_FOUND` if the file does not exist,
   * `NO_MATCH` if no heading has that text, or `AMBIGUOUS_MATCH` if more than
   * one does — drop to {@link extractHeadings} to disambiguate.
   */
  readSection(path: string, heading: string): Promise<string>;
  /**
   * Whether a note exists at `path` — the non-throwing probe that turns the
   * create-or-update dance into a plain branch instead of a `try`/`catch` on
   * `ALREADY_EXISTS`. Checked against the READ allowlist.
   * @param path Vault-relative path to the `.md` file.
   * @returns `true` if a file is present, `false` if not.
   * @throws {@link MdVaultError} `NOT_MARKDOWN` if `path` is not a `.md` path,
   * or `ALLOWLIST_VIOLATION` if it is outside the read scope — an unreadable
   * path is a caller bug, not an absent note.
   */
  exists(path: string): Promise<boolean>;
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
   * Mutate a note's body, leaving any frontmatter block verbatim: `append` and
   * `prepend` add text at either end (both create the note when it is absent),
   * `setBody` replaces the body wholesale, `editByMatch` replaces a single
   * unique substring, and `setSection` replaces the body under one heading.
   * @throws {@link MdVaultError} `NO_MATCH` / `AMBIGUOUS_MATCH` for
   * `editByMatch` and `setSection`, `REFUSE_CREATE` when `setBody` targets a
   * missing note, or `VALIDATION_ERROR` when a `setSection` body would
   * restructure the document outside its own section.
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
   * A `null` or `undefined` return is a no-op; a return byte-identical to the
   * current content is also a no-op (no rewrite, no reindex) → `'unchanged'`.
   * @throws {@link MdVaultError} `REFUSE_CREATE` if asked to write a missing
   * file, `MTIME_CONFLICT` if a concurrent writer keeps winning past the retry
   * budget, or `COMMIT_FAILED` if the write-through index update or the
   * `onCommit` hook throws.
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
  /**
   * Move a note to a new vault-relative path, byte-for-byte: the content and
   * its frontmatter are carried over untouched, and the index row follows to
   * the new path. Both ends are allowlist- and containment-checked; the
   * destination is never clobbered. Runs under BOTH per-file locks, so a
   * concurrent write to either end serializes against it.
   * @param from Vault-relative path of the note to move.
   * @param to Vault-relative destination path (must be a free `.md` path).
   * @throws {@link MdVaultError} `VALIDATION_ERROR` if `from` and `to` resolve
   * to the same note, `NOT_FOUND` if `from` does not exist, `ALREADY_EXISTS`
   * if `to` is taken (the source is left in place), or `MTIME_CONFLICT` if the
   * source changed mid-move (the destination is rolled back).
   */
  moveNote(from: string, to: string): Promise<void>;
};
