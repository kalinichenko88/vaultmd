import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MdVaultError } from '../../errors.ts';
import * as fsSig from '../../fs-atomic/sig.ts';
import { withFileDelete } from '../index.ts';

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
