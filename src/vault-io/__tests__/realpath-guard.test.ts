import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { realTargetRelativeToRoot } from '../realpath-guard.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vaultmd-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('realTargetRelativeToRoot', () => {
  test('a path inside the root resolves to itself', async () => {
    await writeFile(join(root, 'a.md'), 'x');
    expect(realTargetRelativeToRoot(join(root, 'a.md'), root)).toBe('a.md');
  });

  test('a not-yet-existing path resolves to its nearest existing ancestor', async () => {
    expect(realTargetRelativeToRoot(join(root, 'sub', 'new.md'), root)).toBe(
      '',
    );
    await mkdir(join(root, 'sub'));
    expect(realTargetRelativeToRoot(join(root, 'sub', 'new.md'), root)).toBe(
      'sub',
    );
  });

  test('a symlink escaping the root is rejected', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'vaultmd-out-'));
    await writeFile(join(outside, 'secret.md'), 's');
    await symlink(join(outside, 'secret.md'), join(root, 'leak.md'));
    expect(realTargetRelativeToRoot(join(root, 'leak.md'), root)).toBeNull();
    await rm(outside, { recursive: true, force: true });
  });

  test('an in-vault symlink reports the target, not the link', async () => {
    await mkdir(join(root, '.obsidian'));
    await writeFile(join(root, '.obsidian', 'secret.md'), 's');
    await symlink(join(root, '.obsidian', 'secret.md'), join(root, 'a.md'));
    expect(realTargetRelativeToRoot(join(root, 'a.md'), root)).toBe(
      join('.obsidian', 'secret.md'),
    );
  });
});
