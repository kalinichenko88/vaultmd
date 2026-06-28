import type { FrontmatterValidity } from '@/frontmatter/index.ts';
import type { Backlink, OutboundLink } from '@/query/index.ts';

export type ReadNoteResult = {
  frontmatter: Record<string, unknown>;
  tags: string[];
  body: string;
  valid: FrontmatterValidity;
  outbound?: OutboundLink[];
  backlinks?: Backlink[];
};
