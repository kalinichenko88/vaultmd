import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVaultIo } from '@/vault-io/index.ts';

import type { NoteFilter } from '../models/note-filter.ts';
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
  test('returns an object with every QueryApi method', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
      caseSensitive: false,
    });
    const q = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    expect(Object.keys(q).sort()).toEqual([
      'backlinks',
      'countNotes',
      'countSearch',
      'danglingLinks',
      'orphanNotes',
      'outboundLinks',
      'outboundMentions',
      'queryNotes',
      'searchText',
      'tags',
      'unlinkedMentions',
    ]);
  });

  test('queryNotes returns [] on an empty DB', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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

describe('queryNotes — rich where operators', () => {
  // Seeds the fixture and returns a paths-only, order-independent runner.
  function fixture(): (opts: NoteFilter) => string[] {
    const { queryNotes } = mkQuery();
    insertNote(db, {
      path: 'a.md',
      frontmatter: { status: 'open', due: '2026-07-01', priority: 1 },
    });
    insertNote(db, {
      path: 'b.md',
      frontmatter: { status: 'blocked', due: '2026-09-01', priority: 5 },
    });
    insertNote(db, { path: 'c.md', frontmatter: { status: 'done' } });
    insertNote(db, { path: 'd.md', frontmatter: {} }); // no status at all

    return (opts) =>
      queryNotes(opts)
        .map((h) => h.path)
        .sort();
  }

  test('in: set membership', () => {
    const run = fixture();
    expect(run({ where: { status: { in: ['open', 'blocked'] } } })).toEqual([
      'a.md',
      'b.md',
    ]);
  });

  test('ranges: lt / lte / gt / gte, and two bounds AND-ed', () => {
    const run = fixture();
    expect(run({ where: { due: { lt: '2026-08-01' } } })).toEqual(['a.md']);
    expect(run({ where: { priority: { gte: 5 } } })).toEqual(['b.md']);
    expect(run({ where: { priority: { gt: 1, lte: 5 } } })).toEqual(['b.md']);
    // a note missing the field never satisfies a range
    expect(run({ where: { due: { gt: '0000' } } })).toEqual(['a.md', 'b.md']);
  });

  test('ne: excludes the value AND keeps notes missing the field', () => {
    const run = fixture();
    expect(run({ where: { status: { ne: 'done' } } })).toEqual([
      'a.md',
      'b.md',
      'd.md',
    ]);
    // pair with exists to require the field
    expect(run({ where: { status: { ne: 'done', exists: true } } })).toEqual([
      'a.md',
      'b.md',
    ]);
  });

  test('exists: false selects notes lacking the field, true those having it', () => {
    const run = fixture();
    expect(run({ where: { due: { exists: false } } })).toEqual([
      'c.md',
      'd.md',
    ]);
    expect(run({ where: { due: { exists: true } } })).toEqual(['a.md', 'b.md']);
  });

  test('operator entries combine with plain equality across keys', () => {
    const run = fixture();
    expect(run({ where: { status: 'blocked', priority: { gte: 5 } } })).toEqual(
      ['b.md'],
    );
  });

  test('an injected key is rejected for every operator, table intact', () => {
    const run = fixture();
    const bad = 'a";DROP TABLE notes--';
    for (const cond of [
      { in: ['x'] },
      { ne: 'x' },
      { lt: 1 },
      { lte: 1 },
      { gt: 1 },
      { gte: 1 },
      { exists: true },
    ]) {
      expect(() => run({ where: { [bad]: cond } })).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
    }
    expect(
      db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM notes').get()?.c,
    ).toBe(4);
  });

  test('operator values holding SQL are matched literally, not executed', () => {
    const run = fixture();
    const evil = "x'); DROP TABLE notes--";
    expect(run({ where: { status: { in: [evil] } } })).toEqual([]);
    expect(run({ where: { status: { gt: evil } } })).toEqual([]);
    expect(
      db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM notes').get()?.c,
    ).toBe(4);
  });

  test('unknown operator throws VALIDATION_ERROR', () => {
    const run = fixture();
    expect(() => run({ where: { status: { like: 'x' } as never } })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });

  test('an operator named after a prototype member is unknown, not inherited', () => {
    const run = fixture();
    for (const op of ['toString', 'constructor', '__proto__']) {
      expect(() => run({ where: { status: { [op]: 'x' } as never } })).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
    }
  });

  test('non-array `in` throws VALIDATION_ERROR', () => {
    const run = fixture();
    expect(() => run({ where: { status: { in: 'open' as never } } })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });

  // An operator object that contributes no predicate would drop the whole
  // entry and hand back the entire vault — the widening these guards exist to
  // prevent. `{ in: [] }` is the way to ask for "match nothing".
  test('a condition contributing no predicate throws instead of matching all', () => {
    const run = fixture();
    const cutoff = undefined as string | undefined;
    expect(() => run({ where: { status: {} } })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
    expect(() => run({ where: { due: { lt: cutoff } } })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
    // the deliberate "match nothing" spelling still works
    expect(run({ where: { status: { in: [] } } })).toEqual([]);
  });

  test('a non-scalar operand throws VALIDATION_ERROR, not a raw SQLite error', () => {
    const run = fixture();
    for (const cond of [
      { gt: [1, 2] },
      { lt: { a: 1 } },
      { ne: null },
      { in: ['ok', { a: 1 }] },
    ]) {
      expect(() => run({ where: { priority: cond as never } })).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
    }
    // and a bare non-scalar value in the equality form
    expect(() => run({ where: { status: null as never } })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });

  test('a non-boolean `exists` throws rather than reading as true', () => {
    const run = fixture();
    // 'false' is truthy in JS — coercing it would return the exact inverse
    expect(() =>
      run({ where: { status: { exists: 'false' as never } } }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });
});

describe('queryNotes — multi-tag matching', () => {
  function run(opts: NoteFilter): string[] {
    const { queryNotes } = mkQuery();

    return queryNotes(opts)
      .map((h) => h.path)
      .sort();
  }

  beforeEach(() => {
    insertNote(db, { path: 'a.md', tags: ['project', 'active'] });
    insertNote(db, { path: 'b.md', tags: ['project'] });
    insertNote(db, { path: 'c.md', tags: ['active', 'archive'] });
    insertNote(db, { path: 'd.md', tags: [] });
  });

  test('all: every tag must be present', () => {
    expect(run({ tags: { all: ['project', 'active'] } })).toEqual(['a.md']);
    expect(run({ tags: { all: [] } })).toEqual([
      'a.md',
      'b.md',
      'c.md',
      'd.md',
    ]);
  });

  test('any: at least one tag must be present; empty matches nothing', () => {
    expect(run({ tags: { any: ['project', 'archive'] } })).toEqual([
      'a.md',
      'b.md',
      'c.md',
    ]);
    expect(run({ tags: { any: [] } })).toEqual([]);
  });

  test('all + any + the tag shorthand are AND-ed together', () => {
    expect(
      run({ tag: 'project', tags: { all: ['active'], any: ['active'] } }),
    ).toEqual(['a.md']);
  });

  test('tag values holding SQL are parameterised', () => {
    expect(run({ tags: { any: ["x'); DROP TABLE note_tags--"] } })).toEqual([]);
    expect(
      db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM note_tags').get()
        ?.c,
    ).toBe(5);
  });

  // A bare string would otherwise iterate/spread character-by-character into
  // the IN-list and report "no notes have this tag" for a tag that exists.
  test('a non-array or non-string tag list throws VALIDATION_ERROR', () => {
    for (const tags of [
      { all: 'project' },
      { any: 'project' },
      { all: ['project', 7] },
      { any: [null] },
    ]) {
      expect(() => run({ tags: tags as never })).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
    }
  });
});

describe('searchText / countSearch — shared note filters', () => {
  beforeEach(() => {
    insertNote(db, {
      path: 'a.md',
      body: 'hello world',
      tags: ['project', 'active'],
      frontmatter: { status: 'open', priority: 1 },
    });
    insertNote(db, {
      path: 'b.md',
      body: 'hello world',
      tags: ['project'],
      frontmatter: { status: 'done', priority: 9 },
    });
    insertNote(db, {
      path: 'c.md',
      body: 'hello world',
      tags: ['archive'],
      frontmatter: {},
    });
  });

  test('honours tags.all / tags.any alongside the FTS match', () => {
    const q = mkQuery();
    expect(
      q
        .searchText('hello', { tags: { all: ['project', 'active'] } })
        .map((h) => h.path),
    ).toEqual(['a.md']);
    expect(
      q.countSearch('hello', { tags: { any: ['project', 'archive'] } }),
    ).toBe(3);
    expect(q.countSearch('hello', { tags: { any: [] } })).toBe(0);
  });

  test('honours where operators alongside the FTS match', () => {
    const q = mkQuery();
    expect(
      q
        .searchText('hello', { where: { priority: { lt: 5 } } })
        .map((h) => h.path),
    ).toEqual(['a.md']);
    expect(
      q
        .searchText('hello', { where: { status: { exists: false } } })
        .map((h) => h.path),
    ).toEqual(['c.md']);
    expect(q.countSearch('hello', { where: { status: { ne: 'done' } } })).toBe(
      2,
    );
  });

  test('countSearch agrees with searchText on the same filters', () => {
    const q = mkQuery();
    const filters = {
      tag: 'project',
      where: { status: { in: ['open', 'done'] } },
    };
    expect(q.countSearch('hello', filters)).toBe(
      q.searchText('hello', filters).length,
    );
    expect(q.countSearch('hello', filters)).toBe(2);
  });

  // The bare `catch { return [] }` this path used to carry would have turned a
  // filter fault into a plausible-looking empty result set.
  test('a filter fault surfaces as an error, not an empty hit list', () => {
    const q = mkQuery();
    expect(() => q.searchText('hello', { where: { 'bad key!': 'x' } })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
    expect(() =>
      q.countSearch('hello', { tags: { any: 'project' as never } }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });
});

// ── Cycle 3: backlinks ───────────────────────────────────────────────────────
describe('backlinks — relative mode', () => {
  test('returns source notes whose stored target matches the path key', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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

describe('searchText — relevance score', () => {
  test('every hit carries a positive score, best match highest, matching rank order', () => {
    insertNote(db, { path: 'strong.md', body: 'fox fox fox fox' });
    insertNote(db, {
      path: 'weak.md',
      body: `fox ${'unrelated padding words '.repeat(20)}`,
    });
    const hits = mkQuery().searchText('fox');
    expect(hits.map((h) => h.path)).toEqual(['strong.md', 'weak.md']);
    for (const hit of hits) {
      expect(hit.score).toBeGreaterThan(0);
    }
    // The contract callers thread on: score DESC is the order rows arrive in,
    // so `hits[0]` is also `max(score)` and a threshold reads the same way the
    // list does.
    expect(hits[0].score).toBeGreaterThan(hits[1].score as number);
  });

  test('score is the negation of fts5 bm25 rank, not the raw value', () => {
    insertNote(db, { path: 'a.md', body: 'the quick brown fox' });
    const [hit] = mkQuery().searchText('fox');
    const raw = db
      .query<{ rank: number }, [string]>(
        'SELECT rank FROM notes_fts WHERE notes_fts MATCH ?',
      )
      .get('"fox"');
    // fts5 ranks negative-is-better; the exported score is the mirror of it.
    expect(raw?.rank).toBeLessThan(0);
    expect(hit.score).toBe(-(raw?.rank as number));
  });
});

describe('searchText — basic search + filters + read-scope', () => {
  test('finds a note by body keyword', () => {
    const io = createVaultIo({
      root: vaultDir,
      prefixes: { read: [''], write: [''] },
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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
        caseSensitive: false,
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
      caseSensitive: false,
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
      caseSensitive: false,
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

// Query instance over the shared fixture db: whole-vault scope, wikilink
// resolution, case-INSENSITIVE. Not auto-detected — insertNote always stores
// path_key lower-cased, so the fixture is a case-insensitive vault by
// construction, and letting the io detect the host filesystem instead would
// make every path_key lookup in this file pass on macOS and fail on Linux CI.
function mkQuery(
  opts: {
    read?: string[];
    linkResolution?: 'wikilink' | 'relative';
    caseSensitive?: boolean;
  } = {},
) {
  const {
    read = [''],
    linkResolution = 'wikilink',
    caseSensitive = false,
  } = opts;
  const io = createVaultIo({
    root: vaultDir,
    prefixes: { read, write: [''] },
    caseSensitive,
  });

  return createQuery(db, io, { linkResolution, caseSensitive, ignore: [] });
}

// ── 1.0 API completeness ─────────────────────────────────────────────────────
describe('queryNotes — mtime_ms / size passthrough', () => {
  test('carries the indexed mtime_ms and size the order field sorts by', () => {
    insertNote(db, { path: 'a.md', body: 'hello' });
    db.query('UPDATE notes SET mtime_ms = ? WHERE path = ?').run(1234, 'a.md');
    const [hit] = mkQuery().queryNotes();
    expect(hit.mtime_ms).toBe(1234);
    expect(hit.size).toBe(5);
  });
});

describe('countNotes', () => {
  test('is 0 on an empty DB', () => {
    expect(mkQuery().countNotes()).toBe(0);
  });

  test('counts every match, not just the first page', () => {
    for (let i = 0; i < 5; i++) {
      insertNote(db, { path: `n${i}.md`, tags: ['idea'] });
    }
    const q = mkQuery();
    expect(q.queryNotes({ limit: 2 })).toHaveLength(2);
    expect(q.countNotes()).toBe(5);
    expect(q.countNotes({ tag: 'idea' })).toBe(5);
    expect(q.countNotes({ tag: 'missing' })).toBe(0);
  });

  test('applies the same tag / where / folder filters as queryNotes', () => {
    insertNote(db, {
      path: 'Notes/a.md',
      tags: ['idea'],
      frontmatter: { status: 'open' },
    });
    insertNote(db, {
      path: 'Notes/b.md',
      tags: ['idea'],
      frontmatter: { status: 'done' },
    });
    insertNote(db, { path: 'Other/c.md', tags: ['idea'] });
    const q = mkQuery();
    const filters = { tag: 'idea', where: { status: 'open' } };
    expect(q.countNotes(filters)).toBe(q.queryNotes(filters).length);
    expect(q.countNotes(filters)).toBe(1);
    expect(q.countNotes({ folder: 'Notes' })).toBe(2);
  });

  test('excludes notes outside the read scope', () => {
    insertNote(db, { path: 'Notes/a.md' });
    insertNote(db, { path: 'Private/b.md' });
    expect(mkQuery({ read: ['Notes/'] }).countNotes()).toBe(1);
  });

  test('rejects an invalid where key like queryNotes does', () => {
    expect(() => mkQuery().countNotes({ where: { 'bad key!': 1 } })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });

  test('applies where operators and tags exactly as queryNotes does', () => {
    insertNote(db, {
      path: 'a.md',
      tags: ['idea', 'active'],
      frontmatter: { priority: 3 },
    });
    insertNote(db, { path: 'b.md', tags: ['idea'], frontmatter: {} });
    insertNote(db, {
      path: 'c.md',
      tags: ['idea', 'active'],
      frontmatter: { priority: 9 },
    });
    const q = mkQuery();
    const filters = {
      tags: { all: ['idea', 'active'] },
      where: { priority: { lt: 5 } },
    };
    expect(q.countNotes(filters)).toBe(q.queryNotes(filters).length);
    expect(q.countNotes(filters)).toBe(1);
    expect(q.countNotes({ where: { priority: { exists: false } } })).toBe(1);
  });
});

describe('countSearch', () => {
  test('counts all hits beyond the requested page', () => {
    for (let i = 0; i < 4; i++) {
      insertNote(db, { path: `n${i}.md`, body: 'shared keyword here' });
    }
    const q = mkQuery();
    expect(q.searchText('keyword', { limit: 2 })).toHaveLength(2);
    expect(q.countSearch('keyword')).toBe(4);
  });

  test('honours tag / folder filters and the read scope', () => {
    insertNote(db, { path: 'Notes/a.md', body: 'keyword', tags: ['idea'] });
    insertNote(db, { path: 'Notes/b.md', body: 'keyword' });
    insertNote(db, { path: 'Private/c.md', body: 'keyword' });
    expect(mkQuery().countSearch('keyword')).toBe(3);
    expect(mkQuery().countSearch('keyword', { tag: 'idea' })).toBe(1);
    expect(mkQuery().countSearch('keyword', { folder: 'Notes' })).toBe(2);
    expect(mkQuery({ read: ['Notes/'] }).countSearch('keyword')).toBe(2);
  });

  test('is 0 for a query that sanitizes to nothing', () => {
    insertNote(db, { path: 'a.md', body: 'keyword' });
    expect(mkQuery().countSearch('   ')).toBe(0);
  });
});

describe('danglingLinks', () => {
  test('is [] when every link resolves', () => {
    insertNote(db, {
      path: 'a.md',
      links: [{ target: 'b', base: 'b', kind: 'wikilink' }],
    });
    insertNote(db, { path: 'b.md' });
    expect(mkQuery().danglingLinks()).toEqual([]);
  });

  test('reports a wikilink pointing at no note', () => {
    insertNote(db, {
      path: 'a.md',
      links: [{ target: 'ghost', base: 'ghost', kind: 'wikilink' }],
    });
    expect(mkQuery().danglingLinks()).toEqual([
      { from: 'a.md', target: 'ghost' },
    ]);
  });

  test('reports a path-qualified wikilink whose folder target is gone', () => {
    insertNote(db, {
      path: 'a.md',
      links: [{ target: 'Folder/Gone', base: 'gone', kind: 'wikilink' }],
    });
    expect(mkQuery().danglingLinks()).toEqual([
      { from: 'a.md', target: 'Folder/Gone' },
    ]);
  });

  test('reports a dead relative link in relative mode', () => {
    insertNote(db, {
      path: 'a.md',
      links: [{ target: 'gone.md', base: null, kind: 'mdlink' }],
    });
    expect(mkQuery({ linkResolution: 'relative' }).danglingLinks()).toEqual([
      { from: 'a.md', target: 'gone.md' },
    ]);
  });

  test('ignores attachment embeds, which can never resolve to a note', () => {
    insertNote(db, {
      path: 'a.md',
      links: [
        { target: 'diagram.png', base: 'diagram.png', kind: 'embed' },
        { target: 'clip.mp4', base: 'clip.mp4', kind: 'embed' },
      ],
    });
    expect(mkQuery().danglingLinks()).toEqual([]);
  });

  test('still reports a transclusion of a missing note, extension-free', () => {
    insertNote(db, {
      path: 'a.md',
      links: [{ target: 'Ghost Note', base: 'ghost note', kind: 'embed' }],
    });
    expect(mkQuery().danglingLinks()).toEqual([
      { from: 'a.md', target: 'Ghost Note' },
    ]);
  });

  test('a note title ending in a numeric segment is not mistaken for a file', () => {
    insertNote(db, {
      path: 'a.md',
      links: [{ target: 'Chapter 1.2', base: 'chapter 1.2', kind: 'embed' }],
    });
    expect(mkQuery().danglingLinks()).toEqual([
      { from: 'a.md', target: 'Chapter 1.2' },
    ]);
  });

  test('skips links from notes outside the read scope', () => {
    insertNote(db, {
      path: 'Private/a.md',
      links: [{ target: 'ghost', base: 'ghost', kind: 'wikilink' }],
    });
    insertNote(db, {
      path: 'Notes/b.md',
      links: [{ target: 'ghost', base: 'ghost', kind: 'wikilink' }],
    });
    expect(mkQuery({ read: ['Notes/'] }).danglingLinks()).toEqual([
      { from: 'Notes/b.md', target: 'ghost' },
    ]);
  });

  test('a link resolving only to an out-of-scope note counts as dangling', () => {
    insertNote(db, {
      path: 'Notes/a.md',
      links: [{ target: 'secret', base: 'secret', kind: 'wikilink' }],
    });
    insertNote(db, { path: 'Private/secret.md' });
    expect(mkQuery({ read: ['Notes/'] }).danglingLinks()).toEqual([
      { from: 'Notes/a.md', target: 'secret' },
    ]);
  });

  test('paginates after the scope filter', () => {
    for (let i = 0; i < 3; i++) {
      insertNote(db, {
        path: `n${i}.md`,
        links: [{ target: `ghost${i}`, base: `ghost${i}`, kind: 'wikilink' }],
      });
    }
    const q = mkQuery();
    expect(q.danglingLinks({ limit: 2 })).toHaveLength(2);
    expect(q.danglingLinks({ limit: 2, offset: 2 })).toEqual([
      { from: 'n2.md', target: 'ghost2' },
    ]);
  });
});

// ── review regressions ───────────────────────────────────────────────────────
describe('danglingLinks — review regressions', () => {
  test('a mixed-case relative link resolves on a case-insensitive vault', () => {
    insertNote(db, { path: 'Notes/Target.md' });
    insertNote(db, {
      path: 'Source.md',
      links: [{ target: 'Notes/Target.md', base: null, kind: 'mdlink' }],
    });
    const q = mkQuery({ linkResolution: 'relative' });
    expect(q.outboundLinks('Source.md')).toEqual([
      { target: 'Notes/Target.md', resolved: 'Notes/Target.md' },
    ]);
    expect(q.danglingLinks()).toEqual([]);
  });

  test('a broken transclusion whose title ends in a dot segment is reported', () => {
    for (const target of [
      'Meeting 2024.Q1',
      'Draft.v2',
      'Release notes.beta',
      'config.prod',
    ]) {
      insertNote(db, {
        path: `${target}-src.md`,
        links: [{ target, base: target.toLowerCase(), kind: 'embed' }],
      });
    }
    expect(
      mkQuery()
        .danglingLinks()
        .map((d) => d.target)
        .sort(),
    ).toEqual([
      'Draft.v2',
      'Meeting 2024.Q1',
      'Release notes.beta',
      'config.prod',
    ]);
  });

  test('a plain (non-embed) wikilink to an attachment is not reported', () => {
    insertNote(db, {
      path: 'a.md',
      links: [
        { target: 'diagram.png', base: 'diagram.png', kind: 'wikilink' },
        { target: 'notes.pdf', base: 'notes.pdf', kind: 'wikilink' },
      ],
    });
    expect(mkQuery().danglingLinks()).toEqual([]);
  });

  test('a note whose whole title is an extension word is still checked', () => {
    insertNote(db, {
      path: 'a.md',
      links: [{ target: 'zip', base: 'zip', kind: 'wikilink' }],
    });
    expect(mkQuery().danglingLinks()).toEqual([
      { from: 'a.md', target: 'zip' },
    ]);
  });

  test('the same missing target linked and embedded is reported once', () => {
    insertNote(db, {
      path: 'a.md',
      links: [
        { target: 'ghost', base: 'ghost', kind: 'wikilink' },
        { target: 'ghost', base: 'ghost', kind: 'embed' },
      ],
    });
    expect(mkQuery().danglingLinks()).toEqual([
      { from: 'a.md', target: 'ghost' },
    ]);
  });

  test('the base index agrees with the per-link scan on tie-breaks', () => {
    // Two notes share a basename; the bare link must win toward its own folder,
    // the same way outboundLinks (which does not build the index) resolves it.
    insertNote(db, { path: 'Notes/dup.md' });
    insertNote(db, { path: 'Other/dup.md' });
    insertNote(db, {
      path: 'Other/src.md',
      links: [{ target: 'dup', base: 'dup', kind: 'wikilink' }],
    });
    const q = mkQuery();
    expect(q.outboundLinks('Other/src.md')).toEqual([
      { target: 'dup', resolved: 'Other/dup.md' },
    ]);
    expect(q.danglingLinks()).toEqual([]);
  });
});

// ── issue #10: link-graph gaps ───────────────────────────────────────────────
describe('orphanNotes', () => {
  test('is [] on an empty DB', () => {
    expect(mkQuery().orphanNotes()).toEqual([]);
  });

  test('reports a note with no links at all in both modes', () => {
    insertNote(db, { path: 'lonely.md' });
    const q = mkQuery();
    expect(q.orphanNotes().map((n) => n.path)).toEqual(['lonely.md']);
    expect(q.orphanNotes({ mode: 'unreferenced' }).map((n) => n.path)).toEqual([
      'lonely.md',
    ]);
  });

  test('reports a note with an inbound link in neither mode', () => {
    insertNote(db, {
      path: 'src.md',
      links: [{ target: 'target', base: 'target', kind: 'wikilink' }],
    });
    insertNote(db, { path: 'target.md' });
    const q = mkQuery();
    expect(q.orphanNotes().map((n) => n.path)).not.toContain('target.md');
    expect(
      q.orphanNotes({ mode: 'unreferenced' }).map((n) => n.path),
    ).not.toContain('target.md');
  });

  test('a note with only outbound links is unreferenced but not disconnected', () => {
    insertNote(db, {
      path: 'src.md',
      links: [{ target: 'target', base: 'target', kind: 'wikilink' }],
    });
    insertNote(db, { path: 'target.md' });
    const q = mkQuery();
    expect(q.orphanNotes().map((n) => n.path)).toEqual([]);
    expect(q.orphanNotes({ mode: 'unreferenced' }).map((n) => n.path)).toEqual([
      'src.md',
    ]);
  });

  test('a dangling link still counts as an outgoing edge', () => {
    insertNote(db, {
      path: 'src.md',
      links: [{ target: 'ghost', base: 'ghost', kind: 'wikilink' }],
    });
    const q = mkQuery();
    expect(q.orphanNotes().map((n) => n.path)).toEqual([]);
    expect(q.orphanNotes({ mode: 'unreferenced' }).map((n) => n.path)).toEqual([
      'src.md',
    ]);
  });

  test('an attachment link is not a graph edge in either direction', () => {
    insertNote(db, {
      path: 'src.md',
      links: [{ target: 'diagram.png', base: 'diagram.png', kind: 'embed' }],
    });
    expect(
      mkQuery()
        .orphanNotes()
        .map((n) => n.path),
    ).toEqual(['src.md']);
  });

  test('an embed of a note is an edge, exactly like a wikilink', () => {
    insertNote(db, {
      path: 'src.md',
      links: [{ target: 'target', base: 'target', kind: 'embed' }],
    });
    insertNote(db, { path: 'target.md' });
    expect(mkQuery().orphanNotes()).toEqual([]);
  });

  test('a self-link keeps a note out of both modes', () => {
    insertNote(db, {
      path: 'self.md',
      links: [{ target: 'self', base: 'self', kind: 'wikilink' }],
    });
    const q = mkQuery();
    expect(q.orphanNotes()).toEqual([]);
    expect(q.orphanNotes({ mode: 'unreferenced' })).toEqual([]);
  });

  test('an inbound link from an out-of-scope source does not count', () => {
    insertNote(db, {
      path: 'Private/src.md',
      links: [{ target: 'Notes/target', base: 'target', kind: 'wikilink' }],
    });
    insertNote(db, { path: 'Notes/target.md' });
    expect(
      mkQuery({ read: ['Notes/'] })
        .orphanNotes({ mode: 'unreferenced' })
        .map((n) => n.path),
    ).toEqual(['Notes/target.md']);
  });

  test('a bare wikilink leaves the tie-break loser unreferenced', () => {
    insertNote(db, { path: 'dup.md' });
    insertNote(db, { path: 'Deep/dup.md' });
    insertNote(db, {
      path: 'src.md',
      links: [{ target: 'dup', base: 'dup', kind: 'wikilink' }],
    });
    // `dup.md` wins the tie-break toward the source's own folder, so only the
    // loser is left without an inbound edge (as is the linking note itself).
    expect(
      mkQuery()
        .orphanNotes({ mode: 'unreferenced' })
        .map((n) => n.path)
        .sort(),
    ).toEqual(['Deep/dup.md', 'src.md']);
  });

  test('resolves inbound edges by path key in relative mode', () => {
    insertNote(db, {
      path: 'src.md',
      links: [{ target: 'Notes/Target.md', base: null, kind: 'mdlink' }],
    });
    insertNote(db, { path: 'Notes/Target.md', pathKey: 'notes/target.md' });
    expect(
      mkQuery({ linkResolution: 'relative' })
        .orphanNotes({ mode: 'unreferenced' })
        .map((n) => n.path),
    ).toEqual(['src.md']);
  });

  test('applies the same NoteFilter and orderBy as queryNotes', () => {
    insertNote(db, { path: 'Notes/a.md', tags: ['idea'] });
    insertNote(db, { path: 'Notes/b.md' });
    insertNote(db, { path: 'Other/c.md', tags: ['idea'] });
    const q = mkQuery();
    expect(
      q
        .orphanNotes({ tag: 'idea' })
        .map((n) => n.path)
        .sort(),
    ).toEqual(['Notes/a.md', 'Other/c.md']);
    expect(
      q
        .orphanNotes({ folder: 'Notes' })
        .map((n) => n.path)
        .sort(),
    ).toEqual(['Notes/a.md', 'Notes/b.md']);
    expect(
      q
        .orphanNotes({ orderBy: { field: 'path', dir: 'asc' } })
        .map((n) => n.path),
    ).toEqual(['Notes/a.md', 'Notes/b.md', 'Other/c.md']);
  });

  test('fills pages exactly after the orphan filter', () => {
    // Orphans and linked notes interleave by path order; a page must carry
    // `limit` orphans, not `limit` rows thinned down by the filter.
    for (let i = 0; i < 4; i++) {
      insertNote(db, { path: `orphan${i}.md` });
      insertNote(db, {
        path: `linked${i}.md`,
        links: [{ target: `hub${i}`, base: `hub${i}`, kind: 'wikilink' }],
      });
      insertNote(db, { path: `hub${i}.md` });
    }
    const q = mkQuery();
    const order = { field: 'path', dir: 'asc' } as const;
    expect(
      q.orphanNotes({ orderBy: order, limit: 2 }).map((n) => n.path),
    ).toEqual(['orphan0.md', 'orphan1.md']);
    expect(
      q.orphanNotes({ orderBy: order, limit: 2, offset: 2 }).map((n) => n.path),
    ).toEqual(['orphan2.md', 'orphan3.md']);
  });

  test('throws VALIDATION_ERROR on an unknown mode', () => {
    expect(() =>
      mkQuery().orphanNotes({ mode: 'lonely' as 'disconnected' }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });
});

describe('unlinkedMentions', () => {
  test('reports a note naming the target in prose, with a snippet', () => {
    insertNote(db, { path: 'Alpha.md' });
    insertNote(db, {
      path: 'journal.md',
      body: 'we kicked off Alpha today and it went well',
    });
    expect(mkQuery().unlinkedMentions('Alpha.md')).toEqual([
      {
        path: 'journal.md',
        title: 'journal',
        snippet: 'we kicked off <b>Alpha</b> today and it went well',
      },
    ]);
  });

  test('excludes a note that already links, text or not', () => {
    insertNote(db, { path: 'Alpha.md' });
    insertNote(db, {
      path: 'linker.md',
      body: 'see [[Alpha]] for context',
      links: [{ target: 'Alpha', base: 'alpha', kind: 'wikilink' }],
    });
    expect(mkQuery().unlinkedMentions('Alpha.md')).toEqual([]);
  });

  test('the linker exclusion is not capped at a page of backlinks', () => {
    insertNote(db, { path: 'Alpha.md' });
    for (let i = 0; i < 150; i++) {
      insertNote(db, {
        path: `linker${i}.md`,
        body: 'mentions Alpha and links it',
        links: [{ target: 'Alpha', base: 'alpha', kind: 'wikilink' }],
      });
    }
    insertNote(db, { path: 'prose.md', body: 'Alpha came up again' });
    expect(
      mkQuery()
        .unlinkedMentions('Alpha.md')
        .map((h) => h.path),
    ).toEqual(['prose.md']);
  });

  test('excludes the note itself', () => {
    insertNote(db, {
      path: 'Alpha.md',
      body: '# Alpha\n\nAlpha is a project.',
    });
    expect(mkQuery().unlinkedMentions('Alpha.md')).toEqual([]);
  });

  test('matches an alias, as a list or a bare scalar, and coerces numbers', () => {
    insertNote(db, {
      path: 'Alpha.md',
      frontmatter: { aliases: ['AI thing', 2024] },
    });
    insertNote(db, { path: 'Beta.md', frontmatter: { aliases: 'Bee' } });
    insertNote(db, { path: 'm1.md', body: 'the AI thing shipped' });
    insertNote(db, { path: 'm2.md', body: 'back in 2024 we tried' });
    insertNote(db, { path: 'm3.md', body: 'Bee handled it' });
    const q = mkQuery();
    expect(
      q
        .unlinkedMentions('Alpha.md')
        .map((h) => h.path)
        .sort(),
    ).toEqual(['m1.md', 'm2.md']);
    expect(q.unlinkedMentions('Beta.md').map((h) => h.path)).toEqual(['m3.md']);
  });

  test('matches an explicit frontmatter title but never an H1-derived one', () => {
    insertNote(db, {
      path: '2026-07-29.md',
      title: 'Release Retro',
      frontmatter: { title: 'Release Retro' },
    });
    // title column set, but derived from an H1 — not a name the note answers to
    insertNote(db, { path: 'misc.md', title: 'Overview' });
    insertNote(db, { path: 'm1.md', body: 'the Release Retro was useful' });
    insertNote(db, { path: 'm2.md', body: 'a general Overview of things' });
    const q = mkQuery();
    expect(q.unlinkedMentions('2026-07-29.md').map((h) => h.path)).toEqual([
      'm1.md',
    ]);
    expect(q.unlinkedMentions('misc.md')).toEqual([]);
  });

  test('needs the name contiguous, not its words scattered', () => {
    insertNote(db, { path: 'Project Alpha.md' });
    insertNote(db, {
      path: 'scattered.md',
      body: 'the project shipped. alpha builds followed.',
    });
    insertNote(db, { path: 'contiguous.md', body: 'Project Alpha shipped' });
    expect(
      mkQuery()
        .unlinkedMentions('Project Alpha.md')
        .map((h) => h.path),
    ).toEqual(['contiguous.md']);
  });

  test('verifies fts candidates, so a punctuation name does not match its tokens', () => {
    insertNote(db, { path: 'C++.md' });
    insertNote(db, { path: 'letter.md', body: 'option c was chosen' });
    insertNote(db, { path: 'real.md', body: 'written in C++ back then' });
    expect(
      mkQuery()
        .unlinkedMentions('C++.md')
        .map((h) => h.path),
    ).toEqual(['real.md']);
  });

  test('is case-insensitive and never matches inside a longer word', () => {
    insertNote(db, { path: 'cat.md' });
    insertNote(db, { path: 'inside.md', body: 'the catalogue is long' });
    insertNote(db, { path: 'whole.md', body: 'the CAT sat down' });
    expect(
      mkQuery()
        .unlinkedMentions('cat.md')
        .map((h) => h.path),
    ).toEqual(['whole.md']);
  });

  test('honours the read scope on both ends, and unknown paths', () => {
    insertNote(db, { path: 'Notes/Alpha.md' });
    insertNote(db, { path: 'Private/secret.md', body: 'Alpha leaked here' });
    insertNote(db, { path: 'Notes/ok.md', body: 'Alpha is fine' });
    const q = mkQuery({ read: ['Notes/'] });
    expect(q.unlinkedMentions('Notes/Alpha.md').map((h) => h.path)).toEqual([
      'Notes/ok.md',
    ]);
    expect(q.unlinkedMentions('Private/secret.md')).toEqual([]);
    expect(q.unlinkedMentions('Notes/nope.md')).toEqual([]);
  });

  test('paginates', () => {
    insertNote(db, { path: 'Alpha.md' });
    for (let i = 0; i < 4; i++) {
      insertNote(db, { path: `m${i}.md`, body: 'Alpha again' });
    }
    const q = mkQuery();
    expect(q.unlinkedMentions('Alpha.md', { limit: 2 })).toHaveLength(2);
    expect(
      q.unlinkedMentions('Alpha.md', { limit: 2, offset: 2 }),
    ).toHaveLength(2);
    expect(q.unlinkedMentions('Alpha.md', { limit: 2, offset: 4 })).toEqual([]);
  });
});

describe('outboundMentions', () => {
  test('reports another note named in this body', () => {
    insertNote(db, { path: 'journal.md', body: 'talked about Alpha at lunch' });
    insertNote(db, { path: 'Alpha.md' });
    expect(mkQuery().outboundMentions('journal.md')).toEqual([
      {
        path: 'Alpha.md',
        title: 'Alpha',
        snippet: 'talked about <b>Alpha</b> at lunch',
      },
    ]);
  });

  test('excludes a note this one already links', () => {
    insertNote(db, {
      path: 'journal.md',
      body: 'see [[Alpha]] and also Beta',
      links: [{ target: 'Alpha', base: 'alpha', kind: 'wikilink' }],
    });
    insertNote(db, { path: 'Alpha.md' });
    insertNote(db, { path: 'Beta.md' });
    expect(
      mkQuery()
        .outboundMentions('journal.md')
        .map((h) => h.path),
    ).toEqual(['Beta.md']);
  });

  test('excludes the note itself', () => {
    insertNote(db, { path: 'Alpha.md', body: '# Alpha\n\nAlpha again' });
    expect(mkQuery().outboundMentions('Alpha.md')).toEqual([]);
  });

  test('needs a word boundary, in Latin and in Cyrillic', () => {
    insertNote(db, {
      path: 'src.md',
      body: 'the catalogue is long. Проект Альфа стартовал.',
    });
    insertNote(db, { path: 'cat.md' });
    insertNote(db, { path: 'Альфа.md' });
    expect(
      mkQuery()
        .outboundMentions('src.md')
        .map((h) => h.path),
    ).toEqual(['Альфа.md']);
  });

  test('survives regex metacharacters in a note name', () => {
    insertNote(db, {
      path: 'src.md',
      body: 'written in C++ during Meeting 1, not Meeting [1]',
    });
    insertNote(db, { path: 'C++.md' });
    insertNote(db, { path: 'Meeting [1].md' });
    const hits = mkQuery().outboundMentions('src.md');
    // `C++` matches literally; `Meeting [1]` must not be read as a character
    // class and match the text "Meeting 1" — it matches its own literal text.
    expect(hits.map((h) => h.path).sort()).toEqual([
      'C++.md',
      'Meeting [1].md',
    ]);
    expect(hits.find((h) => h.path === 'Meeting [1].md')?.snippet).toContain(
      '<b>Meeting [1]</b>',
    );
  });

  test('matches another note by alias', () => {
    insertNote(db, { path: 'src.md', body: 'the AI thing shipped' });
    insertNote(db, {
      path: 'Alpha.md',
      frontmatter: { aliases: ['AI thing'] },
    });
    expect(
      mkQuery()
        .outboundMentions('src.md')
        .map((h) => h.path),
    ).toEqual(['Alpha.md']);
  });

  test('orders by where the mention falls, not by path', () => {
    insertNote(db, { path: 'src.md', body: 'Zeta came first, Alpha second' });
    insertNote(db, { path: 'Alpha.md' });
    insertNote(db, { path: 'Zeta.md' });
    expect(
      mkQuery()
        .outboundMentions('src.md')
        .map((h) => h.path),
    ).toEqual(['Zeta.md', 'Alpha.md']);
  });

  test('never names a note outside the read scope', () => {
    insertNote(db, {
      path: 'Notes/src.md',
      body: 'about secret and about ok',
    });
    insertNote(db, { path: 'Private/secret.md' });
    insertNote(db, { path: 'Notes/ok.md' });
    expect(
      mkQuery({ read: ['Notes/'] })
        .outboundMentions('Notes/src.md')
        .map((h) => h.path),
    ).toEqual(['Notes/ok.md']);
  });

  test('is [] for a note with no indexed body, and for unknown paths', () => {
    insertNote(db, { path: 'empty.md' });
    insertNote(db, { path: 'Alpha.md' });
    const q = mkQuery();
    expect(q.outboundMentions('empty.md')).toEqual([]);
    expect(q.outboundMentions('nope.md')).toEqual([]);
  });

  test('excludes an already-linked note in relative mode too', () => {
    insertNote(db, {
      path: 'src.md',
      body: 'see [Alpha](Alpha.md) and also Beta',
      links: [{ target: 'Alpha.md', base: null, kind: 'mdlink' }],
    });
    insertNote(db, { path: 'Alpha.md' });
    insertNote(db, { path: 'Beta.md' });
    expect(
      mkQuery({ linkResolution: 'relative' })
        .outboundMentions('src.md')
        .map((h) => h.path),
    ).toEqual(['Beta.md']);
  });

  test('paginates', () => {
    insertNote(db, { path: 'src.md', body: 'one two three four' });
    for (const name of ['one', 'two', 'three', 'four']) {
      insertNote(db, { path: `${name}.md` });
    }
    const q = mkQuery();
    expect(
      q.outboundMentions('src.md', { limit: 2 }).map((h) => h.path),
    ).toEqual(['one.md', 'two.md']);
    expect(
      q.outboundMentions('src.md', { limit: 2, offset: 2 }).map((h) => h.path),
    ).toEqual(['three.md', 'four.md']);
  });
});

describe('mentions — documented limits and cross-method agreement', () => {
  test('a name embedded in unsegmented CJK text is NOT found either way', () => {
    // Locked, not aspirational: unicode61 makes 我去了东京旅行 one token, and the
    // word-boundary matcher sees 了 as a letter. Obsidian finds these; we do
    // not. Changing that means a trigram tokenizer and a schema bump.
    insertNote(db, { path: '东京.md' });
    insertNote(db, { path: 'trip.md', body: '我去了东京旅行' });
    const q = mkQuery();
    expect(q.unlinkedMentions('东京.md')).toEqual([]);
    expect(q.outboundMentions('trip.md')).toEqual([]);
    // …while a delimited occurrence is found, so the limit is the boundary,
    // not the script.
    insertNote(db, { path: 'spaced.md', body: '週末は 东京 に行った' });
    expect(q.unlinkedMentions('东京.md').map((h) => h.path)).toEqual([
      'spaced.md',
    ]);
  });

  test('both methods report the same mention from opposite ends', () => {
    insertNote(db, { path: 'journal.md', body: 'kicked off Alpha today' });
    insertNote(db, { path: 'Alpha.md' });
    const q = mkQuery();
    const inbound = q.unlinkedMentions('Alpha.md');
    const outbound = q.outboundMentions('journal.md');
    expect(inbound.map((h) => h.path)).toEqual(['journal.md']);
    expect(outbound.map((h) => h.path)).toEqual(['Alpha.md']);
    // Same body, same matcher, so the excerpt is identical from either side.
    expect(inbound[0].snippet).toBe(outbound[0].snippet);
  });

  test('neither mention method carries a score — the key is absent, not undefined', () => {
    insertNote(db, { path: 'Alpha.md' });
    insertNote(db, { path: 'journal.md', body: 'kicked off Alpha today' });
    const q = mkQuery();

    // `in`, not `=== undefined`: a consumer feature-detecting the field must
    // not find a present-but-undefined key.
    const hits = [
      ...q.unlinkedMentions('Alpha.md'),
      ...q.outboundMentions('journal.md'),
    ];
    expect(hits).toHaveLength(2);
    for (const hit of hits) {
      expect('score' in hit).toBe(false);
    }
  });
});

// ── review round 1: verified findings ────────────────────────────────────────
describe('mentions — read scope is judged on the canonical row, not the caller string', () => {
  test('a case-variant path cannot reach an out-of-scope note body', () => {
    // The allowlist matches the caller's spelling case-sensitively, but the row
    // is fetched by the case-folded path_key — so 'Notes/secret.md' passes the
    // prefix check and lands on the unreadable 'notes/secret.md'.
    insertNote(db, {
      path: 'notes/secret.md',
      body: 'CONFIDENTIAL merger with pub closes Friday',
    });
    insertNote(db, { path: 'Notes/pub.md', body: 'nothing to see' });
    const q = mkQuery({ read: ['Notes/'] });
    // The scope filter works for the plain readers…
    expect(q.queryNotes().map((n) => n.path)).toEqual(['Notes/pub.md']);
    // …so a snippet quoting that unreadable body must not come back either.
    expect(q.outboundMentions('Notes/secret.md')).toEqual([]);
    expect(q.unlinkedMentions('Notes/secret.md')).toEqual([]);
  });
});

describe('backlinks — resolution agrees with outboundLinks on casing', () => {
  test('a bare wikilink is found however the caller spells the path', () => {
    insertNote(db, { path: 'Alpha.md' });
    insertNote(db, {
      path: 'linker.md',
      body: 'see [[Alpha]] here',
      links: [{ target: 'Alpha', base: 'alpha', kind: 'wikilink' }],
    });
    const q = mkQuery();
    expect(q.backlinks('Alpha.md')).toEqual([{ from: 'linker.md' }]);
    expect(q.backlinks('alpha.md')).toEqual([{ from: 'linker.md' }]);
    // …so the linker is never advertised as an unlinked mention.
    expect(q.unlinkedMentions('alpha.md')).toEqual([]);
  });

  test('a relative link whose target differs in case from the path key', () => {
    insertNote(db, { path: 'Notes/Target.md' });
    insertNote(db, {
      path: 'Notes/Src.md',
      body: 'See [t](Target.md) and Target is important.',
      links: [{ target: 'Notes/Target.md', base: null, kind: 'mdlink' }],
    });
    const q = mkQuery({ linkResolution: 'relative' });
    expect(q.backlinks('Notes/Target.md')).toEqual([{ from: 'Notes/Src.md' }]);
    expect(q.unlinkedMentions('Notes/Target.md')).toEqual([]);
  });

  test('answers an unreadable path with [] whatever the pagination says', () => {
    insertNote(db, { path: 'Private/target.md' });
    const q = mkQuery({ read: ['Notes/'] });
    // outboundLinks has always done this; backlinks must not throw where its
    // sibling stays quiet, or a two-pane UI breaks on one side only.
    expect(q.backlinks('Private/target.md', { limit: -1 })).toEqual([]);
    expect(q.outboundLinks('Private/target.md', { limit: -1 })).toEqual([]);
  });
});

describe('mentions — link markup is not prose', () => {
  test('a name inside a link to a DIFFERENT note is not a mention', () => {
    insertNote(db, { path: 'Alpha.md' });
    insertNote(db, { path: 'Alpha Notes.md' });
    insertNote(db, {
      path: 'journal.md',
      body: 'see [[Alpha Notes]] for details',
      links: [{ target: 'Alpha Notes', base: 'alpha notes', kind: 'wikilink' }],
    });
    const q = mkQuery();
    expect(q.unlinkedMentions('Alpha.md')).toEqual([]);
    expect(q.outboundMentions('journal.md')).toEqual([]);
  });

  test('md-link syntax counts as a link even where it is not indexed', () => {
    // In wikilink mode storedLinksFor discards md-links, so this one is in no
    // exclusion set — only masking keeps it out of the results.
    insertNote(db, { path: 'Alpha.md' });
    insertNote(db, {
      path: 'journal.md',
      body: 'see [Alpha](Alpha.md) please',
    });
    expect(mkQuery().unlinkedMentions('Alpha.md')).toEqual([]);
  });

  test('prose around the markup is still matched', () => {
    insertNote(db, { path: 'Alpha.md' });
    insertNote(db, {
      path: 'journal.md',
      body: 'see [[Other]] and Alpha shipped',
      links: [{ target: 'Other', base: 'other', kind: 'wikilink' }],
    });
    expect(
      mkQuery()
        .unlinkedMentions('Alpha.md')
        .map((h) => h.path),
    ).toEqual(['journal.md']);
  });
});

describe('outboundMentions — earliest mention wins', () => {
  test('an alias earlier in the body beats the filename later in it', () => {
    insertNote(db, {
      path: 'src.md',
      body: 'The AI thing kicked off, then Beta, and later Alpha shipped',
    });
    insertNote(db, {
      path: 'Alpha.md',
      frontmatter: { aliases: ['AI thing'] },
    });
    insertNote(db, { path: 'Beta.md' });
    const hits = mkQuery().outboundMentions('src.md');
    expect(hits.map((h) => h.path)).toEqual(['Alpha.md', 'Beta.md']);
    expect(hits[0].snippet).toContain('<b>AI thing</b>');
  });
});

describe('mentions — names the fts tokenizer cannot index', () => {
  test('a symbol-only name is still found', () => {
    insertNote(db, { path: '→.md' });
    insertNote(db, { path: 'other.md', body: 'the → arrow note explains it' });
    expect(
      mkQuery()
        .unlinkedMentions('→.md')
        .map((h) => h.path),
    ).toEqual(['other.md']);
  });
});

describe('mentionSnippet — window edges', () => {
  test('never cuts a surrogate pair in half', () => {
    const pad = '🎉'.repeat(30);
    insertNote(db, { path: 'Alpha.md' });
    insertNote(db, { path: 'j.md', body: `${pad} Alpha ${pad}` });
    const snippet = mkQuery().unlinkedMentions('Alpha.md')[0].snippet ?? '';
    expect(snippet.isWellFormed()).toBe(true);
    expect(snippet).toContain('<b>Alpha</b>');
  });
});

describe('orphanNotes — validation before work', () => {
  test('rejects an unknown orderBy field like queryNotes does', () => {
    expect(() =>
      mkQuery().orphanNotes({
        orderBy: { field: 'bogus' as 'path', dir: 'asc' },
      }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });
});

describe('backlinks — case-sensitive vault', () => {
  test('resolves through path keys that keep their case', () => {
    // The configuration CI runs under, and the one nothing covered: on a
    // case-sensitive volume path_key preserves case, so a resolver that looks
    // the target up by key only works if the two agree. Every other test in
    // this file pins caseSensitive: false, which hid that.
    insertNote(db, { path: 'Folder/Foo.md', pathKey: 'Folder/Foo.md' });
    insertNote(db, {
      path: 'source.md',
      pathKey: 'source.md',
      body: 'see [[Folder/Foo]], and Foo came up again',
      links: [{ target: 'Folder/Foo', base: 'foo', kind: 'wikilink' }],
    });
    const q = mkQuery({ caseSensitive: true });
    expect(q.backlinks('Folder/Foo.md')).toEqual([{ from: 'source.md' }]);
    // …and a linker is never re-reported as an unlinked mention.
    expect(q.unlinkedMentions('Folder/Foo.md')).toEqual([]);
    // A wrong-case path is a different note here, so it resolves to nothing.
    expect(q.backlinks('folder/foo.md')).toEqual([]);
  });
});
