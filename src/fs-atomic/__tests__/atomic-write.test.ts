import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import * as fsp from 'node:fs/promises';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
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
