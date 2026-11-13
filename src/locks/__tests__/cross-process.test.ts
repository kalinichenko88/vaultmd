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
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
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

  // The lockfile of a holder that died is "past the stale bound" once nobody
  // has refreshed its mtime for the bound; this one is past any bound here.
  const pastStaleBound = async (file: string) => {
    const past = new Date(Date.now() - STALE_MS - 1000);
    await utimes(file, past, past);
  };

  // A short stale bound, so that a waiter confirms an old mtime in 100 ms.
  const STALE = 200;

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

  test('reclaims a lockfile held by a dead same-host pid at once', async () => {
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
    expect(await statSig(`${lockPath(dir, key)}.reclaim`)).toBeNull();
  });

  test.each([
    [
      'a live pid',
      JSON.stringify({ pid: process.pid, host: hostname(), createdAt: 1 }),
    ],
    [
      'another host name',
      JSON.stringify({ pid: 999999999, host: 'other-host', createdAt: 1 }),
    ],
    ['a payload not written in full yet', '{"pid":12'],
  ])(
    'waits then throws MTIME_CONFLICT on a fresh lockfile of %s',
    async (_, content) => {
      const key = 'note.md';
      await writeFile(lockPath(dir, key), content);

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
      expect(await readFile(lockPath(dir, key), 'utf8')).toBe(content); // holder untouched
    },
  );

  test('removes its own lockfile when the write after the create fails', async () => {
    const key = 'note.md';
    const probe = await fsp.open(path.join(dir, 'probe'), 'w');
    const handleProto = Object.getPrototypeOf(probe) as typeof probe;
    await probe.close();
    const real = handleProto.writeFile;
    spyOn(handleProto, 'writeFile').mockImplementationOnce(async function (
      this: typeof probe,
      data,
    ) {
      await real.call(this, String(data).slice(0, 10));
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
    });

    await expect(
      withCrossProcessLock(dir, key, 300, async () => 'never'),
    ).rejects.toThrow('no space');
    mock.restore();

    expect(await statSig(lockPath(dir, key))).toBeNull();
    expect(await withCrossProcessLock(dir, key, 300, async () => 'ok')).toBe(
      'ok',
    );
  });

  test.each([
    [
      'another host name',
      JSON.stringify({ pid: 999999999, host: 'recreated-container' }),
    ],
    [
      'a pid that a live process now has',
      JSON.stringify({ pid: process.pid, host: hostname() }),
    ],
    ['a payload that a crash cut off', '{"pid":12'],
  ])(
    'reclaims a lockfile of %s, once past the stale bound',
    async (_, content) => {
      const key = 'note.md';
      await writeFile(lockPath(dir, key), content);
      await pastStaleBound(lockPath(dir, key));

      expect(
        await withCrossProcessLock(dir, key, 1000, async () => 'ok', STALE),
      ).toBe('ok');
    },
  );

  // Holds the lock for `holdMs` and reports, through `holding`, whether it
  // still does.
  const holdLock = async (key: string, holdMs: number, staleMs = STALE) => {
    const state = { holding: false };
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const done = withCrossProcessLock(
      dir,
      key,
      2000,
      async () => {
        state.holding = true;
        entered();
        await Bun.sleep(holdMs);
        state.holding = false;
      },
      staleMs,
    );
    await inside;

    return { state, done };
  };

  test('keeps the lock of a live holder that holds it past the stale bound', async () => {
    const key = 'note.md';
    const { state, done } = await holdLock(key, STALE * 3);

    const overlapped = await withCrossProcessLock(
      dir,
      key,
      2000,
      async () => state.holding,
      STALE,
    );
    await done;

    expect(overlapped).toBe(false);
  });

  test('keeps the lock of a live holder when the wall clock jumps past the stale bound', async () => {
    const key = 'note.md';
    // The holder's first heartbeat comes 200 ms in, well after the waiter's
    // second poll: only the wait on the waiter's own clock keeps it out.
    const staleMs = 800;
    const { state, done } = await holdLock(key, 600, staleMs);
    await pastStaleBound(lockPath(dir, key)); // as the machine waking from sleep

    const overlapped = await withCrossProcessLock(
      dir,
      key,
      2000,
      async () => state.holding,
      staleMs,
    );
    await done;

    expect(overlapped).toBe(false);
  });

  test('stops refreshing the lockfile once it is released', async () => {
    const key = 'note.md';
    const staleMs = 40;
    await withCrossProcessLock(
      dir,
      key,
      300,
      async () => {
        await Bun.sleep(staleMs);
      },
      staleMs,
    );
    await writeFile(
      lockPath(dir, key),
      JSON.stringify({ pid: 999999999, host: 'other-host' }),
    );
    await pastStaleBound(lockPath(dir, key));
    const before = (await stat(lockPath(dir, key))).mtimeMs;

    await Bun.sleep(staleMs);

    expect((await stat(lockPath(dir, key))).mtimeMs).toBe(before);
  });

  test('lets one waiter in when two find one stale lock', async () => {
    const key = 'note.md';
    await writeFile(
      lockPath(dir, key),
      JSON.stringify({ pid: 999999999, host: hostname() }),
    );
    // Both waiters read the dead holder's file; the second acts on what it
    // read only once the first is inside the lock.
    const real = fsp.readFile;
    let reads = 0;
    let secondRead!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      secondRead = resolve;
    });
    let entered!: () => void;
    const oneInside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    spyOn(fsp, 'readFile').mockImplementation((async (file, options) => {
      const content = await real(file, options);
      reads += 1;
      const read = reads;
      if (read === 1) {
        await bothRead;
      }
      if (read === 2) {
        secondRead();
        await oneInside;
      }

      return content;
    }) as typeof real);
    let active = 0;
    let peak = 0;
    const waiter = () => {
      return withCrossProcessLock(dir, key, 2000, async () => {
        active += 1;
        peak = Math.max(peak, active);
        entered();
        await Bun.sleep(100);
        active -= 1;
      });
    };

    await Promise.all([waiter(), waiter()]);

    expect(peak).toBe(1);
  });

  test('clears a reclaim guard that a dead waiter left, once past the stale bound', async () => {
    const key = 'note.md';
    const guard = `${lockPath(dir, key)}.reclaim`;
    await writeFile(lockPath(dir, key), '{"pid":12');
    await writeFile(guard, '');
    await pastStaleBound(lockPath(dir, key));
    await pastStaleBound(guard);

    expect(
      await withCrossProcessLock(dir, key, 1000, async () => 'ok', STALE),
    ).toBe('ok');
  });

  test('keeps the reclaim guard of a live waiter', async () => {
    const key = 'note.md';
    const guard = `${lockPath(dir, key)}.reclaim`;
    await writeFile(lockPath(dir, key), '{"pid":12');
    await pastStaleBound(lockPath(dir, key));
    await writeFile(guard, '');

    // The lockfile is confirmed stale after 500 ms; the guard stays fresh
    // past the 800 ms deadline.
    await expect(
      withCrossProcessLock(dir, key, 800, async () => 'never', 1000),
    ).rejects.toThrow('cross-process lock busy');
    expect(await statSig(guard)).not.toBeNull();
  });

  test('leaves the lockfile on release when another holder has taken it over', async () => {
    const key = 'note.md';
    const next = JSON.stringify({ pid: process.pid, host: hostname() });

    await withCrossProcessLock(dir, key, 300, async () => {
      await writeFile(lockPath(dir, key), next);
    });

    expect(await readFile(lockPath(dir, key), 'utf8')).toBe(next);
  });

  test('releases a lockfile it cannot read back, as it always did', async () => {
    const key = 'note.md';
    spyOn(fsp, 'readFile').mockImplementation(async () => {
      throw Object.assign(new Error('too many open files'), {
        code: 'EMFILE',
      });
    });

    await withCrossProcessLock(dir, key, 300, async () => 'ok');

    expect(await statSig(lockPath(dir, key))).toBeNull();
  });

  test('throws the error of a reclaim guard it cannot create', async () => {
    const key = 'note.md';
    await writeFile(lockPath(dir, key), '{"pid":12');
    await pastStaleBound(lockPath(dir, key));
    const real = fsp.writeFile;
    spyOn(fsp, 'writeFile').mockImplementation((async (file, data, opts) => {
      if (String(file).endsWith('.reclaim')) {
        throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
      }

      return real(file, data, opts);
    }) as typeof real);

    await expect(
      withCrossProcessLock(dir, key, 1000, async () => 'never', STALE),
    ).rejects.toThrow('no space');
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
      withCrossProcessLock(dir, key, 1000, async () => 'never', STALE),
    ).rejects.toThrow('not permitted');
  }, 3000);
});
