import { type Document, isMap, isScalar, parseDocument } from 'yaml';

import { MdVaultError } from '@/errors.ts';

import type { EditOutcome } from './models/edit-outcome.ts';
import { extractBlock, parseFrontmatter } from './parse.ts';
import { buildFrontmatterBlock, emitFrontmatterBlock } from './serialize.ts';
import { isFlatFrontmatter } from './validate.ts';

/**
 * Apply a mutator callback to a note's frontmatter and return the rewritten
 * file content. Preserves the existing YAML structure and only writes back
 * changed keys. If the existing frontmatter cannot round-trip, or the mutation
 * would produce a value that cannot, the file is left untouched and `outcome`
 * is `'unverifiable'`.
 *
 * @param content Raw UTF-8 content of the markdown file.
 * @param mutate  Callback that receives a mutable copy of the frontmatter
 *   object. Add, update, or delete keys in place.
 * @returns Object with the updated `content` string and an {@link EditOutcome}
 *   describing whether the frontmatter was changed.
 *
 * @example
 * ```ts
 * const { content: updated, outcome } = editFrontmatter(raw, (fm) => {
 *   fm.status = 'done';
 * });
 * ```
 */
export function editFrontmatter(
  content: string,
  mutate: (fm: Record<string, unknown>) => void,
): {
  /** The rewritten file content (identical to input when `outcome` is not `'edited'`). */
  content: string;
  /** Whether the mutation produced a change, no change, or was skipped. */
  outcome: EditOutcome;
} {
  const parsed = parseFrontmatter(content);
  // Refused BEFORE the mutator runs, not after. A post-mutation flatness check
  // is not the same rule: a mutator that deletes the nested key, or replaces it
  // with a scalar, leaves a flat view — and the block would then be re-emitted
  // whole, flattening an author's untouched `|` scalar on the way past. Only
  // `'flat'` is editable; a nested note is read through `parseFrontmatter` and
  // rewritten, if at all, through `transformNote`.
  if (parsed.valid === 'present-but-invalid' || parsed.valid === 'nested') {
    return { content, outcome: 'unverifiable' };
  }
  if (parsed.valid === 'none') {
    const view: Record<string, unknown> = {};
    mutate(view);
    if (!isFlatFrontmatter(view)) {
      return { content, outcome: 'unverifiable' };
    }
    if (Object.keys(view).length === 0) {
      return { content, outcome: 'unchanged' };
    }

    return {
      content: `${buildFrontmatterBlock(view)}${content}`,
      outcome: 'edited',
    };
  }
  const ext = extractBlock(content);
  if (!ext) {
    return { content, outcome: 'unverifiable' };
  }
  const doc = parseDocument(ext.yaml, { uniqueKeys: false });
  dropShadowedKeys(doc);
  // dropShadowedKeys can orphan an alias; toJS then throws a raw ReferenceError.
  let before: Record<string, unknown>;
  try {
    before = (doc.toJS() ?? {}) as Record<string, unknown>;
  } catch {
    return { content, outcome: 'unverifiable' };
  }
  const view = structuredClone(before);
  mutate(view);
  if (!isFlatFrontmatter(view)) {
    return { content, outcome: 'unverifiable' };
  }
  // doc.delete / doc.set can remove the pair that OWNS an anchor, orphaning
  // every `*ref` to it — yaml then refuses to emit and throws a raw, code-less
  // error out of a function documented never to throw for bad frontmatter. The
  // value graph cannot see this coming: last-wins resolution leaves one live
  // reference, so `parseFrontmatter` reports the note as `'valid'`.
  //
  // Only a removal or a type change orphans an anchor; yaml rewrites a scalar
  // in place, so `x: &a hi` -> `x: &a bye` keeps working, and so does an edit
  // that never touches the anchor-owning key.
  try {
    let changed = false;
    for (const key of Object.keys(before)) {
      if (!(key in view)) {
        doc.delete(key);
        changed = true;
      }
    }
    for (const key of Object.keys(view)) {
      if (
        !(key in before) ||
        JSON.stringify(before[key]) !== JSON.stringify(view[key])
      ) {
        doc.set(key, view[key]);
        changed = true;
      }
    }
    if (!changed) {
      return { content, outcome: 'unchanged' };
    }

    return {
      content: `${emitFrontmatterBlock(doc)}${ext.body}`,
      outcome: 'edited',
    };
  } catch (error) {
    // Our own coded failures keep their code rather than being flattened into
    // an outcome — a caller switching on `.code` must still see them.
    if (error instanceof MdVaultError) {
      throw error;
    }

    return { content, outcome: 'unverifiable' };
  }
}

// A note may legally repeat a key (`uniqueKeys: false`), and every reader of one
// is last-wins. `doc.set`/`doc.delete` address the FIRST pair, so without this
// an edit lands where nothing reads it and vanishes on the next parse.
function dropShadowedKeys(doc: Document): void {
  if (!isMap(doc.contents)) {
    return;
  }
  const keys = doc.contents.items.map((p) =>
    isScalar(p.key) ? p.key.value : p.key,
  );
  doc.contents.items = doc.contents.items.filter(
    (_, i) => keys.lastIndexOf(keys[i]) === i,
  );
}
