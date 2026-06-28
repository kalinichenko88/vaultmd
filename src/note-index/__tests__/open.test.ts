import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import type { IndexConfig } from '../models/index-config.ts';
import {
  configFingerprint,
  openIndexDb,
  probeCapabilities,
  readMeta,
  writeMeta,
} from '../open.ts';
import { applySchema } from '../schema.ts';

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
