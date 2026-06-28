import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';

import { MdVaultError } from '../errors.ts';
import type { IndexConfig } from './models/index-config.ts';
import { SCHEMA_VERSION } from './schema.ts';

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
  const row = db.query('SELECT value FROM meta WHERE key = ?').get(key) as {
    value: string;
  } | null;

  return row ? row.value : null;
}

export function writeMeta(db: Database, key: string, value: string): void {
  db.query(
    'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}
