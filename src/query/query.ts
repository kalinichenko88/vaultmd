import type { Database } from 'bun:sqlite';

import { MdVaultError } from '@/errors.ts';
import type { IndexConfig } from '@/note-index/index.ts';
import type { VaultIo } from '@/vault-io/index.ts';

import type { Backlink } from './models/backlink.ts';
import type { NoteHit } from './models/note-hit.ts';
import type { QueryOrder } from './models/order.ts';
import type { OutboundLink } from './models/outbound-link.ts';
import type { QueryApi } from './models/query-api.ts';
import type { SearchHit } from './models/search-hit.ts';
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
};
type TagRow = { tag: string };
type LinkRow = { target: string; base: string | null };
type SearchRow = { path: string; title: string; snippet: string };
type PathRow = { path: string };

function validatePagination(
  limit: number | undefined,
  offset: number | undefined,
): { lim: number; off: number } {
  const lim = limit ?? DEFAULT_LIMIT;
  const off = offset ?? 0;
  if (!Number.isInteger(lim) || lim < 0) {
    throw new MdVaultError(
      'VALIDATION_ERROR',
      `limit must be a non-negative integer, got: ${limit}`,
    );
  }
  if (!Number.isInteger(off) || off < 0) {
    throw new MdVaultError(
      'VALIDATION_ERROR',
      `offset must be a non-negative integer, got: ${offset}`,
    );
  }

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
    const { tag, where = {}, folder, orderBy, limit, offset } = opts;
    const { lim, off } = validatePagination(limit, offset);
    const order: QueryOrder = orderBy ?? { field: 'mtime_ms', dir: 'desc' };
    if (!ORDER_FIELDS.has(order.field)) {
      throw new MdVaultError(
        'VALIDATION_ERROR',
        `orderBy.field must be one of ${[...ORDER_FIELDS].join(', ')}, got: ${order.field}`,
      );
    }
    const dir = order.dir === 'asc' ? 'ASC' : 'DESC';
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
      parts.push('(n.path = ? OR n.path LIKE ?)');
      params.push(folder, `${folder}/%`);
    }

    const clause = parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '';
    // Fetch all matching rows without LIMIT/OFFSET — scope-filter first, then
    // slice in JS to get exact page fills. (At personal-vault scale the full
    // scan is fine; a future optimisation can push read-prefixes into SQL.)
    const sql = `SELECT n.path, n.path_key, n.title, n.frontmatter FROM notes n ${clause} ORDER BY n.${order.field} ${dir}, n.path ASC`;
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
      });
    }

    return scoped.slice(off, off + lim);
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
      const rawCandidates = db
        .query<PathRow, [string, string]>(
          `SELECT path FROM notes WHERE LOWER(path_key) = ? OR LOWER(path_key) LIKE ?`,
        )
        .all(`${base}.md`, `%/${base}.md`);
      const candidates = rawCandidates.filter(
        (c) => pathBaseLower(c.path) === base && inScope(c.path),
      );

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
    const rows = db
      .query<LinkRow, [string]>(
        `SELECT target, base FROM note_links WHERE src_key = ?`,
      )
      .all(srcKey)
      .slice(off, off + lim);

    const results: { target: string; resolved: string | null }[] = [];
    for (const row of rows) {
      let resolved: string | null = null;

      if (cfg.linkResolution === 'relative') {
        const hit = db
          .query<PathRow, [string]>('SELECT path FROM notes WHERE path_key = ?')
          .get(row.target);
        if (hit && inScope(hit.path)) {
          resolved = hit.path;
        }
      } else if (row.target.includes('/')) {
        const tKey = vaultIo.toKey(`${row.target}.md`);
        const hit = db
          .query<PathRow, [string]>('SELECT path FROM notes WHERE path_key = ?')
          .get(tKey);
        if (hit && inScope(hit.path)) {
          resolved = hit.path;
        }
      } else if (row.base !== null) {
        const rawC = db
          .query<PathRow, [string, string]>(
            'SELECT path FROM notes WHERE LOWER(path_key) = ? OR LOWER(path_key) LIKE ?',
          )
          .all(`${row.base}.md`, `%/${row.base}.md`);
        const cands = rawC.filter(
          (c) => pathBaseLower(c.path) === row.base && inScope(c.path),
        );
        const winner = tieBreakWinner(cands, pathFolder(display));
        if (winner !== undefined) {
          resolved = winner;
        }
      }

      results.push({ target: row.target, resolved });
    }

    return results;
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
    const { tag, folder, limit, offset } = opts;
    const { lim, off } = validatePagination(limit, offset);
    const ftsQ = sanitizeFts(q);
    if (ftsQ === null) {
      return [];
    }

    const parts: string[] = [];
    const params: (string | number | boolean | null)[] = [ftsQ];

    if (tag !== undefined) {
      parts.push(
        'EXISTS (SELECT 1 FROM note_tags nt WHERE nt.path_key = n.path_key AND nt.tag = ?)',
      );
      params.push(tag);
    }

    if (folder !== undefined) {
      parts.push('(n.path = ? OR n.path LIKE ?)');
      params.push(folder, `${folder}/%`);
    }

    const extra = parts.length > 0 ? `AND ${parts.join(' AND ')}` : '';
    // Fetch all matching rows without LIMIT/OFFSET — scope-filter first, then
    // slice in JS to get exact page fills. (At personal-vault scale the full
    // scan is fine; a future optimisation can push read-prefixes into SQL.)
    const sql = `
      SELECT n.path, n.title,
             snippet(notes_fts, 0, '<b>', '</b>', '…', 10) AS snippet
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

    return scoped.slice(off, off + lim);
  }

  return { queryNotes, backlinks, outboundLinks, searchText };
}
