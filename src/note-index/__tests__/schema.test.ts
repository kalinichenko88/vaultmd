import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { applySchema, SCHEMA_VERSION } from '../schema.ts';

describe('applySchema', () => {
  let dir: string;
  let db: Database;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mdvault-'));
    db = new Database(path.join(dir, 'index.db'));
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  test('SCHEMA_VERSION is 1', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  test('creates every base table including the FTS5 virtual table', () => {
    applySchema(db);
    const names = (
      db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);

    expect(names).toContain('notes');
    expect(names).toContain('note_tags');
    expect(names).toContain('note_links');
    expect(names).toContain('notes_fts');
    expect(names).toContain('meta');
  });

  test('creates the tag + backlink lookup indexes', () => {
    applySchema(db);
    const names = (
      db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);

    expect(names).toContain('idx_note_tags_tag');
    expect(names).toContain('idx_note_links_target');
    expect(names).toContain('idx_note_links_base');
  });

  test('notes.path_key is UNIQUE (the stable-rowid foundation)', () => {
    applySchema(db);
    db.query(
      'INSERT INTO notes(path, path_key, mtime_ms, size, title, frontmatter) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('A.md', 'a.md', 1, 1, 'A', '{}');

    expect(() =>
      db
        .query(
          'INSERT INTO notes(path, path_key, mtime_ms, size, title, frontmatter) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('A2.md', 'a.md', 2, 2, 'A2', '{}'),
    ).toThrow();
  });

  test('is idempotent when applied twice (IF NOT EXISTS)', () => {
    applySchema(db);

    expect(() => applySchema(db)).not.toThrow();
  });
});
