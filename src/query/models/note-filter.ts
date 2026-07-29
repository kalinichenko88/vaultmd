import type { TagFilter } from './tag-filter.ts';
import type { WhereMap } from './where-map.ts';

/**
 * The row predicates every note reader accepts — {@link QueryApi.queryNotes},
 * {@link QueryApi.countNotes}, {@link QueryApi.searchText} and
 * {@link QueryApi.countSearch} all take these, on top of their own ordering,
 * pagination or query arguments. Every filter given is AND-ed.
 */
export type NoteFilter = {
  /** Notes carrying this exact tag. The single-tag shorthand for `tags`. */
  tag?: string;
  /** Multi-tag matching — see {@link TagFilter}. */
  tags?: TagFilter;
  /** Frontmatter field filters — see {@link WhereMap}. */
  where?: WhereMap;
  /** Restricts to a folder and its subtree (the folder path, no trailing `/`). */
  folder?: string;
};
