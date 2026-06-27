import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { statSig } from '../sig.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mdvault-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('statSig', () => {
  test('returns null for a missing file', async () => {
    expect(await statSig(join(dir, 'nope.md'))).toBeNull();
  });

  test('returns an integer-ms sig for an existing file', async () => {
    const f = join(dir, 'a.md');
    await writeFile(f, 'hello');
    const sig = await statSig(f);
    expect(sig?.size).toBe(5);
    expect(Number.isInteger(sig?.mtimeMs)).toBe(true);
  });
});
