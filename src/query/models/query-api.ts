import type { Backlink } from './backlink.ts';
import type { DanglingLink } from './dangling-link.ts';
import type { NoteFilter } from './note-filter.ts';
import type { NoteHit } from './note-hit.ts';
import type { QueryOrder } from './order.ts';
import type { OutboundLink } from './outbound-link.ts';
import type { SearchHit } from './search-hit.ts';
import type { TagInfo } from './tag-info.ts';

/**
 * The read-only query surface over the derived SQLite index, exposed as
 * `vault.query`. Results are always filtered to notes the vault instance is
 * allowed to read.
 */
export type QueryApi = {
  /**
   * Filter notes by tag, frontmatter field and/or folder — see
   * {@link NoteFilter} — with ordering and pagination. Defaults to newest-first
   * (`mtime_ms` desc), limit 100; hard cap 1000.
   */
  queryNotes(
    opts?: NoteFilter & {
      orderBy?: QueryOrder;
      limit?: number;
      offset?: number;
    },
  ): NoteHit[];
  /**
   * Total number of readable notes matching the same {@link NoteFilter}
   * {@link queryNotes} accepts — the page-count companion to it. Not capped by
   * `limit`, so `Math.ceil(countNotes(f) / pageSize)` is exact.
   */
  countNotes(opts?: NoteFilter): number;
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
   * link dangles). Reports raw resolution, so a link to an attachment
   * (`[[diagram.png]]`) comes back `resolved: null` — nothing outside `.md` is
   * indexed. {@link danglingLinks} filters those out, so treat `resolved: null`
   * as "not a note in this vault", not as "broken". Defaults to limit 100;
   * hard cap 1000.
   */
  outboundLinks(
    path: string,
    opts?: { limit?: number; offset?: number },
  ): OutboundLink[];
  /**
   * Every link in the vault that resolves to no note — the vault-wide sweep for
   * broken `[[wikilinks]]` and dead relative links, ordered by source path then
   * target. Use it after a rename: {@link NotesApi.moveNote} moves a note
   * byte-for-byte and never rewrites inbound links, so this is how the fallout
   * is found. Links naming an attachment file type (`[[diagram.png]]`) are NOT
   * reported: they can never resolve to a `.md` note, so they are not breakage
   * — which is why this can return `[]` for a link {@link outboundLinks} shows
   * as `resolved: null`. Defaults to limit 100; hard cap 1000.
   */
  danglingLinks(opts?: { limit?: number; offset?: number }): DanglingLink[];
  /**
   * FTS5 keyword search over note bodies, returning highlighted snippets,
   * narrowed by the same {@link NoteFilter} the note readers take. Defaults to
   * limit 100; hard cap 1000.
   */
  searchText(
    q: string,
    opts?: NoteFilter & { limit?: number; offset?: number },
  ): SearchHit[];
  /**
   * Total number of readable notes matching the same query and
   * {@link NoteFilter} {@link searchText} accepts — the page-count companion to
   * it. Not capped by `limit`.
   */
  countSearch(q: string, opts?: NoteFilter): number;
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
