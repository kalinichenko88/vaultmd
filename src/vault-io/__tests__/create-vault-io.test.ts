import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MdVaultError } from '@/errors.ts';

import { createVaultIo } from '../index.ts';

let vault: string;

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), 'vaultmd-'));
});

afterEach(async () => {
  await rm(vault, { recursive: true, force: true });
});

function syncCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof MdVaultError ? e.code : String(e);
  }

  return 'NO_THROW';
}

async function asyncCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return e instanceof MdVaultError ? e.code : String(e);
  }

  return 'NO_THROW';
}

describe('toVaultRelative / toKey', () => {
  test('canonicalizes ./, dup-slash, . segments, and resolving ..', () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    expect(io.toVaultRelative('a/./b.md')).toBe('a/b.md');
    expect(io.toVaultRelative('./a//b.md')).toBe('a/b.md');
    expect(io.toVaultRelative('a/b/../c.md')).toBe('a/c.md');
    expect(io.toVaultRelative('Notes/Daily.md')).toBe('Notes/Daily.md'); // case-preserving
  });

  test('NFC-normalizes unicode path segments', () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    expect(io.toVaultRelative('cafe\u0301/note.md')).toBe('caf\u00e9/note.md');
  });

  test('rejects absolute paths and ..-escapes with ALLOWLIST_VIOLATION', () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    expect(syncCode(() => io.toVaultRelative('/abs/x.md'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
    expect(syncCode(() => io.toVaultRelative('../escape.md'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
    expect(syncCode(() => io.toVaultRelative('a/../../escape.md'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
  });

  test('toKey case-folds only when caseSensitive is false', () => {
    const ci = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
      caseSensitive: false,
    });
    expect(ci.toKey('Notes/Daily.md')).toBe('notes/daily.md');
    expect(ci.toVaultRelative('Notes/Daily.md')).toBe('Notes/Daily.md');

    const cs = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
      caseSensitive: true,
    });
    expect(cs.toKey('Notes/Daily.md')).toBe('Notes/Daily.md');
  });

  test('auto-detects volume case sensitivity for toKey when unspecified', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    await writeFile(join(vault, 'CaseProbe.md'), 'x');
    let insensitive = false;
    try {
      await stat(join(vault, 'caseprobe.md'));
      insensitive = true;
    } catch {
      insensitive = false;
    }
    expect(io.toKey('Note.md')).toBe(insensitive ? 'note.md' : 'Note.md');
  });
});

describe('can (per-access boundary-aware prefix match)', () => {
  test("boundary: 'foo' matches the folder and exact entry but NOT 'foobar.md'", () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: ['foo'], write: ['foo'] },
    });
    expect(io.can('foobar.md', 'read')).toBe(false);
    expect(io.can('foo/note.md', 'read')).toBe(true);
    expect(io.can('foo', 'read')).toBe(true);
  });

  test("'' matches everything", () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    expect(io.can('anything/deep/x.md', 'read')).toBe(true);
    expect(io.can('top.md', 'read')).toBe(true);
  });

  test('read and write prefixes are independent; trailing slash canonicalized', () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: ['Public/', 'Shared/'], write: ['Public/'] },
    });
    expect(io.can('Public/x.md', 'read')).toBe(true);
    expect(io.can('Public/x.md', 'write')).toBe(true);
    expect(io.can('Shared/x.md', 'read')).toBe(true);
    expect(io.can('Shared/x.md', 'write')).toBe(false);
    expect(io.can('Private/x.md', 'read')).toBe(false);
  });

  test('an absolute / escaping path is never in the allowlist', () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    expect(io.can('/abs/x.md', 'read')).toBe(false);
    expect(io.can('../escape.md', 'read')).toBe(false);
  });
});

describe('createVaultIo prefix validation', () => {
  test("rejects a '..' segment in a read prefix with ALLOWLIST_VIOLATION at construction time", () => {
    expect(
      syncCode(() =>
        createVaultIo({
          root: vault,
          prefixes: { read: ['../secret'], write: [] },
        }),
      ),
    ).toBe('ALLOWLIST_VIOLATION');
  });

  test("rejects a '..' segment in a write prefix with ALLOWLIST_VIOLATION at construction time", () => {
    expect(
      syncCode(() =>
        createVaultIo({
          root: vault,
          prefixes: { read: [], write: ['safe/../../../escape'] },
        }),
      ),
    ).toBe('ALLOWLIST_VIOLATION');
  });
});

describe('resolveVaultPath', () => {
  test('returns the lexical absolute path for an allowed .md target (need not exist)', () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: ['Public/'], write: ['Public/'] },
    });
    expect(io.resolveVaultPath('Public/a.md', 'write')).toBe(
      join(vault, 'Public/a.md'),
    );
    expect(io.resolveVaultPath('Public/a.md')).toBe(join(vault, 'Public/a.md')); // default access 'read'
  });

  test('.md guard fires before allowlist (NOT_MARKDOWN)', () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: ['Public/'], write: ['Public/'] },
    });
    expect(syncCode(() => io.resolveVaultPath('Public/note.txt'))).toBe(
      'NOT_MARKDOWN',
    );
  });

  test('per-access allowlist violations throw ALLOWLIST_VIOLATION', () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: ['Public/'], write: ['Public/'] },
    });
    expect(syncCode(() => io.resolveVaultPath('Private/x.md', 'read'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
    expect(syncCode(() => io.resolveVaultPath('Private/x.md', 'write'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
  });

  test('rejects a symlink that escapes the vault root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'vaultmd-out-'));
    await writeFile(join(outside, 'secret.md'), '# secret');
    await symlink(join(outside, 'secret.md'), join(vault, 'leak.md'));
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    expect(syncCode(() => io.resolveVaultPath('leak.md', 'read'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
    await rm(outside, { recursive: true, force: true });
  });

  test('rejects symlinked-parent escape on create via nearest-existing-ancestor realpath', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'vaultmd-out-'));
    await symlink(outside, join(vault, 'link')); // link/ -> outside the vault
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    expect(syncCode(() => io.resolveVaultPath('link/new.md', 'write'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
    await rm(outside, { recursive: true, force: true });
  });

  test('an in-vault symlink that stays inside the root resolves fine', async () => {
    await mkdir(join(vault, 'real'));
    await writeFile(join(vault, 'real', 'a.md'), '# a');
    await symlink(join(vault, 'real'), join(vault, 'alias'));
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    expect(io.resolveVaultPath('alias/a.md', 'read')).toBe(
      join(vault, 'alias/a.md'),
    );
  });
});

describe('atomic IO', () => {
  test('writeVaultFile + readVaultFile round-trip carry a matching sig; missing -> null', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    const sig = await io.writeVaultFile('notes/a.md', '# hi'); // atomicWrite mkdir -p parent
    expect(sig.size).toBe(4);
    const read = await io.readVaultFile('notes/a.md');
    expect(read?.content).toBe('# hi');
    expect(read?.sig).toEqual(sig);
    expect(await io.readVaultFile('notes/missing.md')).toBeNull();
  });

  test('writeVaultFile / stat go through the write / read scope respectively', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: ['R/'], write: ['W/'] },
    });
    expect(await asyncCode(() => io.writeVaultFile('R/x.md', 'x'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
    await io.writeVaultFile('W/x.md', 'x');
    expect(await asyncCode(() => io.stat('W/x.md'))).toBe(
      'ALLOWLIST_VIOLATION',
    ); // W not in read scope
  });

  test('rewriteIfUnchanged guards on a stale sig with MTIME_CONFLICT', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    const sig1 = await io.writeVaultFile('x.md', 'AAA'); // size 3
    const sig2 = await io.rewriteIfUnchanged('x.md', 'BBBBB', sig1); // size 5
    expect((await io.readVaultFile('x.md'))?.content).toBe('BBBBB');
    expect(
      await asyncCode(() => io.rewriteIfUnchanged('x.md', 'CCCCCCC', sig1)),
    ).toBe('MTIME_CONFLICT');
    expect(await io.stat('x.md')).toEqual(sig2);
  });

  test('unlinkIfUnchanged deletes on match and is a no-op (false) when already gone', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    const sig = await io.writeVaultFile('y.md', 'hello');
    expect(await io.unlinkIfUnchanged('y.md', sig)).toBe(true);
    expect(await io.stat('y.md')).toBeNull();
    expect(await io.unlinkIfUnchanged('y.md', sig)).toBe(false);
  });
});

describe('listMarkdown', () => {
  test('recurses, returns sorted vault-relative .md, ignores non-.md, missing dir -> []', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    await writeFile(join(vault, 'a.md'), '# a');
    await writeFile(join(vault, 'notes.txt'), 'skip');
    await mkdir(join(vault, 'sub'));
    await writeFile(join(vault, 'sub', 'b.md'), '# b');
    const found = await io.listMarkdown();
    expect(found).toEqual(['a.md', 'sub/b.md']);
    expect(await io.listMarkdown('nope')).toEqual([]);
  });

  test('skips dotfolders (.obsidian/.trash/.git) and configured ignore globs', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
      ignore: ['Drafts/**', '**/_*'],
    });
    await writeFile(join(vault, 'keep.md'), 'k');
    await mkdir(join(vault, '.obsidian'));
    await writeFile(join(vault, '.obsidian', 'cfg.md'), 'c');
    await mkdir(join(vault, 'Drafts'));
    await writeFile(join(vault, 'Drafts', 'secret.md'), 's');
    await writeFile(join(vault, '_template.md'), 't');
    const found = await io.listMarkdown();
    expect(found).toEqual(['keep.md']);
  });

  test('only lists under the read scope', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: ['Public/'], write: [''] },
    });
    await mkdir(join(vault, 'Public'));
    await writeFile(join(vault, 'Public', 'p.md'), 'p');
    await mkdir(join(vault, 'Private'));
    await writeFile(join(vault, 'Private', 's.md'), 's');
    const found = await io.listMarkdown();
    expect(found).toEqual(['Public/p.md']);
  });

  test('does NOT follow a vault-escaping symlinked dir, nor an escaping symlinked .md', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'vaultmd-out-'));
    await writeFile(join(outside, 'secret.md'), '# secret');
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    await writeFile(join(vault, 'a.md'), '# a');
    await mkdir(join(vault, 'sub'));
    await writeFile(join(vault, 'sub', 'b.md'), '# b');
    await symlink(outside, join(vault, 'evil')); // dir symlink -> outside
    await symlink(join(outside, 'secret.md'), join(vault, 'leak.md')); // file symlink -> outside
    const found = await io.listMarkdown();
    expect(found).toContain('a.md');
    expect(found).toContain('sub/b.md');
    expect(found).not.toContain('evil/secret.md');
    expect(found).not.toContain('leak.md');
    await rm(outside, { recursive: true, force: true });
  });
});
