import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MdVaultError } from '@/errors.ts';
import * as fsSig from '@/fs-atomic/sig.ts';

import { withFileMove } from '../index.ts';

let dir: string;
let from: { full: string; key: string; relative: string };
let to: { full: string; key: string; relative: string };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vaultmd-move-'));
  from = { full: join(dir, 'a.md'), key: 'a.md', relative: 'a.md' };
  to = { full: join(dir, 'b.md'), key: 'b.md', relative: 'b.md' };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('withFileMove', () => {
  test('moves the bytes and emits delete-then-create', async () => {
    await writeFile(from.full, '---\nid: 1\n---\nbody');
    const events: CommitSpy[] = [];
    await withFileMove(from, to, {
      onCommit: (e) => {
        events.push(e);
      },
    });
    expect(await readFile(to.full, 'utf8')).toBe('---\nid: 1\n---\nbody');
    expect(await fsSig.statSig(from.full)).toBeNull();
    expect(events).toEqual([
      { op: 'delete', path: 'a.md' },
      { op: 'create', path: 'b.md', content: '---\nid: 1\n---\nbody' },
    ]);
  });

  test('source vanishes mid-move → MTIME_CONFLICT, destination rolled back', async () => {
    await writeFile(from.full, 'hi');
    // Bun ESM live-binding + spyOn (the repo-blessed pattern): the 3rd statSig
    // call is the one inside unlinkIfUnchanged (calls 1-2 are readConsistent's
    // stat/re-stat). null there == "source gone" -> unlinkIfUnchanged returns
    // false, which must undo the freshly created destination.
    const realStatSig = fsSig.statSig;
    let n = 0;
    const spy = spyOn(fsSig, 'statSig').mockImplementation(
      async (p: string) => {
        n++;

        return n === 3 ? null : await realStatSig(p);
      },
    );
    let err: unknown;
    try {
      await withFileMove(from, to);
    } catch (e) {
      err = e;
    } finally {
      spy.mockRestore();
    }
    expect(err).toBeInstanceOf(MdVaultError);
    expect((err as MdVaultError).code).toBe('MTIME_CONFLICT');
    expect(await fsSig.statSig(to.full)).toBeNull();
    expect(await readFile(from.full, 'utf8')).toBe('hi');
  });

  test('a symlinked source is refused, and no destination folder is made (#46)', async () => {
    await writeFile(join(dir, 'real.md'), 'hi');
    await symlink(join(dir, 'real.md'), from.full);
    const deep = {
      full: join(dir, 'new', 'deep', 'b.md'),
      key: 'new/deep/b.md',
      relative: 'new/deep/b.md',
    };
    let err: unknown;
    try {
      await withFileMove(from, deep);
    } catch (e) {
      err = e;
    }
    expect((err as MdVaultError).code).toBe('ALLOWLIST_VIOLATION');
    expect(await fsSig.statSig(join(dir, 'new'))).toBeNull();
    expect((await lstat(from.full)).isSymbolicLink()).toBe(true);
  });

  test('the moved note keeps its mode (#46)', async () => {
    await writeFile(from.full, 'private');
    await chmod(from.full, 0o604); // no common umask gives a new file this
    await withFileMove(from, to);
    expect((await stat(to.full)).mode & 0o777).toBe(0o604);
  });
});

type CommitSpy =
  | { op: 'create' | 'update'; path: string; content: string }
  | { op: 'delete'; path: string };
