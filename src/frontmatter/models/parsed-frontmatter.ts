import type { FrontmatterValidity } from './frontmatter-validity.ts';

/** The structured result returned by {@link parseFrontmatter}. */
export type ParsedFrontmatter = {
  /** The parsed YAML key-value pairs, or an empty object when absent/invalid. */
  frontmatter: Record<string, unknown>;
  /** Normalised tag tokens extracted from `tags`/`tag` frontmatter keys. */
  tags: string[];
  /** The note body: everything after the closing `---` fence, or the full file content when there is no frontmatter. */
  body: string;
  /** Whether the frontmatter block is flat-safe, present but unsafe, or absent. */
  valid: FrontmatterValidity;
};
