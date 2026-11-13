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
  // `expected` is the Sig of a file that was there: with none now, the tmp
  // would get no ownership to carry, so it is a conflict before any write.
  const like = await fileAt(fullPath);
  if (!like) {
    throw new MdVaultError(
      'MTIME_CONFLICT',
      `file gone before write: ${fullPath}`,
    );
  }

  // A chmod or chown during the write changes no Sig, and the tmp carries the
  // ownership from before it: a conflict, so the caller retries on the new
  // ownership instead of the rename undoing it. One that lands after this
  // check and before the rename is still undone. Never reopen the tmp by name
  // to take it over: a link planted at that name would get the chmod.
  return placeTemp(fullPath, content, like, async (tmp) => {
    const current = await fileAt(fullPath);
    if (!current || !sigsEqual(makeSig(current), expected)) {
      throw new MdVaultError(
        'MTIME_CONFLICT',
        `file changed under write: ${fullPath}`,
      );
    }
    if (!sameOwnership(current, like)) {
      throw new MdVaultError(
        'MTIME_CONFLICT',
        `mode, owner or group changed under write: ${fullPath}`,
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
  // Before the mkdir, so a refused source makes no folder.
  const like = copyOf === undefined ? null : await fileAt(copyOf);
  await mkdir(path.dirname(fullPath), { recursive: true });

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
// ponytail: `like` is read before the write. atomicWriteIfUnchanged turns a
// chmod or chown made during the write into a conflict; atomicWrite has no
// check point, and a move checks only its source's Sig, so there the new file
// gets the ownership from before. Upgrade path: the tmp's own handle at the
// place step, never a reopen by name.
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
// A tmp that replaces a note is created no wider than the note for any user
// (`safeMode`), and takes the note's ownership before any byte is written, so
// the new text is never readable by more users than the old text was. `wx`: a
// name that is already taken, or a link planted there, fails instead of being
// written through.
async function writeSynced(
  file: string,
  content: string,
  like: Stats | null,
): Promise<void> {
  const handle = await open(file, 'wx', like ? safeMode(like.mode) : 0o666);
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

// A new inode replaces the note: give it the note's group, mode and owner. The
// group and the owner are best effort — the OS may refuse them, and giving a
// file away takes root. The stat, not the chown's result, says whether the
// group was kept: a mount can ignore a chown with no error. A group it could
// not keep gets `narrowGroup`. Set-id bits are dropped. A refused mode is no
// error while the tmp gives the group and the others no more than the mode
// does, as a mount that refuses chmod leaves it after `safeMode`. The mode goes
// on before the owner, while this process still owns the file. Extended
// attributes and hard links stay with the old inode (docs/pdr/0002).
async function keepOwnership(handle: FileHandle, like: Stats): Promise<void> {
  await handle.chown(-1, like.gid).catch(() => {});
  const own = await handle.stat();
  const ownMode = own.mode & 0o777;
  let mode = like.mode & 0o777;
  if (own.gid !== like.gid) {
    mode = narrowGroup(mode);
  }
  if (ownMode !== mode) {
    await handle.chmod(mode).catch((err: unknown) => {
      if ((ownMode & ~mode & 0o077) !== 0) {
        throw err;
      }
    });
  }
  if (own.uid !== like.uid) {
    await handle.chown(like.uid, -1).catch(() => {});
  }
}

// The mode a tmp is created with: the note's mode under `narrowGroup`, since
// the tmp's group is not the note's yet, and read and write for the writer.
function safeMode(mode: number): number {
  return 0o600 | (narrowGroup(mode) & 0o077);
}

// A file's group that is not the note's gets only the bits that the note's
// group and its others both have: its members then read no more than they
// could before, as a member of the note's group or as others. Zero bits would
// lock them out of what every other user can read (#66).
function narrowGroup(mode: number): number {
  return (mode & 0o707) | ((mode & (mode >> 3) & 0o007) << 3);
}

function sameOwnership(a: Stats, b: Stats): boolean {
  return (
    (a.mode & 0o777) === (b.mode & 0o777) && a.uid === b.uid && a.gid === b.gid
  );
}
