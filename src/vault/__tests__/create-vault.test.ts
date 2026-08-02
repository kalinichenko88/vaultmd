import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { MdVaultError } from '@/errors.ts';

import { type CreateVaultConfig, createVault, type Vault } from '../index.ts';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(5);
  }
  throw new Error('waitFor: condition not met before timeout');
}

let vaultDir: string;
let dataDir: string;
let indexPath: string;
const opened: Vault[] = [];

beforeEach(async () => {
  vaultDir = await mkdtemp(join(tmpdir(), 'vaultmd-vault-'));
  dataDir = await mkdtemp(join(tmpdir(), 'vaultmd-data-'));
  indexPath = join(dataDir, 'index.db');
});

afterEach(async () => {
  for (const v of opened.splice(0)) {
    try {
      v.close();
    } catch {
      // already closed by the test
    }
  }
  await rm(vaultDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

async function writeVaultMd(rel: string, content: string): Promise<void> {
  const full = join(vaultDir, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
}

async function makeVault(
  overrides: Partial<CreateVaultConfig> = {},
): Promise<Vault> {
  const vault = await createVault({
    root: vaultDir,
    prefixes: overrides.prefixes ?? { read: [''], write: [''] },
    indexPath,
    linkResolution: overrides.linkResolution,
    lazyReconcile: overrides.lazyReconcile,
    reconcileTtlMs: overrides.reconcileTtlMs,
  });
  opened.push(vault);

  return vault;
}

describe('createVault', () => {
  test('exposes the full surface and boot-builds the index from existing files', async () => {
    await writeVaultMd(
      'Alpha.md',
      '---\ntitle: Alpha Note\ntags: [x, y]\n---\n# Alpha Heading\nbody one\n',
    );
    await writeVaultMd('sub/Beta.md', '# Beta\nbody two\n');

    const vault = await makeVault();

    expect(typeof vault.io.toKey).toBe('function');
    expect(typeof vault.notes.readNote).toBe('function');
    expect(typeof vault.query.queryNotes).toBe('function');
    expect(typeof vault.reconcile).toBe('function');
    expect(typeof vault.reconcilePaths).toBe('function');
    expect(typeof vault.rebuild).toBe('function');
    expect(typeof vault.close).toBe('function');

    const hits = vault.query.queryNotes();
    expect(hits.map((h) => h.path).sort()).toEqual(['Alpha.md', 'sub/Beta.md']);

    const alpha = hits.find((h) => h.path === 'Alpha.md');
    expect(alpha?.title).toBe('Alpha Note');
    expect([...(alpha?.tags ?? [])].sort()).toEqual(['x', 'y']);

    const beta = hits.find((h) => h.path === 'sub/Beta.md');
    expect(beta?.title).toBe('Beta');
  });

  test('close() releases the db so reopening the same index works', async () => {
    await writeVaultMd('One.md', '# One\n');

    const first = await makeVault();
    expect(first.query.queryNotes().map((h) => h.path)).toEqual(['One.md']);
    first.close();

    // Reopen the SAME index file (proves no WAL/-shm leak holding the db open).
    const second = await makeVault();
    expect(second.query.queryNotes().map((h) => h.path)).toEqual(['One.md']);

    // And the reopened vault is writable through notes (write-through to index).
    await second.notes.createNote('Two.md', { body: '# Two\n' });
    expect(
      second.query
        .queryNotes()
        .map((h) => h.path)
        .sort(),
    ).toEqual(['One.md', 'Two.md']);
  });

  test('lazyReconcile false ignores external writes until an explicit reconcile()', async () => {
    await writeVaultMd('One.md', '# One\n');

    const vault = await makeVault({ lazyReconcile: false });
    expect(vault.query.queryNotes().map((h) => h.path)).toEqual(['One.md']);

    // External write that bypasses notes (no write-through).
    await writeVaultMd('Two.md', '# Two\n');

    // No lazy sweep: repeated reads after a delay never auto-pick it up.
    await sleep(20);
    expect(vault.query.queryNotes().map((h) => h.path)).toEqual(['One.md']);
    expect(vault.query.queryNotes().map((h) => h.path)).toEqual(['One.md']);

    // An explicit reconcile() makes it visible.
    await vault.reconcile();
    expect(
      vault.query
        .queryNotes()
        .map((h) => h.path)
        .sort(),
    ).toEqual(['One.md', 'Two.md']);
  });

  test('reconcile() returns the out-of-band changes; own writes report nothing', async () => {
    await writeVaultMd('One.md', '# One\n');
    const vault = await makeVault({ lazyReconcile: false });

    // Writes through notes are indexed write-through, so nothing is left over.
    await vault.notes.createNote('Own.md', { body: '# Own\n' });
    expect(await vault.reconcile()).toEqual({
      added: [],
      updated: [],
      removed: [],
    });

    // Edits that bypass notes are the ones reconcile has to report.
    await writeVaultMd('Two.md', '# Two\n');
    await writeVaultMd('One.md', '# One\nrewritten with more bytes\n');
    await rm(join(vaultDir, 'Own.md'));
    expect(await vault.reconcile()).toEqual({
      added: ['Two.md'],
      updated: ['One.md'],
      removed: ['Own.md'],
    });
  });

  test('a background sweep does not swallow changes from the next reconcile()', async () => {
    await writeVaultMd('One.md', '# One\n');
    const vault = await makeVault({ lazyReconcile: true, reconcileTtlMs: 1 });

    // An out-of-band write that a query-triggered sweep reaches first.
    await writeVaultMd('Two.md', '# Two\n');
    await sleep(10);
    vault.query.queryNotes(); // fires the background sweep
    await sleep(50); // let it land
    expect(
      vault.query
        .queryNotes()
        .map((h) => h.path)
        .sort(),
    ).toEqual(['One.md', 'Two.md']); // the sweep already indexed it

    // The poller still has to hear about it, even though it is already indexed.
    expect(await vault.reconcile()).toEqual({
      added: ['Two.md'],
      updated: [],
      removed: [],
    });

    // ...and exactly once: draining clears the buffer.
    expect(await vault.reconcile()).toEqual({
      added: [],
      updated: [],
      removed: [],
    });
  });

  test('an owner rebuilds the index on a config-fingerprint mismatch', async () => {
    await writeVaultMd('A.md', '# A\n[[B]]\n');
    await writeVaultMd('B.md', '# B\n');

    const first = await makeVault({ linkResolution: 'wikilink' });
    expect(
      first.query
        .queryNotes()
        .map((h) => h.path)
        .sort(),
    ).toEqual(['A.md', 'B.md']);
    first.close();

    // A file added while the index is closed proves a full rebuild ran on
    // reopen (a stale incremental open would not see it).
    await writeVaultMd('C.md', '# C\n');

    // Reopen with a DIFFERENT linkResolution -> fingerprint mismatch. The read
    // scope is the whole vault (''), so this owner rebuilds rather than fails.
    const second = await makeVault({ linkResolution: 'relative' });
    expect(
      second.query
        .queryNotes()
        .map((h) => h.path)
        .sort(),
    ).toEqual(['A.md', 'B.md', 'C.md']);
  });

  test('a restricted non-owner throws INDEX_UNAVAILABLE on a mismatched shared index', async () => {
    await writeVaultMd('notes/A.md', '# A\n');
    await writeVaultMd('notes/B.md', '# B\n');

    // Owner builds the shared index under wikilink resolution.
    const owner = await makeVault({ linkResolution: 'wikilink' });
    expect(owner.query.queryNotes().length).toBe(2);
    owner.close();

    // A restricted instance (read scope 'notes', NOT the whole vault) reopens
    // the SAME index with a different linkResolution -> mismatch it cannot own.
    let caught: unknown;
    try {
      await createVault({
        root: vaultDir,
        prefixes: { read: ['notes'], write: ['notes'] },
        indexPath,
        linkResolution: 'relative',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MdVaultError);
    expect((caught as MdVaultError).code).toBe('INDEX_UNAVAILABLE');
    // The two triggers call for different actions, so the message has to say
    // which one fired. Here the schema version matches and the IndexConfig
    // does not, so booting an owner would not settle it.
    expect((caught as MdVaultError).message).toContain('IndexConfig');
    expect((caught as MdVaultError).message).toContain('notes');
  });

  test('a stale schema version names the upgrade, not a config mismatch', async () => {
    await writeVaultMd('notes/A.md', '# A\n');

    const owner = await makeVault();
    owner.close();

    // Same IndexConfig, older schema version — the upgrade case.
    const db = new Database(indexPath);
    db.run("UPDATE meta SET value = '1' WHERE key = 'schema_version'");
    db.close();

    let caught: unknown;
    try {
      await createVault({
        root: vaultDir,
        prefixes: { read: ['notes'], write: ['notes'] },
        indexPath,
      });
    } catch (err) {
      caught = err;
    }

    expect((caught as MdVaultError).code).toBe('INDEX_UNAVAILABLE');
    expect((caught as MdVaultError).message).toContain('older release');
    expect((caught as MdVaultError).message).toContain('schema v1');
    expect((caught as MdVaultError).message).not.toContain('IndexConfig');
  });

  test('lazyReconcile true auto-sweeps an external write after the TTL window', async () => {
    await writeVaultMd('One.md', '# One\n');

    const vault = await makeVault({ lazyReconcile: true, reconcileTtlMs: 10 });
    // The first read both returns the boot-built state and primes the clock.
    expect(vault.query.queryNotes().map((h) => h.path)).toEqual(['One.md']);

    // External write that bypasses notes (no write-through).
    await writeVaultMd('Two.md', '# Two\n');

    // Wait past the TTL, then poll: repeated reads kick a background sweep that
    // eventually makes the external file visible. (Ordering only — no exact
    // wall-clock assertion.)
    await sleep(20);
    await waitFor(() =>
      vault.query.queryNotes().some((h) => h.path === 'Two.md'),
    );

    expect(
      vault.query
        .queryNotes()
        .map((h) => h.path)
        .sort(),
    ).toEqual(['One.md', 'Two.md']);
  });

  // Task 2 changed what a present-but-invalid note projects to. reconcile
  // skips an unchanged file on mtime+size, so without a SCHEMA_VERSION bump an
  // upgraded index would keep the old row forever and disagree with a freshly
  // built one about the same vault.
  test('an index built at an older schema version is rebuilt on reopen', async () => {
    await writeVaultMd(
      'N.md',
      '---\na: .nan\ntags: [x]\ntitle: kept\n---\nbody\n',
    );

    const first = await makeVault();
    // The note is invalid under the new gate: no tags, title from the basename.
    expect(first.query.queryNotes()[0].tags).toEqual([]);
    first.close();

    // Simulate an index written by the previous release: stamp the old schema
    // version and a stale row, without touching the file on disk.
    const db = new Database(indexPath);
    db.run("UPDATE meta SET value = '1' WHERE key = 'schema_version'");
    db.run("UPDATE notes SET frontmatter = ?, title = 'kept'", [
      '{"a":null,"tags":["x"],"title":"kept"}',
    ]);
    db.run(
      "INSERT INTO note_tags(path_key, tag) VALUES ((SELECT path_key FROM notes), 'x')",
    );
    db.close();

    // makeVault already registers the vault in `opened`; afterEach closes it.
    const second = await makeVault();
    const hit = second.query.queryNotes()[0];

    expect(hit.frontmatter).toEqual({});
    expect(hit.tags).toEqual([]);
    expect(hit.title).toBe('N');
  });
});
