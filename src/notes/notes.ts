import type { Database } from 'bun:sqlite';
import { stat } from 'node:fs/promises';

import { MdVaultError } from '@/errors.ts';
import {
  assertFlatFrontmatter,
  type EditOutcome,
  editFrontmatter as fmEditFrontmatter,
  parseFrontmatter,
} from '@/frontmatter/index.ts';
import { exclusiveCreate, statSig } from '@/fs-atomic/index.ts';
import {
  createFenceTracker,
  extractHeadings,
  type Heading,
  hasUnclosedFence,
} from '@/headings/index.ts';
import {
  type CommitEvent,
  type CrossLock,
  withFileDelete,
  withFileMove,
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

/** A line shaped like a setext underline — whether it is one depends on what precedes it. */
const UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
/** `***`, `---` or `___`, three or more, spaced or not — never paragraph text. */
const THEMATIC_BREAK =
  /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;

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

  async function readSection(path: string, heading: string): Promise<string> {
    const read = await vaultIo.readVaultFile(path);
    if (!read) {
      throw new MdVaultError('NOT_FOUND', `note not found: ${path}`);
    }
    // Match against the body only, so a `#` comment inside a CLOSED frontmatter
    // block cannot be addressed. An unterminated `---` is not frontmatter at
    // all — parseFrontmatter returns the whole file as body — and stays
    // addressable, exactly as it does for setBody/append/prepend.
    const { body } = parseFrontmatter(read.content);
    const target = locateSection(body, heading, vaultIo.toVaultRelative(path));

    return body.slice(target.bodyStart, target.end);
  }

  async function exists(path: string): Promise<boolean> {
    // resolveVaultPath keeps the NOT_MARKDOWN / ALLOWLIST_VIOLATION contract;
    // any stat failure just means "no note here" and must not escape as a raw
    // errno, and isFile() rejects a DIRECTORY named `x.md`.
    const full = vaultIo.resolveVaultPath(path, 'read');
    const info = await stat(full).catch(() => null);

    return info?.isFile() ?? false;
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

  function buildContent(input: {
    frontmatter?: Record<string, unknown>;
    body: string;
  }): string {
    const fm = input.frontmatter;
    if (!fm || Object.keys(fm).length === 0) {
      return input.body;
    }
    // Validate the caller-supplied frontmatter up front, naming only the
    // offending keys (shared with serializeFrontmatter's guard).
    assertFlatFrontmatter(fm);
    const res = fmEditFrontmatter(input.body, (view) => {
      for (const [k, v] of Object.entries(fm)) {
        view[k] = v;
      }
    });
    if (res.outcome === 'unverifiable') {
      // fm is valid (asserted above), so the body itself carries an invalid
      // frontmatter block.
      throw new MdVaultError(
        'FRONTMATTER_INVALID',
        'note body has an invalid frontmatter block',
      );
    }

    return res.content;
  }

  function locateSection(
    body: string,
    heading: string,
    display: string,
  ): Heading {
    const hits = extractHeadings(body).filter((h) => h.text === heading);
    if (hits.length === 0) {
      throw new MdVaultError(
        'NO_MATCH',
        `no heading "${heading}" in ${display}`,
      );
    }
    if (hits.length > 1) {
      throw new MdVaultError(
        'AMBIGUOUS_MATCH',
        `ambiguous heading "${heading}" (${hits.length} matches) in ${display}`,
      );
    }
    // A section whose span reaches an unterminated fence has no defined end:
    // per CommonMark the fence runs to EOF, so the "section" is the rest of the
    // file — every later heading included. Reading it would hand back content
    // the author never meant as this section, and replacing it would delete
    // that content outright. Refusing both keeps the read → write round trip
    // honest: every section this API returns can be written straight back.
    if (hasUnclosedFence(body.slice(0, hits[0].end))) {
      throw new MdVaultError(
        'VALIDATION_ERROR',
        `section "${heading}" runs into an unterminated code fence in ${display}; close the fence or use transformNote`,
      );
    }

    return hits[0];
  }

  /** The heading texts that appear more than once — i.e. are unaddressable. */
  function duplicateHeadings(md: string): Set<string> {
    const texts = extractHeadings(md).map((h) => h.text);

    return new Set(texts.filter((t, i) => texts.indexOf(t) !== i));
  }

  /**
   * The text a setext underline (`===` / `---`) would turn into a heading, or
   * `null`. `extractHeadings` is ATX-only, so the level guard cannot see these.
   */
  function setextHeading(md: string): string | null {
    const tracker = createFenceTracker();
    let previous = '';
    for (const raw of md.split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (tracker.inFence(line)) {
        previous = '';
        continue;
      }
      if (UNDERLINE.test(line) && underlinesParagraph(previous, line)) {
        return previous.trim();
      }
      previous = line;
    }

    return null;
  }

  /**
   * Whether an underline-shaped `line` really underlines `previous`. CommonMark
   * makes `===` / `---` a heading only after a PARAGRAPH; after a heading, a
   * thematic break, a block quote or a list item it is an ordinary thematic
   * break. What cannot be decided line-by-line fails CLOSED — an indented
   * `previous` may be a lazy paragraph continuation or a code block, and an
   * ordered marker other than `1.` cannot interrupt a paragraph, so both stay
   * headings here.
   */
  function underlinesParagraph(previous: string, line: string): boolean {
    if (previous.trim() === '') {
      return false;
    }
    // None of these is ever paragraph text. A block quote ends here too: an
    // underline cannot be a lazy continuation, so it closes the quote.
    if (
      /^ {0,3}(?:#{1,6}(?:[ \t]|$)|>)/.test(previous) ||
      THEMATIC_BREAK.test(previous)
    ) {
      return false;
    }
    // A bullet, or an ordered marker numbered 1, always opens a list item —
    // even mid-paragraph. The underline then belongs to the item's own
    // paragraph only if it is indented into the item's content. Take the
    // SHALLOWEST content column the marker could have, so a near miss keeps
    // treating the line as a heading.
    const item = /^( {0,3})([-*+]|1[.)])[ \t]+\S/.exec(previous);
    if (item) {
      return line.search(/[^ ]/) >= item[1].length + item[2].length + 1;
    }

    return true;
  }

  function assertPayloadFits(
    payload: string,
    level: number,
    display: string,
  ): void {
    // extractHeadings is fence-aware, so a heading hidden inside a CLOSED fence
    // is not a heading here — and stays hidden once written.
    const inner = extractHeadings(payload).find((h) => h.level <= level);
    if (inner) {
      throw new MdVaultError(
        'VALIDATION_ERROR',
        `setSection body has a level-${inner.level} heading "${inner.text}", which would end the target section in ${display}`,
      );
    }
    const setext = setextHeading(payload);
    if (setext !== null) {
      throw new MdVaultError(
        'VALIDATION_ERROR',
        `setSection body has a setext heading "${setext}", which would end the target section in ${display}`,
      );
    }
    // Unconditional: an unclosed fence runs to EOF, so it swallows whatever
    // follows the section — and when nothing follows yet, it swallows whatever
    // a later append adds, and makes this very section unaddressable.
    if (hasUnclosedFence(payload)) {
      throw new MdVaultError(
        'VALIDATION_ERROR',
        `setSection body leaves a code fence unclosed in ${display}`,
      );
    }
  }

  /** The `setSection` rewrite, over a frontmatter-stripped body. */
  function replaceSection(
    body: string,
    op: { heading: string; body: string },
    display: string,
  ): string {
    const target = locateSection(body, op.heading, display);
    // A whitespace-only payload is the EMPTY payload: it is non-empty as a
    // string but blank as a line, so writing it would leave a section the next
    // call reads as empty and inserts BEFORE — growing the file on every write,
    // while readSection keeps answering ''.
    const next = op.body.trim() === '' ? '' : op.body;
    assertPayloadFits(next, target.level, display);
    // Emptying a section merges the blank run under the heading with the one
    // before the next heading; keeping both would widen the gap on every clear.
    const lineBreak = body.indexOf('\n', target.start);
    const afterHeading = lineBreak === -1 ? body.length : lineBreak + 1;
    const head = body.slice(0, next === '' ? afterHeading : target.bodyStart);
    const tail = body.slice(target.end);
    // Blank lines at either edge are boundary material, not payload text: the
    // span is LINE-shaped, so they are normalised as LINES (a horizontal-
    // whitespace-only match, agreeing with extractHeadings' `.trim()` blank
    // rule) rather than as lone `\n` characters — otherwise a payload with a
    // blank edge line migrates outside the span and grows the file on every
    // repeat of an identical call.
    const lead = next.replace(/^(?:[^\S\r\n]*\r?\n)+/, '');
    // Trailing blank lines collapse onto the newline that already terminates
    // the last non-blank line — CRLF stays CRLF, LF stays LF.
    const trimmed = lead.replace(
      /(\r?\n)(?:[^\S\r\n]*\r?\n)*[^\S\r\n]*$/,
      '$1',
    );
    // Match the terminator the replaced span itself carried, so a file keeps
    // its trailing newline — or its absence — wherever the section sits. An
    // EMPTY span carries no terminator of its own, so the question is what
    // follows: anything at all has to start on its own line, and at the end of
    // the file the file's own ending decides.
    const spanTerminated = tail !== '' || body.endsWith('\n');
    const text =
      lead === ''
        ? ''
        : spanTerminated && !trimmed.endsWith('\n')
          ? `${trimmed}\n`
          : trimmed;
    // A heading that is the file's last line has no newline of its own.
    const sep = text !== '' && !head.endsWith('\n') ? '\n' : '';
    const result = `${head}${sep}${text}${tail}`;
    // The level and setext guards stop the payload ENDING the target section;
    // this stops it colliding with a heading that already exists, which would
    // leave the caller locked out of its own section with AMBIGUOUS_MATCH.
    const before = duplicateHeadings(body);
    const collision = [...duplicateHeadings(result)].find(
      (text) => !before.has(text),
    );
    if (collision !== undefined) {
      throw new MdVaultError(
        'VALIDATION_ERROR',
        `setSection body would make the heading "${collision}" ambiguous in ${display}`,
      );
    }

    return result;
  }

  async function createNote(
    path: string,
    input: { frontmatter?: Record<string, unknown>; body: string },
  ): Promise<void> {
    const content = buildContent(input);
    const { full, key, relative: display } = vaultIo.resolveWriteTarget(path);
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
    const { full, key, relative: display } = vaultIo.resolveWriteTarget(path);

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
      // Both body-position writers below insert AFTER `prefix`, so they share
      // append's fence hazard from the other side: when the prefix is a
      // frontmatter block with no trailing newline, text placed straight after
      // it would weld onto the closing `---`.
      const fenceNl = prefix.length > 0 && !prefix.endsWith('\n') ? '\n' : '';
      if ('prepend' in op) {
        const rest = body ?? '';
        const sep = rest.length > 0 && !op.prepend.endsWith('\n') ? '\n' : '';

        return `${prefix}${fenceNl}${op.prepend}${sep}${rest}`;
      }
      if ('setBody' in op) {
        return `${prefix}${fenceNl}${op.setBody}`;
      }
      if ('setSection' in op) {
        // No fenceNl guard needed here: a frontmatter block with no trailing
        // newline parses to an empty body, an empty body has no headings, and
        // that is NO_MATCH below before anything is written.
        if (body === null) {
          throw new MdVaultError(
            'NO_MATCH',
            `no section in missing file: ${display}`,
          );
        }

        return `${prefix}${replaceSection(body, op.setSection, display)}`;
      }
      const { old, new: replacement } = op.editByMatch;
      if (body === null) {
        throw new MdVaultError(
          'NO_MATCH',
          `no match in missing file: ${display}`,
        );
      }
      const count = old.length === 0 ? 0 : body.split(old).length - 1;
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
    // Only the two additive ops create a missing note; setBody and editByMatch
    // need something to act on (REFUSE_CREATE / NO_MATCH respectively).
    await transformLocked(path, transform, 'append' in op || 'prepend' in op);
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
    const { full, key, relative: display } = vaultIo.resolveWriteTarget(path);
    const { deleted } = await withFileDelete(full, key, display, {
      onCommit: indexCommit,
      cross,
    });

    return deleted;
  }

  async function moveNote(from: string, to: string): Promise<void> {
    // Both ends go through resolveWriteTarget: containment, allowlist and the
    // .md requirement are enforced on the destination too, not just the source.
    await withFileMove(
      vaultIo.resolveWriteTarget(from),
      vaultIo.resolveWriteTarget(to),
      { onCommit: indexCommit, cross },
    );
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
    readSection,
    exists,
    createNote,
    updateNote,
    editFrontmatter,
    deleteNote,
    moveNote,
    transformNote,
  };
}
