import { randomBytes } from 'node:crypto';
import {
  link,
  mkdir,
  open,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';

import { MdVaultError } from '@/errors.ts';

import type { Sig } from './models/sig.ts';
import { makeSig, sigsEqual, statSig } from './sig.ts';

export async function atomicWrite(
  fullPath: string,
  content: string,
): Promise<Sig> {
  await mkdir(path.dirname(fullPath), { recursive: true });

  return placeTemp(fullPath, content, (tmp) => {
    return rename(tmp, fullPath);
  });
}

export function atomicWriteIfUnchanged(
  fullPath: string,
  content: string,
  expected: Sig,
): Promise<Sig> {
  return placeTemp(fullPath, content, async (tmp) => {
    const current = await statSig(fullPath);
    if (!current || !sigsEqual(current, expected)) {
      throw new MdVaultError(
        'MTIME_CONFLICT',
        `file changed under write: ${fullPath}`,
      );
    }
    await rename(tmp, fullPath);
  });
}

export async function exclusiveCreate(
  fullPath: string,
  content: string,
): Promise<Sig> {
  await mkdir(path.dirname(fullPath), { recursive: true });

  return placeTemp(fullPath, content, async (tmp) => {
    try {
      await link(tmp, fullPath); // O_EXCL via hardlink: fails EEXIST if target present
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new MdVaultError(
          'ALREADY_EXISTS',
          `already exists: ${fullPath}`,
          { cause: err },
        );
      }
      throw err;
    }
  });
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

// Write `content` to a synced tmp next to `fullPath`, let `place` give it the
// target's name, then always remove the tmp: after a rename it is already
// gone, after a link it is a second name, after a failure it is junk.
async function placeTemp(
  fullPath: string,
  content: string,
  place: (tmp: string) => Promise<void>,
): Promise<Sig> {
  const tmp = tempPath(fullPath);
  try {
    await writeSynced(tmp, content);
    await place(tmp);
  } finally {
    await unlink(tmp).catch(() => {});
  }

  return makeSig(await stat(fullPath));
}

function tempPath(fullPath: string): string {
  const dir = path.dirname(fullPath);
  const base = path.basename(fullPath);

  return path.join(
    dir,
    `.${base}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
}

// The data must reach the disk before rename/link commits the name, or a crash
// can leave the target empty or short; a writeback error surfaces only at the
// sync. On macOS the sync stops at the drive cache (no F_FULLFSYNC, see #43).
async function writeSynced(file: string, content: string): Promise<void> {
  const handle = await open(file, 'w');
  try {
    await writeFile(handle, content, 'utf8');
    await handle.datasync();
  } catch (err) {
    // A close error must not hide the write or sync error behind it.
    await handle.close().catch(() => {});
    throw err;
  }
  await handle.close();
}
