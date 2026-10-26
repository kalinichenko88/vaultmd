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
    prepare: (file: string) => Promise<() => Promise<Sig>>;
  }[] = [
    {
      name: 'atomicWrite',
      prepare: async (file) => {
        await atomicWrite(file, 'old');

        return () => {
          return atomicWrite(file, 'new content');
        };
      },
    },
    {
      name: 'atomicWriteIfUnchanged',
      prepare: async (file) => {
        const sig = await atomicWrite(file, 'old');

        return () => {
          return atomicWriteIfUnchanged(file, 'new content', sig);
        };
      },
    },
    {
      name: 'exclusiveCreate',
      prepare: async (file) => {
        return () => {
          return exclusiveCreate(file, 'new content');
        };
      },
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
    async ({ prepare }) => {
      const file = path.join(dir, 'note.md');
      const write = await prepare(file);
      const targetAtSync: (string | null)[] = [];
      spyOn(fsp, 'open').mockImplementation(async (...args) => {
        const handle = await realOpen(...args);
        for (const method of ['sync', 'datasync'] as const) {
          const real = handle[method].bind(handle);
          spyOn(handle, method).mockImplementation(async () => {
            targetAtSync.push(await readFile(file, 'utf8').catch(() => null));

            return real();
          });
        }

        return handle;
      });

      await write();

      expect(targetAtSync).toHaveLength(1);
      expect(targetAtSync[0]).not.toBe('new content');
      expect(await readFile(file, 'utf8')).toBe('new content');
    },
  );

  test.each(writers)(
    '$name leaves no tmp and no change when the write fails midway',
    async ({ prepare }) => {
      const file = path.join(dir, 'note.md');
      const write = await prepare(file);
      const before = await snapshot(dir);
      spyOn(fsp, 'writeFile').mockImplementation(
        async (target, data, options) => {
          await realWriteFile(target, String(data).slice(0, 3), options);
          throw Object.assign(new Error('ENOSPC: no space left on device'), {
            code: 'ENOSPC',
          });
        },
      );

      await expect(write()).rejects.toThrow(
        expect.objectContaining({ code: 'ENOSPC' }),
      );
      expect(await snapshot(dir)).toEqual(before);
    },
  );
});

async function snapshot(dir: string): Promise<Record<string, string>> {
  const names = await readdir(dir);
  const entries = await Promise.all(
    names.map(async (name) => {
      return [name, await readFile(path.join(dir, name), 'utf8')] as const;
    }),
  );

  return Object.fromEntries(entries);
}
