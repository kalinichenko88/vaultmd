import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVaultIo } from '@/vault-io/index.ts';

import { createQuery } from '../query.ts';

// ── shared schema ────────────────────────────────────────────────────────────
function setupDb(db: Database): void {
  db.run(`
    CREATE TABLE notes (
      id          INTEGER PRIMARY KEY,
      path        TEXT NOT NULL,
      path_key    TEXT NOT NULL UNIQUE,
      mtime_ms    INTEGER NOT NULL,
      size        INTEGER NOT NULL,
      title       TEXT NOT NULL,
      frontmatter TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE note_tags (
      path_key TEXT NOT NULL,
      tag      TEXT NOT NULL,
      PRIMARY KEY (path_key, tag)
    );
    CREATE TABLE note_links (
      src_key TEXT NOT NULL,
      target  TEXT NOT NULL,
      base    TEXT,
      kind    TEXT NOT NULL,
      PRIMARY KEY (src_key, target, kind)
    );
    CREATE VIRTUAL TABLE notes_fts USING fts5(body);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `);
}

let seq = 0;
function insertNote(
  db: Database,
  opts: {
    path: string;
    pathKey?: string;
    title?: string;
    frontmatter?: Record<string, unknown>;
    tags?: string[];
    body?: string;
    links?: Array<{ target: string; base: string | null; kind: string }>;
  },
): void {
  const pathKey = opts.pathKey ?? opts.path.toLowerCase();
  const title = opts.title ?? opts.path.replace(/\.md$/i, '');
  const fm = JSON.stringify(opts.frontmatter ?? {});
  const body = opts.body ?? '';
  const id = ++seq;
  db.query(
    'INSERT INTO notes (id, path, path_key, mtime_ms, size, title, frontmatter) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, opts.path, pathKey, Date.now(), body.length, title, fm);
  for (const tag of opts.tags ?? []) {
    db.query(
      'INSERT OR IGNORE INTO note_tags (path_key, tag) VALUES (?, ?)',
    ).run(pathKey, tag);
  }
  if (body) {
    db.query('INSERT INTO notes_fts (rowid, body) VALUES (?, ?)').run(id, body);
  }
  for (const link of opts.links ?? []) {
    db.query(
      'INSERT OR IGNORE INTO note_links (src_key, target, base, kind) VALUES (?, ?, ?, ?)',
    ).run(pathKey, link.target, link.base, link.kind);
  }
}

// ── fixture ──────────────────────────────────────────────────────────────────
let vaultDir: string;
let db: Database;

beforeEach(async () => {
  seq = 0;
  vaultDir = await mkdtemp(join(tmpdir(), 'vaultmd-query-'));
  db = new Database(':memory:');
  setupDb(db);
});

afterEach(async () => {
  db.close();
  await rm(vaultDir, { recursive: true, force: true });
});

// ── Cycle 1: scaffold ─────────────────────────────────────────────────────────
describe('createQuery factory', () => {
  test('returns an object with all five methods', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const q = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    expect(typeof q.queryNotes).toBe('function');
    expect(typeof q.backlinks).toBe('function');
    expect(typeof q.outboundLinks).toBe('function');
    expect(typeof q.searchText).toBe('function');
    expect(typeof q.tags).toBe('function');
  });

  test('queryNotes returns [] on an empty DB', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { queryNotes } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    expect(queryNotes()).toEqual([]);
  });
});

// ── Cycle 2: queryNotes ───────────────────────────────────────────────────────
describe('queryNotes — validation', () => {
  test('throws VALIDATION_ERROR on invalid where key (special chars)', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { queryNotes } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    expect(() => queryNotes({ where: { 'bad key!': 'x' } })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });

  test('throws VALIDATION_ERROR on injection attempt in where key', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { queryNotes } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    // key contains "; DROP TABLE notes --" shape — must be rejected before any SQL
    expect(() =>
      queryNotes({ where: { 'a";DROP TABLE notes--': 'x' } }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    // verify notes table is still intact (no injection occurred)
    expect(
      db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM notes').get()?.c,
    ).toBe(0);
  });

  test('throws VALIDATION_ERROR on unknown orderBy field', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { queryNotes } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    expect(() =>
      queryNotes({
        orderBy: { field: 'created_at' as 'mtime_ms', dir: 'asc' },
      }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  test('throws VALIDATION_ERROR on negative limit', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { queryNotes } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    expect(() => queryNotes({ limit: -1 })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });

  test('throws VALIDATION_ERROR on non-integer offset', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { queryNotes } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    expect(() => queryNotes({ offset: 1.5 })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });

  test('clamps oversized limit to 1000 without error', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { queryNotes } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    // insert 3 notes — limit:5000 is clamped to 1000; all 3 still returned
    insertNote(db, { path: 'a.md', body: 'x' });
    insertNote(db, { path: 'b.md', body: 'x' });
    insertNote(db, { path: 'c.md', body: 'x' });
    const hits = queryNotes({ limit: 5000 });
    expect(hits).toHaveLength(3);
  });
});

describe('queryNotes — filtering', () => {
  test('returns all in-scope notes with tags and parsed frontmatter', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { queryNotes } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, {
      path: 'note-a.md',
      title: 'Note A',
      frontmatter: { status: 'draft' },
      tags: ['idea'],
    });
    insertNote(db, {
      path: 'note-b.md',
      title: 'Note B',
      frontmatter: { status: 'done' },
      tags: ['project', 'idea'],
    });
    const hits = queryNotes();
    expect(hits).toHaveLength(2);
    const a = hits.find((h) => h.path === 'note-a.md');
    expect(a).toBeDefined();
    expect(a?.title).toBe('Note A');
    expect(a?.frontmatter).toEqual({ status: 'draft' });
    expect(a?.tags).toEqual(['idea']);
  });

  test('tag filter: only notes with that tag', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { queryNotes } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, { path: 'a.md', tags: ['alpha'] });
    insertNote(db, { path: 'b.md', tags: ['beta'] });
    insertNote(db, { path: 'c.md', tags: ['alpha', 'beta'] });
    const hits = queryNotes({ tag: 'alpha' });
    expect(hits.map((h) => h.path).sort()).toEqual(['a.md', 'c.md']);
  });

  test('folder filter: recursive — matches folder itself and any descendant', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { queryNotes } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, { path: 'daily/2026-01.md' });
    insertNote(db, { path: 'daily/sub/2026-02.md' });
    insertNote(db, { path: 'projects/foo.md' });
    const hits = queryNotes({ folder: 'daily' });
    expect(hits.map((h) => h.path).sort()).toEqual([
      'daily/2026-01.md',
      'daily/sub/2026-02.md',
    ]);
  });

  test('folder filter: % and _ in the folder name match literally, not as wildcards', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { queryNotes } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, { path: 'foo_1/a.md' }); // literal underscore
    insertNote(db, { path: 'fooX1/b.md' }); // matches only if '_' is a wildcard
    insertNote(db, { path: 'bar%baz/c.md' }); // literal percent
    insertNote(db, { path: 'barXXbaz/d.md' }); // matches only if '%' is a wildcard
    expect(queryNotes({ folder: 'foo_1' }).map((h) => h.path)).toEqual([
      'foo_1/a.md',
    ]);
    expect(queryNotes({ folder: 'bar%baz' }).map((h) => h.path)).toEqual([
      'bar%baz/c.md',
    ]);
  });

  test('where filter: matches key=value; missing key = no match', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { queryNotes } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, { path: 'a.md', frontmatter: { status: 'draft' } });
    insertNote(db, { path: 'b.md', frontmatter: { status: 'done' } });
    insertNote(db, { path: 'c.md', frontmatter: {} }); // no status key
    const hits = queryNotes({ where: { status: 'draft' } });
    expect(hits.map((h) => h.path)).toEqual(['a.md']);
  });

  test('where + tag are AND-ed', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { queryNotes } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, {
      path: 'a.md',
      frontmatter: { status: 'draft' },
      tags: ['idea'],
    });
    insertNote(db, {
      path: 'b.md',
      frontmatter: { status: 'draft' },
      tags: [],
    });
    insertNote(db, {
      path: 'c.md',
      frontmatter: { status: 'done' },
      tags: ['idea'],
    });
    const hits = queryNotes({ where: { status: 'draft' }, tag: 'idea' });
    expect(hits.map((h) => h.path)).toEqual(['a.md']);
  });

  test('read-scope filter: out-of-scope notes are never returned', () => {
    // restricted VaultIo: read only 'public/'
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: ['public'], write: ['public'] },
    });
    const { queryNotes } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, { path: 'public/visible.md' });
    insertNote(db, { path: 'private/secret.md' });
    const hits = queryNotes();
    expect(hits.map((h) => h.path)).toEqual(['public/visible.md']);
  });

  test('orderBy path asc', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { queryNotes } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, { path: 'c.md' });
    insertNote(db, { path: 'a.md' });
    insertNote(db, { path: 'b.md' });
    const hits = queryNotes({ orderBy: { field: 'path', dir: 'asc' } });
    expect(hits.map((h) => h.path)).toEqual(['a.md', 'b.md', 'c.md']);
  });

  test('pagination: limit + offset', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { queryNotes } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    for (const p of ['a.md', 'b.md', 'c.md', 'd.md']) {
      insertNote(db, { path: p });
    }
    const page1 = queryNotes({
      orderBy: { field: 'path', dir: 'asc' },
      limit: 2,
      offset: 0,
    });
    const page2 = queryNotes({
      orderBy: { field: 'path', dir: 'asc' },
      limit: 2,
      offset: 2,
    });
    expect(page1.map((h) => h.path)).toEqual(['a.md', 'b.md']);
    expect(page2.map((h) => h.path)).toEqual(['c.md', 'd.md']);
  });
});

// ── Cycle 3: backlinks ───────────────────────────────────────────────────────
describe('backlinks — relative mode', () => {
  test('returns source notes whose stored target matches the path key', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { backlinks } = createQuery(db, io, {
      linkResolution: 'relative',
      caseSensitive: false,
      ignore: [],
    });
    // source A links to target (stored as path_key of target)
    insertNote(db, {
      path: 'source.md',
      links: [{ target: 'target.md', base: null, kind: 'mdlink' }],
    });
    insertNote(db, { path: 'target.md' });
    const bl = backlinks('target.md');
    expect(bl).toEqual([{ from: 'source.md' }]);
  });

  test('dangling link (target not in notes) yields no backlink', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { backlinks } = createQuery(db, io, {
      linkResolution: 'relative',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, {
      path: 'source.md',
      links: [{ target: 'missing.md', base: null, kind: 'mdlink' }],
    });
    // missing.md not inserted — dangling
    const bl = backlinks('missing.md');
    expect(bl).toEqual([]);
  });

  test('out-of-scope source note is not returned', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: ['public'], write: ['public'] },
    });
    const { backlinks } = createQuery(db, io, {
      linkResolution: 'relative',
      caseSensitive: false,
      ignore: [],
    });
    // private source links to public target
    insertNote(db, {
      path: 'private/source.md',
      links: [{ target: 'public/target.md', base: null, kind: 'mdlink' }],
    });
    insertNote(db, { path: 'public/target.md' });
    const bl = backlinks('public/target.md');
    // source is out of scope → must not appear
    expect(bl).toEqual([]);
  });
});

describe('backlinks — wikilink mode', () => {
  test('path-qualified [[Folder/Foo]] resolves as backlink for Folder/Foo.md', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { backlinks } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    // stored target = 'Folder/Foo' (path-qualified, no .md)
    insertNote(db, {
      path: 'source.md',
      links: [{ target: 'Folder/Foo', base: 'foo', kind: 'wikilink' }],
    });
    insertNote(db, { path: 'Folder/Foo.md' });
    const bl = backlinks('Folder/Foo.md');
    expect(bl).toEqual([{ from: 'source.md' }]);
  });

  test('bare [[Foo]] tie-break: same-folder-as-source wins', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { backlinks } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    // source in 'daily/', two candidates: daily/Foo.md (same folder) and root/Foo.md
    insertNote(db, {
      path: 'daily/source.md',
      links: [{ target: 'Foo', base: 'foo', kind: 'wikilink' }],
    });
    insertNote(db, { path: 'daily/Foo.md' });
    insertNote(db, { path: 'Foo.md' });
    // same-folder-as-source is daily/Foo.md → daily/source.md is a backlink for daily/Foo.md
    expect(backlinks('daily/Foo.md')).toEqual([{ from: 'daily/source.md' }]);
    // NOT a backlink for root Foo.md
    expect(backlinks('Foo.md')).toEqual([]);
  });

  test('bare [[Foo]] tie-break: shortest path wins when no same-folder match', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { backlinks } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    // source in 'x/', no x/Foo.md; candidates: Foo.md (short) vs long/path/Foo.md
    insertNote(db, {
      path: 'x/source.md',
      links: [{ target: 'Foo', base: 'foo', kind: 'wikilink' }],
    });
    insertNote(db, { path: 'Foo.md' });
    insertNote(db, { path: 'long/path/Foo.md' });
    expect(backlinks('Foo.md')).toEqual([{ from: 'x/source.md' }]);
    expect(backlinks('long/path/Foo.md')).toEqual([]);
  });

  test('dangling bare [[Missing]] self-heals when note is absent (no backlink)', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { backlinks } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, {
      path: 'source.md',
      links: [{ target: 'Missing', base: 'missing', kind: 'wikilink' }],
    });
    // Missing.md not in DB
    expect(backlinks('Missing.md')).toEqual([]);
  });

  test('read-scoped tie-break: out-of-scope candidate is invisible — does not alter winner', () => {
    // restricted read: only 'public/'
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: ['public'], write: ['public'] },
    });
    const { backlinks } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    // source (public), links bare [[Foo]]
    // candidates in DB: public/Foo.md AND private/Foo.md
    // restricted scope only sees public/Foo.md → winner = public/Foo.md
    insertNote(db, {
      path: 'public/source.md',
      links: [{ target: 'Foo', base: 'foo', kind: 'wikilink' }],
    });
    insertNote(db, { path: 'public/Foo.md' });
    insertNote(db, { path: 'private/Foo.md' });
    // public/Foo.md must be the backlink target (not private)
    expect(backlinks('public/Foo.md')).toEqual([{ from: 'public/source.md' }]);
    expect(backlinks('private/Foo.md')).toEqual([]);
  });
});

// ── Cycle 3: outboundLinks ───────────────────────────────────────────────────
describe('outboundLinks', () => {
  test('relative mode: resolved to display path when target in scope', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { outboundLinks } = createQuery(db, io, {
      linkResolution: 'relative',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, {
      path: 'source.md',
      links: [{ target: 'target.md', base: null, kind: 'mdlink' }],
    });
    insertNote(db, { path: 'target.md' });
    const out = outboundLinks('source.md');
    expect(out).toEqual([{ target: 'target.md', resolved: 'target.md' }]);
  });

  test('wikilink path-qualified: resolved to Folder/Foo.md', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
      // Match the query's caseSensitive:false (and insertNote's lowercased keys)
      // so toKey lowercases on case-sensitive filesystems too (Linux CI). Mirrors
      // createVault, which always threads one caseSensitive through both.
      caseSensitive: false,
    });
    const { outboundLinks } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, {
      path: 'source.md',
      links: [{ target: 'Folder/Foo', base: 'foo', kind: 'wikilink' }],
    });
    insertNote(db, { path: 'Folder/Foo.md' });
    const out = outboundLinks('source.md');
    expect(out).toEqual([{ target: 'Folder/Foo', resolved: 'Folder/Foo.md' }]);
  });

  test('dangling link: resolved = null', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { outboundLinks } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, {
      path: 'source.md',
      links: [{ target: 'Ghost', base: 'ghost', kind: 'wikilink' }],
    });
    // Ghost.md not inserted
    const out = outboundLinks('source.md');
    expect(out).toEqual([{ target: 'Ghost', resolved: null }]);
  });

  test('out-of-scope resolved target shown as null (never leaked)', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: ['public'], write: ['public'] },
    });
    const { outboundLinks } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, {
      path: 'public/source.md',
      links: [{ target: 'Secret/Note', base: 'note', kind: 'wikilink' }],
    });
    insertNote(db, { path: 'Secret/Note.md' }); // exists in DB but out of scope
    const out = outboundLinks('public/source.md');
    // resolved must be null — never reveal Secret/Note.md
    expect(out).toEqual([{ target: 'Secret/Note', resolved: null }]);
  });

  test('pagination: limit + offset on link rows', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { outboundLinks } = createQuery(db, io, {
      linkResolution: 'relative',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, {
      path: 'source.md',
      links: [
        { target: 'a.md', base: null, kind: 'mdlink' },
        { target: 'b.md', base: null, kind: 'mdlink' },
        { target: 'c.md', base: null, kind: 'mdlink' },
      ],
    });
    const all = outboundLinks('source.md', { limit: 2, offset: 0 });
    expect(all).toHaveLength(2);
    const rest = outboundLinks('source.md', { limit: 2, offset: 2 });
    expect(rest).toHaveLength(1);
  });
});

// ── Cycle 4: searchText ──────────────────────────────────────────────────────
describe('searchText — sanitization: adversarial FTS5 input never throws', () => {
  test('empty string → [] (no throw)', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { searchText } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    expect(() => searchText('')).not.toThrow();
    expect(searchText('')).toEqual([]);
  });

  test('whitespace-only → []', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { searchText } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    expect(searchText('   \t  ')).toEqual([]);
  });

  test('raw FTS5 operators (+ - : *) → [] not throw', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { searchText } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, { path: 'x.md', body: 'hello world' });
    expect(() => searchText('+ - : *')).not.toThrow();
    expect(() => searchText('C++ vs Rust:')).not.toThrow();
  });

  test('trailing AND / OR → [] not throw', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { searchText } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, { path: 'y.md', body: 'hello world' });
    expect(() => searchText('hello AND')).not.toThrow();
    expect(() => searchText('hello OR')).not.toThrow();
  });

  test('unbalanced double-quote → [] not throw', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { searchText } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, { path: 'z.md', body: 'hello world' });
    expect(() => searchText('"unbalanced')).not.toThrow();
    expect(() => searchText('un"bal"anced')).not.toThrow();
  });
});

describe('searchText — basic search + filters + read-scope', () => {
  test('finds a note by body keyword', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { searchText } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, {
      path: 'a.md',
      title: 'Alpha',
      body: 'the quick brown fox',
    });
    insertNote(db, { path: 'b.md', title: 'Beta', body: 'the lazy dog' });
    const hits = searchText('fox');
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe('a.md');
    expect(hits[0].title).toBe('Alpha');
  });

  test('snippet is present for a match', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { searchText } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, { path: 'a.md', body: 'the quick brown fox jumps' });
    const hits = searchText('fox');
    expect(hits[0].snippet).toContain('fox');
  });

  test('tag filter: only matching tag + keyword', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { searchText } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, { path: 'a.md', body: 'hello world', tags: ['public'] });
    insertNote(db, { path: 'b.md', body: 'hello world', tags: ['private'] });
    const hits = searchText('hello', { tag: 'public' });
    expect(hits.map((h) => h.path)).toEqual(['a.md']);
  });

  test('folder filter: recursive prefix match', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { searchText } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, { path: 'daily/2026-01.md', body: 'standup notes' });
    insertNote(db, { path: 'projects/foo.md', body: 'standup notes' });
    const hits = searchText('standup', { folder: 'daily' });
    expect(hits.map((h) => h.path)).toEqual(['daily/2026-01.md']);
  });

  test('folder filter: % and _ in the folder name match literally', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { searchText } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, { path: 'foo_1/a.md', body: 'standup notes' });
    insertNote(db, { path: 'fooX1/b.md', body: 'standup notes' });
    expect(
      searchText('standup', { folder: 'foo_1' }).map((h) => h.path),
    ).toEqual(['foo_1/a.md']);
  });

  test('read-scope: out-of-scope notes never returned', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: ['public'], write: ['public'] },
    });
    const { searchText } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, { path: 'public/a.md', body: 'secret plans' });
    insertNote(db, { path: 'private/b.md', body: 'secret plans' });
    const hits = searchText('secret');
    expect(hits.map((h) => h.path)).toEqual(['public/a.md']);
  });

  test('pagination: limit + offset', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { searchText } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    for (const i of [1, 2, 3, 4]) {
      insertNote(db, { path: `n${i}.md`, body: 'common term here' });
    }
    const page1 = searchText('common', { limit: 2, offset: 0 });
    const page2 = searchText('common', { limit: 2, offset: 2 });
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    const allPaths = [...page1, ...page2].map((h) => h.path).sort();
    expect(allPaths).toEqual(['n1.md', 'n2.md', 'n3.md', 'n4.md']);
  });

  test('throws VALIDATION_ERROR on negative limit', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    });
    const { searchText } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    expect(() => searchText('x', { limit: -1 })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });
});

// ── Cycle 5: mixed-scope pagination ──────────────────────────────────────────
// Regression guard for the "paginate AFTER scope-filter" fix:
// SQL LIMIT/OFFSET on the raw set undershoots when out-of-scope rows are
// interleaved — pages must be filled from the already-scoped set.
describe('queryNotes — mixed-scope pagination (Finding 1 regression)', () => {
  test('limit=3 returns exactly 3 in-scope items even with out-of-scope rows interleaved', () => {
    // read scope: only 'pub/' prefix
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: ['pub'], write: ['pub'] },
    });
    const { queryNotes } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    // Insert alternating in-scope / out-of-scope notes (ordered by path)
    insertNote(db, { path: 'priv/a.md' }); // out
    insertNote(db, { path: 'pub/b.md' }); // in
    insertNote(db, { path: 'priv/c.md' }); // out
    insertNote(db, { path: 'pub/d.md' }); // in
    insertNote(db, { path: 'priv/e.md' }); // out
    insertNote(db, { path: 'pub/f.md' }); // in
    insertNote(db, { path: 'priv/g.md' }); // out
    insertNote(db, { path: 'pub/h.md' }); // in (4th in-scope)

    const page = queryNotes({
      orderBy: { field: 'path', dir: 'asc' },
      limit: 3,
      offset: 0,
    });
    expect(page).toHaveLength(3);
    expect(page.map((h) => h.path)).toEqual([
      'pub/b.md',
      'pub/d.md',
      'pub/f.md',
    ]);
  });

  test('offset pages through in-scope items with no gaps or duplicates', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: ['pub'], write: ['pub'] },
    });
    const { queryNotes } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, { path: 'priv/1.md' }); // out
    insertNote(db, { path: 'pub/2.md' }); // in — page 1
    insertNote(db, { path: 'priv/3.md' }); // out
    insertNote(db, { path: 'pub/4.md' }); // in — page 1
    insertNote(db, { path: 'priv/5.md' }); // out
    insertNote(db, { path: 'pub/6.md' }); // in — page 2
    insertNote(db, { path: 'pub/7.md' }); // in — page 2

    const page1 = queryNotes({
      orderBy: { field: 'path', dir: 'asc' },
      limit: 2,
      offset: 0,
    });
    const page2 = queryNotes({
      orderBy: { field: 'path', dir: 'asc' },
      limit: 2,
      offset: 2,
    });

    expect(page1.map((h) => h.path)).toEqual(['pub/2.md', 'pub/4.md']);
    expect(page2.map((h) => h.path)).toEqual(['pub/6.md', 'pub/7.md']);
    // no overlaps, no gaps
    const all = [...page1, ...page2].map((h) => h.path);
    expect(new Set(all).size).toBe(4);
  });
});

// ── tags ──────────────────────────────────────────────────────────────────────
describe('tags', () => {
  function mkTags(
    io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
    }),
  ) {
    return createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    }).tags;
  }

  test('returns [] on an empty DB', () => {
    expect(mkTags()()).toEqual([]);
  });

  test('counts notes per tag and dedups across notes', () => {
    const tags = mkTags();
    insertNote(db, { path: 'a.md', tags: ['idea'] });
    insertNote(db, { path: 'b.md', tags: ['idea', 'project'] });
    expect(tags()).toEqual([
      { tag: 'idea', count: 2 },
      { tag: 'project', count: 1 },
    ]);
  });

  test('sorts by count desc, then tag asc (name tiebreak)', () => {
    const tags = mkTags();
    insertNote(db, { path: 'a.md', tags: ['zeta', 'alpha'] });
    insertNote(db, { path: 'b.md', tags: ['zeta', 'alpha'] });
    insertNote(db, { path: 'c.md', tags: ['mid'] });
    expect(tags()).toEqual([
      { tag: 'alpha', count: 2 },
      { tag: 'zeta', count: 2 },
      { tag: 'mid', count: 1 },
    ]);
  });

  test('sort tiebreak uses Unicode code point, not locale (uppercase before lowercase)', () => {
    const tags = mkTags();
    // 'Z' (U+005A) precedes 'a' (U+0061) by code point; a locale collator would
    // typically order 'a' before 'Z'. Equal count → tiebreak must be code-point.
    insertNote(db, { path: 'a.md', tags: ['a', 'Z'] });
    expect(tags().map((t) => t.tag)).toEqual(['Z', 'a']);
  });

  test('read-scope: out-of-scope-only tag is absent; shared tag counts only in-scope notes', () => {
    const tags = mkTags(
      createVaultIo({
        root: vaultDir,
        prefixes: { read: ['public'], write: ['public'] },
      }),
    );
    insertNote(db, { path: 'public/a.md', tags: ['shared', 'pub'] });
    insertNote(db, { path: 'private/b.md', tags: ['shared', 'priv'] });
    expect(tags()).toEqual([
      { tag: 'pub', count: 1 },
      { tag: 'shared', count: 1 }, // not 2 — the private note is out of scope
    ]);
  });

  test('prefix: anchored branch match, siblings excluded', () => {
    const tags = mkTags();
    insertNote(db, {
      path: 'a.md',
      tags: ['project/vaultmd', 'project/site', 'idea'],
    });
    expect(tags({ prefix: 'project/' }).map((t) => t.tag)).toEqual([
      'project/site',
      'project/vaultmd',
    ]);
  });

  test('prefix: case-sensitive — "project/" does not match "Project/"', () => {
    const tags = mkTags();
    insertNote(db, { path: 'a.md', tags: ['project/x', 'Project/y'] });
    expect(tags({ prefix: 'project/' }).map((t) => t.tag)).toEqual([
      'project/x',
    ]);
  });

  test('prefix: % and _ are literal, not wildcards', () => {
    const tags = mkTags();
    insertNote(db, { path: 'a.md', tags: ['a_b/x', 'aXb/y'] });
    expect(tags({ prefix: 'a_b/' }).map((t) => t.tag)).toEqual(['a_b/x']);
  });

  test('contains: ASCII case-insensitive substring', () => {
    const tags = mkTags();
    insertNote(db, { path: 'a.md', tags: ['Project/x', 'idea', 'reproj'] });
    expect(
      tags({ contains: 'proj' })
        .map((t) => t.tag)
        .sort(),
    ).toEqual(['Project/x', 'reproj']);
  });

  test('contains: % and _ are literal', () => {
    const tags = mkTags();
    insertNote(db, { path: 'a.md', tags: ['a_b', 'aXb'] });
    expect(tags({ contains: 'a_b' }).map((t) => t.tag)).toEqual(['a_b']);
  });

  test('prefix and contains AND together', () => {
    const tags = mkTags();
    insertNote(db, {
      path: 'a.md',
      tags: ['project/alpha', 'project/beta', 'other/alpha'],
    });
    // prefix 'project/' AND contains 'alpha' → only project/alpha qualifies
    expect(
      tags({ prefix: 'project/', contains: 'alpha' }).map((t) => t.tag),
    ).toEqual(['project/alpha']);
  });

  test('contains: non-ASCII tag is findable by exact spelling (symmetric ASCII case-fold)', () => {
    const tags = mkTags();
    insertNote(db, { path: 'a.md', tags: ['Проект/альфа', 'project/beta'] });
    // SQLite LOWER won't fold Cyrillic 'П', so the needle must NOT be
    // JS-lowercased — exact spelling must still match.
    expect(tags({ contains: 'Проект' }).map((t) => t.tag)).toEqual([
      'Проект/альфа',
    ]);
    // ASCII case-insensitivity still works:
    expect(tags({ contains: 'PROJECT' }).map((t) => t.tag)).toEqual([
      'project/beta',
    ]);
  });

  test('folder: only tags from the subtree, count scoped to subtree', () => {
    const tags = mkTags();
    insertNote(db, { path: 'daily/a.md', tags: ['journal'] });
    insertNote(db, { path: 'daily/sub/b.md', tags: ['journal', 'sub'] });
    insertNote(db, { path: 'projects/c.md', tags: ['proj'] });
    expect(tags({ folder: 'daily' })).toEqual([
      { tag: 'journal', count: 2 },
      { tag: 'sub', count: 1 },
    ]);
  });

  test('folder: % and _ in the folder name match literally', () => {
    const tags = mkTags();
    insertNote(db, { path: 'foo_1/a.md', tags: ['t1'] });
    insertNote(db, { path: 'fooX1/b.md', tags: ['t2'] });
    expect(tags({ folder: 'foo_1' }).map((t) => t.tag)).toEqual(['t1']);
  });

  test('limit: returns the top-N by count', () => {
    const tags = mkTags();
    insertNote(db, { path: 'a.md', tags: ['x'] });
    insertNote(db, { path: 'b.md', tags: ['x', 'y'] });
    insertNote(db, { path: 'c.md', tags: ['x', 'y', 'z'] });
    expect(tags({ limit: 2 })).toEqual([
      { tag: 'x', count: 3 },
      { tag: 'y', count: 2 },
    ]);
  });

  test('limit: negative throws VALIDATION_ERROR', () => {
    const tags = mkTags();
    expect(() => tags({ limit: -1 })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });

  test('limit: non-integer throws VALIDATION_ERROR', () => {
    const tags = mkTags();
    expect(() => tags({ limit: 1.5 })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });
});

describe('searchText — mixed-scope pagination (Finding 1 regression)', () => {
  test('limit=2 returns exactly 2 in-scope hits even with out-of-scope rows interleaved', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: ['pub'], write: ['pub'] },
    });
    const { searchText } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    // Insert 2 in-scope and 2 out-of-scope notes all matching the keyword
    insertNote(db, { path: 'priv/a.md', body: 'keyword content' }); // out
    insertNote(db, { path: 'pub/b.md', body: 'keyword content' }); // in
    insertNote(db, { path: 'priv/c.md', body: 'keyword content' }); // out
    insertNote(db, { path: 'pub/d.md', body: 'keyword content' }); // in
    insertNote(db, { path: 'pub/e.md', body: 'keyword content' }); // in (3rd)

    const page = searchText('keyword', { limit: 2, offset: 0 });
    expect(page).toHaveLength(2);
    for (const hit of page) {
      expect(hit.path.startsWith('pub/')).toBe(true);
    }
  });

  test('offset pages through in-scope search hits with no gaps or duplicates', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: ['pub'], write: ['pub'] },
    });
    const { searchText } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, { path: 'priv/1.md', body: 'term here' }); // out
    insertNote(db, { path: 'pub/2.md', body: 'term here' }); // in
    insertNote(db, { path: 'priv/3.md', body: 'term here' }); // out
    insertNote(db, { path: 'pub/4.md', body: 'term here' }); // in
    insertNote(db, { path: 'pub/5.md', body: 'term here' }); // in

    const page1 = searchText('term', { limit: 2, offset: 0 });
    const page2 = searchText('term', { limit: 2, offset: 2 });

    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(1);
    for (const hit of [...page1, ...page2]) {
      expect(hit.path.startsWith('pub/')).toBe(true);
    }
    const paths = [...page1, ...page2].map((h) => h.path);
    expect(new Set(paths).size).toBe(3); // no duplicates
  });
});
