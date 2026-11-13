import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { passesSymlink } from '../symlink-guard.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vaultmd-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('passesSymlink', () => {
  test('a real file and a path that does not exist yet pass no symlink', async () => {
    await mkdir(join(root, 'sub'));
    await writeFile(join(root, 'sub', 'a.md'), 'x');
    expect(passesSymlink(root, 'sub/a.md')).toBe(false);
    expect(passesSymlink(root, 'sub/new.md')).toBe(false);
    expect(passesSymlink(root, 'new/deep/new.md')).toBe(false);
  });

  test('a symlinked note, folder or dangling link is found', async () => {
    await mkdir(join(root, 'real'));
    await writeFile(join(root, 'real', 'a.md'), 'x');
    await symlink(join(root, 'real', 'a.md'), join(root, 'note.md'));
    await symlink(join(root, 'real'), join(root, 'folder'));
    await symlink(join(root, 'gone.md'), join(root, 'dangling.md'));
    expect(passesSymlink(root, 'note.md')).toBe(true);
    expect(passesSymlink(root, 'folder/a.md')).toBe(true);
    expect(passesSymlink(root, 'folder/new.md')).toBe(true);
    expect(passesSymlink(root, 'dangling.md')).toBe(true);
  });

  test('the root is not judged: it may be a link, and so may its parents', async () => {
    await mkdir(join(root, 'real-root'));
    await writeFile(join(root, 'real-root', 'a.md'), 'x');
    await symlink(join(root, 'real-root'), join(root, 'link'));
    expect(passesSymlink(join(root, 'link'), 'a.md')).toBe(false);
    expect(passesSymlink(join(root, 'link'), '')).toBe(false);
  });

  test('a file in the middle of the path stops the walk, as absence does', async () => {
    await writeFile(join(root, 'a.md'), 'x');
    expect(passesSymlink(root, 'a.md/b.md')).toBe(false);
  });
});
