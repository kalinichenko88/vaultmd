import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { realTargetWithinRoot } from '../realpath-guard.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mdvault-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('realTargetWithinRoot', () => {
  test('a path inside the root is contained', async () => {
    await writeFile(join(root, 'a.md'), 'x');
    expect(realTargetWithinRoot(join(root, 'a.md'), root)).toBe(true);
  });

  test('a not-yet-existing path inside the root is allowed (nearest ancestor)', () => {
    expect(realTargetWithinRoot(join(root, 'sub', 'new.md'), root)).toBe(true);
  });

  test('a symlink escaping the root is rejected', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'mdvault-out-'));
    await writeFile(join(outside, 'secret.md'), 's');
    await symlink(join(outside, 'secret.md'), join(root, 'leak.md'));
    expect(realTargetWithinRoot(join(root, 'leak.md'), root)).toBe(false);
    await rm(outside, { recursive: true, force: true });
  });
});
