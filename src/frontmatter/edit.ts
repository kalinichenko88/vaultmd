import { Document, parseDocument } from 'yaml';

import { extractBlock, parseFrontmatter } from './parse.ts';
import type { EditOutcome } from './types.ts';
import { isFlatFrontmatter } from './validate.ts';

export function editFrontmatter(
  content: string,
  mutate: (fm: Record<string, unknown>) => void,
): { content: string; outcome: EditOutcome } {
  const parsed = parseFrontmatter(content);
  if (parsed.valid === 'present-but-invalid') {
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
    const block = String(new Document(view)).replace(/\n$/, '');

    return { content: `---\n${block}\n---\n${content}`, outcome: 'edited' };
  }
  const ext = extractBlock(content);
  if (!ext) {
    return { content, outcome: 'unverifiable' };
  }
  const doc = parseDocument(ext.yaml, { uniqueKeys: false });
  const before = (doc.toJS() ?? {}) as Record<string, unknown>;
  const view = structuredClone(before);
  mutate(view);
  if (!isFlatFrontmatter(view)) {
    return { content, outcome: 'unverifiable' };
  }
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
  const serialized = String(doc);
  const block = serialized.endsWith('\n')
    ? serialized.slice(0, -1)
    : serialized;

  return { content: `---\n${block}\n---\n${ext.body}`, outcome: 'edited' };
}
