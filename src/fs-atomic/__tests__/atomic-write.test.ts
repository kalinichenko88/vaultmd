import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import { statSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import {
  chmod,
  chown,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { MdVaultError } from '@/errors.ts';

import {
  atomicWrite,
  atomicWriteIfUnchanged,
  exclusiveCreate,
  unlinkIfUnchanged,
} from '../atomic-write.ts';
import type { Sig } from '../models/sig.ts';
import { statSig } from '../sig.ts';

const { open: realOpen, writeFile: realWriteFile } = fsp;

describe('statSig + atomicWrite', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vaultmd-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('atomicWrite creates parent dirs and returns the post-write sig', async () => {
    const file = path.join(dir, 'a', 'b', 'note.md');
    const sig = await atomicWrite(file, 'hello');

    expect(await readFile(file, 'utf8')).toBe('hello');
    expect(sig.size).toBe(5);
    expect(Number.isInteger(sig.mtimeMs)).toBe(true);
    expect(await statSig(file)).toEqual(sig);
  });

  test('atomicWriteIfUnchanged rewrites when the sig matches', async () => {
    const file = path.join(dir, 'note.md');
    const first = await atomicWrite(file, 'one');
    const second = await atomicWriteIfUnchanged(file, 'changed', first);

    expect(await readFile(file, 'utf8')).toBe('changed');
    expect(second.size).toBe(7);
    expect(await statSig(file)).toEqual(second);
  });

  test('atomicWriteIfUnchanged throws MTIME_CONFLICT on a stale sig', async () => {
    const file = path.join(dir, 'note.md');
    await atomicWrite(file, 'one');

    const stale = { mtimeMs: 1, size: 999 };
    let caught: unknown;
    try {
      await atomicWriteIfUnchanged(file, 'two', stale);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(MdVaultError);
    expect((caught as MdVaultError).code).toBe('MTIME_CONFLICT');
    expect(await readFile(file, 'utf8')).toBe('one'); // original untouched
    expect(await readdir(dir)).toEqual(['note.md']); // no tmp left
  });
});

describe('the file a write replaces (#46)', () => {
  let dir: string;
  let umask: number;

  // The common umask, so the mode a tmp is created with does not vary.
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vaultmd-'));
    umask = process.umask(0o022);
  });

  afterEach(async () => {
    process.umask(umask);
    mock.restore();
    await rm(dir, { recursive: true, force: true });
  });

  // A group the tmp would not get by default: not the new dir's (BSD, macOS)
  // and not the process's (Linux). Without one, the group case cannot fail.
  const otherGroup = (process.getgroups?.() ?? []).find((gid) => {
    return gid !== statSync(tmpdir()).gid && gid !== process.getegid?.();
  });

  // 0o604 is a mode that no common umask gives a new file, so a write that
  // does not copy the mode cannot pass by luck.
  const MODE = 0o604;

  // `exclusiveCreate` replaces nothing: it copies the mode of the note a move
  // reads from, so the moved note keeps it.
  const writers = [
    {
      name: 'atomicWrite',
      write: (file: string, _sig: Sig) => {
        return atomicWrite(file, 'new');
      },
      result: (file: string) => {
        return file;
      },
    },
    {
      name: 'atomicWriteIfUnchanged',
      write: (file: string, sig: Sig) => {
        return atomicWriteIfUnchanged(file, 'new', sig);
      },
      result: (file: string) => {
        return file;
      },
    },
    {
      name: 'exclusiveCreate',
      write: (file: string, _sig: Sig) => {
        return exclusiveCreate(`${file}.moved`, 'new', file);
      },
      result: (file: string) => {
        return `${file}.moved`;
      },
    },
  ];

  async function note(mode: number): Promise<{ file: string; sig: Sig }> {
    const file = path.join(dir, 'note.md');
    await atomicWrite(file, 'old');
    await chmod(file, mode);

    return { file, sig: (await statSig(file)) as Sig };
  }

  for (const { name, write, result } of writers) {
    test(`${name} keeps the note's mode`, async () => {
      const { file, sig } = await note(MODE);

      await write(file, sig);

      expect(await readFile(result(file), 'utf8')).toBe('new');
      expect((await stat(result(file))).mode & 0o7777).toBe(MODE);
    });

    // The tmp's group is not known to be the note's at create, so its group
    // and its others start with only the bits that both have on the note.
    for (const { mode, bound } of [
      { mode: 0o600, bound: 0o600 },
      { mode: 0o640, bound: 0o600 },
      { mode: 0o604, bound: 0o600 },
    ]) {
      test(`${name} creates its tmp for a ${oct(mode)} note no wider than ${oct(bound)}`, async () => {
        const { file, sig } = await note(mode);
        let atCreate = -1;
        spyOn(fsp, 'open').mockImplementationOnce(async (...args) => {
          const handle = await realOpen(...args);
          atCreate = (await handle.stat()).mode & 0o777;

          return handle;
        });

        await write(file, sig);

        expect(atCreate).not.toBe(-1);
        expect(atCreate & ~bound).toBe(0);
      });
    }

    test(`${name} drops set-id bits`, async () => {
      const { file, sig } = await note(0o4644);

      await write(file, sig);

      expect((await stat(result(file))).mode & 0o7777).toBe(0o644);
    });

    // Kept, the note's group keeps its own bits, not only the shared ones.
    test.skipIf(otherGroup === undefined)(
      `${name} keeps the note's group and its bits`,
      async () => {
        const { file } = await note(0o640);
        await chown(file, (await stat(file)).uid, otherGroup as number);

        await write(file, (await statSig(file)) as Sig);

        const after = await stat(result(file));
        expect(after.gid).toBe(otherGroup as number);
        expect(after.mode & 0o777).toBe(0o640);
      },
    );

    // The writer becomes the owner then (PDR 0002).
    test(`${name} still writes when the OS refuses to give the file back to the note's owner`, async () => {
      const { file, sig } = await note(0o644);
      spyOn(fsp, 'open').mockImplementationOnce(async (...args) => {
        const handle = await realOpen(...args);
        const realStat = handle.stat.bind(handle);
        // The tmp is the writer's, and the note is another user's.
        spyOn(handle, 'stat').mockImplementation((async () => {
          const st = await realStat();

          return Object.assign(st, { uid: st.uid + 1 });
        }) as typeof handle.stat);
        spyOn(handle, 'chown').mockRejectedValue(errno('EPERM'));

        return handle;
      });

      await write(file, sig);

      expect(await readFile(result(file), 'utf8')).toBe('new');
    });

    // The new file's group is not the note's: no member of either group reads
    // more than before, and none less than every other user (#66).
    for (const { mode, expected, refuses } of [
      { mode: 0o664, expected: 0o644, refuses: true },
      { mode: 0o604, expected: 0o600, refuses: true },
      { mode: 0o640, expected: 0o600, refuses: false },
    ]) {
      test.skipIf(otherGroup === undefined)(
        `${name} writes a ${oct(mode)} note as ${oct(expected)} when the OS ${refuses ? 'refuses' : 'ignores'} its group`,
        async () => {
          const { file } = await note(mode);
          await chown(file, (await stat(file)).uid, otherGroup as number);
          spyOn(fsp, 'open').mockImplementationOnce(async (...args) => {
            const handle = await realOpen(...args);
            spyOn(handle, 'chown').mockImplementation(async () => {
              if (refuses) {
                throw errno('EINVAL');
              }
            });

            return handle;
          });

          await write(file, (await statSig(file)) as Sig);

          expect(await readFile(result(file), 'utf8')).toBe('new');
          expect((await stat(result(file))).mode & 0o777).toBe(expected);
        },
      );
    }

    // The 664 note asks for a chmod after the create; the 644 one does not.
    for (const { mode, expected } of [
      { mode: 0o644, expected: 0o644 },
      { mode: 0o664, expected: 0o644 },
    ]) {
      test(`${name} still writes a ${oct(mode)} note as ${oct(expected)} when the OS refuses chmod (#66)`, async () => {
        const { file, sig } = await note(mode);
        fakeMount('refuses');

        await write(file, sig);

        expect(await readFile(result(file), 'utf8')).toBe('new');
        expect((await stat(result(file))).mode & 0o777).toBe(expected);
      });
    }

    for (const outcome of ['refuses', 'ignores'] as const) {
      test(`${name} still writes a read-only note when the OS ${outcome} chmod`, async () => {
        const { file, sig } = await note(0o444);
        fakeMount(outcome);

        await write(file, sig);

        const mode = (await stat(result(file))).mode & 0o777;
        expect(await readFile(result(file), 'utf8')).toBe('new');
        expect(mode).not.toBe(0o444); // the chmod did not apply
        expect(mode & 0o077 & ~0o044).toBe(0);
      });
    }

    // A shared folder of a VM or a CIFS mount gives every file one mode, so
    // the tmp gets the note's own mode and group, whatever was asked.
    test(`${name} writes on a mount with one fixed mode for every file`, async () => {
      const { file, sig } = await note(0o664);
      fakeMount('ignores', 0o664);

      await write(file, sig);

      expect(await readFile(result(file), 'utf8')).toBe('new');
      expect((await stat(result(file))).mode & 0o777).toBe(0o664);
    });

    // Narrowed after the open, the tmp would still be readable through a file
    // descriptor that another user opened before the chmod. 644 over a 640
    // note in its own group widens the others only.
    test(`${name} fails before any text when the OS creates the tmp wider than the note`, async () => {
      const { file, sig } = await note(0o640);
      const written = watchWrite();
      fakeMount('obeys', 0o644);

      await expectUnsafeMode(write(file, sig), written, result(file));
    });

    test(`${name} fails before any text when the OS turns a chmod into a wider mode`, async () => {
      const { file, sig } = await note(0o640);
      const written = watchWrite();
      fakeMount('widens');

      await expectUnsafeMode(write(file, sig), written, result(file));
    });

    // In a group that is not the note's, the bound is the shared bits, not
    // the note's mode: the note's group bits would reach the wrong group.
    test.skipIf(otherGroup === undefined)(
      `${name} fails before any text when the OS creates the tmp at the note's mode in another group`,
      async () => {
        const { file } = await note(0o640);
        await chown(file, (await stat(file)).uid, otherGroup as number);
        const written = watchWrite();
        fakeMount('ignores', 0o640);

        await expectUnsafeMode(
          write(file, (await statSig(file)) as Sig),
          written,
          result(file),
        );
      },
    );

    test.skipIf(otherGroup === undefined)(
      `${name} fails before any text when the group is lost and the OS turns a chmod into a wider mode`,
      async () => {
        const { file } = await note(0o664);
        await chown(file, (await stat(file)).uid, otherGroup as number);
        const written = watchWrite();
        fakeMount('widens', 0o600, true);

        await expectUnsafeMode(
          write(file, (await statSig(file)) as Sig),
          written,
          result(file),
        );
      },
    );
  }

  // The write failed with UNSAFE_MODE, named `target`, and left the note and
  // its folder as they were.
  async function expectUnsafeMode(
    pending: Promise<Sig>,
    written: () => boolean,
    target: string,
  ): Promise<void> {
    const error = await pending.catch((e: unknown) => {
      return e;
    });

    expect((error as MdVaultError).code).toBe('UNSAFE_MODE');
    expect((error as MdVaultError).message).toContain(target);
    expect(written()).toBe(false);
    expect(await readFile(path.join(dir, 'note.md'), 'utf8')).toBe('old');
    expect(await readdir(dir)).toEqual(['note.md']);
  }

  // A mount that obeys chmod, refuses it, ignores it with no error, or sets a
  // wider mode than asked. `createdAs` stands for one that also ignores the
  // mode a file is created with, and `refusesChown` for one that refuses a
  // change of group.
  function fakeMount(
    outcome: 'obeys' | 'refuses' | 'ignores' | 'widens',
    createdAs?: number,
    refusesChown = false,
  ): void {
    spyOn(fsp, 'open').mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      if (createdAs !== undefined) {
        await handle.chmod(createdAs);
      }
      if (refusesChown) {
        spyOn(handle, 'chown').mockRejectedValue(errno('EINVAL'));
      }
      const realChmod = handle.chmod.bind(handle);
      if (outcome !== 'obeys') {
        spyOn(handle, 'chmod').mockImplementation(async (mode) => {
          if (outcome === 'refuses') {
            throw errno('EPERM');
          }
          if (outcome === 'widens') {
            await realChmod(Number(mode) | 0o024);
          }
        });
      }

      return handle;
    });
  }

  // Whether the text of the next write reached its file.
  function watchWrite(): () => boolean {
    let written = false;
    spyOn(fsp, 'writeFile').mockImplementationOnce(async (...args) => {
      written = true;

      return realWriteFile(...args);
    });

    return () => {
      return written;
    };
  }

  function oct(mode: number): string {
    return mode.toString(8);
  }

  // The attack of the security review: while the write runs, swap the tmp
  // name for a link to another file and chmod the note. Nothing may reopen
  // the tmp by name and carry that chmod onto the link's target.
  test('a link planted at the tmp name never gets the note mode', async () => {
    const { file, sig } = await note(0o644);
    const victim = path.join(dir, 'victim');
    await fsp.writeFile(victim, 'private');
    await chmod(victim, 0o600);
    let tmp = '';
    spyOn(fsp, 'open').mockImplementationOnce(async (...args) => {
      tmp = String(args[0]);

      return realOpen(...args);
    });
    spyOn(fsp, 'writeFile').mockImplementationOnce(async (...args) => {
      const result = await realWriteFile(...args);
      await rm(tmp);
      await symlink(victim, tmp);
      await chmod(file, 0o666);

      return result;
    });

    const error = await atomicWriteIfUnchanged(file, 'new', sig).catch(
      (e: unknown) => {
        return e;
      },
    );

    expect(tmp).not.toBe('');
    expect((error as MdVaultError).code).toBe('MTIME_CONFLICT');
    expect((await stat(victim)).mode & 0o777).toBe(0o600);
    expect((await lstat(file)).isSymbolicLink()).toBe(false);
    expect(await readFile(file, 'utf8')).toBe('old');
  });

  test('a chmod made while atomicWriteIfUnchanged writes is a conflict, not undone', async () => {
    const { file, sig } = await note(0o644);
    spyOn(fsp, 'writeFile').mockImplementationOnce(async (...args) => {
      await chmod(file, 0o600); // the person narrows the note mid-write

      return realWriteFile(...args);
    });

    const error = await atomicWriteIfUnchanged(file, 'new', sig).catch(
      (e: unknown) => {
        return e;
      },
    );

    expect((error as MdVaultError).code).toBe('MTIME_CONFLICT');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, 'utf8')).toBe('old');
  });

  test.skipIf(otherGroup === undefined)(
    'a chgrp made while atomicWriteIfUnchanged writes is a conflict, not undone',
    async () => {
      const { file, sig } = await note(0o640);
      spyOn(fsp, 'writeFile').mockImplementationOnce(async (...args) => {
        await chown(file, (await stat(file)).uid, otherGroup as number);

        return realWriteFile(...args);
      });

      const error = await atomicWriteIfUnchanged(file, 'new', sig).catch(
        (e: unknown) => {
          return e;
        },
      );

      expect((error as MdVaultError).code).toBe('MTIME_CONFLICT');
      expect((await stat(file)).gid).toBe(otherGroup as number);
    },
  );

  test('a note absent when atomicWriteIfUnchanged starts is a conflict at once', async () => {
    const { file, sig } = await note(0o600);
    const away = path.join(dir, 'away.md');
    await fsp.rename(file, away);
    // A sync tool brings it back, same Sig, while the write would run.
    const writeSpy = spyOn(fsp, 'writeFile').mockImplementationOnce(
      async (...args) => {
        await fsp.rename(away, file);

        return realWriteFile(...args);
      },
    );

    const error = await atomicWriteIfUnchanged(file, 'new', sig).catch(
      (e: unknown) => {
        return e;
      },
    );

    expect((error as MdVaultError).code).toBe('MTIME_CONFLICT');
    expect(writeSpy).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual(['away.md']);
    expect(await readFile(away, 'utf8')).toBe('old');
  });

  test('a write onto a symlink is refused, and the link and its target stay', async () => {
    const real = path.join(dir, 'real.md');
    const alias = path.join(dir, 'alias.md');
    await atomicWrite(real, 'old\n');
    await symlink(real, alias);
    const sig = (await statSig(alias)) as Sig;

    for (const write of [
      () => {
        return atomicWrite(alias, 'new');
      },
      () => {
        return atomicWriteIfUnchanged(alias, 'new', sig);
      },
    ]) {
      const error = await write().catch((e: unknown) => {
        return e;
      });
      expect((error as MdVaultError).code).toBe('ALLOWLIST_VIOLATION');
    }
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, 'utf8')).toBe('old\n');
  });
});

describe('exclusiveCreate + unlinkIfUnchanged', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vaultmd-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('exclusiveCreate writes a new file and returns its sig', async () => {
    const file = path.join(dir, 'sub', 'new.md');
    const sig = await exclusiveCreate(file, 'fresh');

    expect(await readFile(file, 'utf8')).toBe('fresh');
    expect(await statSig(file)).toEqual(sig);
    // After link() the tmp is a second name for the note; it must go too.
    expect(await readdir(path.dirname(file))).toEqual(['new.md']);
  });

  test('exclusiveCreate throws ALREADY_EXISTS and does not clobber the target', async () => {
    const file = path.join(dir, 'dupe.md');
    await atomicWrite(file, 'orig');

    let caught: unknown;
    try {
      await exclusiveCreate(file, 'second');
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(MdVaultError);
    expect((caught as MdVaultError).code).toBe('ALREADY_EXISTS');
    expect(await readFile(file, 'utf8')).toBe('orig');
    expect(await readdir(dir)).toEqual(['dupe.md']); // no tmp left
  });

  test('exclusiveCreate onto a symlink, dangling or not, is refused, and the link stays', async () => {
    const real = path.join(dir, 'real.md');
    await atomicWrite(real, 'old\n');
    for (const target of [real, path.join(dir, 'gone.md')]) {
      const alias = path.join(dir, 'alias.md');
      await symlink(target, alias);
      const error = await exclusiveCreate(alias, 'new').catch((e: unknown) => {
        return e;
      });
      expect((error as MdVaultError).code).toBe('ALLOWLIST_VIOLATION');
      expect((await lstat(alias)).isSymbolicLink()).toBe(true);
      await rm(alias);
    }
    expect(await readFile(real, 'utf8')).toBe('old\n');
  });

  test('a link() that took effect but failed with EEXIST, as on NFS, is a create (#45)', async () => {
    const file = path.join(dir, 'nfs.md');
    const realLink = fsp.link;
    spyOn(fsp, 'link').mockImplementationOnce(async (from, to) => {
      await realLink(from, to); // the server made the link; its reply was lost
      throw Object.assign(new Error('EEXIST: file already exists, link'), {
        code: 'EEXIST',
      });
    });
    try {
      const sig = await exclusiveCreate(file, 'fresh');
      expect(await statSig(file)).toEqual(sig);
    } finally {
      mock.restore();
    }
    expect(await readFile(file, 'utf8')).toBe('fresh');
    expect(await readdir(dir)).toEqual(['nfs.md']);
  });

  test('unlinkIfUnchanged returns false (no-op) for a missing file', async () => {
    const ghost = path.join(dir, 'ghost.md');
    expect(await unlinkIfUnchanged(ghost, { mtimeMs: 1, size: 1 })).toBe(false);
  });

  test('unlinkIfUnchanged throws MTIME_CONFLICT on a sig mismatch', async () => {
    const file = path.join(dir, 'note.md');
    await atomicWrite(file, 'data');

    let caught: unknown;
    try {
      await unlinkIfUnchanged(file, { mtimeMs: 1, size: 99 });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(MdVaultError);
    expect((caught as MdVaultError).code).toBe('MTIME_CONFLICT');
    expect(await statSig(file)).not.toBeNull();
  });

  test('unlinkIfUnchanged deletes and returns true on a matching sig', async () => {
    const file = path.join(dir, 'note.md');
    const sig = await atomicWrite(file, 'data');

    expect(await unlinkIfUnchanged(file, sig)).toBe(true);
    expect(await statSig(file)).toBeNull();
  });
});

describe('the tmp file of a write', () => {
  const writers: {
    name: string;
    before: string | null;
    prepare: (file: string) => Promise<() => Promise<Sig>>;
  }[] = [
    {
      name: 'atomicWrite',
      before: 'old',
      prepare: async (file) => {
        await atomicWrite(file, 'old');

        return () => {
          return atomicWrite(file, 'new content');
        };
      },
    },
    {
      name: 'atomicWriteIfUnchanged',
      before: 'old',
      prepare: async (file) => {
        const sig = await atomicWrite(file, 'old');

        return () => {
          return atomicWriteIfUnchanged(file, 'new content', sig);
        };
      },
    },
    {
      name: 'exclusiveCreate',
      before: null,
      prepare: async (file) => {
        return () => {
          return exclusiveCreate(file, 'new content');
        };
      },
    },
  ];

  const faults: {
    fault: string;
    code: string;
    failWrite?: string;
    failSync?: string;
    failClose?: string;
  }[] = [
    { fault: 'the write fails midway', code: 'ENOSPC', failWrite: 'ENOSPC' },
    {
      fault: 'the sync fails and then the close fails',
      code: 'EIO',
      failSync: 'EIO',
      failClose: 'EBADF',
    },
    {
      fault: 'the write fails and then the close fails',
      code: 'ENOSPC',
      failWrite: 'ENOSPC',
      failClose: 'EBADF',
    },
    {
      fault: 'the close fails after a good sync',
      code: 'EIO',
      failClose: 'EIO',
    },
  ];

  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vaultmd-'));
  });

  afterEach(async () => {
    mock.restore();
    await rm(dir, { recursive: true, force: true });
  });

  test.each(writers)(
    '$name syncs the tmp before it places it',
    async ({ before, prepare }) => {
      const file = path.join(dir, 'note.md');
      const write = await prepare(file);
      const atSync: { tmp: string; target: string | null }[] = [];
      spyOn(fsp, 'open').mockImplementation(async (...args) => {
        const handle = await realOpen(...args);
        for (const method of ['sync', 'datasync'] as const) {
          const real = handle[method].bind(handle);
          spyOn(handle, method).mockImplementation(async () => {
            atSync.push({
              tmp: await readFile(String(args[0]), 'utf8'),
              target: await readFile(file, 'utf8').catch(() => null),
            });

            return real();
          });
        }

        return handle;
      });

      await write();

      expect(atSync).toEqual([{ tmp: 'new content', target: before }]);
      expect(await readFile(file, 'utf8')).toBe('new content');
    },
  );

  test.each(
    writers.flatMap((writer) => {
      return faults.map((fault) => {
        return { ...writer, ...fault };
      });
    }),
  )(
    '$name closes the tmp once and leaves no tmp and no change when $fault',
    async ({ prepare, code, failWrite, failSync, failClose }) => {
      const file = path.join(dir, 'note.md');
      const write = await prepare(file);
      const before = await snapshot(dir);
      let closes = 0;
      if (failWrite) {
        spyOn(fsp, 'writeFile').mockImplementation(
          async (target, data, options) => {
            await realWriteFile(target, String(data).slice(0, 3), options);
            throw errno(failWrite);
          },
        );
      }
      spyOn(fsp, 'open').mockImplementation(async (...args) => {
        const handle = await realOpen(...args);
        const realClose = handle.close.bind(handle);
        if (failSync) {
          for (const method of ['sync', 'datasync'] as const) {
            spyOn(handle, method).mockImplementation(async () => {
              throw errno(failSync);
            });
          }
        }
        spyOn(handle, 'close').mockImplementation(async () => {
          closes++;
          await realClose();
          if (failClose) {
            throw errno(failClose);
          }
        });

        return handle;
      });

      await expect(write()).rejects.toThrow(expect.objectContaining({ code }));
      expect(await snapshot(dir)).toEqual(before);
      expect(closes).toBe(1);
    },
  );
});

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const names = await readdir(dir);
  const entries = await Promise.all(
    names.map(async (name) => {
      return [name, await readFile(path.join(dir, name), 'utf8')] as const;
    }),
  );

  return Object.fromEntries(entries);
}
