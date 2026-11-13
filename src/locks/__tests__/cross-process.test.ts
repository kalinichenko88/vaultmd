import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import * as path from 'node:path';

import { MdVaultError } from '@/errors.ts';
import { statSig } from '@/fs-atomic/sig.ts';

import { STALE_MS, withCrossProcessLock } from '../cross-process.ts';

describe('withCrossProcessLock', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vaultmd-'));
  });

  afterEach(async () => {
    mock.restore();
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

  // The lockfile of a holder that died is "past the stale bound" once nobody
  // has refreshed its mtime for STALE_MS.
  const pastStaleBound = async (file: string) => {
    const past = new Date(Date.now() - STALE_MS - 1000);
    await utimes(file, past, past);
  };

  test('reclaims a lockfile that a failed write cut off, once past the stale bound', async () => {
    const key = 'note.md';
    const real = fsp.writeFile;
    spyOn(fsp, 'writeFile').mockImplementationOnce(async (file, data, opts) => {
      await real(file, String(data).slice(0, 10), opts);
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
    });
    await expect(
      withCrossProcessLock(dir, key, 300, async () => 'never'),
    ).rejects.toThrow('no space');
    mock.restore();

    await pastStaleBound(lockPath(dir, key));

    expect(await withCrossProcessLock(dir, key, 300, async () => 'ok')).toBe(
      'ok',
    );
  });

  test.each([
    ['another host name', { pid: 999999999, host: 'recreated-container' }],
    ['a pid that a live process now has', { pid: process.pid }],
  ])(
    'reclaims a lockfile of %s, once past the stale bound',
    async (_, holder) => {
      const key = 'note.md';
      await writeFile(
        lockPath(dir, key),
        JSON.stringify({ host: hostname(), createdAt: Date.now(), ...holder }),
      );
      await pastStaleBound(lockPath(dir, key));

      expect(await withCrossProcessLock(dir, key, 300, async () => 'ok')).toBe(
        'ok',
      );
    },
  );

  test('keeps the lock of a live holder that holds it past the stale bound', async () => {
    const key = 'note.md';
    const staleMs = 200;
    let holding = false;
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = withCrossProcessLock(
      dir,
      key,
      2000,
      async () => {
        holding = true;
        entered();
        await Bun.sleep(staleMs * 3);
        holding = false;
      },
      staleMs,
    );
    await inside;

    const overlapped = await withCrossProcessLock(
      dir,
      key,
      2000,
      async () => holding,
      staleMs,
    );
    await first;

    expect(overlapped).toBe(false);
  });

  test('lets one waiter in when two find one stale lock', async () => {
    const key = 'note.md';
    await writeFile(
      lockPath(dir, key),
      JSON.stringify({
        pid: 999999999,
        host: hostname(),
        createdAt: Date.now(),
      }),
    );
    // Waiters B and C both read the dead holder's file; C acts on what it
    // read only after B has taken the lock.
    const real = fsp.readFile;
    let reads = 0;
    spyOn(fsp, 'readFile').mockImplementation((async (file, options) => {
      const content = await real(file, options);
      reads += 1;
      if (reads > 1) {
        await Bun.sleep(100);
      }

      return content;
    }) as typeof real);
    let active = 0;
    let peak = 0;
    const waiter = () => {
      return withCrossProcessLock(dir, key, 2000, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await Bun.sleep(200);
        active -= 1;
      });
    };

    await Promise.all([waiter(), waiter()]);

    expect(peak).toBe(1);
  });

  test('clears a reclaim guard that a dead waiter left, once past the stale bound', async () => {
    const key = 'note.md';
    await writeFile(lockPath(dir, key), '{"pid":12');
    await writeFile(`${lockPath(dir, key)}.reclaim`, '');
    await pastStaleBound(lockPath(dir, key));
    await pastStaleBound(`${lockPath(dir, key)}.reclaim`);

    expect(await withCrossProcessLock(dir, key, 300, async () => 'ok')).toBe(
      'ok',
    );
  });

  test('leaves the lockfile on release when another holder has taken it over', async () => {
    const key = 'note.md';
    const next = JSON.stringify({ pid: 999999999, host: hostname() });

    await withCrossProcessLock(dir, key, 300, async () => {
      await writeFile(lockPath(dir, key), next);
    });

    expect(await readFile(lockPath(dir, key), 'utf8')).toBe(next);
  });

  test('throws the error of a stale lockfile it cannot remove', async () => {
    const key = 'note.md';
    await writeFile(lockPath(dir, key), '{"pid":12');
    await pastStaleBound(lockPath(dir, key));
    const real = fsp.unlink;
    spyOn(fsp, 'unlink').mockImplementation((async (file) => {
      if (file === lockPath(dir, key)) {
        throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
      }

      return real(file);
    }) as typeof real);

    await expect(
      withCrossProcessLock(dir, key, 300, async () => 'never'),
    ).rejects.toThrow('not permitted');
  }, 2000);
});
