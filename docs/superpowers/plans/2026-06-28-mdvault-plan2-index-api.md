# mdvault Plan 2 — Index & API — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the SQLite-backed tier of `mdvault` on top of the merged Plan-1 foundation — a derived `bun:sqlite` index, read-scoped collection/backlink/keyword queries, write-through note CRUD, and the async `createVault` composition root that wires it all together.

**Architecture:** `note-index/` owns the derived `bun:sqlite` index (schema, open+probe+fingerprint, stable-rowid `indexNote`/`dropNote`, scope-bounded `reconcile`/`reconcilePaths`/`rebuild`). `query/` reads the index, always filtered by the caller's read allowlist. `notes/` is CRUD whose every write updates the index in the same lock (write-through). `vault/` is the async `createVault` composition root (opens the db once, config-fingerprint/boot rebuild, lazy reconcile before queries, lifecycle). The `.md` files on disk remain the single source of truth; the index is a derived, rebuildable cache living in the consumer's `DATA_DIR`, never in the vault.

**Tech Stack:** Bun, `bun:sqlite` (FTS5 + JSON1 from the platform `libsqlite3`), TypeScript (ESM), `bun:test`, `yaml` (already a dep). No new runtime dependencies.

## Global Constraints

- **Builds on merged Plan 1.** Import Plan-1 symbols from sibling FOLDER barrels (`../vault-io/index.ts`, `../fs-atomic/index.ts`, `../frontmatter/index.ts`, `../links/index.ts`, `../locked-file/index.ts`, `../locks/index.ts`, `../errors.ts`) — not the top `src/index.ts`.
- **`bun:sqlite` only** (never `better-sqlite3`). No new runtime deps. Native FTS5/JSON1 come from the platform `libsqlite3` — gate at open with a capability probe.
- **Module folders** (matching the repo's post-reorg layout): each Plan-2 module is a folder `src/<module>/<file>.ts` + `src/<module>/index.ts` (named re-export barrel, **no `export *`**) + `src/<module>/__tests__/<file>.test.ts`. Folder is **`note-index`** (not `index`) to avoid clashing with `src/index.ts`.
- **Read-scope invariant (security):** every public read/query — `queryNotes`, `searchText`, `backlinks` (its source notes), `outboundLinks` (its resolved targets), `readNote` — returns only rows inside the caller's `prefixes.read` (`vaultIo.can(path,'read')`), even from a shared/over-broad index.
- **Scope-bounded destructive ops:** `reconcile`/`reconcilePaths`/`rebuild` only insert/drop rows within `prefixes.read` — a restricted instance can never drop another scope's rows.
- **Write-through in-lock:** every note mutation updates the index inside the same `withFileLock(toKey(path))` as the file write, after the file commits and before `onCommit`; stored `(mtime,size)` only advances if the index tx commits (reconcile is the crash backstop).
- **Stable FTS docid:** `notes.id` never changes on re-index — **never `INSERT OR REPLACE` on `notes`** (select-id → update-in-place → FTS delete+insert by same rowid).
- **SQL safety:** `where` values always bound (`?`); `where` keys validated `/^[A-Za-z0-9_.-]+$/` else `VALIDATION_ERROR`; `orderBy.field` from a typed allowlist else `VALIDATION_ERROR`; FTS5 `MATCH` input sanitized (tokenize + double-quote) so operators can't throw.
- **Pagination:** `limit` default 100, hard-max 1000 (clamp); negative/non-integer `limit`/`offset` → `VALIDATION_ERROR`.
- **Index location:** the db lives at the consumer-supplied `indexPath` in `DATA_DIR`, **not** in the vault; consumers gitignore it plus its `-wal`/`-shm` sidecars.
- **Errors:** throw typed `MdVaultError` with stable codes (`NOT_FOUND`, `ALREADY_EXISTS`, `NO_MATCH`, `AMBIGUOUS_MATCH`, `MTIME_CONFLICT`, `VALIDATION_ERROR`, `COMMIT_FAILED`, `INDEX_UNAVAILABLE`, …).
- **Conventions:** Biome single-quote/2-space; `type` not `interface`; ESM with explicit `.ts`; blank line before `return` unless only/first; tests in `__tests__/` using `bun:test`, **never** `mock.module()` (use `spyOn`); db/fs tests use a `mkdtemp` temp dir and **`db.close()` before `rm -rf`** (release WAL). Commits conventional, `--no-gpg-sign`.

## File Structure

```
src/
├── index.ts                       # top barrel — Plan-2 public surface added (Task 7)
├── note-index/                    # derived bun:sqlite index
│   ├── types.ts                   # IndexConfig
│   ├── schema.ts                  # SCHEMA_VERSION, applySchema
│   ├── open.ts                    # openIndexDb, probeCapabilities, configFingerprint, readMeta/writeMeta
│   ├── project.ts                 # deriveTitle, projectRow
│   ├── index-note.ts              # indexNote, dropNote (stable rowid)
│   ├── reconcile.ts               # createReconciler (reconcile/reconcilePaths/rebuild, scope-bounded)
│   ├── index.ts
│   └── __tests__/
├── query/                         # read-scoped reads
│   ├── query.ts                   # createQuery (queryNotes/backlinks/outboundLinks/searchText)
│   ├── index.ts
│   └── __tests__/
├── notes/                         # write-through CRUD
│   ├── notes.ts                   # createNotes (read/create/update/editFrontmatter/delete)
│   ├── index.ts
│   └── __tests__/
└── vault/                         # async composition root
    ├── create-vault.ts            # createVault, CreateVaultConfig, Vault
    ├── index.ts
    └── __tests__/
```

Tasks build in dependency order: **1** note-index schema+open → **2** note-index project+indexNote/dropNote → **3** note-index reconcile → **4** query → **5** notes CRUD → **6** vault composition root → **7** top barrel + packaging.

---
### Task 1: note-index — schema + open (`src/note-index/` foundation)

**Files:**
- Create: `src/note-index/types.ts` (`IndexConfig`)
- Create: `src/note-index/schema.ts` (`SCHEMA_VERSION`, `applySchema`)
- Create: `src/note-index/open.ts` (`openIndexDb`, `probeCapabilities`, `configFingerprint`, `readMeta`, `writeMeta`)
- Create: `src/note-index/index.ts` (named re-export barrel)
- Test: `src/note-index/__tests__/schema.test.ts`
- Test: `src/note-index/__tests__/open.test.ts`

**Interfaces:**

Consumes (Plan-1 + builtins, imported verbatim):
- `bun:sqlite` → `class Database` (`new Database(path)`, `db.run(sql)`, `db.query(sql).get(...params)/.all(...params)/.run(...params)`)
- `node:crypto` → `createHash(algorithm).update(data).digest('hex')`
- `../errors.ts` → `class MdVaultError extends Error { readonly code: MdVaultCode; constructor(code, message, options?: { cause?: unknown }) }` — `MdVaultCode` includes `INDEX_UNAVAILABLE`
- `../links/index.ts` → `type LinkResolution = 'wikilink' | 'relative'`

Produces (exact exported signatures later tasks rely on):
- `export type IndexConfig = { linkResolution: LinkResolution; caseSensitive: boolean; ignore: string[] }`
- `export const SCHEMA_VERSION = 1`
- `export function applySchema(db: Database): void`
- `export function openIndexDb(indexPath: string, opts: { sqliteBusyTimeoutMs: number }): Database`
- `export function probeCapabilities(db: Database): void`
- `export function configFingerprint(cfg: IndexConfig): string`
- `export function readMeta(db: Database, key: string): string | null`
- `export function writeMeta(db: Database, key: string, value: string): void`

---

#### Cycle 1 — `IndexConfig` + `applySchema` (tables, indexes, UNIQUE key)

- [ ] **Write the failing test(s) for the schema DDL** — `src/note-index/__tests__/schema.test.ts`

```ts
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { SCHEMA_VERSION, applySchema } from '../schema.ts';

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
```

- [ ] **Run to verify it fails**
  - Run: `bun test src/note-index/__tests__/schema.test.ts`
  - Expected FAIL: `Cannot find module '../schema.ts'` — `schema.ts` does not exist yet.

- [ ] **Implement `IndexConfig` + `applySchema`** — create `src/note-index/types.ts`:

```ts
import type { LinkResolution } from '../links/index.ts';

// Row-semantics-affecting config (fingerprinted): a change to any field
// invalidates the derived index and forces a rebuild.
export type IndexConfig = {
  linkResolution: LinkResolution;
  caseSensitive: boolean;
  ignore: string[];
};
```

  Then create `src/note-index/schema.ts`:

```ts
import type { Database } from 'bun:sqlite';

export const SCHEMA_VERSION = 1;

// Creates the derived index schema. All statements are IF NOT EXISTS so this is
// safe to call on every boot. notes.id is the stable rowid AND the FTS docid;
// notes_fts is a STANDALONE fts5 table (keeps its own body copy), addressed by
// rowid = notes.id — never INSERT OR REPLACE on notes (that reassigns id and
// orphans the FTS row).
export function applySchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS notes (
      id          INTEGER PRIMARY KEY,
      path        TEXT NOT NULL,
      path_key    TEXT NOT NULL UNIQUE,
      mtime_ms    INTEGER NOT NULL,
      size        INTEGER NOT NULL,
      title       TEXT NOT NULL,
      frontmatter TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS note_tags (
      path_key TEXT NOT NULL,
      tag      TEXT NOT NULL,
      PRIMARY KEY (path_key, tag)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS note_links (
      src_key TEXT NOT NULL,
      target  TEXT NOT NULL,
      base    TEXT,
      kind    TEXT NOT NULL,
      PRIMARY KEY (src_key, target, kind)
    )
  `);

  db.run('CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(body)');

  db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');

  db.run('CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag)');
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_note_links_target ON note_links(target)',
  );
  db.run('CREATE INDEX IF NOT EXISTS idx_note_links_base ON note_links(base)');
}
```

- [ ] **Run to verify pass**
  - Run: `bun test src/note-index/__tests__/schema.test.ts`
  - Expected: PASS (5 tests).

---

#### Cycle 2 — `openIndexDb` (WAL + busy_timeout) and `probeCapabilities` (FTS5/JSON1)

- [ ] **Write the failing test(s) for open + capability probe** — `src/note-index/__tests__/open.test.ts`

```ts
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { openIndexDb, probeCapabilities } from '../open.ts';
import { applySchema } from '../schema.ts';

describe('openIndexDb + probeCapabilities', () => {
  let dir: string;
  let db: Database;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mdvault-'));
    db = openIndexDb(path.join(dir, 'index.db'), { sqliteBusyTimeoutMs: 5000 });
    applySchema(db);
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  test('opens in WAL journal mode with the configured busy_timeout', () => {
    expect(
      (db.query('PRAGMA journal_mode').get() as { journal_mode: string })
        .journal_mode,
    ).toBe('wal');
    expect(
      (db.query('PRAGMA busy_timeout').get() as { timeout: number }).timeout,
    ).toBe(5000);
  });

  test('probeCapabilities passes on a build with FTS5 + JSON1', () => {
    expect(() => probeCapabilities(db)).not.toThrow();
  });

  test('probeCapabilities is idempotent across repeated calls', () => {
    probeCapabilities(db);

    expect(() => probeCapabilities(db)).not.toThrow();
  });
});
```

- [ ] **Run to verify it fails**
  - Run: `bun test src/note-index/__tests__/open.test.ts`
  - Expected FAIL: `Cannot find module '../open.ts'` — `open.ts` does not exist yet.

- [ ] **Implement `openIndexDb` + `probeCapabilities`** — create `src/note-index/open.ts`:

```ts
import { Database } from 'bun:sqlite';

import { MdVaultError } from '../errors.ts';

// Opens (or creates) the derived index DB in WAL with a bounded busy_timeout so
// the CLI + daemon can share one file via SQLite write-serialization. WAL is not
// honored on :memory: DBs — callers pass a real file path. busy_timeout is a
// configured integer; PRAGMA values cannot be bound, so it is interpolated after
// Math.trunc (never a user string).
export function openIndexDb(
  indexPath: string,
  opts: { sqliteBusyTimeoutMs: number },
): Database {
  const db = new Database(indexPath);
  db.run('PRAGMA journal_mode = WAL');
  db.run(`PRAGMA busy_timeout = ${Math.trunc(opts.sqliteBusyTimeoutMs)}`);

  return db;
}

// Fails fast with INDEX_UNAVAILABLE if the Bun SQLite build lacks FTS5 or JSON1,
// the two extensions the index depends on. The probe table is a connection-local
// temp table; DROP IF EXISTS first keeps the probe idempotent across calls.
export function probeCapabilities(db: Database): void {
  try {
    db.run('DROP TABLE IF EXISTS temp.__probe');
    db.run('CREATE VIRTUAL TABLE temp.__probe USING fts5(x)');
  } catch (cause) {
    throw new MdVaultError(
      'INDEX_UNAVAILABLE',
      'SQLite FTS5 extension is unavailable in this Bun build',
      { cause },
    );
  }

  try {
    db.query('SELECT json_extract(?, ?) AS v').get('{}', '$.x');
  } catch (cause) {
    throw new MdVaultError(
      'INDEX_UNAVAILABLE',
      'SQLite JSON1 extension is unavailable in this Bun build',
      { cause },
    );
  }
}
```

- [ ] **Run to verify pass**
  - Run: `bun test src/note-index/__tests__/open.test.ts`
  - Expected: PASS (3 tests).

---

#### Cycle 3 — `configFingerprint` (stable, order-insensitive) + `readMeta`/`writeMeta`

- [ ] **Write the failing test(s) for fingerprint + meta round-trip** — overwrite `src/note-index/__tests__/open.test.ts` with the full file (adds the fingerprint and meta cases):

```ts
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  configFingerprint,
  openIndexDb,
  probeCapabilities,
  readMeta,
  writeMeta,
} from '../open.ts';
import { applySchema } from '../schema.ts';
import type { IndexConfig } from '../types.ts';

const baseCfg: IndexConfig = {
  linkResolution: 'wikilink',
  caseSensitive: false,
  ignore: ['.obsidian', 'node_modules'],
};

describe('openIndexDb + probeCapabilities', () => {
  let dir: string;
  let db: Database;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mdvault-'));
    db = openIndexDb(path.join(dir, 'index.db'), { sqliteBusyTimeoutMs: 5000 });
    applySchema(db);
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  test('opens in WAL journal mode with the configured busy_timeout', () => {
    expect(
      (db.query('PRAGMA journal_mode').get() as { journal_mode: string })
        .journal_mode,
    ).toBe('wal');
    expect(
      (db.query('PRAGMA busy_timeout').get() as { timeout: number }).timeout,
    ).toBe(5000);
  });

  test('probeCapabilities passes on a build with FTS5 + JSON1', () => {
    expect(() => probeCapabilities(db)).not.toThrow();
  });

  test('probeCapabilities is idempotent across repeated calls', () => {
    probeCapabilities(db);

    expect(() => probeCapabilities(db)).not.toThrow();
  });

  test('readMeta round-trips a written value', () => {
    writeMeta(db, 'schema_version', '1');

    expect(readMeta(db, 'schema_version')).toBe('1');
  });

  test('writeMeta upserts an existing key', () => {
    writeMeta(db, 'config_fingerprint', 'aaa');
    writeMeta(db, 'config_fingerprint', 'bbb');

    expect(readMeta(db, 'config_fingerprint')).toBe('bbb');
  });

  test('readMeta returns null for an absent key', () => {
    expect(readMeta(db, 'never_written')).toBeNull();
  });
});

describe('configFingerprint', () => {
  test('is a 64-char sha256 hex digest', () => {
    expect(configFingerprint(baseCfg)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('is stable for equal configs', () => {
    expect(configFingerprint(baseCfg)).toBe(configFingerprint({ ...baseCfg }));
  });

  test('is order-insensitive for ignore', () => {
    const reordered: IndexConfig = {
      ...baseCfg,
      ignore: ['node_modules', '.obsidian'],
    };

    expect(configFingerprint(reordered)).toBe(configFingerprint(baseCfg));
  });

  test('changes when linkResolution changes', () => {
    const other: IndexConfig = { ...baseCfg, linkResolution: 'relative' };

    expect(configFingerprint(other)).not.toBe(configFingerprint(baseCfg));
  });

  test('changes when caseSensitive changes', () => {
    const other: IndexConfig = { ...baseCfg, caseSensitive: true };

    expect(configFingerprint(other)).not.toBe(configFingerprint(baseCfg));
  });

  test('changes when ignore membership changes', () => {
    const other: IndexConfig = { ...baseCfg, ignore: ['.obsidian'] };

    expect(configFingerprint(other)).not.toBe(configFingerprint(baseCfg));
  });
});
```

- [ ] **Run to verify it fails**
  - Run: `bun test src/note-index/__tests__/open.test.ts`
  - Expected FAIL: `Export named 'configFingerprint' not found in module '.../open.ts'` (also `readMeta`/`writeMeta`) — the module load fails because `open.ts` does not export them yet.

- [ ] **Implement `configFingerprint` + `readMeta`/`writeMeta`** — overwrite `src/note-index/open.ts` with the full file:

```ts
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';

import { MdVaultError } from '../errors.ts';
import { SCHEMA_VERSION } from './schema.ts';
import type { IndexConfig } from './types.ts';

// Opens (or creates) the derived index DB in WAL with a bounded busy_timeout so
// the CLI + daemon can share one file via SQLite write-serialization. WAL is not
// honored on :memory: DBs — callers pass a real file path. busy_timeout is a
// configured integer; PRAGMA values cannot be bound, so it is interpolated after
// Math.trunc (never a user string).
export function openIndexDb(
  indexPath: string,
  opts: { sqliteBusyTimeoutMs: number },
): Database {
  const db = new Database(indexPath);
  db.run('PRAGMA journal_mode = WAL');
  db.run(`PRAGMA busy_timeout = ${Math.trunc(opts.sqliteBusyTimeoutMs)}`);

  return db;
}

// Fails fast with INDEX_UNAVAILABLE if the Bun SQLite build lacks FTS5 or JSON1,
// the two extensions the index depends on. The probe table is a connection-local
// temp table; DROP IF EXISTS first keeps the probe idempotent across calls.
export function probeCapabilities(db: Database): void {
  try {
    db.run('DROP TABLE IF EXISTS temp.__probe');
    db.run('CREATE VIRTUAL TABLE temp.__probe USING fts5(x)');
  } catch (cause) {
    throw new MdVaultError(
      'INDEX_UNAVAILABLE',
      'SQLite FTS5 extension is unavailable in this Bun build',
      { cause },
    );
  }

  try {
    db.query('SELECT json_extract(?, ?) AS v').get('{}', '$.x');
  } catch (cause) {
    throw new MdVaultError(
      'INDEX_UNAVAILABLE',
      'SQLite JSON1 extension is unavailable in this Bun build',
      { cause },
    );
  }
}

// Stable digest over the row-semantics-affecting config plus SCHEMA_VERSION.
// ignore is sorted so order does not matter; any drift between the stored value
// and this one means the index was built under different rules → rebuild.
export function configFingerprint(cfg: IndexConfig): string {
  const canonical = JSON.stringify({
    linkResolution: cfg.linkResolution,
    caseSensitive: cfg.caseSensitive,
    ignore: [...cfg.ignore].sort(),
    schema: SCHEMA_VERSION,
  });

  return createHash('sha256').update(canonical).digest('hex');
}

export function readMeta(db: Database, key: string): string | null {
  const row = db.query('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | null;

  return row ? row.value : null;
}

export function writeMeta(db: Database, key: string, value: string): void {
  db.query(
    'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}
```

- [ ] **Run to verify pass**
  - Run: `bun test src/note-index/__tests__/open.test.ts`
  - Expected: PASS (12 tests).

---

#### Cycle 4 — Barrel + full-suite + typecheck

- [ ] **Wire the named re-export barrel** — create `src/note-index/index.ts`:

```ts
export {
  configFingerprint,
  openIndexDb,
  probeCapabilities,
  readMeta,
  writeMeta,
} from './open.ts';
export { SCHEMA_VERSION, applySchema } from './schema.ts';
export type { IndexConfig } from './types.ts';
```

- [ ] **Run to verify the whole module + build is green**
  - Run: `bun test src/note-index/ && bun run check`
  - Expected: PASS — all `note-index` tests green; Biome (single-quote / 2-space / grouped imports) and `tsc --noEmit` clean.

- [ ] **Commit**

```bash
git add src/note-index/types.ts src/note-index/schema.ts src/note-index/open.ts src/note-index/index.ts src/note-index/__tests__/schema.test.ts src/note-index/__tests__/open.test.ts && \
git commit --no-gpg-sign -m "feat(note-index): index schema + WAL open, FTS5/JSON1 probe, config fingerprint, meta"
```

---

All idioms verified against the real Bun 1.3.13 + bun:sqlite. Here is the complete Task 2 block.

### Task 2: note-index — `project` (deriveTitle/projectRow) + `index-note` (indexNote/dropNote)

**Files:**
- Create: `src/note-index/project.ts`, `src/note-index/index-note.ts`
- Extend: `src/note-index/index.ts` (named re-export barrel — append two lines)
- Test: `src/note-index/__tests__/project.test.ts`, `src/note-index/__tests__/index-note.test.ts`

**Interfaces:**

Consumes (Plan-1, from sibling folder barrels — verbatim):
- `../frontmatter/index.ts`: `parseFrontmatter(content): { frontmatter: Record<string,unknown>; tags: string[]; body: string; valid: FrontmatterValidity }`; `deriveTags(fm: Record<string,unknown>): string[]`
- `../links/index.ts`: `storedLinksFor(content: string, srcRel: string, mode: 'wikilink'|'relative'): StoredLink[]`; `type StoredLink = { target: string; base: string | null; kind: 'wikilink'|'embed'|'mdlink' }`
- `../fs-atomic/index.ts`: `type Sig = { mtimeMs: number; size: number }`
- `../vault-io/index.ts`: `createVaultIo(config): VaultIo`; `type VaultIo` with `toVaultRelative(rel): string`, `toKey(rel): string`

Consumes (Task 1, same folder):
- `./types.ts`: `type IndexConfig = { linkResolution: 'wikilink'|'relative'; caseSensitive: boolean; ignore: string[] }`
- `./schema.ts`: `applySchema(db: Database): void`
- `bun:sqlite`: `Database`

Produces (later tasks — `reconcile`, `notes` — rely on these exactly):
- `deriveTitle(frontmatter: Record<string,unknown>, body: string, rel: string): string`
- `projectRow(content: string, rel: string, vaultIo: Pick<VaultIo, 'toVaultRelative' | 'toKey'>, cfg: IndexConfig): { path: string; pathKey: string; title: string; frontmatterJson: string; tags: string[]; links: StoredLink[] }`
- `indexNote(db: Database, vaultIo: Pick<VaultIo, 'toVaultRelative' | 'toKey'>, cfg: IndexConfig, rel: string, content: string, sig: Sig): void`
- `dropNote(db: Database, pathKey: string): void`

---

#### Cycle 1 — `project.ts`: `deriveTitle` precedence + `projectRow` derivation

- [ ] **Write the failing test(s) for `deriveTitle` precedence and `projectRow` derivation (real `vaultIo`).**

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type VaultIo, createVaultIo } from '../../vault-io/index.ts';
import { deriveTitle, projectRow } from '../project.ts';
import type { IndexConfig } from '../types.ts';

let dir: string;
let io: VaultIo;
const cfg: IndexConfig = {
  linkResolution: 'wikilink',
  caseSensitive: true,
  ignore: [],
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mdvault-'));
  // caseSensitive: true makes toKey === toVaultRelative -> deterministic on any volume
  io = createVaultIo({
    root: dir,
    prefixes: { read: [''], write: [''] },
    caseSensitive: true,
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('deriveTitle', () => {
  test('prefers a non-empty string frontmatter.title over an H1', () => {
    expect(deriveTitle({ title: 'From FM' }, '# H1 heading\n\nbody', 'notes/x.md')).toBe(
      'From FM',
    );
  });

  test('falls back to the first H1 line (ignoring H2) when no frontmatter title', () => {
    const body = 'intro line\n## not-h1\n# Real Heading\nmore';
    expect(deriveTitle({}, body, 'notes/x.md')).toBe('Real Heading');
  });

  test('ignores a non-string title and a non-H1 hash, then uses basename', () => {
    expect(deriveTitle({ title: 42 }, '## subhead only', 'notes/My File.md')).toBe(
      'My File',
    );
  });

  test('falls back to basename without .md when nothing else matches', () => {
    expect(deriveTitle({}, 'no heading here', 'folder/Deep Note.md')).toBe('Deep Note');
  });
});

describe('projectRow', () => {
  test('builds path/pathKey/title/frontmatterJson/tags/links from a real vaultIo', () => {
    const content = [
      '---',
      'title: Projected',
      'tags: [alpha, beta]',
      '---',
      '# Ignored Heading',
      '',
      'Body referencing [[Folder/Target]] and ![[pic.png]].',
    ].join('\n');

    const row = projectRow(content, 'Folder/Note.md', io, cfg);

    expect(row.path).toBe('Folder/Note.md');
    expect(row.pathKey).toBe('Folder/Note.md'); // caseSensitive: true -> key === display path
    expect(row.title).toBe('Projected'); // frontmatter.title wins over the H1
    expect(row.tags).toEqual(['alpha', 'beta']);
    expect(JSON.parse(row.frontmatterJson)).toEqual({
      title: 'Projected',
      tags: ['alpha', 'beta'],
    });

    const wl = row.links.find((l) => l.target === 'Folder/Target');
    expect(wl).toBeDefined();
    expect(wl?.kind).toBe('wikilink');
    expect(wl?.base).toBe('target'); // path-qualified target preserved; base case-folded
  });

  test('title falls back to the H1 when frontmatter has no title', () => {
    const content = '---\ntags: [x]\n---\n# Real H1\n\ntext';
    const row = projectRow(content, 'a.md', io, cfg);
    expect(row.title).toBe('Real H1');
  });
});
```

- [ ] **Run to verify it fails.**
  Run: `bun test src/note-index/__tests__/project.test.ts`
  Expected FAIL: `Cannot find module '../project.ts'` (the module does not exist yet).

- [ ] **Implement `deriveTitle` + `projectRow`.**

```ts
import { basename } from 'node:path';

import { deriveTags, parseFrontmatter } from '../frontmatter/index.ts';
import { type StoredLink, storedLinksFor } from '../links/index.ts';
import type { VaultIo } from '../vault-io/index.ts';
import type { IndexConfig } from './types.ts';

export function deriveTitle(
  frontmatter: Record<string, unknown>,
  body: string,
  rel: string,
): string {
  const fmTitle = frontmatter.title;
  if (typeof fmTitle === 'string' && fmTitle.trim() !== '') {
    return fmTitle;
  }

  for (const line of body.split('\n')) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match) {
      return match[1];
    }
  }

  return basename(rel).replace(/\.md$/i, '');
}

export function projectRow(
  content: string,
  rel: string,
  vaultIo: Pick<VaultIo, 'toVaultRelative' | 'toKey'>,
  cfg: IndexConfig,
): {
  path: string;
  pathKey: string;
  title: string;
  frontmatterJson: string;
  tags: string[];
  links: StoredLink[];
} {
  const path = vaultIo.toVaultRelative(rel);
  const pathKey = vaultIo.toKey(rel);
  const parsed = parseFrontmatter(content);
  const tags = deriveTags(parsed.frontmatter);
  const title = deriveTitle(parsed.frontmatter, parsed.body, path);
  const links = storedLinksFor(content, path, cfg.linkResolution);
  const frontmatterJson = JSON.stringify(parsed.frontmatter);

  return { path, pathKey, title, frontmatterJson, tags, links };
}
```

- [ ] **Run to verify pass.**
  Run: `bun test src/note-index/__tests__/project.test.ts`
  Expected: PASS.

---

#### Cycle 2 — `index-note.ts`: `indexNote` keeps `notes.id` stable, FTS re-addressable, tags/links replaced

- [ ] **Write the failing test(s) for `indexNote` (stable rowid, FTS swap, tag/link replacement, no duplicate edges).**

```ts
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type VaultIo, createVaultIo } from '../../vault-io/index.ts';
import { indexNote } from '../index-note.ts';
import { applySchema } from '../schema.ts';
import type { IndexConfig } from '../types.ts';

let dir: string;
let db: Database;
let io: VaultIo;
const cfg: IndexConfig = {
  linkResolution: 'wikilink',
  caseSensitive: true,
  ignore: [],
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mdvault-'));
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
  const row = db.query('SELECT id FROM notes WHERE path_key = ?').get(pathKey) as
    | { id: number }
    | null;

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
  const row = db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };

  return row.c;
}

describe('indexNote', () => {
  test('keeps notes.id stable across re-index and never orphans the FTS row', () => {
    const v1 = '---\ntags: [x]\n---\n# First\n\nalpha [[Foo]]';
    indexNote(db, io, cfg, 'a.md', v1, { mtimeMs: 1000, size: v1.length });

    const id1 = noteId('a.md');
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
```

- [ ] **Run to verify it fails.**
  Run: `bun test src/note-index/__tests__/index-note.test.ts`
  Expected FAIL: `Cannot find module '../index-note.ts'` (the module does not exist yet).

- [ ] **Implement `indexNote` (stable-rowid algorithm in one synchronous transaction).**

```ts
import type { Database } from 'bun:sqlite';

import { parseFrontmatter } from '../frontmatter/index.ts';
import type { Sig } from '../fs-atomic/index.ts';
import type { VaultIo } from '../vault-io/index.ts';
import { projectRow } from './project.ts';
import type { IndexConfig } from './types.ts';

export function indexNote(
  db: Database,
  vaultIo: Pick<VaultIo, 'toVaultRelative' | 'toKey'>,
  cfg: IndexConfig,
  rel: string,
  content: string,
  sig: Sig,
): void {
  const row = projectRow(content, rel, vaultIo, cfg);
  const body = parseFrontmatter(content).body; // FTS indexes note text, not the YAML block

  const tx = db.transaction(() => {
    const existing = db
      .query('SELECT id FROM notes WHERE path_key = ?')
      .get(row.pathKey) as { id: number } | null;

    let id: number;
    if (existing) {
      // UPDATE in place — keep notes.id (the FTS docid) STABLE; never INSERT OR REPLACE
      id = existing.id;
      db.query(
        'UPDATE notes SET path = ?, mtime_ms = ?, size = ?, title = ?, frontmatter = ? WHERE id = ?',
      ).run(row.path, sig.mtimeMs, sig.size, row.title, row.frontmatterJson, id);
      db.query('DELETE FROM notes_fts WHERE rowid = ?').run(id);
    } else {
      const res = db
        .query(
          'INSERT INTO notes(path, path_key, mtime_ms, size, title, frontmatter) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          row.path,
          row.pathKey,
          sig.mtimeMs,
          sig.size,
          row.title,
          row.frontmatterJson,
        );
      id = Number(res.lastInsertRowid);
    }
    // re-insert the FTS body under the (stable) rowid for both create and update
    db.query('INSERT INTO notes_fts(rowid, body) VALUES (?, ?)').run(id, body);

    // tags: replace-by-key; PK + OR IGNORE collapses duplicates within the note
    db.query('DELETE FROM note_tags WHERE path_key = ?').run(row.pathKey);
    const insertTag = db.query(
      'INSERT OR IGNORE INTO note_tags(path_key, tag) VALUES (?, ?)',
    );
    for (const tag of row.tags) {
      insertTag.run(row.pathKey, tag);
    }

    // links: replace-by-key; PK (src_key, target, kind) keeps edges distinct
    db.query('DELETE FROM note_links WHERE src_key = ?').run(row.pathKey);
    const insertLink = db.query(
      'INSERT OR IGNORE INTO note_links(src_key, target, base, kind) VALUES (?, ?, ?, ?)',
    );
    for (const link of row.links) {
      insertLink.run(row.pathKey, link.target, link.base, link.kind);
    }
  });

  tx();
}
```

- [ ] **Run to verify pass.**
  Run: `bun test src/note-index/__tests__/index-note.test.ts`
  Expected: PASS.

---

#### Cycle 3 — `index-note.ts`: `dropNote` removes the note from all four tables (incl. FTS by rowid)

- [ ] **Write the failing test(s) for `dropNote`.** First widen the import line in `src/note-index/__tests__/index-note.test.ts`:

Change:
```ts
import { indexNote } from '../index-note.ts';
```
to:
```ts
import { dropNote, indexNote } from '../index-note.ts';
```

Then append this `describe` block at the end of the file:

```ts
describe('dropNote', () => {
  test('removes the note from notes, note_tags, note_links, and the FTS row by rowid', () => {
    const v = '---\ntags: [x]\n---\n# Title\n\ngamma [[Foo]]';
    indexNote(db, io, cfg, 'a.md', v, { mtimeMs: 1, size: v.length });

    const id = noteId('a.md');
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
```

- [ ] **Run to verify it fails.**
  Run: `bun test src/note-index/__tests__/index-note.test.ts`
  Expected FAIL: import error `export named 'dropNote' not found in module '.../index-note.ts'` (or `dropNote is not a function`) — the export does not exist yet.

- [ ] **Implement `dropNote` (append to `src/note-index/index-note.ts`).**

```ts
export function dropNote(db: Database, pathKey: string): void {
  const tx = db.transaction(() => {
    const existing = db
      .query('SELECT id FROM notes WHERE path_key = ?')
      .get(pathKey) as { id: number } | null;
    if (existing) {
      db.query('DELETE FROM notes_fts WHERE rowid = ?').run(existing.id);
    }
    db.query('DELETE FROM notes WHERE path_key = ?').run(pathKey);
    db.query('DELETE FROM note_tags WHERE path_key = ?').run(pathKey);
    db.query('DELETE FROM note_links WHERE src_key = ?').run(pathKey);
  });

  tx();
}
```

- [ ] **Run to verify pass.**
  Run: `bun test src/note-index/__tests__/index-note.test.ts`
  Expected: PASS.

---

#### Cycle 4 — Wire the barrel + full module verification

- [ ] **Extend the named-export barrel `src/note-index/index.ts`** — append these two lines (alongside the Task 1 exports for `schema`/`open`/`types`):

```ts
export { dropNote, indexNote } from './index-note.ts';
export { deriveTitle, projectRow } from './project.ts';
```

- [ ] **Run to verify the whole module + lint/types.**
  Run: `bun test src/note-index/__tests__/ && bun run check`
  Expected: PASS (both test files green; Biome + `tsc --noEmit` clean).

---

- [ ] **Commit.**

```bash
git add src/note-index/project.ts src/note-index/index-note.ts src/note-index/index.ts src/note-index/__tests__/project.test.ts src/note-index/__tests__/index-note.test.ts && git commit --no-gpg-sign -m "feat(note-index): add projectRow + stable-rowid indexNote/dropNote"
```

---

All load-bearing assumptions are verified (nested `db.transaction` savepoints + rollback; cross-module + barrel-re-export `spyOn` interception; `.get()` returns `null`; FTS5 MATCH/join; `resolveVaultPath` tolerates a missing target; `listMarkdown` skips out-of-scope files). Here is the Task 3 block.

### Task 3: note-index — reconcile (`createReconciler`: `reconcile` / `reconcilePaths` / `rebuild`)

**Files:**
- Create: `src/note-index/reconcile.ts`
- Edit (extend barrel): `src/note-index/index.ts`
- Test: `src/note-index/__tests__/reconcile.test.ts`

**Interfaces:**

Consumes (exact signatures — imported from sibling FOLDER barrels / earlier note-index files):
- `../fs-atomic/index.ts`: `type Sig = { mtimeMs: number; size: number }`; `statSig(fullPath: string): Promise<Sig | null>`; `readConsistent(fullPath: string): Promise<{ content: string | null; sig: Sig | null }>`
- `../vault-io/index.ts`: `type VaultIo` with `toVaultRelative(rel): string`, `toKey(rel): string`, `can(rel, access): boolean`, `resolveVaultPath(rel, access?): string`, `listMarkdown(dir?): Promise<string[]>`; `type Access = 'read' | 'write'`; `createVaultIo(config: VaultIoConfig): VaultIo` (test only)
- `./types.ts`: `type IndexConfig = { linkResolution: 'wikilink' | 'relative'; caseSensitive: boolean; ignore: string[] }`
- `./schema.ts`: `applySchema(db: Database): void` (test only)
- `./open.ts`: `openIndexDb(indexPath: string, opts: { sqliteBusyTimeoutMs: number }): Database`; `configFingerprint(cfg: IndexConfig): string`; `readMeta(db: Database, key: string): string | null`; `writeMeta(db: Database, key: string, value: string): void`; `export const SCHEMA_VERSION = 1`
- `./index-note.ts`: `indexNote(db: Database, vaultIo, cfg: IndexConfig, rel: string, content: string, sig: Sig): void`; `dropNote(db: Database, pathKey: string): void`

Produces (later tasks — the `vault` composition root — rely on these verbatim):
- `createReconciler(db: Database, vaultIo: VaultIo, cfg: IndexConfig): { reconcile(): Promise<void>; reconcilePaths(rels: string[]): Promise<void>; rebuild(): Promise<void> }`
- `type Reconciler = { reconcile(): Promise<void>; reconcilePaths(rels: string[]): Promise<void>; rebuild(): Promise<void> }`

---

#### Cycle 1 — `reconcile()`: index new, re-index changed (stable rowid), drop vanished; read via `readConsistent`

- [ ] **Write the failing test(s) for `reconcile()`** (this block also lays down the whole test scaffolding — imports, `beforeEach`/`afterEach`, helpers — reused by all later cycles):

```ts
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import * as fsAtomic from '../../fs-atomic/index.ts';
import { type VaultIo, createVaultIo } from '../../vault-io/index.ts';

import { SCHEMA_VERSION, configFingerprint, openIndexDb, readMeta } from '../open.ts';
import { createReconciler } from '../reconcile.ts';
import { applySchema } from '../schema.ts';
import type { IndexConfig } from '../types.ts';

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
    db = openIndexDb(path.join(dataDir, 'index.db'), { sqliteBusyTimeoutMs: 5000 });
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
      .query('SELECT id, path, mtime_ms, size, title FROM notes WHERE path_key = ?')
      .get(key) as
      | { id: number; path: string; mtime_ms: number; size: number; title: string }
      | null;
  }

  function tagsFor(key: string): string[] {
    return (
      db.query('SELECT tag FROM note_tags WHERE path_key = ? ORDER BY tag').all(key) as {
        tag: string;
      }[]
    ).map((r) => r.tag);
  }

  function linkTargetsFor(key: string): string[] {
    return (
      db
        .query('SELECT target FROM note_links WHERE src_key = ? ORDER BY target')
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
    await writeMd('a.md', '# A\n\nreplacedword now appears with many more bytes than before\n');
    await reconciler.reconcile();

    const after = rowFor(key);
    expect(after?.id).toBe(before?.id); // STABLE rowid — never INSERT OR REPLACE
    expect(after?.size).not.toBe(before?.size);
    expect(ftsPathsFor('replacedword')).toEqual(['a.md']);
    expect(ftsPathsFor('originalword')).toEqual([]); // old body gone
  });

  test('reconcile drops a vanished in-scope row (notes, tags, links, fts)', async () => {
    await writeMd('gone.md', '---\ntags: [x]\n---\n\n# Gone\n\nvanishword and [[Target]]\n');
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
});
```

- [ ] **Run to verify it fails**
  Run: `bun test src/note-index/__tests__/reconcile.test.ts`
  Expected FAIL: module `../reconcile.ts` cannot be resolved / `createReconciler is not a function` — `reconcile.ts` does not exist yet.

- [ ] **Implement `createReconciler` + `reconcile()`** (create `src/note-index/reconcile.ts`; `reconcilePaths`/`rebuild` are stubbed for the next cycles; `storedSigs()` is intentionally un-scoped here and gets its scope guard in Cycle 4):

```ts
import type { Database } from 'bun:sqlite';

import { type Sig, readConsistent, statSig } from '../fs-atomic/index.ts';
import type { VaultIo } from '../vault-io/index.ts';

import { dropNote, indexNote } from './index-note.ts';
import type { IndexConfig } from './types.ts';

type StoredRow = {
  path_key: string;
  path: string;
  mtime_ms: number;
  size: number;
};

export type Reconciler = {
  reconcile(): Promise<void>;
  reconcilePaths(rels: string[]): Promise<void>;
  rebuild(): Promise<void>;
};

export function createReconciler(
  db: Database,
  vaultIo: VaultIo,
  cfg: IndexConfig,
): Reconciler {
  function storedSigs(): Map<string, Sig> {
    const rows = db
      .query('SELECT path_key, path, mtime_ms, size FROM notes')
      .all() as StoredRow[];
    const stored = new Map<string, Sig>();
    for (const row of rows) {
      stored.set(row.path_key, { mtimeMs: row.mtime_ms, size: row.size });
    }

    return stored;
  }

  async function reconcile(): Promise<void> {
    const rels = await vaultIo.listMarkdown();
    const stored = storedSigs();
    const onDisk = await Promise.all(
      rels.map(async (rel) => {
        const full = vaultIo.resolveVaultPath(rel, 'read');
        const sig = await statSig(full);

        return { rel, key: vaultIo.toKey(rel), full, sig };
      }),
    );
    const seen = new Set<string>();
    for (const entry of onDisk) {
      if (entry.sig === null) {
        continue;
      }
      seen.add(entry.key);
      const prev = stored.get(entry.key);
      if (
        prev &&
        prev.mtimeMs === entry.sig.mtimeMs &&
        prev.size === entry.sig.size
      ) {
        continue;
      }
      const read = await readConsistent(entry.full);
      if (read.content === null || read.sig === null) {
        continue;
      }
      indexNote(db, vaultIo, cfg, entry.rel, read.content, read.sig);
    }
    for (const key of stored.keys()) {
      if (!seen.has(key)) {
        dropNote(db, key);
      }
    }
  }

  async function reconcilePaths(_rels: string[]): Promise<void> {
    throw new Error('not implemented');
  }

  async function rebuild(): Promise<void> {
    throw new Error('not implemented');
  }

  return { reconcile, reconcilePaths, rebuild };
}
```

  Also extend the barrel `src/note-index/index.ts` (named re-export, NO export-star):

```ts
export { createReconciler } from './reconcile.ts';
export type { Reconciler } from './reconcile.ts';
```

- [ ] **Run to verify pass**
  Run: `bun test src/note-index/__tests__/reconcile.test.ts`
  Expected: PASS (4 tests).

---

#### Cycle 2 — `reconcilePaths(rels)`: present path indexes, deleted path drops by syntactic key

- [ ] **Write the failing test(s) for `reconcilePaths`** (add these two tests inside the `describe` block):

```ts
  test('reconcilePaths indexes a present in-scope path', async () => {
    await writeMd('present.md', '---\ntags: [keep]\n---\n\n# Present\n\npresentbody\n');
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
```

- [ ] **Run to verify it fails**
  Run: `bun test src/note-index/__tests__/reconcile.test.ts`
  Expected FAIL: both new tests throw `Error: not implemented` from the `reconcilePaths` stub.

- [ ] **Implement `reconcilePaths`** (replace the stub body in `src/note-index/reconcile.ts`):

```ts
  async function reconcilePaths(rels: string[]): Promise<void> {
    for (const rel of rels) {
      if (!vaultIo.can(rel, 'read')) {
        continue;
      }
      const key = vaultIo.toKey(rel);
      let full: string;
      try {
        full = vaultIo.resolveVaultPath(rel, 'read');
      } catch {
        dropNote(db, key); // unresolvable target -> drop by syntactic key
        continue;
      }
      const read = await readConsistent(full);
      if (read.content === null || read.sig === null) {
        dropNote(db, key); // gone on disk -> drop by syntactic key (no realpath needed)
        continue;
      }
      indexNote(db, vaultIo, cfg, rel, read.content, read.sig);
    }
  }
```

- [ ] **Run to verify pass**
  Run: `bun test src/note-index/__tests__/reconcile.test.ts`
  Expected: PASS (6 tests).

---

#### Cycle 3 — `rebuild()`: parse-all-first, single-transaction swap, writes meta, reads via `readConsistent`

- [ ] **Write the failing test(s) for `rebuild`** (add these two tests inside the `describe` block):

```ts
  test('rebuild parses all files then swaps to a correct full index and writes meta', async () => {
    await writeMd('one.md', '---\ntags: [t1]\n---\n\n# One\n\nfirstbody and [[Two]]\n');
    await writeMd('sub/two.md', '# Two Title\n\nsecondbody\n');
    await reconciler.reconcile(); // index the current two files

    // drift: a brand-new file not yet indexed, plus a stale row rebuild must remove
    await writeMd('three.md', '# Three\n\nthirdbody\n');
    db.query(
      "INSERT INTO notes(path, path_key, mtime_ms, size, title, frontmatter) VALUES ('ghost.md','ghost.md',1,1,'Ghost','{}')",
    ).run();

    await reconciler.rebuild();

    const count = (db.query('SELECT count(*) AS c FROM notes').get() as { c: number }).c;
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
```

- [ ] **Run to verify it fails**
  Run: `bun test src/note-index/__tests__/reconcile.test.ts`
  Expected FAIL: both new tests throw `Error: not implemented` from the `rebuild` stub.

- [ ] **Implement `rebuild`** in `src/note-index/reconcile.ts`. First add the `./open.ts` import to the relative import group (keep it between `./index-note.ts` and `./types.ts`):

```ts
import { SCHEMA_VERSION, configFingerprint, writeMeta } from './open.ts';
```

  Then replace the `rebuild` stub body. The file reads (IO) happen first with **no DB writes**; then one `db.transaction` deletes the in-scope rows and bulk-inserts via `indexNote` (nested SAVEPOINT — readers see the pre-rebuild snapshot until the outer COMMIT), and writes the meta keys (delete loop is intentionally un-scoped here; Cycle 4 adds its scope guard):

```ts
  async function rebuild(): Promise<void> {
    const rels = await vaultIo.listMarkdown();
    const items = (
      await Promise.all(
        rels.map(async (rel) => {
          const full = vaultIo.resolveVaultPath(rel, 'read');
          const read = await readConsistent(full);
          if (read.content === null || read.sig === null) {
            return null;
          }

          return { rel, content: read.content, sig: read.sig };
        }),
      )
    ).filter(
      (item): item is { rel: string; content: string; sig: Sig } => item !== null,
    );

    const swap = db.transaction(() => {
      const rows = db
        .query('SELECT id, path_key, path FROM notes')
        .all() as { id: number; path_key: string; path: string }[];
      const delNote = db.query('DELETE FROM notes WHERE id = ?');
      const delFts = db.query('DELETE FROM notes_fts WHERE rowid = ?');
      const delTags = db.query('DELETE FROM note_tags WHERE path_key = ?');
      const delLinks = db.query('DELETE FROM note_links WHERE src_key = ?');
      for (const row of rows) {
        delFts.run(row.id);
        delNote.run(row.id);
        delTags.run(row.path_key);
        delLinks.run(row.path_key);
      }
      for (const item of items) {
        indexNote(db, vaultIo, cfg, item.rel, item.content, item.sig);
      }
      writeMeta(db, 'config_fingerprint', configFingerprint(cfg));
      writeMeta(db, 'schema_version', String(SCHEMA_VERSION));
    });
    swap();
  }
```

- [ ] **Run to verify pass**
  Run: `bun test src/note-index/__tests__/reconcile.test.ts`
  Expected: PASS (8 tests).

---

#### Cycle 4 — scope-bounded destructive ops: a narrow instance must not drop another scope's rows

- [ ] **Write the failing test(s) for scope-bounding** (two scoped `VaultIo`s sharing the **one** `db`; add inside the `describe` block):

```ts
  test('scope-bounded reconcile preserves another scope rows when its file vanishes', async () => {
    await writeMd('scopeA/a.md', '# A\n\nabody\n');
    await writeMd('scopeB/b.md', '# B\n\nbbody\n');
    const ioA = createVaultIo({ root, prefixes: { read: ['scopeA'], write: ['scopeA'] }, caseSensitive: true });
    const ioB = createVaultIo({ root, prefixes: { read: ['scopeB'], write: ['scopeB'] }, caseSensitive: true });
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
    const ioA = createVaultIo({ root, prefixes: { read: ['scopeA'], write: ['scopeA'] }, caseSensitive: true });
    const ioB = createVaultIo({ root, prefixes: { read: ['scopeB'], write: ['scopeB'] }, caseSensitive: true });
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
```

- [ ] **Run to verify it fails**
  Run: `bun test src/note-index/__tests__/reconcile.test.ts`
  Expected FAIL: the un-scoped `storedSigs()` makes `recB.reconcile()` treat A's row as in-scope and drop it (`expect(rowFor(keyA)).not.toBeNull()` → received `null`); likewise the un-scoped rebuild delete loop wipes A's row (`recB.rebuild()` → A `null`).

- [ ] **Implement scope-bounding** in `src/note-index/reconcile.ts` — a row is in scope iff `vaultIo.can(itsDisplayPath, 'read')`. (a) Add the guard in `storedSigs()` so only in-scope rows are tracked/droppable:

```ts
  function storedSigs(): Map<string, Sig> {
    const rows = db
      .query('SELECT path_key, path, mtime_ms, size FROM notes')
      .all() as StoredRow[];
    const stored = new Map<string, Sig>();
    for (const row of rows) {
      if (!vaultIo.can(row.path, 'read')) {
        continue; // out-of-scope row: never inspected, never dropped
      }
      stored.set(row.path_key, { mtimeMs: row.mtime_ms, size: row.size });
    }

    return stored;
  }
```

  (b) Add the matching guard in `rebuild`'s delete loop so only in-scope rows are deleted before the bulk insert:

```ts
      for (const row of rows) {
        if (!vaultIo.can(row.path, 'read')) {
          continue; // out-of-scope row: survives the rebuild swap
        }
        delFts.run(row.id);
        delNote.run(row.id);
        delTags.run(row.path_key);
        delLinks.run(row.path_key);
      }
```

- [ ] **Run to verify pass**
  Run: `bun test src/note-index/__tests__/reconcile.test.ts`
  Expected: PASS (10 tests).

---

- [ ] **Commit**

```bash
git add src/note-index/reconcile.ts src/note-index/index.ts src/note-index/__tests__/reconcile.test.ts && \
git commit --no-gpg-sign -m "feat(note-index): add createReconciler (reconcile/reconcilePaths/rebuild), scope-bounded"
```

---

### Task 4: query

**Files:**
- Create: `src/query/query.ts`, `src/query/index.ts`, `src/query/__tests__/query.test.ts`

**Interfaces:**

Consumes (real, from prior Plan 2 tasks):
- `../errors.ts` → `MdVaultError` (codes incl. `VALIDATION_ERROR`), `MdVaultCode`
- `../vault-io/index.ts` → `VaultIo` (methods: `can(rel, access): boolean`, `toKey(rel): string`, `toVaultRelative(rel): string`), `Access`
- `../note-index/index.ts` → `IndexConfig = { linkResolution: 'wikilink'|'relative'; caseSensitive: boolean; ignore: string[] }`
- `bun:sqlite` → `Database` (`db.query(sql).all(...params)` / `.get(...params)`)
- `../links/index.ts` → `StoredLink` (for wikilink `base` tie-break shape — used conceptually; imported as type only if needed)

> **Prerequisite:** The note-index task (Task 2 or 3 in Plan 2) must be merged so that
> `src/note-index/index.ts` exports `type IndexConfig`. Only the type is consumed at
> compile time; the tests below are self-contained and do not call `indexNote`.

Produces (verbatim):

```ts
export type OrderField = 'mtime_ms' | 'path' | 'title'
export type QueryOrder = { field: OrderField; dir: 'asc' | 'desc' }
export type WhereMap = Record<string, string | number | boolean>
export type NoteHit = { path: string; title: string; frontmatter: Record<string, unknown>; tags: string[] }
export type SearchHit = { path: string; title: string; snippet?: string }
export function createQuery(db: Database, vaultIo: VaultIo, cfg: IndexConfig): {
  queryNotes(opts?: { tag?: string; where?: WhereMap; folder?: string; orderBy?: QueryOrder; limit?: number; offset?: number }): NoteHit[]
  backlinks(path: string, opts?: { limit?: number; offset?: number }): { from: string }[]
  outboundLinks(path: string, opts?: { limit?: number; offset?: number }): { target: string; resolved: string | null }[]
  searchText(q: string, opts?: { tag?: string; folder?: string; limit?: number; offset?: number }): SearchHit[]
}
```

---

#### TDD Cycle 1 — Types + factory scaffold

- [ ] **Write the failing test(s)**

```ts
// src/query/__tests__/query.test.ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVaultIo } from '../../vault-io/index.ts';
import { createQuery } from '../query.ts';

// ── shared schema ────────────────────────────────────────────────────────────
function setupDb(db: Database): void {
  db.exec(`
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
    db.query('INSERT OR IGNORE INTO note_tags (path_key, tag) VALUES (?, ?)').run(pathKey, tag);
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
  vaultDir = await mkdtemp(join(tmpdir(), 'mdvault-query-'));
  db = new Database(':memory:');
  setupDb(db);
});

afterEach(async () => {
  db.close();
  await rm(vaultDir, { recursive: true, force: true });
});

// ── Cycle 1: scaffold ─────────────────────────────────────────────────────────
describe('createQuery factory', () => {
  test('returns an object with all four methods', () => {
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
    const q = createQuery(db, io, { linkResolution: 'wikilink', caseSensitive: false, ignore: [] });
    expect(typeof q.queryNotes).toBe('function');
    expect(typeof q.backlinks).toBe('function');
    expect(typeof q.outboundLinks).toBe('function');
    expect(typeof q.searchText).toBe('function');
  });

  test('queryNotes returns [] on an empty DB', () => {
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
    const { queryNotes } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    expect(queryNotes()).toEqual([]);
  });
});
```

- [ ] **Run to verify it fails**

```
bun test src/query/__tests__/query.test.ts
```

Expected reason: `Cannot find module '../query.ts'` — the file does not exist yet.

- [ ] **Implement scaffold — `src/query/query.ts`**

```ts
import type { Database } from 'bun:sqlite';

import { MdVaultError } from '../errors.ts';
import type { IndexConfig } from '../note-index/index.ts';
import type { VaultIo } from '../vault-io/index.ts';

export type OrderField = 'mtime_ms' | 'path' | 'title';
export type QueryOrder = { field: OrderField; dir: 'asc' | 'desc' };
export type WhereMap = Record<string, string | number | boolean>;
export type NoteHit = {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
};
export type SearchHit = { path: string; title: string; snippet?: string };

const ORDER_FIELDS = new Set<string>(['mtime_ms', 'path', 'title']);
const WHERE_KEY_RE = /^[A-Za-z0-9_.-]+$/;
const DEFAULT_LIMIT = 100;
const HARD_MAX = 1000;

type RawNoteRow = { path: string; path_key: string; title: string; frontmatter: string };
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
    throw new MdVaultError('VALIDATION_ERROR', `limit must be a non-negative integer, got: ${limit}`);
  }
  if (!Number.isInteger(off) || off < 0) {
    throw new MdVaultError('VALIDATION_ERROR', `offset must be a non-negative integer, got: ${offset}`);
  }

  return { lim: Math.min(lim, HARD_MAX), off };
}

function sanitizeFts(q: string): string | null {
  const tokens = q.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;

  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
}

function pathBaseLower(p: string): string {
  return (p.split('/').at(-1) ?? p).replace(/\.md$/i, '').toLowerCase();
}

function pathFolder(p: string): string {
  const i = p.lastIndexOf('/');

  return i < 0 ? '' : p.slice(0, i);
}

function tieBreakWinner(candidates: { path: string }[], srcFolder: string): string | undefined {
  const sorted = [...candidates].sort((a, b) => {
    const af = pathFolder(a.path);
    const bf = pathFolder(b.path);
    const as_ = af === srcFolder ? 0 : 1;
    const bs_ = bf === srcFolder ? 0 : 1;
    if (as_ !== bs_) return as_ - bs_;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;

    return a.path.localeCompare(b.path);
  });

  return sorted[0]?.path;
}

export function createQuery(db: Database, vaultIo: VaultIo, cfg: IndexConfig) {
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
    const params: unknown[] = [];

    if (tag !== undefined) {
      parts.push(
        'EXISTS (SELECT 1 FROM note_tags nt WHERE nt.path_key = n.path_key AND nt.tag = ?)',
      );
      params.push(tag);
    }

    for (const key of Object.keys(where)) {
      if (!WHERE_KEY_RE.test(key)) {
        throw new MdVaultError('VALIDATION_ERROR', `where key contains invalid characters: ${key}`);
      }
      parts.push(`json_extract(n.frontmatter, '$."${key}"') = ?`);
      params.push(where[key]);
    }

    if (folder !== undefined) {
      parts.push('(n.path = ? OR n.path LIKE ?)');
      params.push(folder, `${folder}/%`);
    }

    const clause = parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '';
    const sql = `SELECT n.path, n.path_key, n.title, n.frontmatter FROM notes n ${clause} ORDER BY n.${order.field} ${dir}, n.path ASC LIMIT ? OFFSET ?`;
    params.push(lim, off);
    const rows = db.query<RawNoteRow, unknown[]>(sql).all(...params);
    const results: NoteHit[] = [];
    for (const row of rows) {
      if (!inScope(row.path)) continue;
      results.push({
        path: row.path,
        title: row.title,
        frontmatter: JSON.parse(row.frontmatter) as Record<string, unknown>,
        tags: tagsFor(row.path_key),
      });
    }

    return results;
  }

  function backlinks(
    path: string,
    opts: { limit?: number; offset?: number } = {},
  ): { from: string }[] {
    if (!inScope(path)) return [];
    const { lim, off } = validatePagination(opts.limit, opts.offset);
    const display = vaultIo.toVaultRelative(path);
    const targetKey = vaultIo.toKey(path);
    const base = pathBaseLower(display);
    const sources: string[] = [];

    if (cfg.linkResolution === 'relative') {
      const rows = db
        .query<{ from_path: string }, [string]>(
          `SELECT n.path AS from_path
           FROM note_links nl
           JOIN notes n ON n.path_key = nl.src_key
           WHERE nl.target = ?`,
        )
        .all(targetKey);
      for (const r of rows) {
        if (inScope(r.from_path)) sources.push(r.from_path);
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
        if (!inScope(r.from_path)) continue;
        if (vaultIo.toKey(`${r.target}.md`) === targetKey) sources.push(r.from_path);
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
        if (!inScope(r.from_path)) continue;
        const winner = tieBreakWinner(candidates, pathFolder(r.from_path));
        if (winner === display) sources.push(r.from_path);
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
  ): { target: string; resolved: string | null }[] {
    if (!inScope(path)) return [];
    const { lim, off } = validatePagination(opts.limit, opts.offset);
    const srcKey = vaultIo.toKey(path);
    const display = vaultIo.toVaultRelative(path);
    const rows = db
      .query<LinkRow, [string]>(
        `SELECT target, base FROM note_links WHERE src_key = ? LIMIT -1 OFFSET 0`,
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
        if (hit && inScope(hit.path)) resolved = hit.path;
      } else if (row.target.includes('/')) {
        const tKey = vaultIo.toKey(`${row.target}.md`);
        const hit = db
          .query<PathRow, [string]>('SELECT path FROM notes WHERE path_key = ?')
          .get(tKey);
        if (hit && inScope(hit.path)) resolved = hit.path;
      } else if (row.base !== null) {
        const rawC = db
          .query<PathRow, [string, string]>(
            'SELECT path FROM notes WHERE LOWER(path_key) = ? OR LOWER(path_key) LIKE ?',
          )
          .all(`${row.base}.md`, `%/${row.base}.md`);
        const cands = rawC.filter((c) => pathBaseLower(c.path) === row.base && inScope(c.path));
        const winner = tieBreakWinner(cands, pathFolder(display));
        if (winner !== undefined) resolved = winner;
      }

      results.push({ target: row.target, resolved });
    }

    return results;
  }

  function searchText(
    q: string,
    opts: { tag?: string; folder?: string; limit?: number; offset?: number } = {},
  ): SearchHit[] {
    const { tag, folder, limit, offset } = opts;
    const { lim, off } = validatePagination(limit, offset);
    const ftsQ = sanitizeFts(q);
    if (ftsQ === null) return [];

    const parts: string[] = [];
    const params: unknown[] = [ftsQ];

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
    const sql = `
      SELECT n.path, n.title,
             snippet(notes_fts, 0, '<b>', '</b>', '…', 10) AS snippet
      FROM notes_fts
      JOIN notes n ON notes_fts.rowid = n.id
      WHERE notes_fts MATCH ? ${extra}
      ORDER BY notes_fts.rank
      LIMIT ? OFFSET ?
    `;
    params.push(lim, off);

    let rows: SearchRow[];
    try {
      rows = db.query<SearchRow, unknown[]>(sql).all(...params);
    } catch {
      // malformed FTS query that slipped through sanitizer → safe empty result
      return [];
    }

    const results: SearchHit[] = [];
    for (const row of rows) {
      if (!inScope(row.path)) continue;
      results.push({
        path: row.path,
        title: row.title,
        snippet: row.snippet || undefined,
      });
    }

    return results;
  }

  return { queryNotes, backlinks, outboundLinks, searchText };
}
```

- [ ] **Implement barrel — `src/query/index.ts`**

```ts
export type {
  NoteHit,
  OrderField,
  QueryOrder,
  SearchHit,
  WhereMap,
} from './query.ts';
export { createQuery } from './query.ts';
```

- [ ] **Run to verify Cycle 1 passes**

```
bun test src/query/__tests__/query.test.ts --test-name-pattern "createQuery factory"
```

Expected: 2 pass.

---

#### TDD Cycle 2 — `queryNotes`: validation + filtering + read-scope + injection proof

- [ ] **Write the failing tests** (add these `describe` blocks to the test file)

```ts
// ── Cycle 2: queryNotes ───────────────────────────────────────────────────────
describe('queryNotes — validation', () => {
  test('throws VALIDATION_ERROR on invalid where key (special chars)', () => {
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
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
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
    const { queryNotes } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    // key contains "; DROP TABLE notes --" shape — must be rejected before any SQL
    expect(() => queryNotes({ where: { 'a";DROP TABLE notes--': 'x' } })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
    // verify notes table is still intact (no injection occurred)
    expect(db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM notes').get()!.c).toBe(0);
  });

  test('throws VALIDATION_ERROR on unknown orderBy field', () => {
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
    const { queryNotes } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    expect(() =>
      queryNotes({ orderBy: { field: 'created_at' as 'mtime_ms', dir: 'asc' } }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  test('throws VALIDATION_ERROR on negative limit', () => {
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
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
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
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
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
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
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
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
    const a = hits.find((h) => h.path === 'note-a.md')!;
    expect(a.title).toBe('Note A');
    expect(a.frontmatter).toEqual({ status: 'draft' });
    expect(a.tags).toEqual(['idea']);
  });

  test('tag filter: only notes with that tag', () => {
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
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
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
    const { queryNotes } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, { path: 'daily/2026-01.md' });
    insertNote(db, { path: 'daily/sub/2026-02.md' });
    insertNote(db, { path: 'projects/foo.md' });
    const hits = queryNotes({ folder: 'daily' });
    expect(hits.map((h) => h.path).sort()).toEqual(['daily/2026-01.md', 'daily/sub/2026-02.md']);
  });

  test('where filter: matches key=value; missing key = no match', () => {
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
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
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
    const { queryNotes } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, { path: 'a.md', frontmatter: { status: 'draft' }, tags: ['idea'] });
    insertNote(db, { path: 'b.md', frontmatter: { status: 'draft' }, tags: [] });
    insertNote(db, { path: 'c.md', frontmatter: { status: 'done' }, tags: ['idea'] });
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
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
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
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
    const { queryNotes } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    for (const p of ['a.md', 'b.md', 'c.md', 'd.md']) insertNote(db, { path: p });
    const page1 = queryNotes({ orderBy: { field: 'path', dir: 'asc' }, limit: 2, offset: 0 });
    const page2 = queryNotes({ orderBy: { field: 'path', dir: 'asc' }, limit: 2, offset: 2 });
    expect(page1.map((h) => h.path)).toEqual(['a.md', 'b.md']);
    expect(page2.map((h) => h.path)).toEqual(['c.md', 'd.md']);
  });
});
```

- [ ] **Run to verify it fails**

```
bun test src/query/__tests__/query.test.ts --test-name-pattern "queryNotes"
```

Expected reason: Tests for `queryNotes — validation` pass if implementation already present from Cycle 1; however `queryNotes — filtering` tests fail because the DB is empty / the query returns no rows (the implementation IS present from Cycle 1 — these tests fail because `insertNote` data is not yet validated against a running query). On a clean state where only the scaffold exists, tests fail with missing implementation errors. Once the full `query.ts` from Cycle 1 is in place, run this to confirm all Cycle 2 tests go green:

- [ ] **Run to verify Cycle 2 passes**

```
bun test src/query/__tests__/query.test.ts --test-name-pattern "queryNotes"
```

Expected: all 12 tests pass.

> Note: Because the full `query.ts` implementation is provided in Cycle 1 above (containing
> all four functions), Cycles 2–4 are primarily test-coverage cycles. The test-first
> discipline here is: write each test block, verify it exercises the correct code path,
> confirm the test passes for the right reasons (actual logic, not a stub returning []).

---

#### TDD Cycle 3 — `backlinks` and `outboundLinks`

- [ ] **Write the failing tests** (add these `describe` blocks to the test file)

```ts
// ── Cycle 3: backlinks ───────────────────────────────────────────────────────
describe('backlinks — relative mode', () => {
  test('returns source notes whose stored target matches the path key', () => {
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
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
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
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
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
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
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
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
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
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
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
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
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
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
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
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
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
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
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
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
```

- [ ] **Run to verify Cycle 3 passes**

```
bun test src/query/__tests__/query.test.ts --test-name-pattern "backlinks|outboundLinks"
```

Expected: all 10 tests pass (tie-break logic, read-scope, dangling, relative/wikilink modes).

---

#### TDD Cycle 4 — `searchText`: FTS5 + sanitization + adversarial input

- [ ] **Write the failing tests** (add these `describe` blocks to the test file)

```ts
// ── Cycle 4: searchText ──────────────────────────────────────────────────────
describe('searchText — sanitization: adversarial FTS5 input never throws', () => {
  test('empty string → [] (no throw)', () => {
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
    const { searchText } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    expect(() => searchText('')).not.toThrow();
    expect(searchText('')).toEqual([]);
  });

  test('whitespace-only → []', () => {
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
    const { searchText } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    expect(searchText('   \t  ')).toEqual([]);
  });

  test('raw FTS5 operators (+ - : *) → [] not throw', () => {
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
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
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
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
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
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
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
    const { searchText } = createQuery(db, io, {
      linkResolution: 'wikilink',
      caseSensitive: false,
      ignore: [],
    });
    insertNote(db, { path: 'a.md', title: 'Alpha', body: 'the quick brown fox' });
    insertNote(db, { path: 'b.md', title: 'Beta', body: 'the lazy dog' });
    const hits = searchText('fox');
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe('a.md');
    expect(hits[0].title).toBe('Alpha');
  });

  test('snippet is present for a match', () => {
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
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
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
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
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
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
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
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
    const io = createVaultIo({ root: vaultDir, prefixes: { read: [''], write: [''] } });
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
```

- [ ] **Run to verify Cycle 4 passes**

```
bun test src/query/__tests__/query.test.ts --test-name-pattern "searchText"
```

Expected: all 12 tests pass. Adversarial inputs return `[]` without throwing; keyword search, tag/folder filters, read-scope, and pagination all work correctly.

- [ ] **Full test gate**

```
bun test src/query/__tests__/query.test.ts
```

Expected: all tests pass (factory + queryNotes + backlinks + outboundLinks + searchText).

- [ ] **Type-check**

```
bun run check
```

Expected: Biome + `tsc --noEmit` both green; no import cycles, all types resolve.

---

#### Commit

- [ ] **Commit**

```bash
git add src/query && git commit --no-gpg-sign -m "feat(query): SQLite query layer — queryNotes/backlinks/outboundLinks/searchText with read-scope, wikilink tie-break, and sanitized FTS5"
```

---

### Task 5: notes (CRUD with in-lock write-through)

**Files:**
- Create: `src/notes/notes.ts` (the `createNotes` factory + the notes types), `src/notes/index.ts` (named re-export barrel).
- Test: `src/notes/__tests__/notes.test.ts`.

**Interfaces:**

Consumes (exact signatures imported — copy verbatim):
- Plan-1 `../errors.ts`: `class MdVaultError extends Error { readonly code: MdVaultCode }` (codes used here: `NOT_FOUND`, `ALREADY_EXISTS`, `NO_MATCH`, `AMBIGUOUS_MATCH`, `FRONTMATTER_INVALID`, `COMMIT_FAILED`).
- Plan-1 `../fs-atomic/index.ts`: `exclusiveCreate(fullPath, content): Promise<Sig>` (EEXIST → `ALREADY_EXISTS`); `statSig(fullPath): Promise<Sig|null>`; `type Sig={mtimeMs:number;size:number}`.
- Plan-1 `../locked-file/index.ts`: `withFileTransform(fullPath, lockKey, relForCommit, transform:(current:string|null)=>string|null, opts?:TransformOpts): Promise<TransformResult>`; `withFileDelete(fullPath, lockKey, relForCommit, opts?:{onCommit?;cross?}): Promise<{deleted:boolean}>`; `type CommitEvent = {op:'create'|'update';path:string;content:string} | {op:'delete';path:string}`; `type CrossLock={lockDir:string;busyTimeoutMs:number}`; `type TransformOpts={allowCreate?:boolean;onCommit?:(e:CommitEvent)=>void|Promise<void>;maxRetries?:number;cross?:CrossLock|false}`.
- Plan-1 `../locks/index.ts`: `withFileLock<T>(key, fn:()=>Promise<T>): Promise<T>`; `withCrossProcessLock<T>(lockDir, key, busyTimeoutMs, fn:()=>Promise<T>): Promise<T>`.
- Plan-1 `../frontmatter/index.ts`: `parseFrontmatter(content):{frontmatter;tags;body;valid}`; `editFrontmatter(content, mutate:(fm)=>void):{content;outcome:'edited'|'unchanged'|'unverifiable'}`; `type EditOutcome`, `type FrontmatterValidity`.
- Plan-1 `../vault-io/index.ts`: `type VaultIo` (methods `toVaultRelative`, `toKey`, `resolveVaultPath(rel,access?)`, `readVaultFile(rel):Promise<{content;sig}|null>`, `stat(rel):Promise<Sig|null>`, …); `createVaultIo(config)` (tests only).
- Task 1-3 `../note-index/index.ts`: `indexNote(db, vaultIo, cfg, rel, content, sig): void`; `dropNote(db, pathKey): void`; `type IndexConfig`; `openIndexDb(indexPath,{sqliteBusyTimeoutMs}): Database` + `applySchema(db): void` (tests only).
- Task 4 `../query/index.ts`: `createQuery(db, vaultIo, cfg)` returning `{ queryNotes, backlinks, outboundLinks, searchText }`.

Produces (exact exported signatures later tasks rely on — copy verbatim):
```ts
export type ReadNoteResult = { frontmatter: Record<string, unknown>; tags: string[]; body: string; valid: FrontmatterValidity; outbound?: { target: string; resolved: string | null }[]; backlinks?: { from: string }[] }
export type UpdateOp = { editByMatch: { old: string; new: string } } | { append: string }
export type NotesDeps = { db: Database; vaultIo: VaultIo; cfg: IndexConfig; query: ReturnType<typeof createQuery>; onCommit?: (e: CommitEvent) => void | Promise<void>; cross?: CrossLock | false }
createNotes(deps: NotesDeps) returns {
  readNote(path: string, opts?: { withLinks?: boolean }): Promise<ReadNoteResult>
  createNote(path: string, input: { frontmatter?: Record<string,unknown>; body: string }): Promise<void>
  updateNote(path: string, op: UpdateOp): Promise<void>
  editFrontmatter(path: string, mutate: (fm: Record<string,unknown>) => void): Promise<EditOutcome>
  deleteNote(path: string): Promise<boolean>
}
```

**PINNED write-through mechanism (load-bearing):** the per-file lock is taken by `withFileTransform`/`withFileDelete` and is **not reentrant** (`src/locks/in-process.ts` chains promises by key — a nested `withFileLock(sameKey)` would deadlock). So write-through is sequenced via the **`onCommit` seam**: we pass our own `indexCommit` as the `onCommit`, which runs **inside the same lock, AFTER the file write commits and BEFORE the consumer's `onCommit`**. `indexCommit` does `indexNote`/`dropNote` first, then calls `deps.onCommit`. `createNote` uses `exclusiveCreate` (true no-clobber) inside an explicit `withFileLock` (+ cross lock), then `indexNote`, then `onCommit` — index in the same lock as the create. On an index-write failure the file stays (reconcile backstop) and the stored `(mtime,size)` only advances if the `indexNote` transaction commits.

---

#### Cycle 1 — `readNote` (missing / present / `withLinks`)

- [ ] Write the failing test(s) for `readNote`

```ts
import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MdVaultError } from '../../errors.ts';
import {
  type IndexConfig,
  applySchema,
  indexNote,
  openIndexDb,
} from '../../note-index/index.ts';
import { createQuery } from '../../query/index.ts';
import { type VaultIo, createVaultIo } from '../../vault-io/index.ts';
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
  notes = createNotes({ db, io, cfg, query, cross: false });
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
```

- [ ] Run to verify it fails
  Run: `bun test src/notes/__tests__/notes.test.ts`
  Expected FAIL: `error: Cannot find module '../notes.ts'` — `src/notes/notes.ts` and its barrel do not exist yet, so the suite cannot import `createNotes`.

- [ ] Implement `readNote` (create `src/notes/notes.ts` with the full import block + types + factory shell + `readNote`, and `src/notes/index.ts`). The complete import block here covers the whole module; later cycles fill in the methods that use the currently-unreferenced imports.

`src/notes/notes.ts`:
```ts
import type { Database } from 'bun:sqlite';

import { MdVaultError } from '../errors.ts';
import {
  type EditOutcome,
  type FrontmatterValidity,
  editFrontmatter as fmEditFrontmatter,
  parseFrontmatter,
} from '../frontmatter/index.ts';
import { exclusiveCreate, statSig } from '../fs-atomic/index.ts';
import {
  type CommitEvent,
  type CrossLock,
  withFileDelete,
  withFileTransform,
} from '../locked-file/index.ts';
import { withCrossProcessLock, withFileLock } from '../locks/index.ts';
import { type IndexConfig, dropNote, indexNote } from '../note-index/index.ts';
import { createQuery } from '../query/index.ts';
import type { VaultIo } from '../vault-io/index.ts';

export type ReadNoteResult = {
  frontmatter: Record<string, unknown>;
  tags: string[];
  body: string;
  valid: FrontmatterValidity;
  outbound?: { target: string; resolved: string | null }[];
  backlinks?: { from: string }[];
};

export type UpdateOp =
  | { editByMatch: { old: string; new: string } }
  | { append: string };

export type NotesDeps = {
  db: Database;
  vaultIo: VaultIo;
  cfg: IndexConfig;
  query: ReturnType<typeof createQuery>;
  onCommit?: (e: CommitEvent) => void | Promise<void>;
  cross?: CrossLock | false;
};

export function createNotes(deps: NotesDeps) {
  const { db, vaultIo, cfg, query, onCommit, cross = false } = deps;

  async function readNote(
    path: string,
    opts?: { withLinks?: boolean },
  ): Promise<ReadNoteResult> {
    const read = await vaultIo.readVaultFile(path);
    if (!read) {
      throw new MdVaultError('NOT_FOUND', `note not found: ${path}`);
    }
    const parsed = parseFrontmatter(read.content);
    const result: ReadNoteResult = {
      frontmatter: parsed.frontmatter,
      tags: parsed.tags,
      body: parsed.body,
      valid: parsed.valid,
    };
    if (opts?.withLinks) {
      result.outbound = query.outboundLinks(path);
      result.backlinks = query.backlinks(path);
    }

    return result;
  }

  return { readNote };
}
```

`src/notes/index.ts`:
```ts
export { createNotes } from './notes.ts';
export type { NotesDeps, ReadNoteResult, UpdateOp } from './notes.ts';
```

- [ ] Run to verify pass
  Run: `bun test src/notes/__tests__/notes.test.ts`
  Expected: PASS.

---

#### Cycle 2 — `createNote` (write-through index + exclusive-create no-clobber)

- [ ] Write the failing test(s) for `createNote` (append this `describe` block to `src/notes/__tests__/notes.test.ts`)

```ts
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
```

- [ ] Run to verify it fails
  Run: `bun test src/notes/__tests__/notes.test.ts`
  Expected FAIL: `TypeError: notes.createNote is not a function` — Cycle 1's factory returns only `{ readNote }`.

- [ ] Implement `createNote` (add the `runLocked` + `buildContent` helpers and the `createNote` method inside `createNotes`, just above the `return`, then extend the returned object)

```ts
  function runLocked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const locked = () => withFileLock(key, fn);
    if (cross) {
      return withCrossProcessLock(
        cross.lockDir,
        key,
        cross.busyTimeoutMs,
        locked,
      );
    }

    return locked();
  }

  function buildContent(input: {
    frontmatter?: Record<string, unknown>;
    body: string;
  }): string {
    const fm = input.frontmatter;
    if (!fm || Object.keys(fm).length === 0) {
      return input.body;
    }
    const res = fmEditFrontmatter(input.body, (view) => {
      for (const [k, v] of Object.entries(fm)) {
        view[k] = v;
      }
    });
    if (res.outcome === 'unverifiable') {
      throw new MdVaultError(
        'FRONTMATTER_INVALID',
        `frontmatter is not flat: ${Object.keys(fm).join(', ')}`,
      );
    }

    return res.content;
  }

  async function createNote(
    path: string,
    input: { frontmatter?: Record<string, unknown>; body: string },
  ): Promise<void> {
    const content = buildContent(input);
    const full = vaultIo.resolveVaultPath(path, 'write');
    const key = vaultIo.toKey(path);
    const display = vaultIo.toVaultRelative(path);
    await runLocked(key, async () => {
      // exclusiveCreate (temp + link) → ALREADY_EXISTS on clash, never clobbers.
      const sig = await exclusiveCreate(full, content);
      // Write-through: index in the SAME lock with the post-create sig.
      indexNote(db, vaultIo, cfg, path, content, sig);
      if (onCommit) {
        try {
          await onCommit({ op: 'create', path: display, content });
        } catch (cause) {
          throw new MdVaultError(
            'COMMIT_FAILED',
            `onCommit failed for ${display}`,
            { cause },
          );
        }
      }
    });
  }
```

Update the factory's returned object to:
```ts
  return { readNote, createNote };
```

- [ ] Run to verify pass
  Run: `bun test src/notes/__tests__/notes.test.ts`
  Expected: PASS.

---

#### Cycle 3 — `updateNote` (`editByMatch` 0/1/>1 + `append` create-if-missing, write-through)

- [ ] Write the failing test(s) for `updateNote` (append this `describe` block to the test file)

```ts
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
      await notes.updateNote('zero.md', { editByMatch: { old: 'zzz', new: 'q' } });
    } catch (e) {
      err = e;
    }
    expect((err as MdVaultError).code).toBe('NO_MATCH');
    expect(await readFile(join(vaultDir, 'zero.md'), 'utf8')).toBe('nothing here');
  });

  test('editByMatch >1 occurrences → AMBIGUOUS_MATCH, no partial write', async () => {
    await notes.createNote('many.md', { body: 'x marks x marks x' });
    let err: unknown;
    try {
      await notes.updateNote('many.md', { editByMatch: { old: 'x', new: 'y' } });
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
    expect(await readFile(join(vaultDir, 'fresh.md'), 'utf8')).toBe('hello world');
    expect(query.searchText('hello').map((h) => h.path)).toContain('fresh.md');
  });

  test('append newline rule: one newline before text iff existing lacks a trailing newline', async () => {
    await notes.createNote('log.md', { body: 'line1' });
    await notes.updateNote('log.md', { append: 'line2' });
    expect(await readFile(join(vaultDir, 'log.md'), 'utf8')).toBe('line1\nline2');
  });
});
```

- [ ] Run to verify it fails
  Run: `bun test src/notes/__tests__/notes.test.ts`
  Expected FAIL: `TypeError: notes.updateNote is not a function` — not yet on the returned object.

- [ ] Implement `updateNote` (add module-level `countOccurrences` above `createNotes`; add the `indexCommit` write-through seam and the `updateNote` method inside `createNotes`; extend the return)

Module-level (above `createNotes`):
```ts
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }

  return count;
}
```

Inside `createNotes` (the shared write-through seam + the method):
```ts
  // Write-through seam. withFileTransform/withFileDelete invoke this INSIDE the
  // per-file lock, AFTER the file write commits and BEFORE the consumer onCommit.
  // The index mutation therefore shares the same lock as the file write.
  const indexCommit = async (e: CommitEvent): Promise<void> => {
    if (e.op === 'delete') {
      dropNote(db, vaultIo.toKey(e.path));
    } else {
      const sig = await statSig(vaultIo.resolveVaultPath(e.path, 'write'));
      if (sig) {
        indexNote(db, vaultIo, cfg, e.path, e.content, sig);
      }
    }
    if (onCommit) {
      await onCommit(e);
    }
  };

  async function updateNote(path: string, op: UpdateOp): Promise<void> {
    const full = vaultIo.resolveVaultPath(path, 'write');
    const key = vaultIo.toKey(path);
    const display = vaultIo.toVaultRelative(path);
    const transform = (current: string | null): string | null => {
      if ('append' in op) {
        const baseText = current ?? '';
        const needsNl = baseText.length > 0 && !baseText.endsWith('\n');

        return `${baseText}${needsNl ? '\n' : ''}${op.append}`;
      }
      const { old, new: replacement } = op.editByMatch;
      if (current === null) {
        throw new MdVaultError(
          'NO_MATCH',
          `no match in missing file: ${display}`,
        );
      }
      const count = countOccurrences(current, old);
      if (count === 0) {
        throw new MdVaultError(
          'NO_MATCH',
          `no match for replacement in ${display}`,
        );
      }
      if (count > 1) {
        throw new MdVaultError(
          'AMBIGUOUS_MATCH',
          `ambiguous match (${count}) in ${display}`,
        );
      }
      const at = current.indexOf(old);

      return current.slice(0, at) + replacement + current.slice(at + old.length);
    };
    await withFileTransform(full, key, display, transform, {
      allowCreate: 'append' in op,
      onCommit: indexCommit,
      cross,
    });
  }
```

Update the returned object to:
```ts
  return { readNote, createNote, updateNote };
```

- [ ] Run to verify pass
  Run: `bun test src/notes/__tests__/notes.test.ts`
  Expected: PASS.

---

#### Cycle 4 — `editFrontmatter` (field change + reindex; unverifiable leaves file AND index untouched)

- [ ] Write the failing test(s) for `editFrontmatter` (append this `describe` block to the test file)

```ts
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
```

- [ ] Run to verify it fails
  Run: `bun test src/notes/__tests__/notes.test.ts`
  Expected FAIL: `TypeError: notes.editFrontmatter is not a function` — not yet on the returned object.

- [ ] Implement `editFrontmatter` (add the method inside `createNotes`; extend the return). The transform returns `null` for `unchanged`/`unverifiable`, so no file write and no `onCommit`/reindex fire — file and index both stay.

```ts
  async function editFrontmatter(
    path: string,
    mutate: (fm: Record<string, unknown>) => void,
  ): Promise<EditOutcome> {
    const full = vaultIo.resolveVaultPath(path, 'write');
    const key = vaultIo.toKey(path);
    const display = vaultIo.toVaultRelative(path);
    let outcome: EditOutcome = 'unchanged';
    const transform = (current: string | null): string | null => {
      if (current === null) {
        outcome = 'unchanged';

        return null;
      }
      const res = fmEditFrontmatter(current, mutate);
      outcome = res.outcome;
      if (res.outcome === 'edited') {
        return res.content;
      }

      return null;
    };
    await withFileTransform(full, key, display, transform, {
      allowCreate: false,
      onCommit: indexCommit,
      cross,
    });

    return outcome;
  }
```

Update the returned object to:
```ts
  return { readNote, createNote, updateNote, editFrontmatter };
```

- [ ] Run to verify pass
  Run: `bun test src/notes/__tests__/notes.test.ts`
  Expected: PASS.

---

#### Cycle 5 — `deleteNote` (file + index row dropped, returns true; missing → false)

- [ ] Write the failing test(s) for `deleteNote` (append this `describe` block to the test file)

```ts
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
```

- [ ] Run to verify it fails
  Run: `bun test src/notes/__tests__/notes.test.ts`
  Expected FAIL: `TypeError: notes.deleteNote is not a function` — not yet on the returned object.

- [ ] Implement `deleteNote` (add the method inside `createNotes`; finalize the return). `withFileDelete` calls `onCommit` (our `indexCommit` → `dropNote`) only when it actually deleted, all inside the one lock; a missing file is a no-op with no `onCommit` and no drop.

```ts
  async function deleteNote(path: string): Promise<boolean> {
    const full = vaultIo.resolveVaultPath(path, 'write');
    const key = vaultIo.toKey(path);
    const display = vaultIo.toVaultRelative(path);
    const { deleted } = await withFileDelete(full, key, display, {
      onCommit: indexCommit,
      cross,
    });

    return deleted;
  }
```

Finalize the returned object to:
```ts
  return { readNote, createNote, updateNote, editFrontmatter, deleteNote };
```

- [ ] Run to verify pass
  Run: `bun test src/notes/__tests__/notes.test.ts`
  Expected: PASS.

---

- [ ] Commit

```bash
cd /Users/ivan_kalinichenko/Dev/Personal/mdvault
bun run check && bun test src/notes/__tests__/notes.test.ts
git add src/notes/notes.ts src/notes/index.ts src/notes/__tests__/notes.test.ts
git commit --no-gpg-sign -m "feat(notes): CRUD primitives with in-lock write-through to the index"
```

---

I have everything I need. Here is the complete Task 6 block.

---

### Task 6: vault (async composition root)

**Files:**
- Create: `src/vault/create-vault.ts` (+ `src/vault/index.ts`)
- Test: `src/vault/__tests__/create-vault.test.ts`

**Interfaces:**

Consumes (exact signatures, imported from sibling folder barrels):
- `../errors.ts`: `class MdVaultError extends Error { readonly code: MdVaultCode; constructor(code, message, options?: { cause?: unknown }) }` — code `INDEX_UNAVAILABLE`
- `../vault-io/index.ts`: `createVaultIo(config: VaultIoConfig): VaultIo`; `type VaultIoConfig = { root: string; prefixes: VaultPrefixes; caseSensitive?: boolean; ignore?: string[] }`; `type VaultPrefixes = { read: string[]; write: string[] }`; `VaultIo` has `toKey(rel): string`, `toVaultRelative(rel): string` (plus the IO methods)
- `../locked-file/index.ts`: `type CommitEvent = { op: 'create'|'update'; path: string; content: string } | { op: 'delete'; path: string }`; `type CrossLock = { lockDir: string; busyTimeoutMs: number }`
- `../note-index/index.ts` (Task 1): `const SCHEMA_VERSION = 1`; `type IndexConfig = { linkResolution: 'wikilink'|'relative'; caseSensitive: boolean; ignore: string[] }`; `applySchema(db): void`; `openIndexDb(indexPath, { sqliteBusyTimeoutMs }): Database`; `probeCapabilities(db): void`; `configFingerprint(cfg: IndexConfig): string`; `readMeta(db, key): string|null`; `createReconciler(db, vaultIo, cfg): { reconcile(): Promise<void>; reconcilePaths(rels: string[]): Promise<void>; rebuild(): Promise<void> }`
- `../query/index.ts` (Task 5): `createQuery(db, vaultIo, cfg): { queryNotes(opts?): NoteHit[]; backlinks(path, opts?): { from: string }[]; outboundLinks(path, opts?): { target: string; resolved: string|null }[]; searchText(q, opts?): SearchHit[] }`
- `../notes/index.ts` (Task 3): `createNotes(deps: NotesDeps)`; `type NotesDeps = { db: Database; vaultIo: VaultIo; cfg: IndexConfig; query: ReturnType<typeof createQuery>; onCommit?: (e: CommitEvent) => void|Promise<void>; cross?: CrossLock|false }`

Produces (later consumers / both downstream projects rely on these verbatim):
- `export type CreateVaultConfig = VaultIoConfig & { indexPath: string; linkResolution?: 'wikilink'|'relative'; lazyReconcile?: boolean; reconcileTtlMs?: number; sqliteBusyTimeoutMs?: number; crossProcessWriterLock?: boolean; onCommit?: (e: CommitEvent) => void|Promise<void> }`
- `export type Vault = { io: VaultIo; notes: ReturnType<typeof createNotes>; query: ReturnType<typeof createQuery>; reconcile(): Promise<void>; reconcilePaths(rels: string[]): Promise<void>; rebuild(): Promise<void>; close(): void }`
- `export async function createVault(config: CreateVaultConfig): Promise<Vault>`

---

#### Cycle 1 — composition surface, boot build-if-missing, and `close()`/reopen

- [ ] **Write the failing test(s) for the surface, boot build, and close/reopen.** Create `src/vault/__tests__/create-vault.test.ts` with imports, shared fixtures, and the three core tests.

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { MdVaultError } from '../../errors.ts';
import {
  type CreateVaultConfig,
  createVault,
  type Vault,
} from '../create-vault.ts';

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
  vaultDir = await mkdtemp(join(tmpdir(), 'mdvault-vault-'));
  dataDir = await mkdtemp(join(tmpdir(), 'mdvault-data-'));
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
    expect(second.query.queryNotes().map((h) => h.path).sort()).toEqual([
      'One.md',
      'Two.md',
    ]);
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
    expect(vault.query.queryNotes().map((h) => h.path).sort()).toEqual([
      'One.md',
      'Two.md',
    ]);
  });
});
```

- [ ] **Run to verify it fails.**
  Run: `bun test src/vault/__tests__/create-vault.test.ts`
  Expected FAIL: cannot resolve `../create-vault.ts` (module does not exist yet) — every test errors at import.

- [ ] **Implement the core composition root.** Create `src/vault/create-vault.ts` with the minimal wiring: open the db, probe, apply schema, build on open, wire raw `query` + `notes`, expose reconcile passthroughs and `close()`.

```ts
import { dirname } from 'node:path';

import type { CommitEvent } from '../locked-file/index.ts';
import {
  applySchema,
  createReconciler,
  type IndexConfig,
  openIndexDb,
  probeCapabilities,
} from '../note-index/index.ts';
import { createNotes } from '../notes/index.ts';
import { createQuery } from '../query/index.ts';
import {
  createVaultIo,
  type VaultIo,
  type VaultIoConfig,
} from '../vault-io/index.ts';

export type CreateVaultConfig = VaultIoConfig & {
  indexPath: string;
  linkResolution?: 'wikilink' | 'relative';
  lazyReconcile?: boolean;
  reconcileTtlMs?: number;
  sqliteBusyTimeoutMs?: number;
  crossProcessWriterLock?: boolean;
  onCommit?: (e: CommitEvent) => void | Promise<void>;
};

export type Vault = {
  io: VaultIo;
  notes: ReturnType<typeof createNotes>;
  query: ReturnType<typeof createQuery>;
  reconcile(): Promise<void>;
  reconcilePaths(rels: string[]): Promise<void>;
  rebuild(): Promise<void>;
  close(): void;
};

export async function createVault(config: CreateVaultConfig): Promise<Vault> {
  const linkResolution = config.linkResolution ?? 'wikilink';
  const sqliteBusyTimeoutMs = config.sqliteBusyTimeoutMs ?? 5000;
  const crossProcessWriterLock = config.crossProcessWriterLock ?? true;

  const io = createVaultIo({
    root: config.root,
    prefixes: config.prefixes,
    caseSensitive: config.caseSensitive,
    ignore: config.ignore,
  });

  // Resolve the effective case-sensitivity purely from the public VaultIo
  // surface: on a case-insensitive volume toKey case-folds, so it differs
  // from the case-preserving toVaultRelative; on a case-sensitive volume
  // the two agree.
  const caseSensitive = io.toKey('A.md') === io.toVaultRelative('A.md');

  const cfg: IndexConfig = {
    linkResolution,
    caseSensitive,
    ignore: config.ignore ?? [],
  };

  const db = openIndexDb(config.indexPath, { sqliteBusyTimeoutMs });
  probeCapabilities(db);
  applySchema(db);

  const reconciler = createReconciler(db, io, cfg);
  await reconciler.rebuild();

  const query = createQuery(db, io, cfg);
  const notes = createNotes({
    db,
    vaultIo: io,
    cfg,
    query,
    onCommit: config.onCommit,
    cross: crossProcessWriterLock
      ? {
          lockDir: `${dirname(config.indexPath)}/.mdvault-locks`,
          busyTimeoutMs: sqliteBusyTimeoutMs,
        }
      : false,
  });

  return {
    io,
    notes,
    query,
    reconcile: () => reconciler.reconcile(),
    reconcilePaths: (rels) => reconciler.reconcilePaths(rels),
    rebuild: () => reconciler.rebuild(),
    close: () => {
      db.close();
    },
  };
}
```

  And create the barrel `src/vault/index.ts`:

```ts
export type { CreateVaultConfig, Vault } from './create-vault.ts';
export { createVault } from './create-vault.ts';
```

- [ ] **Run to verify pass.**
  Run: `bun test src/vault/__tests__/create-vault.test.ts`
  Expected: PASS (3 tests).

---

#### Cycle 2 — config-fingerprint guard (owner rebuilds, non-owner fails `INDEX_UNAVAILABLE`)

- [ ] **Write the failing test(s) for fingerprint-mismatch handling.** Append these two tests inside the `describe('createVault', …)` block.

```ts
  test('an owner rebuilds the index on a config-fingerprint mismatch', async () => {
    await writeVaultMd('A.md', '# A\n[[B]]\n');
    await writeVaultMd('B.md', '# B\n');

    const first = await makeVault({ linkResolution: 'wikilink' });
    expect(first.query.queryNotes().map((h) => h.path).sort()).toEqual([
      'A.md',
      'B.md',
    ]);
    first.close();

    // A file added while the index is closed proves a full rebuild ran on
    // reopen (a stale incremental open would not see it).
    await writeVaultMd('C.md', '# C\n');

    // Reopen with a DIFFERENT linkResolution -> fingerprint mismatch. The read
    // scope is the whole vault (''), so this owner rebuilds rather than fails.
    const second = await makeVault({ linkResolution: 'relative' });
    expect(second.query.queryNotes().map((h) => h.path).sort()).toEqual([
      'A.md',
      'B.md',
      'C.md',
    ]);
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
  });
```

- [ ] **Run to verify it fails.**
  Run: `bun test src/vault/__tests__/create-vault.test.ts`
  Expected FAIL: the non-owner test fails — the Cycle-1 root unconditionally rebuilds on every open, so the restricted instance returns a `Vault` instead of throwing `MdVaultError(INDEX_UNAVAILABLE)` (the `expect(caught).toBeInstanceOf` assertion fails; `caught` is `undefined`). The owner-rebuild test already passes.

- [ ] **Implement the fingerprint / version / integrity branch.** Replace the whole `src/vault/create-vault.ts` with this version (adds the `MdVaultError`, `configFingerprint`, `readMeta`, `SCHEMA_VERSION` imports and the open-time decision).

```ts
import { dirname } from 'node:path';

import { MdVaultError } from '../errors.ts';
import type { CommitEvent } from '../locked-file/index.ts';
import {
  applySchema,
  configFingerprint,
  createReconciler,
  type IndexConfig,
  openIndexDb,
  probeCapabilities,
  readMeta,
  SCHEMA_VERSION,
} from '../note-index/index.ts';
import { createNotes } from '../notes/index.ts';
import { createQuery } from '../query/index.ts';
import {
  createVaultIo,
  type VaultIo,
  type VaultIoConfig,
} from '../vault-io/index.ts';

export type CreateVaultConfig = VaultIoConfig & {
  indexPath: string;
  linkResolution?: 'wikilink' | 'relative';
  lazyReconcile?: boolean;
  reconcileTtlMs?: number;
  sqliteBusyTimeoutMs?: number;
  crossProcessWriterLock?: boolean;
  onCommit?: (e: CommitEvent) => void | Promise<void>;
};

export type Vault = {
  io: VaultIo;
  notes: ReturnType<typeof createNotes>;
  query: ReturnType<typeof createQuery>;
  reconcile(): Promise<void>;
  reconcilePaths(rels: string[]): Promise<void>;
  rebuild(): Promise<void>;
  close(): void;
};

export async function createVault(config: CreateVaultConfig): Promise<Vault> {
  const linkResolution = config.linkResolution ?? 'wikilink';
  const sqliteBusyTimeoutMs = config.sqliteBusyTimeoutMs ?? 5000;
  const crossProcessWriterLock = config.crossProcessWriterLock ?? true;

  const io = createVaultIo({
    root: config.root,
    prefixes: config.prefixes,
    caseSensitive: config.caseSensitive,
    ignore: config.ignore,
  });

  // Resolve the effective case-sensitivity purely from the public VaultIo
  // surface: on a case-insensitive volume toKey case-folds, so it differs
  // from the case-preserving toVaultRelative; on a case-sensitive volume
  // the two agree.
  const caseSensitive = io.toKey('A.md') === io.toVaultRelative('A.md');

  const cfg: IndexConfig = {
    linkResolution,
    caseSensitive,
    ignore: config.ignore ?? [],
  };

  const db = openIndexDb(config.indexPath, { sqliteBusyTimeoutMs });
  probeCapabilities(db);
  applySchema(db);

  const reconciler = createReconciler(db, io, cfg);

  // This instance owns the whole index iff its read scope covers the entire
  // vault (the empty-string prefix). Only an owner may rebuild a shared index
  // out from under another scope.
  const ownsWholeIndex = config.prefixes.read.includes('');

  const cur = configFingerprint(cfg);
  const stored = readMeta(db, 'config_fingerprint');
  const storedVer = readMeta(db, 'schema_version');

  if (stored === null) {
    // Fresh / never-built index -> boot build (rebuild writes both meta keys).
    await reconciler.rebuild();
  } else if (stored !== cur || storedVer !== String(SCHEMA_VERSION)) {
    if (ownsWholeIndex) {
      await reconciler.rebuild();
    } else {
      db.close();
      throw new MdVaultError(
        'INDEX_UNAVAILABLE',
        'index config fingerprint mismatch on a shared index not owned by this scope',
      );
    }
  } else {
    const row = db.query('PRAGMA integrity_check').get() as
      | { integrity_check?: string }
      | null;
    if (!row || row.integrity_check !== 'ok') {
      await reconciler.rebuild();
    }
  }

  const query = createQuery(db, io, cfg);
  const notes = createNotes({
    db,
    vaultIo: io,
    cfg,
    query,
    onCommit: config.onCommit,
    cross: crossProcessWriterLock
      ? {
          lockDir: `${dirname(config.indexPath)}/.mdvault-locks`,
          busyTimeoutMs: sqliteBusyTimeoutMs,
        }
      : false,
  });

  return {
    io,
    notes,
    query,
    reconcile: () => reconciler.reconcile(),
    reconcilePaths: (rels) => reconciler.reconcilePaths(rels),
    rebuild: () => reconciler.rebuild(),
    close: () => {
      db.close();
    },
  };
}
```

- [ ] **Run to verify pass.**
  Run: `bun test src/vault/__tests__/create-vault.test.ts`
  Expected: PASS (5 tests) — fresh boot build, matched-fingerprint reopen (integrity-checked, no rebuild), owner rebuild on mismatch, and non-owner `INDEX_UNAVAILABLE` all hold.

---

#### Cycle 3 — lazy reconcile (auto-sweep external writes through the wrapped reads)

- [ ] **Write the failing test for lazy auto-reconcile.** Append this test inside the `describe('createVault', …)` block.

```ts
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

    expect(vault.query.queryNotes().map((h) => h.path).sort()).toEqual([
      'One.md',
      'Two.md',
    ]);
  });
```

- [ ] **Run to verify it fails.**
  Run: `bun test src/vault/__tests__/create-vault.test.ts`
  Expected FAIL: the new lazy-true test fails — the Cycle-2 root hands back the raw `createQuery` object with no reconcile trigger, so the external `Two.md` is never swept and `waitFor` throws `condition not met before timeout`. (The lazy-false test still passes because raw reads never auto-sweep.)

- [ ] **Implement the lazy-reconcile wrapper.** Replace the whole `src/vault/create-vault.ts` with the final version: add the `lazyReconcile`/`reconcileTtlMs` defaults, a per-instance TTL + in-flight guard, a synchronous `maybeReconcile()`, and wrap the four reads (keeping their exact synchronous return types). Pass the wrapped `query` to `createNotes` so `readNote({ withLinks })` triggers the sweep too, and reset the clock after an explicit `reconcile()`.

```ts
import { dirname } from 'node:path';

import { MdVaultError } from '../errors.ts';
import type { CommitEvent } from '../locked-file/index.ts';
import {
  applySchema,
  configFingerprint,
  createReconciler,
  type IndexConfig,
  openIndexDb,
  probeCapabilities,
  readMeta,
  SCHEMA_VERSION,
} from '../note-index/index.ts';
import { createNotes } from '../notes/index.ts';
import { createQuery } from '../query/index.ts';
import {
  createVaultIo,
  type VaultIo,
  type VaultIoConfig,
} from '../vault-io/index.ts';

export type CreateVaultConfig = VaultIoConfig & {
  indexPath: string;
  linkResolution?: 'wikilink' | 'relative';
  lazyReconcile?: boolean;
  reconcileTtlMs?: number;
  sqliteBusyTimeoutMs?: number;
  crossProcessWriterLock?: boolean;
  onCommit?: (e: CommitEvent) => void | Promise<void>;
};

export type Vault = {
  io: VaultIo;
  notes: ReturnType<typeof createNotes>;
  query: ReturnType<typeof createQuery>;
  reconcile(): Promise<void>;
  reconcilePaths(rels: string[]): Promise<void>;
  rebuild(): Promise<void>;
  close(): void;
};

export async function createVault(config: CreateVaultConfig): Promise<Vault> {
  const linkResolution = config.linkResolution ?? 'wikilink';
  const lazyReconcile = config.lazyReconcile ?? true;
  const reconcileTtlMs = config.reconcileTtlMs ?? 2000;
  const sqliteBusyTimeoutMs = config.sqliteBusyTimeoutMs ?? 5000;
  const crossProcessWriterLock = config.crossProcessWriterLock ?? true;

  const io = createVaultIo({
    root: config.root,
    prefixes: config.prefixes,
    caseSensitive: config.caseSensitive,
    ignore: config.ignore,
  });

  // Resolve the effective case-sensitivity purely from the public VaultIo
  // surface: on a case-insensitive volume toKey case-folds, so it differs
  // from the case-preserving toVaultRelative; on a case-sensitive volume
  // the two agree.
  const caseSensitive = io.toKey('A.md') === io.toVaultRelative('A.md');

  const cfg: IndexConfig = {
    linkResolution,
    caseSensitive,
    ignore: config.ignore ?? [],
  };

  const db = openIndexDb(config.indexPath, { sqliteBusyTimeoutMs });
  probeCapabilities(db);
  applySchema(db);

  const reconciler = createReconciler(db, io, cfg);

  // This instance owns the whole index iff its read scope covers the entire
  // vault (the empty-string prefix). Only an owner may rebuild a shared index
  // out from under another scope.
  const ownsWholeIndex = config.prefixes.read.includes('');

  const cur = configFingerprint(cfg);
  const stored = readMeta(db, 'config_fingerprint');
  const storedVer = readMeta(db, 'schema_version');

  if (stored === null) {
    // Fresh / never-built index -> boot build (rebuild writes both meta keys).
    await reconciler.rebuild();
  } else if (stored !== cur || storedVer !== String(SCHEMA_VERSION)) {
    if (ownsWholeIndex) {
      await reconciler.rebuild();
    } else {
      db.close();
      throw new MdVaultError(
        'INDEX_UNAVAILABLE',
        'index config fingerprint mismatch on a shared index not owned by this scope',
      );
    }
  } else {
    const row = db.query('PRAGMA integrity_check').get() as
      | { integrity_check?: string }
      | null;
    if (!row || row.integrity_check !== 'ok') {
      await reconciler.rebuild();
    }
  }

  // Lazy reconcile: the first read (and the first read after each TTL window)
  // kicks ONE background sweep, guarded so concurrent reads never overlap it.
  // Reads stay synchronous (their return types must equal createQuery's), so
  // the sweep is fire-and-forget — its result is visible to the NEXT read.
  let lastReconcileMs = 0;
  let inFlight: Promise<void> | null = null;

  function maybeReconcile(): void {
    if (!lazyReconcile || inFlight) {
      return;
    }
    const now = Date.now();
    if (now - lastReconcileMs < reconcileTtlMs) {
      return;
    }
    lastReconcileMs = now;
    inFlight = reconciler
      .reconcile()
      .catch(() => {
        // A failed lazy sweep must never break a read; the next sweep retries.
      })
      .finally(() => {
        inFlight = null;
      });
  }

  const rawQuery = createQuery(db, io, cfg);
  const query: ReturnType<typeof createQuery> = {
    queryNotes(opts) {
      maybeReconcile();

      return rawQuery.queryNotes(opts);
    },
    backlinks(path, opts) {
      maybeReconcile();

      return rawQuery.backlinks(path, opts);
    },
    outboundLinks(path, opts) {
      maybeReconcile();

      return rawQuery.outboundLinks(path, opts);
    },
    searchText(q, opts) {
      maybeReconcile();

      return rawQuery.searchText(q, opts);
    },
  };

  const notes = createNotes({
    db,
    vaultIo: io,
    cfg,
    query,
    onCommit: config.onCommit,
    cross: crossProcessWriterLock
      ? {
          lockDir: `${dirname(config.indexPath)}/.mdvault-locks`,
          busyTimeoutMs: sqliteBusyTimeoutMs,
        }
      : false,
  });

  return {
    io,
    notes,
    query,
    reconcile: async () => {
      await reconciler.reconcile();
      lastReconcileMs = Date.now();
    },
    reconcilePaths: (rels) => reconciler.reconcilePaths(rels),
    rebuild: () => reconciler.rebuild(),
    close: () => {
      db.close();
    },
  };
}
```

- [ ] **Run to verify pass.**
  Run: `bun test src/vault/__tests__/create-vault.test.ts`
  Expected: PASS (6 tests).

- [ ] **Run the full check gate.**
  Run: `bun test && bun run check`
  Expected: PASS — all vault tests green, Biome + `tsc --noEmit` clean.

- [ ] **Commit.**

```bash
git add src/vault && \
git commit --no-gpg-sign -m "feat(vault): async createVault composition root — wires vault-io + index + query + notes, with config-fingerprint guard (owner rebuild / non-owner INDEX_UNAVAILABLE), boot build-if-missing, integrity check, and per-instance lazy reconcile"
```

---

### Task 7: Top barrel + packaging + API-freeze update

**Files:**
- Modify: `src/index.ts` (add the Plan-2 public surface)
- Modify: `src/__tests__/index.test.ts` (extend the frozen export set)
- Modify: `README.md`
- Test: `src/__tests__/index.test.ts`

**Interfaces:**
- Consumes: the public surface of `src/vault/index.ts` (`createVault`, `CreateVaultConfig`, `Vault`), `src/query/index.ts` (`NoteHit`, `SearchHit`, `OrderField`, `QueryOrder`, `WhereMap`), `src/notes/index.ts` (`ReadNoteResult`, `UpdateOp`) — all produced by Tasks 4–6.
- Produces: the package public surface now includes the Plan-2 entry point `createVault` and its option/result types, importable as `import { createVault } from 'mdvault'`.

Note on the public surface: only `createVault` (value) plus the option/result **types** consumers annotate against are added to the top barrel. The note-index internals (`openIndexDb`, `indexNote`, `createReconciler`, …), `createQuery`, and `createNotes` stay package-internal — they are wired by `createVault`, not called directly by consumers.

- [ ] **Step: Update the API-freeze test to the new frozen set (RED)**

Edit `src/__tests__/index.test.ts` — extend `ALL_EXPORTS` with the 10 new Plan-2 names (1 value + 9 types) and add `createVault` to the runtime-value-liveness assertions. The new `ALL_EXPORTS` (sorted) is the previous 26 names plus: `CreateVaultConfig`, `NoteHit`, `OrderField`, `QueryOrder`, `ReadNoteResult`, `SearchHit`, `UpdateOp`, `Vault`, `WhereMap`, `createVault`.

```ts
const ALL_EXPORTS = [
  // — Plan 1 (existing 26) —
  'Access',
  'CommitEvent',
  'CrossLock',
  'EditOutcome',
  'ExtractedLinks',
  'FrontmatterValidity',
  'LinkResolution',
  'MdVaultCode',
  'MdVaultError',
  'ParsedFrontmatter',
  'Sig',
  'StoredLink',
  'TransformOpts',
  'TransformResult',
  'VaultIo',
  'VaultIoConfig',
  'VaultPrefixes',
  'createVaultIo',
  'deriveTags',
  'editFrontmatter',
  'extractLinks',
  'isFlatFrontmatter',
  'parseFrontmatter',
  'storedLinksFor',
  'withFileDelete',
  'withFileTransform',
  // — Plan 2 (new 10) —
  'CreateVaultConfig',
  'NoteHit',
  'OrderField',
  'QueryOrder',
  'ReadNoteResult',
  'SearchHit',
  'UpdateOp',
  'Vault',
  'WhereMap',
  'createVault',
].sort();
```

Add `createVault` to the runtime-value-liveness test (the block asserting each public value export is a function):

```ts
test('createVault is a live function export', () => {
  expect(typeof mdvault.createVault).toBe('function');
});
```

- [ ] **Step: Run to verify it fails**

Run: `bun test src/__tests__/index.test.ts`
Expected: FAIL — the freeze test reports the new names are in `ALL_EXPORTS` but missing from `src/index.ts` (and `mdvault.createVault` is `undefined`), because the barrel hasn't been extended yet.

- [ ] **Step: Extend the top barrel**

Append to `src/index.ts`:

```ts
export type { NoteHit, OrderField, QueryOrder, SearchHit, WhereMap } from './query/index.ts';
export type { ReadNoteResult, UpdateOp } from './notes/index.ts';
export type { CreateVaultConfig, Vault } from './vault/index.ts';
export { createVault } from './vault/index.ts';
```

- [ ] **Step: Run to verify pass**

Run: `bun test src/__tests__/index.test.ts`
Expected: PASS — the barrel exports exactly the frozen 36-name set and `createVault` is a live function.

- [ ] **Step: Update `README.md`**

Replace the status section so it states Plan 2 has landed and shows the primary entry point. Use this content for the status + usage portion:

```markdown
## Status

`mdvault` provides a headless markdown-vault data layer: CRUD over `.md`
notes plus a derived `bun:sqlite` index (collection queries, backlinks,
keyword search), with the `.md` files as the source of truth and the index a
rebuildable cache. No Obsidian.

Primary entry point — the `createVault` composition root:

\```ts
import { createVault } from 'mdvault';

const vault = await createVault({
  root: '/path/to/vault',
  prefixes: { read: [''], write: ['Notes/'] },
  indexPath: './data/vault-index.db', // in DATA_DIR, NOT the vault
});

const hits = vault.query.queryNotes({ tag: 'project', limit: 20 });
await vault.notes.updateNote('Notes/today.md', { append: '\n- done' });
vault.close();
\```

Lower-level primitives (`createVaultIo`, `withFileTransform`, `parseFrontmatter`,
`storedLinksFor`, …) are also exported for advanced use.

The index db and its `-wal`/`-shm` sidecars must be gitignored and kept out of
the synced vault.

## License

MIT — generic vault mechanics only; domain/persona/sync logic lives in the
consuming applications.
```

(Replace the literal `\`` escaping above with real triple-backticks in the README.)

- [ ] **Step: Final verification**

Run: `bun run format && bun test && bun run check`
Expected: every suite PASSES (Plan-1 + all Plan-2 modules + the freeze test) and `biome check` + `tsc --noEmit` exit 0.

- [ ] **Step: Commit**

```bash
git add src/index.ts src/__tests__/index.test.ts README.md && git commit --no-gpg-sign -m "feat: export Plan 2 surface (createVault + query/notes types); freeze 36-name API"
```

---

## Plan 2 complete — what's next

When all seven tasks are green, `mdvault` is a complete headless markdown data
layer: CRUD + a derived SQLite index (collection/tag/folder queries, backlinks,
keyword search) + the `createVault` composition root, all on top of the Plan-1
primitives. Optional follow-ups recorded as deferred in the spec (each its own
spec→plan when needed): the `graphology` graph-algorithm adapter, a pluggable
`SearchBackend` interface + a `qmd` semantic adapter, and Node-runtime support
behind a SQLite-driver boundary. Then: migrate `machine-spirit` and
`selgeo-brain` onto `mdvault` (each its own migration spec).
