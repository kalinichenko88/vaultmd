import { type Document, isMap, isScalar, parseDocument } from 'yaml';

import type { EditOutcome } from './models/edit-outcome.ts';
import { extractBlock, parseFrontmatter } from './parse.ts';
import { buildFrontmatterBlock, emitFrontmatterBlock } from './serialize.ts';
import { isValidFrontmatter } from './validate.ts';

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
  if (parsed.valid === 'present-but-invalid') {
    return { content, outcome: 'unverifiable' };
  }
  if (parsed.valid === 'none') {
    const view: Record<string, unknown> = {};
    mutate(view);
    if (!isValidFrontmatter(view)) {
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
  // A duplicate top-level key can shadow the pair carrying a YAML anchor
  // (dropShadowedKeys just removed it above) while the parsed object still
  // held a live, unshared reference through an alias elsewhere — the one case
  // isValidFrontmatter's shared-reference check cannot see, because last-wins
  // resolution during `parse()` leaves no repeat behind. toJS() then can't
  // resolve the now-orphaned alias and throws a raw, code-less ReferenceError.
  let before: Record<string, unknown>;
  try {
    before = (doc.toJS() ?? {}) as Record<string, unknown>;
  } catch {
    return { content, outcome: 'unverifiable' };
  }
  const view = structuredClone(before);
  mutate(view);
  if (!isValidFrontmatter(view)) {
    return { content, outcome: 'unverifiable' };
  }
  // doc.set below can orphan an anchor the same way (replacing the pair that
  // owns it), which only surfaces when the result is emitted — same raw-throw
  // risk, guarded the same way.
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
  } catch {
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
