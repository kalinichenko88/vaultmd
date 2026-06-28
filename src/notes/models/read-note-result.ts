import type { FrontmatterValidity } from '@/frontmatter/index.ts';
import type { Backlink, OutboundLink } from '@/query/index.ts';

/** The structured result returned by {@link NotesApi.readNote}. */
export type ReadNoteResult = {
  /** The parsed YAML frontmatter key-value map (empty object when absent or invalid). */
  frontmatter: Record<string, unknown>;
  /** Normalised tag tokens extracted from frontmatter. */
  tags: string[];
  /** The note body: everything after the closing `---` fence. */
  body: string;
  /** Whether the frontmatter block is flat-safe, present but unsafe, or absent. */
  valid: FrontmatterValidity;
  /** Outbound links from this note (only populated when `withLinks: true`). */
  outbound?: OutboundLink[];
  /** Notes that link back to this note (only populated when `withLinks: true`). */
  backlinks?: Backlink[];
};
