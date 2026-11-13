import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
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
  // `holder` is for a person who reads a stuck lockfile, and no code reads it.
  // It is not `pid` and `host`: versions before #62 read those to take a lock
  // over at once, and would take a live one from another PID namespace.
  const payload = JSON.stringify({
    holder: `${process.pid}@${hostname()}`,
    id: randomUUID(),
  });
  const beatMs = Math.min(1000, staleMs / 4);
  const watch: Watch = {
    mtimeMs: Number.NaN,
    since: 0,
    begun: 0,
    lengthMs: beatMs * 3,
  };
  const start = performance.now();
  const deadline = start + busyTimeoutMs;

  for (let poll = start; ; poll = performance.now()) {
    try {
      await createLockfile(lockfile, payload);
      break; // acquired
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
      const next = await reclaim(lockfile, staleMs, watch, poll);
      if (next === 'retry') {
        continue;
      }
      // A watch begun in a poll that started by the deadline runs to its end,
      // so that a busyTimeoutMs of 0 or more can take a stale lock over.
      const watching = next === 'watching' && watch.begun <= deadline;
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

// A lockfile that nobody refreshed for this long is stale. Only the age tells:
// a pid says nothing to a waiter in another PID namespace, even under the same
// host name (#62, PDR 0003), so a dead holder's lock waits out the bound.
// ponytail: a live holder loses the lock when its event loop blocks for about
// STALE_MS, or for longer than the 3 s watch just after the machine wakes or
// the clock steps; a heartbeat off the main thread would close both, if they
// ever matter. A dead holder's lockfile whose mtime is in the future, after
// the clock was stepped back, waits until the clock passes it: taking it
// sooner would take a live holder's lock whose heartbeat waits on SQLite.
export const STALE_MS = 30_000;

// The age is read on the wall clock, which jumps forward when the machine
// wakes from sleep or the clock is stepped, before the holder's heartbeat has
// run again. So a waiter takes a lockfile as aged only once it has also seen
// the same mtime for three heartbeats (lengthMs) on its own monotonic clock:
// from after the stat that first saw it (since) to before the stat that sees
// it again. `begun` is the start of the poll in which the watch began, which
// the deadline reads.
type Watch = {
  mtimeMs: number;
  since: number;
  begun: number;
  lengthMs: number;
};

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

// Two waiters that both find the lockfile stale would each remove it, and the
// second would remove the lock the first had just taken. So only the waiter
// that holds the guard removes it, after it checks the lockfile again.
async function reclaim(
  lockfile: string,
  staleMs: number,
  watch: Watch,
  poll: number,
): Promise<'retry' | 'watching' | 'busy'> {
  const before = await staleness(lockfile, staleMs, watch, poll);
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
    const now = await staleness(lockfile, staleMs, watch, poll);
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
  poll: number,
): Promise<'gone' | 'live' | 'watching' | 'stale'> {
  const asked = performance.now();
  // lstat, so that a link at the path is judged as a file: stat would fail on
  // a dangling one, and any error but ENOENT read as 'gone' spins the poll.
  const info = await lstat(lockfile).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  });
  if (!info) {
    return 'gone';
  }
  if (!isOld(info.mtimeMs, staleMs)) {
    return 'live';
  }
  if (watch.mtimeMs !== info.mtimeMs) {
    watch.mtimeMs = info.mtimeMs;
    watch.since = performance.now();
    watch.begun = poll;
  } else if (asked - watch.since >= watch.lengthMs) {
    return 'stale';
  }

  return 'watching';
}

function isOld(mtimeMs: number, staleMs: number): boolean {
  return Date.now() - mtimeMs > staleMs;
}
