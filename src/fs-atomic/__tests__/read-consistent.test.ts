import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readConsistent } from '../read-consistent.ts';
import * as sig from '../sig.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vaultmd-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readConsistent', () => {
  test('missing file → { content: null, sig: null }', async () => {
    expect(await readConsistent(join(dir, 'nope.md'))).toEqual({
      content: null,
      sig: null,
    });
  });

  test('stable file → content with a matching sig', async () => {
    const f = join(dir, 'a.md');
    await writeFile(f, 'hello');
    const res = await readConsistent(f);
    expect(res.content).toBe('hello');
    expect(res.sig).toEqual(await sig.statSig(f));
  });

  test('sig changes between the two stats → retries once, then converges', async () => {
    const f = join(dir, 'a.md');
    await writeFile(f, 'stable');
    const real = sig.statSig;
    let n = 0;
    const spy = spyOn(sig, 'statSig').mockImplementation(async (p: string) => {
      n++;
      const r = await real(p);
      // 2nd call is the post-read re-stat of iteration 1: make it disagree with
      // the pre-read stat so the loop retries; all later calls are real.
      if (n === 2 && r) {
        return { mtimeMs: r.mtimeMs + 1, size: r.size + 1 };
      }

      return r;
    });
    try {
      const res = await readConsistent(f);
      expect(res.content).toBe('stable');
      expect(res.sig).toEqual(await real(f));
      expect(n).toBeGreaterThanOrEqual(4); // looped at least twice
    } finally {
      spy.mockRestore();
    }
  });
});
