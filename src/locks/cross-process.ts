import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import * as path from 'node:path';

import { MdVaultError } from '@/errors.ts';

export async function withCrossProcessLock<T>(
  lockDir: string,
  key: string,
  busyTimeoutMs: number,
  fn: () => Promise<T>,
  staleMs = STALE_MS,
): Promise<T> {
  await mkdir(lockDir, { recursive: true });
  const lockfile = path.join(
    lockDir,
    `${createHash('sha256').update(key).digest('hex')}.lock`,
  );
  // `id` tells this holder's lockfile from the next one on the same key.
  const payload = JSON.stringify({
    pid: process.pid,
    host: hostname(),
    id: randomUUID(),
  });
  const beatMs = Math.min(1000, staleMs / 4);
  const watch: Watch = { mtimeMs: Number.NaN, since: 0, lengthMs: beatMs * 3 };
  const deadline = performance.now() + busyTimeoutMs;

  for (;;) {
    try {
      await createLockfile(lockfile, payload);
      break; // acquired
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
      const next = await reclaim(lockfile, staleMs, watch);
      if (next === 'retry') {
        continue;
      }
      // A watch that began before the deadline runs to its end, so that any
      // busyTimeoutMs can take a stale lock over.
      const watching = next === 'watching' && watch.since < deadline;
      if (performance.now() >= deadline && !watching) {
        throw new MdVaultError(
          'MTIME_CONFLICT',
          `cross-process lock busy: ${lockfile}`,
        );
      }
      await Bun.sleep(50);
    }
  }

  // Keep the mtime fresh while fn runs, so that only a dead holder's
  // lockfile ages past staleMs.
  const heartbeat = setInterval(() => {
    const now = new Date();
    utimes(lockfile, now, now).catch(() => {});
  }, beatMs);
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    // Leave the lockfile of a holder that took the lock over after this one
    // lost it by age; this narrows that race, it cannot close it. A lockfile
    // that cannot be read, for any reason but ENOENT, is taken as this
    // holder's own, as the release always did.
    const current = await readFile(lockfile, 'utf8').catch(
      (err: NodeJS.ErrnoException) => {
        return err.code === 'ENOENT' ? null : payload;
      },
    );
    if (current === payload) {
      await unlink(lockfile).catch(() => {});
    }
  }
}

// A lockfile that nobody refreshed for this long is stale, whatever it holds:
// the name of a host that is gone, a pid that a new process got, or a payload
// that a crash cut off.
// ponytail: a live holder loses the lock when its event loop blocks for about
// STALE_MS, or for longer than the 3 s watch just after the machine wakes or
// the clock steps; a heartbeat off the main thread would close both, if they
// ever matter.
export const STALE_MS = 30_000;

// The age is read on the wall clock, which jumps forward when the machine
// wakes from sleep or the clock is stepped, before the holder's heartbeat has
// run again. So a waiter takes a lockfile as aged only once it has also seen
// the same mtime for three heartbeats (lengthMs) on its own monotonic clock.
type Watch = { mtimeMs: number; since: number; lengthMs: number };

// The exclusive create makes this process the file's only writer, so a write
// that fails leaves no cut-off lockfile to block the key: the file goes.
async function createLockfile(
  lockfile: string,
  payload: string,
): Promise<void> {
  const handle = await open(lockfile, 'wx');
  try {
    await handle.writeFile(payload);
    await handle.close();
  } catch (err) {
    await handle.close().catch(() => {});
    await unlink(lockfile).catch(() => {});
    throw err;
  }
}

// Two waiters that both read the dead holder's file would each remove it, and
// the second would remove the lock the first had just taken. So only the
// waiter that holds the guard removes it, after it checks the lockfile again.
async function reclaim(
  lockfile: string,
  staleMs: number,
  watch: Watch,
): Promise<'retry' | 'watching' | 'busy'> {
  const before = await staleness(lockfile, staleMs, watch);
  if (before !== 'stale') {
    return outcomeOf(before);
  }
  const guard = `${lockfile}.reclaim`;
  try {
    await writeFile(guard, '', { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
    // ponytail: a guard left by a waiter that died while it held it, or seen
    // across a clock jump, is judged by its mtime alone; only then can two
    // waiters race on it.
    const info = await stat(guard).catch(() => null);
    if (!info || !isOld(info.mtimeMs, staleMs)) {
      return 'busy';
    }

    return unlink(guard).then(
      () => 'retry',
      (e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? 'retry' : 'busy'),
    );
  }
  try {
    const now = await staleness(lockfile, staleMs, watch);
    if (now !== 'stale') {
      return outcomeOf(now);
    }
    await unlink(lockfile).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') {
        throw err; // a lockfile that cannot be removed never frees the lock
      }
    });

    return 'retry';
  } finally {
    await unlink(guard).catch(() => {});
  }
}

function outcomeOf(
  state: 'gone' | 'live' | 'watching',
): 'retry' | 'watching' | 'busy' {
  if (state === 'gone') {
    return 'retry';
  }

  return state === 'watching' ? 'watching' : 'busy';
}

async function staleness(
  lockfile: string,
  staleMs: number,
  watch: Watch,
): Promise<'gone' | 'live' | 'watching' | 'stale'> {
  const info = await stat(lockfile).catch(() => null);
  if (!info) {
    return 'gone';
  }
  const old = isOld(info.mtimeMs, staleMs);
  if (old) {
    if (watch.mtimeMs !== info.mtimeMs) {
      watch.mtimeMs = info.mtimeMs;
      watch.since = performance.now();
    } else if (performance.now() - watch.since >= watch.lengthMs) {
      return 'stale';
    }
  }
  if (await holderIsDead(lockfile)) {
    return 'stale';
  }

  return old ? 'watching' : 'live';
}

function isOld(mtimeMs: number, staleMs: number): boolean {
  return Date.now() - mtimeMs > staleMs;
}

// A same-host pid tells at once that the holder is dead.
async function holderIsDead(lockfile: string): Promise<boolean> {
  let holder: { pid?: unknown; host?: unknown };
  try {
    holder = { ...JSON.parse(await readFile(lockfile, 'utf8')) };
  } catch {
    return false; // gone, or not written in full yet
  }
  if (holder.host !== hostname() || typeof holder.pid !== 'number') {
    return false;
  }
  try {
    process.kill(holder.pid, 0);

    return false; // alive, or the pid is reused: the age tells later
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH'; // EPERM: alive
  }
}
