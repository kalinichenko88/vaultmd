import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
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

  // A short stale bound: heartbeats every 50 ms, an old mtime confirmed in
  // 150 ms.
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

  test.each([
    [
      'a live pid',
      JSON.stringify({ pid: process.pid, host: hostname(), createdAt: 1 }),
    ],
    [
      // A holder in another PID namespace under the same host name (#62).
      'a pid that no process here has',
      JSON.stringify({ pid: 999999999, host: hostname(), id: randomUUID() }),
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
    ['a payload that is not an object', 'null'],
  ])(
    'reclaims a lockfile of %s, once past the stale bound',
    async (_, content) => {
      const key = 'note.md';
      await writeFile(lockPath(dir, key), content);
      await pastStaleBound(lockPath(dir, key));

      expect(
        await withCrossProcessLock(dir, key, 1000, async () => 'ok', STALE),
      ).toBe('ok');
      expect(await statSig(lockPath(dir, key))).toBeNull();
      expect(await statSig(`${lockPath(dir, key)}.reclaim`)).toBeNull();
    },
  );

  test('takes a stale lockfile over in one call whose wait is shorter than the watch', async () => {
    const key = 'note.md';
    await writeFile(lockPath(dir, key), '{"pid":12');
    await pastStaleBound(lockPath(dir, key));

    // The watch takes three heartbeats (225 ms); the call waits 50 ms.
    expect(
      await withCrossProcessLock(dir, key, 50, async () => 'ok', 300),
    ).toBe('ok');
  });

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
    // second poll, and the hold outlasts the 600 ms watch: the watch keeps
    // the waiter out until that heartbeat makes the lockfile fresh again.
    const staleMs = 800;
    const { state, done } = await holdLock(key, 1000, staleMs);
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
    await writeFile(lockPath(dir, key), '{"pid":12');
    await pastStaleBound(lockPath(dir, key));
    // Both waiters find the lockfile stale; the second acts on that only once
    // the first is inside the lock.
    const real = fsp.writeFile;
    let guards = 0;
    let secondGuard!: () => void;
    const bothStale = new Promise<void>((resolve) => {
      secondGuard = resolve;
    });
    let entered!: () => void;
    const oneInside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    spyOn(fsp, 'writeFile').mockImplementation((async (file, data, opts) => {
      if (String(file).endsWith('.reclaim')) {
        guards += 1;
        const guard = guards;
        if (guard === 1) {
          await bothStale;
        }
        if (guard === 2) {
          secondGuard();
          await oneInside;
        }
      }

      return real(file, data, opts);
    }) as typeof real);
    let active = 0;
    let peak = 0;
    const waiter = () => {
      return withCrossProcessLock(
        dir,
        key,
        2000,
        async () => {
          active += 1;
          peak = Math.max(peak, active);
          entered();
          await Bun.sleep(100);
          active -= 1;
        },
        STALE,
      );
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

    // The call waits 50 ms; the watch alone takes 225 ms.
    expect(
      await withCrossProcessLock(dir, key, 50, async () => 'ok', 300),
    ).toBe('ok');
  });

  test('takes a stale lockfile over with a wait of 0', async () => {
    const key = 'note.md';
    await writeFile(lockPath(dir, key), '{"pid":12');
    await pastStaleBound(lockPath(dir, key));

    expect(await withCrossProcessLock(dir, key, 0, async () => 'ok', 300)).toBe(
      'ok',
    );
  });

  test('takes a lockfile over whose mtime is past the stale bound in the future', async () => {
    const key = 'note.md';
    await writeFile(lockPath(dir, key), '{"pid":12');
    // A writer that died before the clock was stepped back.
    const future = new Date(Date.now() + STALE_MS + 1000);
    await utimes(lockPath(dir, key), future, future);

    expect(
      await withCrossProcessLock(dir, key, 1000, async () => 'ok', STALE),
    ).toBe('ok');
  });

  test('writes no pid or host key, which released versions read to take a lock over at once', async () => {
    const key = 'note.md';
    const content = await withCrossProcessLock(dir, key, 300, async () => {
      return readFile(lockPath(dir, key), 'utf8');
    });

    expect(Object.keys(JSON.parse(content))).not.toContain('pid');
    expect(Object.keys(JSON.parse(content))).not.toContain('host');
  });

  test('takes a stale lockfile over when a slow stat outlasts the watch', async () => {
    const key = 'note.md';
    await writeFile(lockPath(dir, key), '{"pid":12');
    await pastStaleBound(lockPath(dir, key));
    const real = fsp.stat;
    spyOn(fsp, 'stat').mockImplementation((async (file, options) => {
      await Bun.sleep(100);

      return real(file, options);
    }) as typeof real);

    expect(
      await withCrossProcessLock(dir, key, 50, async () => 'ok', 300),
    ).toBe('ok');
  });

  test('stops waiting at the deadline when an old mtime keeps changing', async () => {
    const key = 'note.md';
    await writeFile(lockPath(dir, key), '{"pid":12');
    // A holder whose clock lags a minute: each heartbeat writes an old mtime,
    // a whole second apart, so a filesystem that keeps seconds sees it too.
    let lag = 60_000;
    const beat = setInterval(() => {
      lag -= 1000;
      const old = new Date(Date.now() - lag);
      utimes(lockPath(dir, key), old, old).catch(() => {});
    }, 20);

    const start = performance.now();
    try {
      await expect(
        withCrossProcessLock(dir, key, 100, async () => 'never', 300),
      ).rejects.toThrow('cross-process lock busy');
    } finally {
      clearInterval(beat);
    }

    // The deadline, plus at most one watch (225 ms) begun before it, with
    // room for a slow machine; without the bound the call never returns.
    expect(performance.now() - start).toBeLessThan(1000);
  });

  test('keeps the reclaim guard of a live waiter', async () => {
    const key = 'note.md';
    const guard = `${lockPath(dir, key)}.reclaim`;
    await writeFile(lockPath(dir, key), '{"pid":12');
    await pastStaleBound(lockPath(dir, key));
    await writeFile(guard, '');
    const fresh = new Date(Date.now() + 60_000); // fresh for the whole test
    await utimes(guard, fresh, fresh);

    await expect(
      withCrossProcessLock(dir, key, 400, async () => 'never', STALE),
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
