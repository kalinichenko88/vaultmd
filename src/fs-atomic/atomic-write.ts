import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  type FileHandle,
  link,
  lstat,
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
  const like = await fileAt(fullPath);

  return placeTemp(fullPath, content, like, (tmp) => {
    return rename(tmp, fullPath);
  });
}

export async function atomicWriteIfUnchanged(
  fullPath: string,
  content: string,
  expected: Sig,
): Promise<Sig> {
  const like = await fileAt(fullPath);

  return placeTemp(fullPath, content, like, async (tmp) => {
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

// `copyOf` is the file whose content this is — the source of a move — so the
// new file gets its mode and owner, as a replaced file gives them.
export async function exclusiveCreate(
  fullPath: string,
  content: string,
  copyOf?: string,
): Promise<Sig> {
  await mkdir(path.dirname(fullPath), { recursive: true });
  const like = copyOf === undefined ? null : await fileAt(copyOf);

  return placeTemp(fullPath, content, like, async (tmp) => {
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

// The file at `fullPath`, or null when there is none. A symlink is refused, not
// written through or replaced: a rename puts a regular file where the link was
// and leaves its target stale (#46, docs/pdr/0001).
async function fileAt(fullPath: string): Promise<Stats | null> {
  let st: Stats;
  try {
    st = await lstat(fullPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new MdVaultError(
      'ALLOWLIST_VIOLATION',
      `path is a symlink: ${fullPath}`,
    );
  }

  return st;
}

// Write `content` to a synced tmp next to `fullPath`, let `place` give it the
// target's name, then always remove the tmp: after a rename it is already
// gone, after a link it is a second name, after a failure it is junk.
async function placeTemp(
  fullPath: string,
  content: string,
  like: Stats | null,
  place: (tmp: string) => Promise<void>,
): Promise<Sig> {
  const tmp = tempPath(fullPath);
  try {
    await writeSynced(tmp, content, like);
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
// The tmp is created no wider than `like` (umask can only narrow it) and takes
// its ownership before any byte is written, so the new text is never readable
// by more users than the old text was.
async function writeSynced(
  file: string,
  content: string,
  like: Stats | null,
): Promise<void> {
  const handle = await open(file, 'w', like ? like.mode & 0o777 : 0o666);
  try {
    if (like) {
      await keepOwnership(handle, like);
    }
    await writeFile(handle, content, 'utf8');
    await handle.datasync();
  } catch (err) {
    // A close error must not hide the write or sync error behind it.
    await handle.close().catch(() => {});
    throw err;
  }
  await handle.close();
}

// A new inode replaces the note: give it the note's group and owner where the
// OS lets this process set them — each on its own, best effort, since giving a
// file away takes root — then its mode, set-id bits dropped. Extended
// attributes and hard links stay with the old inode (docs/pdr/0002).
async function keepOwnership(handle: FileHandle, like: Stats): Promise<void> {
  const own = await handle.stat();
  if (own.gid !== like.gid) {
    await handle.chown(-1, like.gid).catch(() => {});
  }
  if (own.uid !== like.uid) {
    await handle.chown(like.uid, -1).catch(() => {});
  }
  const mode = like.mode & 0o777;
  if ((own.mode & 0o777) !== mode) {
    await handle.chmod(mode);
  }
}
