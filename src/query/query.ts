import type { Database } from 'bun:sqlite';
import { extname } from 'node:path';

import { MdVaultError } from '@/errors.ts';
import type { IndexConfig } from '@/note-index/index.ts';
import type { VaultIo } from '@/vault-io/index.ts';

import type { Backlink } from './models/backlink.ts';
import type { DanglingLink } from './models/dangling-link.ts';
import type { NoteFilter } from './models/note-filter.ts';
import type { NoteHit } from './models/note-hit.ts';
import type { QueryOrder } from './models/order.ts';
import type { OutboundLink } from './models/outbound-link.ts';
import type { QueryApi } from './models/query-api.ts';
import type { SearchHit } from './models/search-hit.ts';
import type { TagInfo } from './models/tag-info.ts';
import type { WhereCondition, WhereValue } from './models/where-map.ts';

const ORDER_FIELDS = new Set<string>(['mtime_ms', 'path', 'title']);
const ORPHAN_MODES = new Set<string>(['disconnected', 'unreferenced']);
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

// Quotes each whitespace-separated token so caller text cannot reach the fts5
// query grammar. Whitespace-joined the tokens are separate phrases — an
// implicit AND that matches words in different sentences; `phrase` joins them
// with fts5's `+` instead, which demands the tokens be adjacent in that order.
function sanitizeFts(q: string, phrase = false): string | null {
  const tokens = q
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return null;
  }

  return tokens
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(phrase ? ' + ' : ' ');
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

// Comparison operators that take one scalar operand. `ne` is `IS NOT`, not
// `!=`: json_extract yields NULL for a field the note never sets, and `!=`
// would drop those rows — "status is not done" reads as including a note with
// no status at all. Callers who want the field present add `exists: true`.
// A Map, not an object literal: a plain object would resolve an operator named
// `toString` (or any other prototype member) to an inherited function and
// splice it into the SQL text instead of falling through to the unknown-operator
// throw.
const WHERE_COMPARISONS = new Map<string, string>([
  ['ne', 'IS NOT'],
  ['lt', '<'],
  ['lte', '<='],
  ['gt', '>'],
  ['gte', '>='],
]);

function placeholders(n: number): string {
  return Array(n).fill('?').join(', ');
}

// Filters arrive from HTTP query strings, CLIs and JSON configs as often as
// from typed call sites, and `exactOptionalPropertyTypes` is off, so an
// `undefined` operand type-checks. Every operand is therefore shape-checked
// here rather than trusted: an unvalidated one either binds as a raw Error
// with no `.code` (breaking the documented catch-on-code contract) or, worse,
// widens the query silently.
function assertWhereValue(value: unknown, label: string): WhereValue {
  if (!['string', 'number', 'boolean'].includes(typeof value)) {
    throw new MdVaultError(
      'VALIDATION_ERROR',
      `${label} must be a string, number or boolean`,
    );
  }

  return value as WhereValue;
}

function assertTagList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((t) => typeof t !== 'string')) {
    throw new MdVaultError(
      'VALIDATION_ERROR',
      `${label} must be an array of strings`,
    );
  }

  return value;
}

// One `where` entry as SQL over the frontmatter JSON: a bare value is equality,
// an object is a set of operators AND-ed together. Only `key` reaches the SQL
// text (WHERE_KEY_RE-guarded by the caller) — every operand stays a parameter.
function pushWhereFilter(
  parts: string[],
  params: (string | number | boolean | null)[],
  key: string,
  cond: WhereValue | WhereCondition,
): void {
  const col = `json_extract(n.frontmatter, '$."${key}"')`;
  if (typeof cond !== 'object' || cond === null) {
    parts.push(`${col} = ?`);
    params.push(assertWhereValue(cond, `where ${key}`));

    return;
  }

  // An operator object that would contribute no predicate — `{}`, or
  // `{ lt: cutoff }` where `cutoff` came in undefined — drops the whole entry
  // and silently widens the query to the entire vault. Refuse it: an empty
  // `in` list is how you ask for "match nothing".
  if (Object.values(cond).every((v) => v === undefined)) {
    throw new MdVaultError(
      'VALIDATION_ERROR',
      `where ${key} has no operator to apply; use { in: [] } to match nothing`,
    );
  }

  for (const op of Object.keys(cond)) {
    const value = cond[op as keyof WhereCondition];
    if (value === undefined) {
      continue;
    }
    const comparison = WHERE_COMPARISONS.get(op);
    if (comparison !== undefined) {
      parts.push(`${col} ${comparison} ?`);
      params.push(assertWhereValue(value, `where ${key}.${op}`));
      continue;
    }
    if (op === 'in') {
      if (!Array.isArray(value)) {
        throw new MdVaultError(
          'VALIDATION_ERROR',
          `where ${key}.in must be an array`,
        );
      }
      // `IN ()` is legal in SQLite and matches nothing — the right answer for
      // "any of no values", so an empty list needs no special case.
      parts.push(`${col} IN (${placeholders(value.length)})`);
      for (const item of value) {
        params.push(assertWhereValue(item, `where ${key}.in`));
      }
      continue;
    }
    if (op === 'exists') {
      // Not truthiness: a string 'false' off a query string would read as
      // `true` and hand back the exact inverse of what was asked for.
      if (typeof value !== 'boolean') {
        throw new MdVaultError(
          'VALIDATION_ERROR',
          `where ${key}.exists must be a boolean`,
        );
      }
      parts.push(`${col} IS ${value ? 'NOT NULL' : 'NULL'}`);
      continue;
    }
    throw new MdVaultError(
      'VALIDATION_ERROR',
      `unknown where operator on ${key}: ${op}`,
    );
  }
}

// Membership in a tag set: one row in note_tags carrying any of `list`. Used
// once per tag for `all` (each must match) and once for the whole list for
// `any`. note paths are aliased `n` in every query.
function pushTagFilter(
  parts: string[],
  params: (string | number | boolean | null)[],
  list: string[],
): void {
  parts.push(
    `EXISTS (SELECT 1 FROM note_tags nt WHERE nt.path_key = n.path_key AND nt.tag IN (${placeholders(list.length)}))`,
  );
  params.push(...list);
}

// Builds the row predicates shared by every note reader: tag membership,
// frontmatter filters, folder subtree. Returned unjoined because searchText
// appends them to an existing `WHERE notes_fts MATCH ?` with AND, while the
// note-table readers open their own WHERE. The notes table is aliased `n` in
// every caller.
function buildNoteFilters(opts: NoteFilter): {
  parts: string[];
  params: (string | number | boolean | null)[];
} {
  const { tag, tags, where = {}, folder } = opts;
  const parts: string[] = [];
  const params: (string | number | boolean | null)[] = [];

  if (tag !== undefined) {
    pushTagFilter(parts, params, [tag]);
  }

  if (tags?.all !== undefined) {
    for (const t of assertTagList(tags.all, 'tags.all')) {
      pushTagFilter(parts, params, [t]);
    }
  }

  if (tags?.any !== undefined) {
    pushTagFilter(parts, params, assertTagList(tags.any, 'tags.any'));
  }

  for (const key of Object.keys(where)) {
    if (!WHERE_KEY_RE.test(key)) {
      throw new MdVaultError(
        'VALIDATION_ERROR',
        `where key contains invalid characters: ${key}`,
      );
    }
    pushWhereFilter(parts, params, key, where[key]);
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

  // Every readable note matching `opts`, ordered but UNPAGINATED. queryNotes
  // slices it straight into a page; orphanNotes filters it first — so both fill
  // pages exactly off one scan, instead of orphanNotes thinning an already
  // sliced page.
  function scopedNotes(
    opts: NoteFilter & { orderBy?: QueryOrder } = {},
  ): NoteHit[] {
    const { orderBy } = opts;
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
    // Fetch all matching rows without LIMIT/OFFSET — the caller scope-filters
    // and slices in JS to get exact page fills. (At personal-vault scale the
    // full scan is fine; a future optimisation can push read-prefixes into SQL.)
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

    return scoped;
  }

  function queryNotes(
    opts: NoteFilter & {
      orderBy?: QueryOrder;
      limit?: number;
      offset?: number;
    } = {},
  ): NoteHit[] {
    const { lim, off } = validatePagination(opts.limit, opts.offset);

    return scopedNotes(opts).slice(off, off + lim);
  }

  function countNotes(opts: NoteFilter = {}): number {
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

  // Every readable note linking to `path`, deduplicated but UNPAGINATED.
  // backlinks slices it into a page; unlinkedMentions subtracts the whole set,
  // which must not be capped at some caller's page size — linker #101 is still
  // a linker, not an unlinked mention.
  function backlinkSources(path: string): string[] {
    if (!inScope(path)) {
      return [];
    }
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
    const deduped: string[] = [];
    for (const s of sources) {
      if (!seen.has(s)) {
        seen.add(s);
        deduped.push(s);
      }
    }

    return deduped;
  }

  function backlinks(
    path: string,
    opts: { limit?: number; offset?: number } = {},
  ): Backlink[] {
    const { lim, off } = validatePagination(opts.limit, opts.offset);

    return backlinkSources(path)
      .slice(off, off + lim)
      .map((from) => ({ from }));
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

  // Every stored link joined to the note it came from, plus the base index bare
  // wikilinks resolve through. Shared by danglingLinks and linkEdges so the two
  // vault-wide sweeps cannot drift apart on what they read or how they resolve.
  function linkRows(): {
    rows: SrcLinkRow[];
    baseIndex?: Map<string, PathRow[]>;
  } {
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

    return { rows, baseIndex };
  }

  // The note-graph edges, both directions, in one pass. Only readable notes are
  // nodes: an out-of-scope source is invisible, and resolveLinkTarget already
  // refuses an out-of-scope target. A link naming an attachment is no edge at
  // all (Obsidian hides attachments from the graph), while a link that dangles
  // still gives its source an outgoing edge (Obsidian draws it as a ghost node)
  // and gives nothing an inbound one — there is no target to receive it.
  function linkEdges(): { inbound: Set<string>; outbound: Set<string> } {
    const { rows, baseIndex } = linkRows();
    const inbound = new Set<string>();
    const outbound = new Set<string>();
    for (const row of rows) {
      if (!inScope(row.from_path) || isAttachmentTarget(row.target)) {
        continue;
      }
      outbound.add(row.from_path);
      const target = resolveLinkTarget(row, row.from_path, baseIndex);
      if (target !== null) {
        inbound.add(target);
      }
    }

    return { inbound, outbound };
  }

  function orphanNotes(
    opts: NoteFilter & {
      mode?: 'disconnected' | 'unreferenced';
      orderBy?: QueryOrder;
      limit?: number;
      offset?: number;
    } = {},
  ): NoteHit[] {
    const mode = opts.mode ?? 'disconnected';
    // Not a silent fallback to the default: a typo'd mode arriving from a query
    // string would otherwise answer a different question than the caller asked.
    if (!ORPHAN_MODES.has(mode)) {
      throw new MdVaultError(
        'VALIDATION_ERROR',
        `mode must be one of ${[...ORPHAN_MODES].join(', ')}, got: ${mode}`,
      );
    }
    const { lim, off } = validatePagination(opts.limit, opts.offset);
    const { inbound, outbound } = linkEdges();

    // Filter before slicing: paginating first would hand back pages thinned by
    // the orphan test instead of pages of orphans.
    return scopedNotes(opts)
      .filter(
        (note) =>
          !inbound.has(note.path) &&
          (mode === 'unreferenced' || !outbound.has(note.path)),
      )
      .slice(off, off + lim);
  }

  function danglingLinks(
    opts: { limit?: number; offset?: number } = {},
  ): DanglingLink[] {
    const { lim, off } = validatePagination(opts.limit, opts.offset);
    const { rows, baseIndex } = linkRows();
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
  // disagree with the rows it counts. `snippet` is off for the count: fts5
  // `snippet()` builds a highlighted string per matching row, and a "page 1 of
  // N" render would pay for one per hit only to discard it. `phrase` demands
  // adjacent tokens instead of the default implicit AND — mention lookup needs
  // a contiguous name, not its words scattered across the note.
  function searchScoped(
    q: string,
    opts: NoteFilter = {},
    flags: { snippet?: boolean; phrase?: boolean } = {},
  ): SearchHit[] {
    const withSnippet = flags.snippet ?? true;
    const ftsQ = sanitizeFts(q, flags.phrase ?? false);
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
    } catch (error) {
      // Only a malformed FTS query that slipped through the sanitizer is
      // expected here → safe empty result. SQLite reports those with a numeric
      // `errno`; a bind-arity or programming fault carries none, and must NOT
      // be flattened into "no hits" — buildNoteFilters splices its parts into
      // this same statement, so a fault in a tag/where filter would otherwise
      // read as an empty search instead of surfacing, and diverge from
      // queryNotes on the identical filter.
      if (typeof (error as { errno?: unknown }).errno !== 'number') {
        throw error;
      }

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
    opts: NoteFilter & { limit?: number; offset?: number } = {},
  ): SearchHit[] {
    const { lim, off } = validatePagination(opts.limit, opts.offset);

    return searchScoped(q, opts).slice(off, off + lim);
  }

  function countSearch(q: string, opts: NoteFilter = {}): number {
    return searchScoped(q, opts, { snippet: false }).length;
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
    orphanNotes,
    backlinks,
    outboundLinks,
    danglingLinks,
    searchText,
    countSearch,
    tags,
  };
}
