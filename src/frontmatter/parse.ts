import { parse } from 'yaml';

import type { ParsedFrontmatter } from './models/parsed-frontmatter.ts';
import { deriveTags } from './tags.ts';
import { isValidFrontmatter, keepValidKeys } from './validate.ts';

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
 * Handles files with no frontmatter, empty blocks, invalid YAML, and
 * round-trippable vs. non-round-trippable blocks. Never throws.
 *
 * @param content Raw UTF-8 content of a markdown file.
 * @returns A {@link ParsedFrontmatter} with the parsed key-value map, tag
 * tokens, body text, and a {@link FrontmatterValidity} descriptor.
 *
 * @example
 * ```ts
 * const { frontmatter, tags, body, valid } = parseFrontmatter(fileContent);
 * if (valid === 'valid') { // safe to pass to editFrontmatter }
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
    return { frontmatter: {}, tags: [], body, valid: 'valid' };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { frontmatter: {}, tags: [], body, valid: 'present-but-invalid' };
  }
  const frontmatter = parsed as Record<string, unknown>;
  if (isValidFrontmatter(frontmatter)) {
    return {
      frontmatter,
      tags: deriveTags(frontmatter),
      body,
      valid: 'valid',
    };
  }

  // Some value here cannot round-trip. Report the rest anyway: one `.nan` or
  // stray `!!python/object` should cost the reader that key, not the note's
  // tags and title as well. Filtering rather than returning the parsed map is
  // load-bearing, not tidiness — an anchor-built block can be cyclic, and
  // projectRow stringifies whatever this returns without consulting `valid`.
  const usable = keepValidKeys(frontmatter);

  return {
    frontmatter: usable,
    tags: deriveTags(usable),
    body,
    valid: 'present-but-invalid',
  };
}
