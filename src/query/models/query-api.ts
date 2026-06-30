import type { Backlink } from './backlink.ts';
import type { NoteHit } from './note-hit.ts';
import type { QueryOrder } from './order.ts';
import type { OutboundLink } from './outbound-link.ts';
import type { SearchHit } from './search-hit.ts';
import type { TagInfo } from './tag-info.ts';
import type { WhereMap } from './where-map.ts';

/**
 * The read-only query surface over the derived SQLite index, exposed as
 * `vault.query`. Results are always filtered to notes the vault instance is
 * allowed to read.
 */
export type QueryApi = {
  /**
   * Filter notes by tag, frontmatter field, and/or folder, with ordering and
   * pagination. Defaults to newest-first (`mtime_ms` desc), limit 100; hard
   * cap 1000.
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
   * Defaults to limit 100; hard cap 1000.
   */
  backlinks(
    path: string,
    opts?: { limit?: number; offset?: number },
  ): Backlink[];
  /**
   * Links out of `path`, each with its `resolved` target (or `null` if the
   * link dangles). Defaults to limit 100; hard cap 1000.
   */
  outboundLinks(
    path: string,
    opts?: { limit?: number; offset?: number },
  ): OutboundLink[];
  /**
   * FTS5 keyword search over note bodies, returning highlighted snippets.
   * Defaults to limit 100; hard cap 1000.
   */
  searchText(
    q: string,
    opts?: { tag?: string; folder?: string; limit?: number; offset?: number },
  ): SearchHit[];
  /**
   * Every tag present on notes the instance can read, each with the number of
   * those notes that carry it, ranked most-used first (canonical tags float to
   * the top). `prefix` matches case-sensitively for hierarchy navigation;
   * `contains` is a substring search (ASCII case-insensitive, per SQLite LIKE);
   * `folder` restricts to a folder subtree; `limit` caps the result.
   */
  tags(opts?: {
    prefix?: string;
    contains?: string;
    folder?: string;
    limit?: number;
  }): TagInfo[];
};
