import { parse } from 'yaml';

import type { ParsedFrontmatter } from './models/parsed-frontmatter.ts';
import { deriveTags } from './tags.ts';
import { isFlatFrontmatter, isStorableFrontmatter } from './validate.ts';

type Block = { yaml: string; body: string };

export function extractBlock(content: string): Block | null {
  const firstNl = content.indexOf('\n');
  if (firstNl === -1) {
    return null;
  }
  if (content.slice(0, firstNl).replace(/\r$/, '') !== '---') {
    return null;
  }
  const lines = content.slice(firstNl + 1).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].replace(/\r$/, '') === '---') {
      const yaml = lines.slice(0, i).join('\n');
      const body = lines.slice(i + 1).join('\n');

      return { yaml, body };
    }
  }

  return null;
}

/**
 * Parse the YAML frontmatter from a markdown file's raw content string.
 * Handles files with no frontmatter, empty blocks, invalid YAML, and nested
 * blocks. Never throws.
 *
 * A nested block is **read**: its keys come back and are indexed, and `valid`
 * is `'nested'` rather than `'flat'` to say that {@link editFrontmatter} will
 * refuse it. Only a block that cannot be stored at all — unparseable, a
 * non-map root, or holding a cycle, a non-finite number, or nesting deep
 * enough to overflow the serializer — comes back empty.
 *
 * @param content Raw UTF-8 content of a markdown file.
 * @returns A {@link ParsedFrontmatter} with the parsed key-value map, tag
 * tokens, body text, and a {@link FrontmatterValidity} descriptor.
 *
 * @example
 * ```ts
 * const { frontmatter, tags, body, valid } = parseFrontmatter(fileContent);
 * if (valid === 'flat') { // safe to pass to editFrontmatter }
 * if (valid === 'nested') { // read frontmatter, but do not edit it }
 * ```
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const block = extractBlock(content);
  if (!block) {
    return { frontmatter: {}, tags: [], body: content, valid: 'none' };
  }
  const { yaml: yamlText, body } = block;
  let parsed: unknown;
  try {
    parsed = parse(yamlText, { uniqueKeys: false });
  } catch {
    return { frontmatter: {}, tags: [], body, valid: 'present-but-invalid' };
  }
  if (parsed === null || parsed === undefined) {
    return { frontmatter: {}, tags: [], body, valid: 'flat' };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { frontmatter: {}, tags: [], body, valid: 'present-but-invalid' };
  }
  const frontmatter = parsed as Record<string, unknown>;
  // projectRow stringifies whatever this returns without consulting `valid`, so
  // a cyclic anchor-built block would throw out of indexNote and abort the sweep.
  if (!isStorableFrontmatter(frontmatter)) {
    return { frontmatter: {}, tags: [], body, valid: 'present-but-invalid' };
  }

  return {
    frontmatter,
    tags: deriveTags(frontmatter),
    body,
    // Nested is readable and indexed; only `'flat'` promises it is editable.
    valid: isFlatFrontmatter(frontmatter) ? 'flat' : 'nested',
  };
}
