import type { Backlink } from './backlink.ts';
import type { NoteHit } from './note-hit.ts';
import type { QueryOrder } from './order.ts';
import type { OutboundLink } from './outbound-link.ts';
import type { SearchHit } from './search-hit.ts';
import type { WhereMap } from './where-map.ts';

/**
 * The read-only query surface over the derived SQLite index, exposed as
 * `vault.query`. Results are always filtered to notes the vault instance is
 * allowed to read.
 */
export interface QueryApi {
  /**
   * Filter notes by tag, frontmatter field, and/or folder, with ordering and
   * pagination. Defaults to newest-first (`mtime_ms` desc), limit 100.
   */
  queryNotes(opts?: {
    tag?: string;
    where?: WhereMap;
    folder?: string;
    orderBy?: QueryOrder;
    limit?: number;
    offset?: number;
  }): NoteHit[];
  /**
   * Notes that link to `path` via `[[wikilink]]` or relative-link resolution.
   */
  backlinks(
    path: string,
    opts?: { limit?: number; offset?: number },
  ): Backlink[];
  /**
   * Links out of `path`, each with its `resolved` target (or `null` if the
   * link dangles).
   */
  outboundLinks(
    path: string,
    opts?: { limit?: number; offset?: number },
  ): OutboundLink[];
  /**
   * FTS5 keyword search over note bodies, returning highlighted snippets.
   */
  searchText(
    q: string,
    opts?: { tag?: string; folder?: string; limit?: number; offset?: number },
  ): SearchHit[];
}
