import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import * as path from 'node:path';

import { MdVaultError } from '../errors.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryReclaim(lockfile: string, payload: string): Promise<boolean> {
  let holder: { pid?: number; host?: string };
  try {
    holder = JSON.parse(await readFile(lockfile, 'utf8'));
  } catch {
    return false; // unreadable / vanished — let the caller re-poll
  }
  if (holder.host !== hostname() || typeof holder.pid !== 'number') {
    return false; // foreign host or malformed — never reclaim
  }
  try {
    process.kill(holder.pid, 0);

    return false; // signal delivered -> pid alive
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      return false; // EPERM etc. -> alive but not ours
    }
  }
  // dead same-host pid: drop the stale lockfile and re-acquire
  await unlink(lockfile).catch(() => {});
  try {
    await writeFile(lockfile, payload, { flag: 'wx' });

    return true;
  } catch {
    return false; // lost the race; caller re-polls
  }
}

export async function withCrossProcessLock<T>(
  lockDir: string,
  key: string,
  busyTimeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  await mkdir(lockDir, { recursive: true });
  const lockfile = path.join(
    lockDir,
    `${createHash('sha256').update(key).digest('hex')}.lock`,
  );
  const payload = JSON.stringify({
    pid: process.pid,
    host: hostname(),
    createdAt: Date.now(),
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
      if (await tryReclaim(lockfile, payload)) {
        break;
      }
      if (Date.now() >= deadline) {
        throw new MdVaultError(
          'MTIME_CONFLICT',
          `cross-process lock busy: ${lockfile}`,
        );
      }
      await delay(50);
    }
  }

  try {
    return await fn();
  } finally {
    await unlink(lockfile).catch(() => {});
  }
}
