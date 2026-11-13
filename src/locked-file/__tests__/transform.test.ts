import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import { writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
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
import { statSig } from '@/fs-atomic/sig.ts';

import { withFileTransform } from '../index.ts';

let dir: string;
let file: string;
const KEY = 'note.md';
const REL = 'note.md';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vaultmd-locked-'));
  file = join(dir, 'note.md');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('withFileTransform', () => {
  test('missing file + allowCreate:false → REFUSE_CREATE, nothing written', async () => {
    let err: unknown;
    try {
      await withFileTransform(file, KEY, REL, () => 'hello');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MdVaultError);
    expect((err as MdVaultError).code).toBe('REFUSE_CREATE');
    expect(await statSig(file)).toBeNull();
  });

  test('missing file + allowCreate:true → created, on disk, onCommit create event', async () => {
    const events: CommitSpy[] = [];
    const res = await withFileTransform(file, KEY, REL, () => 'hello', {
      allowCreate: true,
      onCommit: (e) => {
        events.push(e);
      },
    });
    expect(res).toEqual({ content: 'hello', outcome: 'created' });
    expect(await readFile(file, 'utf8')).toBe('hello');
    expect(events).toEqual([{ op: 'create', path: REL, content: 'hello' }]);
  });

  test('transform returns null on a present file → unchanged, untouched', async () => {
    await writeFile(file, 'orig');
    const before = await statSig(file);
    const res = await withFileTransform(file, KEY, REL, () => null);
    expect(res).toEqual({ content: 'orig', outcome: 'unchanged' });
    expect(await readFile(file, 'utf8')).toBe('orig');
    expect(await statSig(file)).toEqual(before);
  });

  test('transform returns null on a missing file → unchanged with null content (no REFUSE_CREATE)', async () => {
    const res = await withFileTransform(file, KEY, REL, () => null);
    expect(res).toEqual({ content: null, outcome: 'unchanged' });
    expect(await statSig(file)).toBeNull();
  });

  test('transform returns byte-identical content → unchanged, no rewrite, no commit', async () => {
    await writeFile(file, 'orig');
    const before = await statSig(file);
    const events: CommitSpy[] = [];
    const res = await withFileTransform(file, KEY, REL, (c) => c, {
      onCommit: (e) => {
        events.push(e);
      },
    });
    expect(res).toEqual({ content: 'orig', outcome: 'unchanged' });
    // mtime/signature untouched (no rename) and no phantom 'update' event
    expect(await statSig(file)).toEqual(before);
    expect(events).toEqual([]);
  });

  test('present file changed → updated, disk updated, onCommit update event', async () => {
    await writeFile(file, 'a');
    const events: CommitSpy[] = [];
    const res = await withFileTransform(file, KEY, REL, (c) => `${c}b`, {
      onCommit: (e) => {
        events.push(e);
      },
    });
    expect(res).toEqual({ content: 'ab', outcome: 'updated' });
    expect(await readFile(file, 'utf8')).toBe('ab');
    expect(events).toEqual([{ op: 'update', path: REL, content: 'ab' }]);
  });

  test('onCommit throw → COMMIT_FAILED with cause, file already written (no rollback)', async () => {
    await writeFile(file, 'a');
    const boom = new Error('git commit failed');
    let err: unknown;
    try {
      await withFileTransform(file, KEY, REL, () => 'NEW', {
        onCommit: () => {
          throw boom;
        },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MdVaultError);
    expect((err as MdVaultError).code).toBe('COMMIT_FAILED');
    expect((err as MdVaultError).cause).toBe(boom);
    expect(await readFile(file, 'utf8')).toBe('NEW');
  });

  test('two concurrent appends on the same lockKey → no lost update', async () => {
    await writeFile(file, 'start\n');
    await Promise.all([
      withFileTransform(file, KEY, REL, (c) => `${c}X\n`),
      withFileTransform(file, KEY, REL, (c) => `${c}Y\n`),
    ]);
    const final = await readFile(file, 'utf8');
    expect(final.startsWith('start\n')).toBe(true);
    expect(final).toContain('X');
    expect(final).toContain('Y');
    expect(final.length).toBe('start\nX\nY\n'.length);
  });

  test('external mid-flight write → retries on MTIME_CONFLICT and converges', async () => {
    await writeFile(file, 'base\n');
    let injected = false;
    const res = await withFileTransform(file, KEY, REL, (c) => {
      if (!injected) {
        injected = true;
        // External writer lands AFTER our consistent read, BEFORE our guarded write.
        // Size differs from 'base\n', so the pre-rename re-stat is guaranteed to mismatch.
        writeFileSync(file, 'base\nEXTERNAL\n');
      }

      return `${c}A`;
    });
    expect(res.outcome).toBe('updated');
    expect(await readFile(file, 'utf8')).toBe('base\nEXTERNAL\nA');
  });

  test('a symlinked path is refused, and the link and its target stay (#46)', async () => {
    const real = join(dir, 'real.md');
    await writeFile(real, 'old\n');
    await symlink(real, file);
    let err: unknown;
    try {
      await withFileTransform(file, KEY, REL, (c) => `${c}new`);
    } catch (e) {
      err = e;
    }
    expect((err as MdVaultError).code).toBe('ALLOWLIST_VIOLATION');
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, 'utf8')).toBe('old\n');
  });

  test('a chmod made during the write is kept: the update retries on it (#46)', async () => {
    await writeFile(file, 'old');
    await chmod(file, 0o644);
    const realWriteFile = fsp.writeFile;
    spyOn(fsp, 'writeFile').mockImplementationOnce(async (...args) => {
      await chmod(file, 0o600); // the person narrows the note mid-write

      return realWriteFile(...args);
    });
    try {
      const res = await withFileTransform(file, KEY, REL, (c) => `${c}+new`);
      expect(res.outcome).toBe('updated');
    } finally {
      mock.restore();
    }
    expect(await readFile(file, 'utf8')).toBe('old+new');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});

type CommitSpy =
  | { op: 'create' | 'update'; path: string; content: string }
  | { op: 'delete'; path: string };
