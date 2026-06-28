import { parse } from 'yaml';

import type { FrontmatterValidity } from './models/frontmatter-validity.ts';
import type { ParsedFrontmatter } from './models/parsed-frontmatter.ts';
import { deriveTags } from './tags.ts';
import { isFlatFrontmatter } from './validate.ts';

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
  const valid: FrontmatterValidity = isFlatFrontmatter(frontmatter)
    ? 'flat'
    : 'present-but-invalid';

  return { frontmatter, tags: deriveTags(frontmatter), body, valid };
}
