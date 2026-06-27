import { randomBytes } from 'node:crypto';
import { link, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { MdVaultError } from '../errors.ts';
import { type Sig, makeSig, sigsEqual, statSig } from './sig.ts';

function tempPath(fullPath: string): string {
  const dir = path.dirname(fullPath);
  const base = path.basename(fullPath);

  return path.join(
    dir,
    `.${base}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
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
