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
        // A link there, dangling or not, is refused as every write refuses
        // it (docs/pdr/0001), not reported as a file that is there.
        const there = await fileAt(fullPath);
        // On NFS a link() that took effect can still fail with EEXIST
        // (open(2)): the name then holds the tmp's inode, and the create is
        // done. A retry above must not apply its change a second time.
        const mine = await lstat(tmp);
        if (there && there.ino === mine.ino && there.dev === mine.dev) {
          return;
        }
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
    await writeSynced(tmp, content, like, fullPath);
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
// A tmp for `note` that takes the ownership of `like` — the note it replaces,
// or the source of a move — is created no wider than `like` for any other user
// (`safeMode`), and takes that ownership before any byte is written, so by
// its mode the new text is never readable by more users than the old text was
// (an ACL that the folder gives a new file is not checked, docs/pdr/0002).
// `wx`: a name that is already taken, or a link planted there, fails instead
// of being written through.
async function writeSynced(
  file: string,
  content: string,
  like: Stats | null,
  note: string,
): Promise<void> {
  const handle = await open(file, 'wx', like ? safeMode(like.mode) : 0o666);
  try {
    if (like) {
      // Before any byte: it also refuses a tmp the OS made wider (UNSAFE_MODE).
      await keepOwnership(handle, like, note);
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

// A new inode replaces the note: give it the note's group, mode and owner. A
// tmp whose group or others bits the OS made wider than `target` allows is
// refused at once: a chmod after the open would not close a file descriptor
// that another user opened before it. `target` is the note's mode while the
// tmp is in the note's group — so a mount with one fixed mode for every file
// still writes — and `sharedBits` in another group. Past
// that check the group, the mode and the owner are best effort — the OS may
// refuse or ignore them, and giving a file away takes root — and the stat, not
// a call's result, says what the OS kept. A group it could not keep gets
// `sharedBits`. Set-id bits are dropped. The mode goes on before the owner,
// while this process still owns the file. Extended attributes and hard links
// stay with the old inode (docs/pdr/0002).
async function keepOwnership(
  handle: FileHandle,
  like: Stats,
  note: string,
): Promise<void> {
  // The note's mode for a tmp in the note's group, `sharedBits` in another.
  const target = (st: Stats): number => {
    return st.gid === like.gid ? like.mode & 0o777 : sharedBits(like.mode);
  };
  let own = await handle.stat();
  refuseWider(own, target(own), note);
  if (own.gid !== like.gid) {
    await handle.chown(-1, like.gid).catch(() => {});
    own = await handle.stat();
  }
  const mode = target(own);
  if ((own.mode & 0o777) !== mode) {
    await handle.chmod(mode).catch(() => {});
    refuseWider(await handle.stat(), mode, note);
  }
  if (own.uid !== like.uid) {
    await handle.chown(like.uid, -1).catch(() => {});
  }
}

// The tmp may give the group and the others no more than `mode`. The owner's
// bits do not count: they are the writer's, or the note's owner's.
function refuseWider(own: Stats, mode: number, note: string): void {
  if ((own.mode & ~mode & 0o077) !== 0) {
    throw new MdVaultError(
      'UNSAFE_MODE',
      `the OS gave the tmp for ${note} mode ${(own.mode & 0o777).toString(8)}, wider than ${mode.toString(8)}`,
    );
  }
}

// The mode a tmp is created with: read and write for the writer, and
// `sharedBits` for the rest, since the tmp's group is not the note's yet.
function safeMode(mode: number): number {
  return 0o600 | (sharedBits(mode) & 0o077);
}

// The note's mode for a file whose group is not the note's: its group and its
// others both get only the bits that the note's group and others both have. A
// member of either group then reads no more than before, whichever class it
// falls into, and no less than every other user (#66).
function sharedBits(mode: number): number {
  const shared = mode & (mode >> 3) & 0o007;

  return (mode & 0o700) | (shared << 3) | shared;
}

function sameOwnership(a: Stats, b: Stats): boolean {
  return (
    (a.mode & 0o777) === (b.mode & 0o777) && a.uid === b.uid && a.gid === b.gid
  );
}
