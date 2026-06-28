import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import * as fsAtomic from '../../fs-atomic/index.ts';
import { createVaultIo, type VaultIo } from '../../vault-io/index.ts';

import type { IndexConfig } from '../models/index-config.ts';
import { configFingerprint, openIndexDb, readMeta } from '../open.ts';
import { createReconciler } from '../reconcile.ts';
import { applySchema, SCHEMA_VERSION } from '../schema.ts';

describe('note-index reconcile', () => {
  let root: string;
  let dataDir: string;
  let db: Database;
  let vaultIo: VaultIo;
  let cfg: IndexConfig;
  let reconciler: ReturnType<typeof createReconciler>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mdvault-vault-'));
    dataDir = await mkdtemp(path.join(tmpdir(), 'mdvault-data-'));
    vaultIo = createVaultIo({
      root,
      prefixes: { read: [''], write: [''] },
      caseSensitive: true,
    });
    cfg = { linkResolution: 'wikilink', caseSensitive: true, ignore: [] };
    db = openIndexDb(path.join(dataDir, 'index.db'), {
      sqliteBusyTimeoutMs: 5000,
    });
    applySchema(db);
    reconciler = createReconciler(db, vaultIo, cfg);
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  async function writeMd(rel: string, content: string): Promise<void> {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await Bun.write(full, content);
  }

  function rowFor(key: string) {
    return db
      .query(
        'SELECT id, path, mtime_ms, size, title FROM notes WHERE path_key = ?',
      )
      .get(key) as {
      id: number;
      path: string;
      mtime_ms: number;
      size: number;
      title: string;
    } | null;
  }

  function tagsFor(key: string): string[] {
    return (
      db
        .query('SELECT tag FROM note_tags WHERE path_key = ? ORDER BY tag')
        .all(key) as {
        tag: string;
      }[]
    ).map((r) => r.tag);
  }

  function linkTargetsFor(key: string): string[] {
    return (
      db
        .query(
          'SELECT target FROM note_links WHERE src_key = ? ORDER BY target',
        )
        .all(key) as { target: string }[]
    ).map((r) => r.target);
  }

  function ftsPathsFor(term: string): string[] {
    return (
      db
        .query(
          'SELECT n.path FROM notes_fts f JOIN notes n ON n.id = f.rowid WHERE notes_fts MATCH ?',
        )
        .all(term) as { path: string }[]
    ).map((r) => r.path);
  }

  test('reconcile indexes a new file (row, title, tags, links, fts body)', async () => {
    await writeMd(
      'notes/hello.md',
      '---\ntitle: Hello Note\ntags: [alpha, beta]\n---\n\n# Heading\n\nThe quick brownfox links [[Other]].\n',
    );
    await reconciler.reconcile();

    const key = vaultIo.toKey('notes/hello.md');
    const row = rowFor(key);
    expect(row).not.toBeNull();
    expect(row?.path).toBe('notes/hello.md');
    expect(row?.title).toBe('Hello Note');
    expect(tagsFor(key)).toEqual(['alpha', 'beta']);
    expect(linkTargetsFor(key)).toContain('Other');
    expect(ftsPathsFor('brownfox')).toEqual(['notes/hello.md']);
  });

  test('reconcile re-indexes a changed file: stable notes.id, new (mtime,size), swapped fts body', async () => {
    await writeMd('a.md', '# A\n\noriginalword here\n');
    await reconciler.reconcile();
    const key = vaultIo.toKey('a.md');
    const before = rowFor(key);
    expect(before).not.toBeNull();
    expect(ftsPathsFor('originalword')).toEqual(['a.md']);

    // change the bytes so the (mtime,size) signature differs from stored
    await writeMd(
      'a.md',
      '# A\n\nreplacedword now appears with many more bytes than before\n',
    );
    await reconciler.reconcile();

    const after = rowFor(key);
    expect(after?.id).toBe(before?.id); // STABLE rowid — never INSERT OR REPLACE
    expect(after?.size).not.toBe(before?.size);
    expect(ftsPathsFor('replacedword')).toEqual(['a.md']);
    expect(ftsPathsFor('originalword')).toEqual([]); // old body gone
  });

  test('reconcile drops a vanished in-scope row (notes, tags, links, fts)', async () => {
    await writeMd(
      'gone.md',
      '---\ntags: [x]\n---\n\n# Gone\n\nvanishword and [[Target]]\n',
    );
    await reconciler.reconcile();
    const key = vaultIo.toKey('gone.md');
    expect(rowFor(key)).not.toBeNull();

    await rm(path.join(root, 'gone.md'));
    await reconciler.reconcile();

    expect(rowFor(key)).toBeNull();
    expect(tagsFor(key)).toEqual([]);
    expect(linkTargetsFor(key)).toEqual([]);
    expect(ftsPathsFor('vanishword')).toEqual([]);
  });

  test('reconcile reads new/changed files via readConsistent (stat->read->stat)', async () => {
    await writeMd('r.md', '# R\n\nreadpathword\n');
    const spy = spyOn(fsAtomic, 'readConsistent');
    await reconciler.reconcile();

    expect(spy).toHaveBeenCalledWith(vaultIo.resolveVaultPath('r.md', 'read'));
    spy.mockRestore();
  });

  test('reconcilePaths indexes a present in-scope path', async () => {
    await writeMd(
      'present.md',
      '---\ntags: [keep]\n---\n\n# Present\n\npresentbody\n',
    );
    await reconciler.reconcilePaths(['present.md']);

    const key = vaultIo.toKey('present.md');
    expect(rowFor(key)).not.toBeNull();
    expect(tagsFor(key)).toEqual(['keep']);
    expect(ftsPathsFor('presentbody')).toEqual(['present.md']);
  });

  test('reconcilePaths drops a deleted path by its syntactic key', async () => {
    await writeMd('drop.md', '# Drop\n\ndropbody\n');
    await reconciler.reconcilePaths(['drop.md']);
    const key = vaultIo.toKey('drop.md');
    expect(rowFor(key)).not.toBeNull();

    await rm(path.join(root, 'drop.md'));
    await reconciler.reconcilePaths(['drop.md']); // gone on disk -> dropNote(toKey)

    expect(rowFor(key)).toBeNull();
    expect(ftsPathsFor('dropbody')).toEqual([]);
  });

  test('rebuild parses all files then swaps to a correct full index and writes meta', async () => {
    await writeMd(
      'one.md',
      '---\ntags: [t1]\n---\n\n# One\n\nfirstbody and [[Two]]\n',
    );
    await writeMd('sub/two.md', '# Two Title\n\nsecondbody\n');
    await reconciler.reconcile(); // index the current two files

    // drift: a brand-new file not yet indexed, plus a stale row rebuild must remove
    await writeMd('three.md', '# Three\n\nthirdbody\n');
    db.query(
      "INSERT INTO notes(path, path_key, mtime_ms, size, title, frontmatter) VALUES ('ghost.md','ghost.md',1,1,'Ghost','{}')",
    ).run();

    await reconciler.rebuild();

    const count = (
      db.query('SELECT count(*) AS c FROM notes').get() as { c: number }
    ).c;
    expect(count).toBe(3); // ghost removed, three picked up

    expect(rowFor(vaultIo.toKey('ghost.md'))).toBeNull();
    expect(rowFor(vaultIo.toKey('three.md'))).not.toBeNull();
    expect(rowFor(vaultIo.toKey('sub/two.md'))?.title).toBe('Two Title');
    expect(ftsPathsFor('thirdbody')).toEqual(['three.md']);
    expect(tagsFor(vaultIo.toKey('one.md'))).toEqual(['t1']);
    expect(linkTargetsFor(vaultIo.toKey('one.md'))).toContain('Two');

    expect(readMeta(db, 'config_fingerprint')).toBe(configFingerprint(cfg));
    expect(readMeta(db, 'schema_version')).toBe(String(SCHEMA_VERSION));
  });

  test('rebuild reads files via readConsistent before the swap transaction', async () => {
    await writeMd('p.md', '# P\n\npbody\n');
    const spy = spyOn(fsAtomic, 'readConsistent');
    await reconciler.rebuild();

    expect(spy).toHaveBeenCalledWith(vaultIo.resolveVaultPath('p.md', 'read'));
    spy.mockRestore();
  });

  test('scope-bounded reconcile preserves another scope rows when its file vanishes', async () => {
    await writeMd('scopeA/a.md', '# A\n\nabody\n');
    await writeMd('scopeB/b.md', '# B\n\nbbody\n');
    const ioA = createVaultIo({
      root,
      prefixes: { read: ['scopeA'], write: ['scopeA'] },
      caseSensitive: true,
    });
    const ioB = createVaultIo({
      root,
      prefixes: { read: ['scopeB'], write: ['scopeB'] },
      caseSensitive: true,
    });
    const recA = createReconciler(db, ioA, cfg);
    const recB = createReconciler(db, ioB, cfg);
    await recA.reconcile();
    await recB.reconcile();
    const keyA = ioA.toKey('scopeA/a.md');
    const keyB = ioB.toKey('scopeB/b.md');
    expect(rowFor(keyA)).not.toBeNull();
    expect(rowFor(keyB)).not.toBeNull();

    // A's file is gone from disk; B reconciles ITS scope and must NOT drop A
    await rm(path.join(root, 'scopeA', 'a.md'));
    await recB.reconcile();
    expect(rowFor(keyA)).not.toBeNull(); // out-of-scope row preserved
    expect(rowFor(keyB)).not.toBeNull();
  });

  test('scope-bounded rebuild deletes only in-scope rows', async () => {
    await writeMd('scopeA/a.md', '# A\n\nabody\n');
    await writeMd('scopeB/b.md', '# B\n\nbbody\n');
    const ioA = createVaultIo({
      root,
      prefixes: { read: ['scopeA'], write: ['scopeA'] },
      caseSensitive: true,
    });
    const ioB = createVaultIo({
      root,
      prefixes: { read: ['scopeB'], write: ['scopeB'] },
      caseSensitive: true,
    });
    const recA = createReconciler(db, ioA, cfg);
    const recB = createReconciler(db, ioB, cfg);
    await recA.reconcile();
    await recB.reconcile();
    const keyA = ioA.toKey('scopeA/a.md');
    const keyB = ioB.toKey('scopeB/b.md');

    await recB.rebuild(); // rebuild B scope only
    expect(rowFor(keyA)).not.toBeNull(); // A scope untouched by B's rebuild
    expect(rowFor(keyB)).not.toBeNull();
  });
});
