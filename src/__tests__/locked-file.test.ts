import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MdVaultError } from '../errors.ts';
import * as fsSig from '../fs-atomic/sig.ts';
import { withFileDelete, withFileTransform } from '../locked-file.ts';

let dir: string;
let file: string;
const KEY = 'note.md';
const REL = 'note.md';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mdvault-locked-'));
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
    expect(await fsSig.statSig(file)).toBeNull();
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
    const before = await fsSig.statSig(file);
    const res = await withFileTransform(file, KEY, REL, () => null);
    expect(res).toEqual({ content: 'orig', outcome: 'unchanged' });
    expect(await readFile(file, 'utf8')).toBe('orig');
    expect(await fsSig.statSig(file)).toEqual(before);
  });

  test('transform returns null on a missing file → unchanged with null content (no REFUSE_CREATE)', async () => {
    const res = await withFileTransform(file, KEY, REL, () => null);
    expect(res).toEqual({ content: null, outcome: 'unchanged' });
    expect(await fsSig.statSig(file)).toBeNull();
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
});

describe('withFileDelete', () => {
  test('missing file → { deleted:false }, onCommit not called', async () => {
    const events: CommitSpy[] = [];
    const res = await withFileDelete(file, KEY, REL, {
      onCommit: (e) => {
        events.push(e);
      },
    });
    expect(res).toEqual({ deleted: false });
    expect(events).toEqual([]);
  });

  test('present file → unlink + onCommit delete event, { deleted:true }', async () => {
    await writeFile(file, 'bye');
    const events: CommitSpy[] = [];
    const res = await withFileDelete(file, KEY, REL, {
      onCommit: (e) => {
        events.push(e);
      },
    });
    expect(res).toEqual({ deleted: true });
    expect(events).toEqual([{ op: 'delete', path: REL }]);
    expect(await fsSig.statSig(file)).toBeNull();
  });

  test('signature changed under us → MTIME_CONFLICT, file not deleted', async () => {
    await writeFile(file, 'bye');
    // Bun ESM live-binding + spyOn (the repo-blessed pattern): make ONLY the
    // first statSig call (the one inside withFileDelete) return a stale sig;
    // unlinkIfUnchanged then re-stats the real file -> size mismatch -> conflict.
    const realStatSig = fsSig.statSig;
    let n = 0;
    const spy = spyOn(fsSig, 'statSig').mockImplementation(
      async (p: string) => {
        n++;
        const real = await realStatSig(p);
        if (n === 1 && real) {
          return { mtimeMs: real.mtimeMs, size: real.size + 7 };
        }

        return real;
      },
    );
    let err: unknown;
    try {
      await withFileDelete(file, KEY, REL);
    } catch (e) {
      err = e;
    } finally {
      spy.mockRestore();
    }
    expect(err).toBeInstanceOf(MdVaultError);
    expect((err as MdVaultError).code).toBe('MTIME_CONFLICT');
    expect(await readFile(file, 'utf8')).toBe('bye');
  });
});

type CommitSpy =
  | { op: 'create' | 'update'; path: string; content: string }
  | { op: 'delete'; path: string };
