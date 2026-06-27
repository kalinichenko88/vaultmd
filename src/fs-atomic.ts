import { createHash, randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  link,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import * as path from 'node:path';

import { MdVaultError } from './errors.ts';

export type Sig = { mtimeMs: number; size: number };

function makeSig(st: Stats): Sig {
  return { mtimeMs: Math.trunc(st.mtimeMs), size: st.size };
}

function sigsEqual(a: Sig, b: Sig): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function tempPath(fullPath: string): string {
  const dir = path.dirname(fullPath);
  const base = path.basename(fullPath);

  return path.join(
    dir,
    `.${base}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
}

export async function statSig(fullPath: string): Promise<Sig | null> {
  try {
    return makeSig(await stat(fullPath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export async function atomicWrite(
  fullPath: string,
  content: string,
): Promise<Sig> {
  await mkdir(path.dirname(fullPath), { recursive: true });
  const tmp = tempPath(fullPath);
  await writeFile(tmp, content, 'utf8');
  try {
    await rename(tmp, fullPath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }

  return makeSig(await stat(fullPath));
}

export async function atomicWriteIfUnchanged(
  fullPath: string,
  content: string,
  expected: Sig,
): Promise<Sig> {
  const tmp = tempPath(fullPath);
  await writeFile(tmp, content, 'utf8');
  try {
    const current = await statSig(fullPath);
    if (!current || !sigsEqual(current, expected)) {
      throw new MdVaultError(
        'MTIME_CONFLICT',
        `file changed under write: ${fullPath}`,
      );
    }
    await rename(tmp, fullPath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }

  return makeSig(await stat(fullPath));
}

export async function exclusiveCreate(
  fullPath: string,
  content: string,
): Promise<Sig> {
  await mkdir(path.dirname(fullPath), { recursive: true });
  const tmp = tempPath(fullPath);
  await writeFile(tmp, content, 'utf8');
  try {
    await link(tmp, fullPath); // O_EXCL via hardlink: fails EEXIST if target present
  } catch (err) {
    await unlink(tmp).catch(() => {});
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new MdVaultError('ALREADY_EXISTS', `already exists: ${fullPath}`, {
        cause: err,
      });
    }
    throw err;
  }
  await unlink(tmp).catch(() => {});

  return makeSig(await stat(fullPath));
}

export async function unlinkIfUnchanged(
  fullPath: string,
  expected: Sig,
): Promise<boolean> {
  const current = await statSig(fullPath);
  if (!current) {
    return false;
  }
  if (!sigsEqual(current, expected)) {
    throw new MdVaultError(
      'MTIME_CONFLICT',
      `file changed before delete: ${fullPath}`,
    );
  }
  await unlink(fullPath);

  return true;
}

const fileLocks = new Map<string, Promise<void>>();

export async function withFileLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = fileLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mine = prev.then(() => gate);
  fileLocks.set(key, mine);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (fileLocks.get(key) === mine) {
      fileLocks.delete(key); // self-clean when no waiter chained behind us
    }
  }
}

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
