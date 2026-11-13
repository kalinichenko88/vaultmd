import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fsp from 'node:fs/promises';
import {
  lstat,
  mkdir,
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

  test('rejects a create under a symlinked folder that leads out of the vault', async () => {
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

  test('a path through an in-vault symlink is refused: one file, one path', async () => {
    await mkdir(join(vault, 'real'));
    await writeFile(join(vault, 'real', 'a.md'), '# a');
    await symlink(join(vault, 'real'), join(vault, 'alias'));
    await symlink(join(vault, 'real', 'a.md'), join(vault, 'b.md'));
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    for (const access of ['read', 'write'] as const) {
      expect(syncCode(() => io.resolveVaultPath('alias/a.md', access))).toBe(
        'ALLOWLIST_VIOLATION',
      );
      expect(syncCode(() => io.resolveVaultPath('alias/new.md', access))).toBe(
        'ALLOWLIST_VIOLATION',
      );
      expect(syncCode(() => io.resolveVaultPath('b.md', access))).toBe(
        'ALLOWLIST_VIOLATION',
      );
    }
    expect(io.resolveVaultPath('real/a.md', 'read')).toBe(
      join(vault, 'real/a.md'),
    );
  });

  test('a write through a symlinked note is refused and keeps the link', async () => {
    await writeFile(join(vault, 'real.md'), 'old\n');
    await symlink(join(vault, 'real.md'), join(vault, 'alias.md'));
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    const sig = await io.stat('real.md');
    if (!sig) {
      throw new Error('real.md was not written');
    }
    expect(await asyncCode(() => io.writeVaultFile('alias.md', 'x'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
    expect(
      await asyncCode(() => io.rewriteIfUnchanged('alias.md', 'x', sig)),
    ).toBe('ALLOWLIST_VIOLATION');
    expect((await lstat(join(vault, 'alias.md'))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(vault, 'real.md'), 'utf8')).toBe('old\n');
  });

  test('a dangling symlink is refused too, so a write cannot follow it out', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'vaultmd-out-'));
    await rm(outside, { recursive: true, force: true }); // the target is gone
    await symlink(join(outside, 'x.md'), join(vault, 'dangling.md'));
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    expect(syncCode(() => io.resolveVaultPath('dangling.md', 'write'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
  });

  test('the root itself may be a symlink', async () => {
    await mkdir(join(vault, 'real-root', 'notes'), { recursive: true });
    await writeFile(join(vault, 'real-root', 'notes', 'a.md'), '# a');
    await symlink(join(vault, 'real-root'), join(vault, 'root-link'));
    const io = createVaultIo({
      root: join(vault, 'root-link'),
      prefixes: { read: [''], write: [''] },
    });
    expect((await io.readVaultFile('notes/a.md'))?.content).toBe('# a');
    await io.writeVaultFile('notes/b.md', '# b');
    expect(await io.listMarkdown()).toEqual(['notes/a.md', 'notes/b.md']);
  });
});

describe('resolveWriteTarget', () => {
  test('matches resolveVaultPath(write)/toKey/toVaultRelative in one pass', () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: ['Public/'], write: ['Public/'] },
      caseSensitive: false,
    });
    // non-canonical input exercises the single canonicalization pass
    const target = io.resolveWriteTarget('Public/./sub/../A.md');
    expect(target).toEqual({
      full: io.resolveVaultPath('Public/A.md', 'write'),
      key: io.toKey('Public/A.md'),
      relative: io.toVaultRelative('Public/A.md'),
    });
    // case-insensitive: key is folded, relative is case-preserving
    expect(target.key).toBe('public/a.md');
    expect(target.relative).toBe('Public/A.md');
  });

  test('enforces the write allowlist and .md guard like resolveVaultPath', () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: ['Public/'] },
    });
    expect(syncCode(() => io.resolveWriteTarget('Public/note.txt'))).toBe(
      'NOT_MARKDOWN',
    );
    expect(syncCode(() => io.resolveWriteTarget('Private/x.md'))).toBe(
      'ALLOWLIST_VIOLATION',
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

describe('listFolders', () => {
  test('recurses, includes empty folders, excludes the root, missing dir -> []', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    await writeFile(join(vault, 'a.md'), '# a');
    await mkdir(join(vault, 'notes'));
    await writeFile(join(vault, 'notes', 'b.md'), '# b');
    await mkdir(join(vault, 'archive', 'deep'), { recursive: true }); // no .md anywhere
    expect(await io.listFolders()).toEqual([
      'archive',
      'archive/deep',
      'notes',
    ]);
    expect(await io.listFolders('notes')).toEqual([]);
    expect(await io.listFolders('nope')).toEqual([]);
  });

  test('skips dotfolders, ignore globs, out-of-read-scope and symlinked dirs', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'vaultmd-out-'));
    const io = createVaultIo({
      root: vault,
      prefixes: { read: ['Public/'], write: [''] },
      ignore: ['Public/Drafts'],
    });
    await mkdir(join(vault, 'Public', 'Sub'), { recursive: true });
    await mkdir(join(vault, 'Public', 'Drafts', 'wip'), { recursive: true });
    await mkdir(join(vault, 'Private'));
    await mkdir(join(vault, '.obsidian'));
    await symlink(outside, join(vault, 'Public', 'evil'));
    expect(await io.listFolders()).toEqual(['Public', 'Public/Sub']);
    await rm(outside, { recursive: true, force: true });
  });

  test('omits unreadable ancestors of the read scope', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: ['Public/Notes'], write: [''] },
    });
    await mkdir(join(vault, 'Public', 'Notes', 'Sub'), { recursive: true });
    expect(await io.listFolders()).toEqual([
      'Public/Notes',
      'Public/Notes/Sub',
    ]);
  });
});

describe('enumeration skips symlinks', () => {
  test('in-vault links to a folder or a note are skipped: one file, one path', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    await mkdir(join(vault, 'real'));
    await writeFile(join(vault, 'real', 'a.md'), '# a');
    await symlink(join(vault, 'real'), join(vault, 'alias'));
    await symlink(join(vault, 'real', 'a.md'), join(vault, 'b.md'));
    expect(await io.listFolders()).toEqual(['real']);
    expect(await io.listMarkdown()).toEqual(['real/a.md']);
  });

  test('listing a folder that is a symlink finds nothing', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    await mkdir(join(vault, 'real', 'sub'), { recursive: true });
    await writeFile(join(vault, 'real', 'a.md'), '# a');
    await symlink(join(vault, 'real'), join(vault, 'alias'));
    expect(await io.listMarkdown('alias')).toEqual([]);
    expect(await io.listFolders('alias')).toEqual([]);
  });

  test('a hidden start folder is not walked at all', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    await mkdir(join(vault, '.git', 'objects', 'ab'), { recursive: true });
    const readdirSpy = spyOn(fsp, 'readdir');
    try {
      expect(await io.listMarkdown('.git')).toEqual([]);
      expect(await io.listFolders('.git')).toEqual([]);
      expect(readdirSpy).not.toHaveBeenCalled();
    } finally {
      readdirSpy.mockRestore();
    }
  });
});

describe('readBinary', () => {
  test('reads a non-markdown file as bytes; missing or a directory -> null', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    await mkdir(join(vault, 'assets'), { recursive: true });
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    await writeFile(join(vault, 'assets/logo.png'), png);
    expect(await io.readBinary('assets/logo.png')).toEqual(png);
    expect(await io.readBinary('assets/missing.png')).toBeNull();
    expect(await io.readBinary('assets')).toBeNull(); // a directory is not a file
  });

  test('readVaultFile still rejects the same non-markdown path', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    await writeFile(join(vault, 'logo.png'), 'x');
    expect(await asyncCode(() => io.readVaultFile('logo.png'))).toBe(
      'NOT_MARKDOWN',
    );
  });

  test('enforces the read allowlist, not the write one', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: ['Public'], write: [''] },
    });
    await mkdir(join(vault, 'Private'), { recursive: true });
    await writeFile(join(vault, 'Private/x.png'), 'x');
    expect(await asyncCode(() => io.readBinary('Private/x.png'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
  });

  test('rejects absolute paths and ..-escapes', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    expect(await asyncCode(() => io.readBinary('/etc/passwd'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
    expect(await asyncCode(() => io.readBinary('../outside.png'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
  });

  test('rejects a symlink that escapes the vault root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'vaultmd-out-'));
    await writeFile(join(outside, 'secret.png'), 'secret');
    await symlink(join(outside, 'secret.png'), join(vault, 'leak.png'));
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    expect(await asyncCode(() => io.readBinary('leak.png'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
    await rm(outside, { recursive: true, force: true });
  });

  test('rejects hidden state reached through an in-vault symlink', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    await mkdir(join(vault, 'assets'), { recursive: true });
    await mkdir(join(vault, '.obsidian'), { recursive: true });
    await writeFile(join(vault, '.env'), 'SECRET=1');
    await writeFile(join(vault, '.obsidian/w.json'), '{}');
    // Both links stay inside the root and have visible names: the guard
    // refuses them as links, before their hidden targets matter.
    await symlink(join(vault, '.env'), join(vault, 'assets/leak.png'));
    await symlink(join(vault, '.obsidian'), join(vault, 'assets/cfg'));
    expect(await asyncCode(() => io.readBinary('assets/leak.png'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
    expect(await asyncCode(() => io.readBinary('assets/cfg/w.json'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
  });

  test('a dangling symlink is refused like any other link', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    await symlink(join(vault, 'gone.png'), join(vault, 'dangling.png'));
    expect(await asyncCode(() => io.readBinary('dangling.png'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
  });

  test('an in-vault symlink to a visible file is refused', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    await mkdir(join(vault, 'assets'), { recursive: true });
    await writeFile(join(vault, 'assets/real.png'), 'png');
    await symlink(join(vault, 'assets/real.png'), join(vault, 'alias.png'));
    expect(await asyncCode(() => io.readBinary('alias.png'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
  });

  test('rejects dot-segment paths so hidden state stays out of reach', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    await mkdir(join(vault, '.obsidian'), { recursive: true });
    await writeFile(join(vault, '.obsidian/workspace.json'), '{}');
    await writeFile(join(vault, '.env'), 'SECRET=1');
    expect(
      await asyncCode(() => io.readBinary('.obsidian/workspace.json')),
    ).toBe('ALLOWLIST_VIOLATION');
    expect(await asyncCode(() => io.readBinary('.env'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
    expect(await asyncCode(() => io.readBinary('./assets/a.png'))).not.toBe(
      'ALLOWLIST_VIOLATION',
    );
  });
});

describe('hidden state on the markdown surfaces', () => {
  test('rejects a hidden .md named directly', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    await mkdir(join(vault, '.obsidian'), { recursive: true });
    await writeFile(join(vault, '.obsidian/secret.md'), '# hidden');
    expect(await asyncCode(() => io.readVaultFile('.obsidian/secret.md'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
    expect(await asyncCode(() => io.stat('.obsidian/secret.md'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
    expect(
      await asyncCode(() => io.writeVaultFile('.obsidian/pwned.md', 'x')),
    ).toBe('ALLOWLIST_VIOLATION');
    expect(syncCode(() => io.resolveWriteTarget('.trash/gone.md'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
  });

  test('rejects a hidden .md reached through an in-vault symlink', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    await mkdir(join(vault, '.obsidian'), { recursive: true });
    await writeFile(join(vault, '.obsidian/secret.md'), '# hidden');
    await symlink(join(vault, '.obsidian/secret.md'), join(vault, 'notes.md'));
    expect(await asyncCode(() => io.readVaultFile('notes.md'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
  });

  test('the .md name on a link is no ticket to a non-markdown target', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    await writeFile(join(vault, '.env'), 'SECRET=1');
    await symlink(join(vault, '.env'), join(vault, 'aliased-env.md'));
    expect(await asyncCode(() => io.readVaultFile('aliased-env.md'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
  });

  test('a write into a directory symlinked at hidden state is refused', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    await mkdir(join(vault, '.obsidian'), { recursive: true });
    await symlink(join(vault, '.obsidian'), join(vault, 'notes'));
    expect(
      await asyncCode(() => io.writeVaultFile('notes/pwned.md', 'x')),
    ).toBe('ALLOWLIST_VIOLATION');
  });

  test('an in-vault symlink to a visible note is refused', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    await mkdir(join(vault, 'notes'), { recursive: true });
    await writeFile(join(vault, 'notes/real.md'), '# real');
    await symlink(join(vault, 'notes/real.md'), join(vault, 'alias.md'));
    expect(await asyncCode(() => io.readVaultFile('alias.md'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
  });

  test('can() answers false for a hidden path, whatever the allowlist', () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    // Stale rows an older index built before the guard must not read as
    // in-scope: `query` filters on `can` alone.
    expect(io.can('.secret.md', 'read')).toBe(false);
    expect(io.can('.obsidian/cfg.md', 'read')).toBe(false);
    expect(io.can('.secret.md', 'write')).toBe(false);
    expect(io.can('notes/keep.md', 'read')).toBe(true);
  });

  test('listFolders skips a dot-folder aliased by an in-vault symlink', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    await mkdir(join(vault, '.obsidian/deep'), { recursive: true });
    await mkdir(join(vault, 'real'), { recursive: true });
    await symlink(join(vault, '.obsidian'), join(vault, 'notes'));
    expect(await io.listFolders()).toEqual(['real']);
  });

  test('enumeration skips a hidden .md at the vault root', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
    });
    await writeFile(join(vault, 'keep.md'), 'k');
    await writeFile(join(vault, '.secret.md'), 's');
    expect(await io.listMarkdown()).toEqual(['keep.md']);
  });
});
