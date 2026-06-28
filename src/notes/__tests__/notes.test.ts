import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MdVaultError } from '@/errors.ts';
import {
  applySchema,
  type IndexConfig,
  indexNote,
  openIndexDb,
} from '@/note-index/index.ts';
import { createQuery } from '@/query/index.ts';
import { createVaultIo, type VaultIo } from '@/vault-io/index.ts';
import { createNotes } from '../notes.ts';

let base: string;
let vaultDir: string;
let indexPath: string;
let db: Database;
let io: VaultIo;
let cfg: IndexConfig;
let query: ReturnType<typeof createQuery>;
let notes: ReturnType<typeof createNotes>;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'mdvault-notes-'));
  vaultDir = join(base, 'vault');
  await mkdir(vaultDir, { recursive: true });
  indexPath = join(base, 'index.db');
  io = createVaultIo({
    root: vaultDir,
    prefixes: { read: [''], write: [''] },
    caseSensitive: true,
    ignore: [],
  });
  cfg = { linkResolution: 'wikilink', caseSensitive: true, ignore: [] };
  db = openIndexDb(indexPath, { sqliteBusyTimeoutMs: 5000 });
  applySchema(db);
  query = createQuery(db, io, cfg);
  notes = createNotes({ db, vaultIo: io, cfg, query, cross: false });
});

afterEach(async () => {
  db.close();
  await rm(base, { recursive: true, force: true });
});

describe('readNote', () => {
  test('missing → NOT_FOUND', async () => {
    let err: unknown;
    try {
      await notes.readNote('ghost.md');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MdVaultError);
    expect((err as MdVaultError).code).toBe('NOT_FOUND');
  });

  test('present → frontmatter/tags/body/valid, no links unless asked', async () => {
    await writeFile(
      join(vaultDir, 'note.md'),
      '---\ntitle: Hello\ntags: [a, b]\n---\nBody text',
    );
    const res = await notes.readNote('note.md');
    expect(res.valid).toBe('flat');
    expect(res.frontmatter).toEqual({ title: 'Hello', tags: ['a', 'b'] });
    expect(res.tags).toEqual(['a', 'b']);
    expect(res.body).toBe('Body text');
    expect(res.outbound).toBeUndefined();
    expect(res.backlinks).toBeUndefined();
  });

  test('withLinks adds outbound + backlinks from the index', async () => {
    await writeFile(join(vaultDir, 'Source.md'), 'See [[Target]] now');
    await writeFile(join(vaultDir, 'Target.md'), 'I am the target');
    const srcSig = await io.stat('Source.md');
    const tgtSig = await io.stat('Target.md');
    if (!srcSig || !tgtSig) {
      throw new Error('fixture stat failed');
    }
    indexNote(db, io, cfg, 'Source.md', 'See [[Target]] now', srcSig);
    indexNote(db, io, cfg, 'Target.md', 'I am the target', tgtSig);

    const src = await notes.readNote('Source.md', { withLinks: true });
    expect(src.outbound).toContainEqual({
      target: 'Target',
      resolved: 'Target.md',
    });
    expect(src.backlinks).toEqual([]);

    const tgt = await notes.readNote('Target.md', { withLinks: true });
    expect(tgt.backlinks).toContainEqual({ from: 'Source.md' });
    expect(tgt.outbound).toEqual([]);
  });
});

describe('createNote', () => {
  test('writes the file AND indexes it (queryNotes finds it immediately = write-through)', async () => {
    await notes.createNote('task.md', {
      frontmatter: { tags: ['project'], status: 'open' },
      body: 'Plan the launch',
    });
    // file on disk carries the serialized frontmatter + body
    const onDisk = await readFile(join(vaultDir, 'task.md'), 'utf8');
    expect(onDisk).toContain('Plan the launch');
    expect(onDisk).toContain('project');
    // index was populated IN-LOCK during createNote — no reconcile was ever called
    expect(query.queryNotes({ tag: 'project' }).map((n) => n.path)).toContain(
      'task.md',
    );
    expect(
      query.queryNotes({ where: { status: 'open' } }).map((n) => n.path),
    ).toContain('task.md');
  });

  test('clash → ALREADY_EXISTS (exclusiveCreate, no clobber)', async () => {
    await notes.createNote('dup.md', { body: 'first' });
    let err: unknown;
    try {
      await notes.createNote('dup.md', { body: 'second' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MdVaultError);
    expect((err as MdVaultError).code).toBe('ALREADY_EXISTS');
    expect(await readFile(join(vaultDir, 'dup.md'), 'utf8')).toBe('first');
  });
});

describe('updateNote', () => {
  test('editByMatch unique → literal replace + index reflects new content (write-through)', async () => {
    await notes.createNote('doc.md', { body: 'alpha beta gamma' });
    await notes.updateNote('doc.md', {
      editByMatch: { old: 'beta', new: 'delta' },
    });
    expect(await readFile(join(vaultDir, 'doc.md'), 'utf8')).toBe(
      'alpha delta gamma',
    );
    // reindexed IN-LOCK: new term searchable, old term gone — no reconcile called
    expect(query.searchText('delta').map((h) => h.path)).toContain('doc.md');
    expect(query.searchText('beta').map((h) => h.path)).not.toContain('doc.md');
  });

  test('editByMatch 0 occurrences → NO_MATCH, file untouched', async () => {
    await notes.createNote('zero.md', { body: 'nothing here' });
    let err: unknown;
    try {
      await notes.updateNote('zero.md', {
        editByMatch: { old: 'zzz', new: 'q' },
      });
    } catch (e) {
      err = e;
    }
    expect((err as MdVaultError).code).toBe('NO_MATCH');
    expect(await readFile(join(vaultDir, 'zero.md'), 'utf8')).toBe(
      'nothing here',
    );
  });

  test('editByMatch >1 occurrences → AMBIGUOUS_MATCH, no partial write', async () => {
    await notes.createNote('many.md', { body: 'x marks x marks x' });
    let err: unknown;
    try {
      await notes.updateNote('many.md', {
        editByMatch: { old: 'x', new: 'y' },
      });
    } catch (e) {
      err = e;
    }
    expect((err as MdVaultError).code).toBe('AMBIGUOUS_MATCH');
    expect(await readFile(join(vaultDir, 'many.md'), 'utf8')).toBe(
      'x marks x marks x',
    );
  });

  test('append creates a missing file and indexes it (write-through)', async () => {
    await notes.updateNote('fresh.md', { append: 'hello world' });
    expect(await readFile(join(vaultDir, 'fresh.md'), 'utf8')).toBe(
      'hello world',
    );
    expect(query.searchText('hello').map((h) => h.path)).toContain('fresh.md');
  });

  test('append newline rule: one newline before text iff existing lacks a trailing newline', async () => {
    await notes.createNote('log.md', { body: 'line1' });
    await notes.updateNote('log.md', { append: 'line2' });
    expect(await readFile(join(vaultDir, 'log.md'), 'utf8')).toBe(
      'line1\nline2',
    );
  });
});

describe('editFrontmatter', () => {
  test('changes a field, reindexes, returns edited', async () => {
    await notes.createNote('fm.md', {
      frontmatter: { status: 'todo' },
      body: 'content',
    });
    expect(
      query.queryNotes({ where: { status: 'todo' } }).map((n) => n.path),
    ).toContain('fm.md');

    const outcome = await notes.editFrontmatter('fm.md', (fm) => {
      fm.status = 'done';
    });
    expect(outcome).toBe('edited');
    expect(await readFile(join(vaultDir, 'fm.md'), 'utf8')).toContain(
      'status: done',
    );
    // index reflects the edit (write-through reindex)
    expect(
      query.queryNotes({ where: { status: 'done' } }).map((n) => n.path),
    ).toContain('fm.md');
    expect(
      query.queryNotes({ where: { status: 'todo' } }).map((n) => n.path),
    ).not.toContain('fm.md');
  });

  test('present-but-invalid frontmatter → unverifiable, leaves file AND index untouched', async () => {
    // nested map is non-flat → present-but-invalid; written directly (never indexed)
    const raw = '---\nmeta:\n  nested: true\n---\nbody';
    await writeFile(join(vaultDir, 'weird.md'), raw);
    const before = await io.stat('weird.md');

    const outcome = await notes.editFrontmatter('weird.md', (fm) => {
      fm.added = 'x';
    });
    expect(outcome).toBe('unverifiable');
    // file bytes + signature untouched (no write happened — fail-closed)
    expect(await readFile(join(vaultDir, 'weird.md'), 'utf8')).toBe(raw);
    expect(await io.stat('weird.md')).toEqual(before);
    // index untouched: never inserted, still not found
    expect(query.queryNotes({ where: { added: 'x' } })).toEqual([]);
  });
});

describe('deleteNote', () => {
  test('removes the file AND drops the index row, returns true', async () => {
    await notes.createNote('del.md', {
      frontmatter: { tags: ['gone'] },
      body: 'bye',
    });
    expect(query.queryNotes({ tag: 'gone' }).map((n) => n.path)).toContain(
      'del.md',
    );

    const deleted = await notes.deleteNote('del.md');
    expect(deleted).toBe(true);
    // file is gone
    expect(await io.stat('del.md')).toBeNull();
    // index row dropped IN-LOCK (write-through delete) — no reconcile called
    expect(query.queryNotes({ tag: 'gone' }).map((n) => n.path)).not.toContain(
      'del.md',
    );
  });

  test('missing file → false (idempotent no-op)', async () => {
    expect(await notes.deleteNote('nope.md')).toBe(false);
  });
});
