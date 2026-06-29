import type { Database } from 'bun:sqlite';

import { MdVaultError } from '@/errors.ts';
import {
  type EditOutcome,
  editFrontmatter as fmEditFrontmatter,
  parseFrontmatter,
} from '@/frontmatter/index.ts';
import { exclusiveCreate, statSig } from '@/fs-atomic/index.ts';
import {
  type CommitEvent,
  type CrossLock,
  withFileDelete,
  withFileTransform,
} from '@/locked-file/index.ts';
import { withCrossProcessLock, withFileLock } from '@/locks/index.ts';
import { dropNote, type IndexConfig, indexNote } from '@/note-index/index.ts';
import type { createQuery } from '@/query/index.ts';
import type { VaultIo } from '@/vault-io/index.ts';

import type { NotesApi } from './models/notes-api.ts';
import type { ReadNoteResult } from './models/read-note-result.ts';
import type { TransformOutcome } from './models/transform-outcome.ts';
import type { UpdateOp } from './models/update-op.ts';

export type NotesDeps = {
  db: Database;
  vaultIo: VaultIo;
  cfg: IndexConfig;
  query: ReturnType<typeof createQuery>;
  onCommit?: (e: CommitEvent) => void | Promise<void>;
  cross?: CrossLock | false;
};

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }

  return count;
}

export function createNotes(deps: NotesDeps): NotesApi {
  const { db, vaultIo, cfg, query, onCommit, cross = false } = deps;

  async function readNote(
    path: string,
    opts?: { withLinks?: boolean },
  ): Promise<ReadNoteResult> {
    const read = await vaultIo.readVaultFile(path);
    if (!read) {
      throw new MdVaultError('NOT_FOUND', `note not found: ${path}`);
    }
    const parsed = parseFrontmatter(read.content);
    const result: ReadNoteResult = {
      frontmatter: parsed.frontmatter,
      tags: parsed.tags,
      body: parsed.body,
      valid: parsed.valid,
    };
    if (opts?.withLinks) {
      result.outbound = query.outboundLinks(path);
      result.backlinks = query.backlinks(path);
    }

    return result;
  }

  function runLocked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const locked = () => withFileLock(key, fn);
    if (cross) {
      return withCrossProcessLock(
        cross.lockDir,
        key,
        cross.busyTimeoutMs,
        locked,
      );
    }

    return locked();
  }

  // The write-path resolve trio shared by every mutator: the absolute fs path,
  // the case-folded lock/serialization key, and the display path for commits —
  // canonicalized once by vault-io rather than three times.
  function resolveForWrite(path: string): {
    full: string;
    key: string;
    display: string;
  } {
    const { full, key, relative } = vaultIo.resolveWriteTarget(path);

    return { full, key, display: relative };
  }

  function buildContent(input: {
    frontmatter?: Record<string, unknown>;
    body: string;
  }): string {
    const fm = input.frontmatter;
    if (!fm || Object.keys(fm).length === 0) {
      return input.body;
    }
    const res = fmEditFrontmatter(input.body, (view) => {
      for (const [k, v] of Object.entries(fm)) {
        view[k] = v;
      }
    });
    if (res.outcome === 'unverifiable') {
      throw new MdVaultError(
        'FRONTMATTER_INVALID',
        `frontmatter is not flat: ${Object.keys(fm).join(', ')}`,
      );
    }

    return res.content;
  }

  async function createNote(
    path: string,
    input: { frontmatter?: Record<string, unknown>; body: string },
  ): Promise<void> {
    const content = buildContent(input);
    const { full, key, display } = resolveForWrite(path);
    await runLocked(key, async () => {
      // exclusiveCreate (temp + link) → ALREADY_EXISTS on clash, never clobbers.
      const sig = await exclusiveCreate(full, content);
      // Write-through: index in the SAME lock with the post-create sig.
      indexNote(db, vaultIo, cfg, path, content, sig);
      if (onCommit) {
        try {
          await onCommit({ op: 'create', path: display, content });
        } catch (cause) {
          throw new MdVaultError(
            'COMMIT_FAILED',
            `onCommit failed for ${display}`,
            { cause },
          );
        }
      }
    });
  }

  // Write-through seam. withFileTransform/withFileDelete invoke this INSIDE the
  // per-file lock, AFTER the file write commits and BEFORE the consumer onCommit.
  // The index mutation therefore shares the same lock as the file write.
  const indexCommit = async (e: CommitEvent): Promise<void> => {
    if (e.op === 'delete') {
      dropNote(db, vaultIo.toKey(e.path));
    } else {
      const sig = await statSig(vaultIo.resolveVaultPath(e.path, 'write'));
      if (sig) {
        indexNote(db, vaultIo, cfg, e.path, e.content, sig);
      }
    }
    if (onCommit) {
      await onCommit(e);
    }
  };

  // Shared wiring for the transform-based mutators (updateNote, editFrontmatter,
  // transformNote): resolve → run under the per-file lock with write-through
  // indexing. Any change to the write-through seam lands here once, for all three.
  function transformLocked(
    path: string,
    transform: (current: string | null) => string | null,
    allowCreate: boolean,
  ) {
    const { full, key, display } = resolveForWrite(path);

    return withFileTransform(full, key, display, transform, {
      allowCreate,
      onCommit: indexCommit,
      cross,
    });
  }

  async function updateNote(path: string, op: UpdateOp): Promise<void> {
    const display = vaultIo.toVaultRelative(path);
    const transform = (current: string | null): string | null => {
      // updateNote targets the note body only; any frontmatter block is left
      // verbatim. parseFrontmatter's `body` is a byte-exact suffix of the raw
      // content, so `prefix` is exactly the frontmatter (empty when absent).
      const body = current === null ? null : parseFrontmatter(current).body;
      const prefix =
        current !== null && body !== null
          ? current.slice(0, current.length - body.length)
          : '';
      if ('append' in op) {
        // Boundary newline is keyed off the FULL preserved content (frontmatter
        // prefix + body), not the body alone: a frontmatter-only note with no
        // trailing newline (`---\n...\n---`) has an empty body but a non-empty
        // prefix ending in the closing fence. Counting only the body would weld
        // the appended text onto `---`, corrupting the fence.
        const existing = `${prefix}${body ?? ''}`;
        const needsNl = existing.length > 0 && !existing.endsWith('\n');

        return `${existing}${needsNl ? '\n' : ''}${op.append}`;
      }
      const { old, new: replacement } = op.editByMatch;
      if (body === null) {
        throw new MdVaultError(
          'NO_MATCH',
          `no match in missing file: ${display}`,
        );
      }
      const count = countOccurrences(body, old);
      if (count === 0) {
        throw new MdVaultError(
          'NO_MATCH',
          `no match for replacement in ${display}`,
        );
      }
      if (count > 1) {
        throw new MdVaultError(
          'AMBIGUOUS_MATCH',
          `ambiguous match (${count}) in ${display}`,
        );
      }
      const at = body.indexOf(old);

      return (
        prefix + body.slice(0, at) + replacement + body.slice(at + old.length)
      );
    };
    await transformLocked(path, transform, 'append' in op);
  }

  async function editFrontmatter(
    path: string,
    mutate: (fm: Record<string, unknown>) => void,
  ): Promise<EditOutcome> {
    let outcome: EditOutcome = 'unchanged';
    const transform = (current: string | null): string | null => {
      if (current === null) {
        outcome = 'unchanged';

        return null;
      }
      const res = fmEditFrontmatter(current, mutate);
      outcome = res.outcome;
      if (res.outcome === 'edited') {
        return res.content;
      }

      return null;
    };
    await transformLocked(path, transform, false);

    return outcome;
  }

  async function deleteNote(path: string): Promise<boolean> {
    const { full, key, display } = resolveForWrite(path);
    const { deleted } = await withFileDelete(full, key, display, {
      onCommit: indexCommit,
      cross,
    });

    return deleted;
  }

  async function transformNote(
    path: string,
    transform: (current: string | null) => string | null,
  ): Promise<TransformOutcome> {
    // Coerce a forgotten/implicit `undefined` return (a JS consumer omitting
    // `return null`) into a no-op, rather than letting it fall through to the
    // write path and throw a raw TypeError with no MdVaultCode.
    const safe = (current: string | null): string | null =>
      transform(current) ?? null;
    const res = await transformLocked(path, safe, false);

    switch (res.outcome) {
      case 'unchanged':
        return 'unchanged';
      // `created` is unreachable with allowCreate:false; the exhaustive switch
      // forces a compile error if TransformResult.outcome ever grows a case.
      case 'created':
      case 'updated':
        return 'edited';
    }
  }

  return {
    readNote,
    createNote,
    updateNote,
    editFrontmatter,
    deleteNote,
    transformNote,
  };
}
