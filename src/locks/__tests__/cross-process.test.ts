import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import * as path from 'node:path';

import { MdVaultError } from '../../errors.ts';
import { statSig } from '../../fs-atomic/sig.ts';
import { withCrossProcessLock } from '../cross-process.ts';

describe('withCrossProcessLock', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mdvault-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const lockPath = (lockDir: string, key: string) =>
    path.join(
      lockDir,
      `${createHash('sha256').update(key).digest('hex')}.lock`,
    );

  test('runs fn, creating lockDir if missing, then releases the lockfile', async () => {
    const nested = path.join(dir, 'locks');
    const result = await withCrossProcessLock(
      nested,
      'x.md',
      500,
      async () => 'ok',
    );

    expect(result).toBe('ok');
    expect(await statSig(lockPath(nested, 'x.md'))).toBeNull(); // released in finally
  });

  test('reclaims a lockfile held by a dead same-host pid', async () => {
    const key = 'note.md';
    await writeFile(
      lockPath(dir, key),
      JSON.stringify({
        pid: 999999999,
        host: hostname(),
        createdAt: Date.now(),
      }),
    );

    let ran = false;
    const result = await withCrossProcessLock(dir, key, 1000, async () => {
      ran = true;

      return 42;
    });

    expect(ran).toBe(true);
    expect(result).toBe(42);
    expect(await statSig(lockPath(dir, key))).toBeNull();
  });

  test('waits then throws MTIME_CONFLICT when held by a live pid', async () => {
    const key = 'note.md';
    await writeFile(
      lockPath(dir, key),
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        createdAt: Date.now(),
      }),
    );

    const start = Date.now();
    let caught: unknown;
    try {
      await withCrossProcessLock(dir, key, 150, async () => 'never');
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(MdVaultError);
    expect((caught as MdVaultError).code).toBe('MTIME_CONFLICT');
    expect(Date.now() - start).toBeGreaterThanOrEqual(140); // polled to the deadline
    expect(await statSig(lockPath(dir, key))).not.toBeNull(); // live holder untouched
  });
});
