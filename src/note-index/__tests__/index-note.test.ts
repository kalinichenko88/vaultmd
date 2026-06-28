import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVaultIo, type VaultIo } from '@/vault-io/index.ts';

import { dropNote, indexNote } from '../index-note.ts';
import type { IndexConfig } from '../models/index-config.ts';
import { applySchema } from '../schema.ts';

let dir: string;
let db: Database;
let io: VaultIo;
const cfg: IndexConfig = {
  linkResolution: 'wikilink',
  caseSensitive: true,
  ignore: [],
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vaultmd-'));
  db = new Database(join(dir, 'index.db'));
  applySchema(db);
  io = createVaultIo({
    root: dir,
    prefixes: { read: [''], write: [''] },
    caseSensitive: true,
  });
});

afterEach(async () => {
  // close BEFORE rm so WAL/-shm/-wal handles are released
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function noteId(pathKey: string): number | null {
  const row = db
    .query('SELECT id FROM notes WHERE path_key = ?')
    .get(pathKey) as { id: number } | null;

  return row ? row.id : null;
}

function ftsMatch(term: string): number[] {
  const rows = db
    .query('SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?')
    .all(term) as { rowid: number }[];

  return rows.map((r) => r.rowid);
}

function tagRows(pathKey: string): string[] {
  const rows = db
    .query('SELECT tag FROM note_tags WHERE path_key = ? ORDER BY tag')
    .all(pathKey) as { tag: string }[];

  return rows.map((r) => r.tag);
}

function linkTargets(pathKey: string): string[] {
  const rows = db
    .query('SELECT target FROM note_links WHERE src_key = ? ORDER BY target')
    .all(pathKey) as { target: string }[];

  return rows.map((r) => r.target);
}

function countRows(table: string): number {
  const row = db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as {
    c: number;
  };

  return row.c;
}

describe('indexNote', () => {
  test('keeps notes.id stable across re-index and never orphans the FTS row', () => {
    const v1 = '---\ntags: [x]\n---\n# First\n\nalpha [[Foo]]';
    indexNote(db, io, cfg, 'a.md', v1, { mtimeMs: 1000, size: v1.length });

    const id1 = noteId('a.md') as number;
    expect(id1).not.toBeNull();
    expect(ftsMatch('alpha')).toEqual([id1]); // FTS body addressable by the note id

    const v2 = '---\ntags: [y]\n---\n# Second\n\nbeta [[Bar]]';
    indexNote(db, io, cfg, 'a.md', v2, { mtimeMs: 2000, size: v2.length });

    const id2 = noteId('a.md');
    expect(id2).toBe(id1); // SAME rowid -> no INSERT OR REPLACE on notes

    // FTS row re-addressable: new body present, old body gone (delete+insert by rowid)
    expect(ftsMatch('beta')).toEqual([id1]);
    expect(ftsMatch('alpha')).toEqual([]);

    // notes metadata advanced to the new sig + title
    const meta = db
      .query('SELECT mtime_ms, size, title FROM notes WHERE id = ?')
      .get(id2) as { mtime_ms: number; size: number; title: string };
    expect(meta.mtime_ms).toBe(2000);
    expect(meta.size).toBe(v2.length);
    expect(meta.title).toBe('Second');
  });

  test('replaces note_tags/note_links across re-index and dedups edges (no duplicate rows)', () => {
    const v1 = '---\ntags: [x]\n---\nbody [[Foo]] [[Foo]]'; // duplicate wikilink edge
    indexNote(db, io, cfg, 'a.md', v1, { mtimeMs: 1, size: v1.length });

    // duplicate (src_key, target, kind) collapses to one row (PK + INSERT OR IGNORE)
    expect(tagRows('a.md')).toEqual(['x']);
    expect(linkTargets('a.md')).toEqual(['Foo']);

    const v2 = '---\ntags: [y]\n---\nbody [[Bar]]';
    indexNote(db, io, cfg, 'a.md', v2, { mtimeMs: 2, size: v2.length });

    // old tag/link replaced (delete-by-key + insert), not accumulated
    expect(tagRows('a.md')).toEqual(['y']);
    expect(linkTargets('a.md')).toEqual(['Bar']);
    expect(countRows('note_tags')).toBe(1);
    expect(countRows('note_links')).toBe(1);
  });
});

describe('dropNote', () => {
  test('removes the note from notes, note_tags, note_links, and the FTS row by rowid', () => {
    const v = '---\ntags: [x]\n---\n# Title\n\ngamma [[Foo]]';
    indexNote(db, io, cfg, 'a.md', v, { mtimeMs: 1, size: v.length });

    const id = noteId('a.md') as number;
    expect(id).not.toBeNull();
    expect(ftsMatch('gamma')).toEqual([id]);

    dropNote(db, 'a.md');

    expect(noteId('a.md')).toBeNull();
    expect(countRows('notes')).toBe(0);
    expect(countRows('note_tags')).toBe(0);
    expect(countRows('note_links')).toBe(0);
    expect(countRows('notes_fts')).toBe(0); // FTS row gone -> no orphan
    expect(ftsMatch('gamma')).toEqual([]);
  });

  test('is a no-op for an unknown path_key', () => {
    expect(() => dropNote(db, 'missing.md')).not.toThrow();
    expect(countRows('notes')).toBe(0);
    expect(countRows('notes_fts')).toBe(0);
  });
});
