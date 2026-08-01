import {
  type Document,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  visit,
} from 'yaml';

import type { EditOutcome } from './models/edit-outcome.ts';
import { extractBlock, parseFrontmatter } from './parse.ts';
import {
  buildFrontmatterBlock,
  emitFrontmatterBlock,
  quoteMultilineStrings,
} from './serialize.ts';
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
  if (hasContainerAlias(doc)) {
    return { content, outcome: 'unverifiable' };
  }
  dropShadowedKeys(doc);
  const before = (doc.toJS() ?? {}) as Record<string, unknown>;
  const view = structuredClone(before);
  mutate(view);
  if (!isValidFrontmatter(view)) {
    return { content, outcome: 'unverifiable' };
  }
  if (!applyDiff(doc, [], before, view)) {
    return { content, outcome: 'unchanged' };
  }

  return {
    content: `${emitFrontmatterBlock(doc)}${ext.body}`,
    outcome: 'edited',
  };
}

// Is `a` the same value as `b`, structurally? Map key ORDER is not part of the
// answer: a mutator that rebuilds a map from its own fields — the shape the
// recipes guide suggests — reorders keys without changing anything, and
// treating that as an edit would rewrite every note in the vault on every run.
// Arrays stay order-sensitive, where order is meaning.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null
  ) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => deepEqual(item, b[i]))
    );
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);

  return (
    aKeys.length === bKeys.length &&
    aKeys.every(
      (key) =>
        key in b &&
        deepEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        ),
    )
  );
}

// Writes the difference between `before` and `after` into `doc` at `path`,
// descending into maps so only the leaves that actually changed are touched.
// Setting a whole node instead would re-emit its entire subtree from the plain
// JS clone, discarding every comment, anchor and scalar style underneath it —
// an author's `# why this value` and their `|` blocks would vanish from a note
// whose only edit was one sibling key.
//
// Arrays are set whole: yaml has no stable identity for a moved element, so a
// per-index diff would mangle an insertion rather than preserve anything.
//
// @returns whether anything was written.
function applyDiff(
  doc: Document,
  path: string[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  let changed = false;
  for (const key of Object.keys(before)) {
    if (!(key in after)) {
      doc.deleteIn([...path, key]);
      changed = true;
    }
  }
  for (const key of Object.keys(after)) {
    const next = [...path, key];
    const prev = before[key];
    const value = after[key];
    if (!(key in before)) {
      setStyled(doc, next, value);
      changed = true;
      continue;
    }
    if (deepEqual(prev, value)) {
      continue;
    }
    if (isPlainMap(prev) && isPlainMap(value)) {
      changed = applyDiff(doc, next, prev, value) || changed;
      continue;
    }
    setStyled(doc, next, value);
    changed = true;
  }

  return changed;
}

// doc.setIn with the raw value, but with the node built first so its scalar
// style can be pinned before it lands. Only what this write creates is
// restyled — nodes elsewhere in the note keep the shape their author gave them.
function setStyled(doc: Document, path: string[], value: unknown): void {
  const node = doc.createNode(value);
  quoteMultilineStrings(node);
  doc.setIn(path, node);
}

function isPlainMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Whether the block anchors a map or a sequence and refers to it by alias.
// Such a note cannot be edited a key at a time: `doc.set` on the pair owning
// the anchor orphans every `*ref` to it and yaml then refuses to emit, throwing
// a raw, code-less error; mutating the container in place instead unrolls the
// alias into independent copies, silently losing it. Neither is an edit anyone
// asked for, so the note is left alone.
//
// Scalar anchors are deliberately allowed — `doc.set` rewrites the value and
// keeps the anchor, so nothing is lost. This also covers the case a value-graph
// check cannot see: a duplicate top-level key can shadow the pair carrying the
// anchor, and last-wins resolution then leaves no repeated reference behind.
function hasContainerAlias(doc: Document): boolean {
  let found = false;
  visit(doc, {
    Alias(_key, node) {
      const target = node.resolve(doc);
      if (isMap(target) || isSeq(target)) {
        found = true;

        return visit.BREAK;
      }
    },
  });

  return found;
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
