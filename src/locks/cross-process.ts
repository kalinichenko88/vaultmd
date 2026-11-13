import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
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
  const deadline = Date.now() + busyTimeoutMs;

  for (;;) {
    try {
      await writeFile(lockfile, payload, { flag: 'wx' });
      break; // acquired
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
      if (await removeIfStale(lockfile, staleMs)) {
        continue; // the stale lockfile is gone: take the lock now
      }
      if (Date.now() >= deadline) {
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
  }, staleMs / 4);
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    // Leave the lockfile of a holder that took the lock over after this one
    // lost it by age; this narrows that race, it cannot close it. A lockfile
    // that cannot be read (EMFILE) is taken as this holder's own.
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
// a payload that a failed write cut off, the name of a host that is gone, or a
// pid that a new process got.
// ponytail: a live holder loses the lock when its event loop blocks for more
// than 3/4 of STALE_MS (a sqliteBusyTimeoutMs above 7.5 s can do it), or when
// the machine sleeps while another process waits; a waiter that confirms the
// age on its own monotonic clock closes both, if they ever matter.
export const STALE_MS = 10_000;

// Two waiters that both read the dead holder's file would each remove it, and
// the second would remove the lock the first had just taken. So only the
// waiter that holds the guard removes it, after it checks the lockfile again.
async function removeIfStale(
  lockfile: string,
  staleMs: number,
): Promise<boolean> {
  if (!(await isStale(lockfile, staleMs))) {
    return false;
  }
  const guard = `${lockfile}.reclaim`;
  try {
    await writeFile(guard, '', { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
    // ponytail: a waiter that dies while it holds the guard leaves it; the
    // guard then ages out like a lockfile, and only after such a death can
    // two waiters race on it.
    if (await isStale(guard, staleMs)) {
      await unlink(guard).catch(() => {});
    }

    return false;
  }
  try {
    if (!(await isStale(lockfile, staleMs))) {
      return false;
    }
    await unlink(lockfile).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') {
        throw err; // a lockfile that cannot be removed never frees the lock
      }
    });

    return true;
  } finally {
    await unlink(guard).catch(() => {});
  }
}

async function isStale(file: string, staleMs: number): Promise<boolean> {
  const info = await stat(file).catch(() => null);
  if (!info) {
    return false; // gone: the caller polls again
  }
  if (Date.now() - info.mtimeMs > staleMs) {
    return true;
  }
  // Fresh, but its holder can be dead already: a same-host pid tells at once.
  let holder: { pid?: unknown; host?: unknown };
  try {
    holder = JSON.parse(await readFile(file, 'utf8'));
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
