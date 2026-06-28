import type { FrontmatterValidity } from './frontmatter-validity.ts';

export type ParsedFrontmatter = {
  frontmatter: Record<string, unknown>;
  tags: string[];
  body: string;
  valid: FrontmatterValidity;
};
