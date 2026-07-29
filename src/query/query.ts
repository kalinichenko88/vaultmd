import type { Database } from 'bun:sqlite';
import { extname } from 'node:path';

import { MdVaultError } from '@/errors.ts';
import type { IndexConfig } from '@/note-index/index.ts';
import type { VaultIo } from '@/vault-io/index.ts';

import type { Backlink } from './models/backlink.ts';
import type { DanglingLink } from './models/dangling-link.ts';
import type { NoteHit } from './models/note-hit.ts';
import type { QueryOrder } from './models/order.ts';
import type { OutboundLink } from './models/outbound-link.ts';
import type { QueryApi } from './models/query-api.ts';
import type { SearchHit } from './models/search-hit.ts';
import type { TagInfo } from './models/tag-info.ts';
import type { WhereMap } from './models/where-map.ts';

const ORDER_FIELDS = new Set<string>(['mtime_ms', 'path', 'title']);
const WHERE_KEY_RE = /^[A-Za-z0-9_.-]+$/;
const DEFAULT_LIMIT = 100;
const HARD_MAX = 1000;

type RawNoteRow = {
  path: string;
  path_key: string;
  title: string;
  frontmatter: string;
  mtime_ms: number;
  size: number;
};
type TagRow = { tag: string };
type LinkRow = { target: string; base: string | null };
type SrcLinkRow = LinkRow & { from_path: string };
type SearchRow = { path: string; title: string; snippet: string };
type PathRow = { path: string };

function assertNonNegativeInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new MdVaultError(
      'VALIDATION_ERROR',
      `${label} must be a non-negative integer, got: ${value}`,
    );
  }
}

function validatePagination(
  limit: number | undefined,
  offset: number | undefined,
): { lim: number; off: number } {
  const lim = limit ?? DEFAULT_LIMIT;
  const off = offset ?? 0;
  assertNonNegativeInt(lim, 'limit');
  assertNonNegativeInt(off, 'offset');

  return { lim: Math.min(lim, HARD_MAX), off };
}

function sanitizeFts(q: string): string | null {
  const tokens = q
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return null;
  }

  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
}

// Escapes LIKE metacharacters (\, %, _) so caller-supplied text matches
// literally under an `ESCAPE '\'` clause. Single pass: each metachar gets one
// leading backslash, so escaping '\' first is not double-applied.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Appends the recursive folder-subtree filter (`folder` itself + `folder/…`
// descendants) with %/_ escaped. note paths are aliased `n` in every query.
function pushFolderFilter(
  parts: string[],
  params: (string | number | boolean | null)[],
  folder: string,
): void {
  parts.push("(n.path = ? OR n.path LIKE ? ESCAPE '\\')");
  params.push(folder, `${escapeLike(folder)}/%`);
}

// Builds the row predicates shared by every note reader: tag membership,
// frontmatter equality, folder subtree. Returned unjoined because searchText
// appends them to an existing `WHERE notes_fts MATCH ?` with AND, while the
// note-table readers open their own WHERE. The notes table is aliased `n` in
// every caller.
function buildNoteFilters(opts: {
  tag?: string;
  where?: WhereMap;
  folder?: string;
}): { parts: string[]; params: (string | number | boolean | null)[] } {
  const { tag, where = {}, folder } = opts;
  const parts: string[] = [];
  const params: (string | number | boolean | null)[] = [];

  if (tag !== undefined) {
    parts.push(
      'EXISTS (SELECT 1 FROM note_tags nt WHERE nt.path_key = n.path_key AND nt.tag = ?)',
    );
    params.push(tag);
  }

  for (const key of Object.keys(where)) {
    if (!WHERE_KEY_RE.test(key)) {
      throw new MdVaultError(
        'VALIDATION_ERROR',
        `where key contains invalid characters: ${key}`,
      );
    }
    parts.push(`json_extract(n.frontmatter, '$."${key}"') = ?`);
    params.push(where[key]);
  }

  if (folder !== undefined) {
    pushFolderFilter(parts, params, folder);
  }

  return { parts, params };
}

function whereClause(parts: string[]): string {
  return parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '';
}

// Attachment file types a vault links to but this package does not index. A
// CLOSED list, not a shape test: an open "looks like an extension" rule cuts
// both ways — it swallows real broken links whose title merely ends in a dot
// segment (`[[Meeting 2024.Q1]]`, `[[Draft.v2]]`, `[[Release notes.beta]]`),
// and a missed transclusion is worse than a listed one. Anything not named
// here is treated as a note reference and gets checked.
// ponytail: extend the list if a real vault links a type it lacks.
const ATTACHMENT_EXTENSIONS = new Set(
  [
    'png jpg jpeg gif svg webp avif bmp ico heic tif tiff', // images
    'pdf doc docx xls xlsx ppt pptx odt ods epub', // documents
    'mp3 wav m4a ogg flac aac mp4 mov webm mkv avi m4v', // audio / video
    'zip gz tar 7z canvas', // archives + editor artefacts
  ].flatMap((group) => group.split(' ')),
);

// `[[diagram.png]]` names an attachment, not a missing note — it can never
// resolve to a `.md` note, so reporting it as broken would bury real breakage
// under every image in the vault. Kind-independent on purpose: the plain
// wikilink form is as common as the `![[...]]` embed for PDFs and images meant
// to be clicked. Relative mode never stores non-`.md` targets, so in practice
// this only fires for wikilinks.
function isAttachmentTarget(target: string): boolean {
  // extname returns '' for both a bare `zip` and a leading-dot `.png`, so a
  // note titled `zip` cannot read as an archive and no guard is needed.
  return ATTACHMENT_EXTENSIONS.has(extname(target).slice(1).toLowerCase());
}

function pathBaseLower(p: string): string {
  return (p.split('/').at(-1) ?? p).replace(/\.md$/i, '').toLowerCase();
}

function pathFolder(p: string): string {
  const i = p.lastIndexOf('/');

  return i < 0 ? '' : p.slice(0, i);
}

function tieBreakWinner(
  candidates: { path: string }[],
  srcFolder: string,
): string | undefined {
  const sorted = [...candidates].sort((a, b) => {
    const af = pathFolder(a.path);
    const bf = pathFolder(b.path);
    const as_ = af === srcFolder ? 0 : 1;
    const bs_ = bf === srcFolder ? 0 : 1;
    if (as_ !== bs_) {
      return as_ - bs_;
    }
    if (a.path.length !== b.path.length) {
      return a.path.length - b.path.length;
    }

    return a.path.localeCompare(b.path);
  });

  return sorted[0]?.path;
}

export function createQuery(
  db: Database,
  vaultIo: VaultIo,
  cfg: IndexConfig,
): QueryApi {
  function inScope(path: string): boolean {
    return vaultIo.can(path, 'read');
  }

  function tagsFor(pathKey: string): string[] {
    return db
      .query<TagRow, [string]>('SELECT tag FROM note_tags WHERE path_key = ?')
      .all(pathKey)
      .map((r) => r.tag);
  }

  // In-scope notes whose basename (case-folded, sans .md) equals `base` — the
  // bare-wikilink candidate set, shared by backlinks, outboundLinks and
  // danglingLinks. `index` short-circuits the per-base LIKE scan: see
  // buildBaseIndex for when passing one is worth it.
  function bareCandidates(
    base: string,
    index?: Map<string, PathRow[]>,
  ): PathRow[] {
    if (index) {
      return index.get(base) ?? [];
    }

    return db
      .query<PathRow, [string, string]>(
        'SELECT path FROM notes WHERE LOWER(path_key) = ? OR LOWER(path_key) LIKE ?',
      )
      .all(`${base}.md`, `%/${base}.md`)
      .filter((c) => pathBaseLower(c.path) === base && inScope(c.path));
  }

  // Every in-scope note grouped by basename, in ONE pass over `notes`. The
  // per-base LIKE scan bareCandidates does otherwise is unindexed, so resolving
  // a whole vault of links one at a time is quadratic — measured at ~4.5s for
  // 3000 notes / 15000 links, on a synchronous call. Callers resolving a single
  // page (outboundLinks) should NOT build this: one scan to save a handful of
  // lookups is the worse trade.
  function buildBaseIndex(): Map<string, PathRow[]> {
    const rows = db
      .query<PathRow, []>('SELECT path FROM notes')
      .all()
      .filter((row) => inScope(row.path));

    return Map.groupBy(rows, (row) => pathBaseLower(row.path));
  }

  function queryNotes(
    opts: {
      tag?: string;
      where?: WhereMap;
      folder?: string;
      orderBy?: QueryOrder;
      limit?: number;
      offset?: number;
    } = {},
  ): NoteHit[] {
    const { orderBy, limit, offset } = opts;
    const { lim, off } = validatePagination(limit, offset);
    const order: QueryOrder = orderBy ?? { field: 'mtime_ms', dir: 'desc' };
    if (!ORDER_FIELDS.has(order.field)) {
      throw new MdVaultError(
        'VALIDATION_ERROR',
        `orderBy.field must be one of ${[...ORDER_FIELDS].join(', ')}, got: ${order.field}`,
      );
    }
    const dir = order.dir === 'asc' ? 'ASC' : 'DESC';
    const { parts, params } = buildNoteFilters(opts);
    const clause = whereClause(parts);
    // Fetch all matching rows without LIMIT/OFFSET — scope-filter first, then
    // slice in JS to get exact page fills. (At personal-vault scale the full
    // scan is fine; a future optimisation can push read-prefixes into SQL.)
    const sql = `SELECT n.path, n.path_key, n.title, n.frontmatter, n.mtime_ms, n.size FROM notes n ${clause} ORDER BY n.${order.field} ${dir}, n.path ASC`;
    const rows = db
      .query<RawNoteRow, (string | number | boolean | null)[]>(sql)
      .all(...params);
    const scoped: NoteHit[] = [];
    for (const row of rows) {
      if (!inScope(row.path)) {
        continue;
      }
      scoped.push({
        path: row.path,
        title: row.title,
        frontmatter: JSON.parse(row.frontmatter) as Record<string, unknown>,
        tags: tagsFor(row.path_key),
        mtime_ms: row.mtime_ms,
        size: row.size,
      });
    }

    return scoped.slice(off, off + lim);
  }

  function countNotes(
    opts: { tag?: string; where?: WhereMap; folder?: string } = {},
  ): number {
    const { parts, params } = buildNoteFilters(opts);
    // Path-only projection: the scope filter needs nothing else, so this skips
    // the frontmatter JSON parse and the per-row tag lookup queryNotes pays for.
    const rows = db
      .query<PathRow, (string | number | boolean | null)[]>(
        `SELECT n.path FROM notes n ${whereClause(parts)}`,
      )
      .all(...params);

    return rows.filter((row) => inScope(row.path)).length;
  }

  function backlinks(
    path: string,
    opts: { limit?: number; offset?: number } = {},
  ): Backlink[] {
    if (!inScope(path)) {
      return [];
    }
    const { lim, off } = validatePagination(opts.limit, opts.offset);
    const display = vaultIo.toVaultRelative(path);
    const targetKey = vaultIo.toKey(path);
    const base = pathBaseLower(display);
    const sources: string[] = [];

    if (cfg.linkResolution === 'relative') {
      // JOIN notes tn on the target side so dangling links (target not in index) yield no rows.
      const rows = db
        .query<{ from_path: string }, [string]>(
          `SELECT n.path AS from_path
           FROM note_links nl
           JOIN notes n ON n.path_key = nl.src_key
           JOIN notes tn ON tn.path_key = nl.target
           WHERE nl.target = ?`,
        )
        .all(targetKey);
      for (const r of rows) {
        if (inScope(r.from_path)) {
          sources.push(r.from_path);
        }
      }
    } else {
      // path-qualified: [[Folder/Foo]] stored as target='Folder/Foo'; resolves to Folder/Foo.md
      const pqRows = db
        .query<{ from_path: string; target: string }, []>(
          `SELECT n.path AS from_path, nl.target
           FROM note_links nl
           JOIN notes n ON n.path_key = nl.src_key
           WHERE nl.target LIKE '%/%'`,
        )
        .all();
      for (const r of pqRows) {
        if (!inScope(r.from_path)) {
          continue;
        }
        if (vaultIo.toKey(`${r.target}.md`) === targetKey) {
          sources.push(r.from_path);
        }
      }

      // bare: [[Foo]] stored as base='foo'; win tie-break to be a backlink
      const bareRows = db
        .query<{ from_path: string }, [string]>(
          `SELECT n.path AS from_path
           FROM note_links nl
           JOIN notes n ON n.path_key = nl.src_key
           WHERE nl.base = ?`,
        )
        .all(base);

      // candidates are the same for every source with this base, but tie-break winner
      // differs per source folder — compute candidates once, winner per source
      const candidates = bareCandidates(base);

      for (const r of bareRows) {
        if (!inScope(r.from_path)) {
          continue;
        }
        const winner = tieBreakWinner(candidates, pathFolder(r.from_path));
        if (winner === display) {
          sources.push(r.from_path);
        }
      }
    }

    // deduplicate (a note could link via both path-qualified and bare)
    const seen = new Set<string>();
    const deduped: { from: string }[] = [];
    for (const s of sources) {
      if (!seen.has(s)) {
        seen.add(s);
        deduped.push({ from: s });
      }
    }

    return deduped.slice(off, off + lim);
  }

  // In-scope note owning `pathKey`, or null when the key indexes nothing (or
  // nothing the instance may read).
  function readableNoteByKey(pathKey: string): string | null {
    const hit = db
      .query<PathRow, [string]>('SELECT path FROM notes WHERE path_key = ?')
      .get(pathKey);

    return hit && inScope(hit.path) ? hit.path : null;
  }

  // Resolves one stored link row to the note it points at, or null when it
  // dangles. Shared by outboundLinks (one note) and danglingLinks (vault-wide),
  // so both agree on what "resolved" means. `srcDisplay` is the linking note's
  // canonical path — bare wikilinks tie-break toward the source's own folder.
  function resolveLinkTarget(
    row: LinkRow,
    srcDisplay: string,
    baseIndex?: Map<string, PathRow[]>,
  ): string | null {
    if (cfg.linkResolution === 'relative') {
      // toKey, not the raw target: note_links.target holds the path as written
      // in the link, while path_key is case-folded on a case-insensitive
      // volume. Comparing the two directly makes every mixed-case relative
      // link ([t](Notes/Target.md)) miss its own note.
      return readableNoteByKey(vaultIo.toKey(row.target));
    }
    // path-qualified: [[Folder/Foo]] stored as target='Folder/Foo'
    if (row.target.includes('/')) {
      return readableNoteByKey(vaultIo.toKey(`${row.target}.md`));
    }
    if (row.base !== null) {
      return (
        tieBreakWinner(
          bareCandidates(row.base, baseIndex),
          pathFolder(srcDisplay),
        ) ?? null
      );
    }

    return null;
  }

  function outboundLinks(
    path: string,
    opts: { limit?: number; offset?: number } = {},
  ): OutboundLink[] {
    if (!inScope(path)) {
      return [];
    }
    const { lim, off } = validatePagination(opts.limit, opts.offset);
    const srcKey = vaultIo.toKey(path);
    const display = vaultIo.toVaultRelative(path);

    return db
      .query<LinkRow, [string]>(
        `SELECT target, base FROM note_links WHERE src_key = ?`,
      )
      .all(srcKey)
      .slice(off, off + lim)
      .map((row) => ({
        target: row.target,
        resolved: resolveLinkTarget(row, display),
      }));
  }

  function danglingLinks(
    opts: { limit?: number; offset?: number } = {},
  ): DanglingLink[] {
    const { lim, off } = validatePagination(opts.limit, opts.offset);
    const rows = db
      .query<SrcLinkRow, []>(
        `SELECT n.path AS from_path, nl.target, nl.base
         FROM note_links nl
         JOIN notes n ON n.path_key = nl.src_key
         ORDER BY n.path ASC, nl.target ASC`,
      )
      .all();
    // Only bare wikilinks consult it; relative mode resolves by path_key alone,
    // so building it there would be a full scan nobody reads.
    const baseIndex =
      cfg.linkResolution === 'wikilink' ? buildBaseIndex() : undefined;
    // One row per (src, target, kind), so a note carrying both [[ghost]] and
    // ![[ghost]] reports the same breakage twice and burns two slots of the
    // caller's page. backlinks dedupes for the same reason.
    const seen = new Set<string>();
    const broken: DanglingLink[] = [];
    for (const row of rows) {
      if (!inScope(row.from_path) || isAttachmentTarget(row.target)) {
        continue;
      }
      // NUL separator, not a space: a space would collide "a b" + "c"
      // with "a" + "b c".
      const key = `${row.from_path}\u0000${row.target}`;
      if (seen.has(key)) {
        continue;
      }
      if (resolveLinkTarget(row, row.from_path, baseIndex) === null) {
        seen.add(key);
        broken.push({ from: row.from_path, target: row.target });
      }
    }

    return broken.slice(off, off + lim);
  }

  // Every in-scope hit for `q`, unpaginated and rank-ordered — searchText slices
  // it into a page, countSearch just takes its length, so a count can never
  // disagree with the rows it counts. `withSnippet` is off for the count: fts5
  // `snippet()` builds a highlighted string per matching row, and a "page 1 of
  // N" render would pay for one per hit only to discard it.
  function searchScoped(
    q: string,
    opts: { tag?: string; folder?: string } = {},
    withSnippet = true,
  ): SearchHit[] {
    const ftsQ = sanitizeFts(q);
    if (ftsQ === null) {
      return [];
    }

    const { parts, params: filterParams } = buildNoteFilters(opts);
    const params: (string | number | boolean | null)[] = [
      ftsQ,
      ...filterParams,
    ];
    const extra = parts.length > 0 ? `AND ${parts.join(' AND ')}` : '';
    const snippetCol = withSnippet
      ? `snippet(notes_fts, 0, '<b>', '</b>', '…', 10)`
      : `''`;
    // Fetch all matching rows without LIMIT/OFFSET — scope-filter first, then
    // slice in JS to get exact page fills. (At personal-vault scale the full
    // scan is fine; a future optimisation can push read-prefixes into SQL.)
    const sql = `
      SELECT n.path, n.title, ${snippetCol} AS snippet
      FROM notes_fts
      JOIN notes n ON notes_fts.rowid = n.id
      WHERE notes_fts MATCH ? ${extra}
      ORDER BY notes_fts.rank
    `;

    let rows: SearchRow[];
    try {
      rows = db
        .query<SearchRow, (string | number | boolean | null)[]>(sql)
        .all(...params);
    } catch {
      // malformed FTS query that slipped through sanitizer → safe empty result
      return [];
    }

    const scoped: SearchHit[] = [];
    for (const row of rows) {
      if (!inScope(row.path)) {
        continue;
      }
      scoped.push({
        path: row.path,
        title: row.title,
        snippet: row.snippet || undefined,
      });
    }

    return scoped;
  }

  function searchText(
    q: string,
    opts: {
      tag?: string;
      folder?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): SearchHit[] {
    const { lim, off } = validatePagination(opts.limit, opts.offset);

    return searchScoped(q, opts).slice(off, off + lim);
  }

  function countSearch(
    q: string,
    opts: { tag?: string; folder?: string } = {},
  ): number {
    return searchScoped(q, opts, false).length;
  }

  function tags(
    opts: {
      prefix?: string;
      contains?: string;
      folder?: string;
      limit?: number;
    } = {},
  ): TagInfo[] {
    const { prefix, contains, folder, limit } = opts;
    if (limit !== undefined) {
      assertNonNegativeInt(limit, 'limit');
    }
    const parts: string[] = [];
    const params: (string | number | boolean | null)[] = [];

    if (prefix !== undefined) {
      // Case-sensitive exact prefix (default BINARY collation); substr avoids
      // LIKE wildcard handling, so %/_ in the prefix are literal.
      parts.push('substr(nt.tag, 1, length(?)) = ?');
      params.push(prefix, prefix);
    }

    if (contains !== undefined) {
      // LOWER both sides via SQLite (ASCII-only) so case-folding is symmetric.
      // A JS toLowerCase here would Unicode-fold only the needle while SQLite
      // leaves the haystack's non-ASCII letters intact, making non-ASCII tags
      // (e.g. Cyrillic) unfindable even by exact spelling.
      parts.push("LOWER(nt.tag) LIKE LOWER(?) ESCAPE '\\'");
      params.push(`%${escapeLike(contains)}%`);
    }

    if (folder !== undefined) {
      pushFolderFilter(parts, params, folder);
    }

    const clause = parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '';
    // Join notes for the path so scope is filtered in JS (note_tags is keyed by
    // path_key, not path); aggregate counts in a Map since a tag spans notes.
    const sql = `SELECT nt.tag AS tag, n.path AS path FROM note_tags nt JOIN notes n ON n.path_key = nt.path_key ${clause}`;
    const rows = db
      .query<
        { tag: string; path: string },
        (string | number | boolean | null)[]
      >(sql)
      .all(...params);
    const counts = new Map<string, number>();
    const scopeByPath = new Map<string, boolean>();
    for (const row of rows) {
      let allowed = scopeByPath.get(row.path);
      if (allowed === undefined) {
        allowed = inScope(row.path);
        scopeByPath.set(row.path, allowed);
      }
      if (allowed) {
        counts.set(row.tag, (counts.get(row.tag) ?? 0) + 1);
      }
    }
    const result: TagInfo[] = [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      // count DESC, then tag ASC by UTF-16 code-unit order — locale-independent
      // and deterministic across macOS/Linux CI (the prefix filter is likewise
      // case-sensitive). Diverges from SQLite BINARY only for astral-plane
      // characters, which do not occur in realistic tags.
      .sort((a, b) => {
        if (a.count !== b.count) {
          return b.count - a.count;
        }

        return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0;
      });

    return limit === undefined ? result : result.slice(0, limit);
  }

  return {
    queryNotes,
    countNotes,
    backlinks,
    outboundLinks,
    danglingLinks,
    searchText,
    countSearch,
    tags,
  };
}
