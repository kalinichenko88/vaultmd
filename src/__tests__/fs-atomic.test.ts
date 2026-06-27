import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import * as path from 'node:path';

import { MdVaultError } from '../errors.ts';
import {
  atomicWrite,
  atomicWriteIfUnchanged,
  exclusiveCreate,
  statSig,
  unlinkIfUnchanged,
  withCrossProcessLock,
  withFileLock,
} from '../fs-atomic.ts';

describe('statSig + atomicWrite', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mdvault-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('statSig returns null for a missing file', async () => {
    expect(await statSig(path.join(dir, 'nope.md'))).toBeNull();
  });

  test('atomicWrite creates parent dirs and returns the post-write sig', async () => {
    const file = path.join(dir, 'a', 'b', 'note.md');
    const sig = await atomicWrite(file, 'hello');

    expect(await readFile(file, 'utf8')).toBe('hello');
    expect(sig.size).toBe(5);
    expect(Number.isInteger(sig.mtimeMs)).toBe(true);
    expect(await statSig(file)).toEqual(sig);
  });

  test('atomicWriteIfUnchanged rewrites when the sig matches', async () => {
    const file = path.join(dir, 'note.md');
    const first = await atomicWrite(file, 'one');
    const second = await atomicWriteIfUnchanged(file, 'changed', first);

    expect(await readFile(file, 'utf8')).toBe('changed');
    expect(second.size).toBe(7);
    expect(await statSig(file)).toEqual(second);
  });

  test('atomicWriteIfUnchanged throws MTIME_CONFLICT on a stale sig', async () => {
    const file = path.join(dir, 'note.md');
    await atomicWrite(file, 'one');

    const stale = { mtimeMs: 1, size: 999 };
    let caught: unknown;
    try {
      await atomicWriteIfUnchanged(file, 'two', stale);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(MdVaultError);
    expect((caught as MdVaultError).code).toBe('MTIME_CONFLICT');
    expect(await readFile(file, 'utf8')).toBe('one'); // original untouched
  });
});

describe('exclusiveCreate + unlinkIfUnchanged', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mdvault-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('exclusiveCreate writes a new file and returns its sig', async () => {
    const file = path.join(dir, 'sub', 'new.md');
    const sig = await exclusiveCreate(file, 'fresh');

    expect(await readFile(file, 'utf8')).toBe('fresh');
    expect(await statSig(file)).toEqual(sig);
  });

  test('exclusiveCreate throws ALREADY_EXISTS and does not clobber the target', async () => {
    const file = path.join(dir, 'dupe.md');
    await atomicWrite(file, 'orig');

    let caught: unknown;
    try {
      await exclusiveCreate(file, 'second');
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(MdVaultError);
    expect((caught as MdVaultError).code).toBe('ALREADY_EXISTS');
    expect(await readFile(file, 'utf8')).toBe('orig');
  });

  test('unlinkIfUnchanged returns false (no-op) for a missing file', async () => {
    const ghost = path.join(dir, 'ghost.md');
    expect(await unlinkIfUnchanged(ghost, { mtimeMs: 1, size: 1 })).toBe(false);
  });

  test('unlinkIfUnchanged throws MTIME_CONFLICT on a sig mismatch', async () => {
    const file = path.join(dir, 'note.md');
    await atomicWrite(file, 'data');

    let caught: unknown;
    try {
      await unlinkIfUnchanged(file, { mtimeMs: 1, size: 99 });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(MdVaultError);
    expect((caught as MdVaultError).code).toBe('MTIME_CONFLICT');
    expect(await statSig(file)).not.toBeNull();
  });

  test('unlinkIfUnchanged deletes and returns true on a matching sig', async () => {
    const file = path.join(dir, 'note.md');
    const sig = await atomicWrite(file, 'data');

    expect(await unlinkIfUnchanged(file, sig)).toBe(true);
    expect(await statSig(file)).toBeNull();
  });
});

describe('withFileLock', () => {
  test('serializes concurrent fns sharing a key', async () => {
    const order: string[] = [];

    const slow = withFileLock('k', async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('a-end');

      return 'a';
    });
    const fast = withFileLock('k', async () => {
      order.push('b-start');
      order.push('b-end');

      return 'b';
    });

    const [ra, rb] = await Promise.all([slow, fast]);
    expect(ra).toBe('a');
    expect(rb).toBe('b');
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  test('different keys run concurrently', async () => {
    const order: string[] = [];

    const p1 = withFileLock('k1', async () => {
      order.push('1-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('1-end');
    });
    const p2 = withFileLock('k2', async () => {
      order.push('2-start');
      order.push('2-end');
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual(['1-start', '2-start', '2-end', '1-end']);
  });

  test('a rejecting fn still releases the lock for the next holder', async () => {
    await expect(
      withFileLock('z', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // next acquirer must not deadlock behind the failed one
    expect(await withFileLock('z', async () => 'ok')).toBe('ok');
  });
});

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
