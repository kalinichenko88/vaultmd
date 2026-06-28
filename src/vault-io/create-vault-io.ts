import { join, resolve as resolvePath } from 'node:path';

import { MdVaultError } from '@/errors.ts';
import {
  atomicWrite,
  atomicWriteIfUnchanged,
  unlinkIfUnchanged as fsUnlinkIfUnchanged,
  readConsistent,
  type Sig,
  statSig,
} from '@/fs-atomic/index.ts';

import { matches } from './allowlist.ts';
import { resolveCaseSensitive } from './case-sensitivity.ts';
import { listMarkdown as enumerateMarkdown } from './enumerate.ts';
import { globToRegExp } from './glob.ts';
import type { Access } from './models/access.ts';
import type { VaultIo } from './models/vault-io.ts';
import type { VaultIoConfig } from './models/vault-io-config.ts';
import type { VaultPrefixes } from './models/vault-prefixes.ts';
import { canonicalizeRelative, canonPrefix } from './paths.ts';
import { realTargetWithinRoot } from './realpath-guard.ts';

/**
 * Create a {@link VaultIo} instance scoped to `config.root` and the supplied
 * prefix allowlists. The returned handle is the single IO chokepoint for all
 * file reads, writes, and enumerations; it enforces path canonicalization,
 * allowlist membership, symlink guards, and case-sensitivity probing.
 *
 * @param config IO configuration — at minimum `root` and `prefixes`.
 * @returns A ready-to-use {@link VaultIo} handle.
 *
 * @example
 * ```ts
 * const io = createVaultIo({
 *   root: '/notes',
 *   prefixes: { read: [''], write: ['drafts'] },
 * });
 * const file = await io.readVaultFile('drafts/idea.md');
 * ```
 */
export function createVaultIo(config: VaultIoConfig): VaultIo {
  const root = resolvePath(config.root);
  const caseSensitive = resolveCaseSensitive(root, config.caseSensitive);
  const canonPrefixes: VaultPrefixes = {
    read: config.prefixes.read.map(canonPrefix),
    write: config.prefixes.write.map(canonPrefix),
  };
  const ignoreRes = (config.ignore ?? []).map(globToRegExp);

  function toVaultRelative(rel: string): string {
    return canonicalizeRelative(rel);
  }

  function toKey(rel: string): string {
    const canonical = canonicalizeRelative(rel);

    return caseSensitive ? canonical : canonical.toLowerCase();
  }

  function can(rel: string, access: Access): boolean {
    let x: string;
    try {
      x = canonicalizeRelative(rel);
    } catch {
      return false;
    }

    return matches(x, canonPrefixes[access]);
  }

  function resolveVaultPath(rel: string, access: Access = 'read'): string {
    const canonical = canonicalizeRelative(rel);
    if (!canonical.endsWith('.md')) {
      throw new MdVaultError('NOT_MARKDOWN', `not a markdown path: ${rel}`);
    }
    if (!matches(canonical, canonPrefixes[access])) {
      throw new MdVaultError(
        'ALLOWLIST_VIOLATION',
        `path outside ${access} allowlist: ${rel}`,
      );
    }
    const full = join(root, canonical);
    if (!realTargetWithinRoot(full, root)) {
      throw new MdVaultError(
        'ALLOWLIST_VIOLATION',
        `vault path escapes root (symlink): ${rel}`,
      );
    }

    return full;
  }

  async function readVaultFile(
    rel: string,
  ): Promise<{ content: string; sig: Sig } | null> {
    const full = resolveVaultPath(rel, 'read');
    const result = await readConsistent(full);
    if (result.content === null) {
      return null;
    }

    return { content: result.content, sig: result.sig };
  }

  async function writeVaultFile(rel: string, content: string): Promise<Sig> {
    return atomicWrite(resolveVaultPath(rel, 'write'), content);
  }

  async function rewriteIfUnchanged(
    rel: string,
    content: string,
    expected: Sig,
  ): Promise<Sig> {
    return atomicWriteIfUnchanged(
      resolveVaultPath(rel, 'write'),
      content,
      expected,
    );
  }

  async function unlinkIfUnchanged(
    rel: string,
    expected: Sig,
  ): Promise<boolean> {
    return fsUnlinkIfUnchanged(resolveVaultPath(rel, 'write'), expected);
  }

  async function stat(rel: string): Promise<Sig | null> {
    return statSig(resolveVaultPath(rel, 'read'));
  }

  function isIgnored(rel: string): boolean {
    return ignoreRes.some((re) => re.test(rel));
  }

  function listMarkdown(dir?: string): Promise<string[]> {
    return enumerateMarkdown(root, dir, {
      isIgnored,
      resolveVaultPath,
      toVaultRelative,
    });
  }

  return {
    toVaultRelative,
    toKey,
    can,
    resolveVaultPath,
    readVaultFile,
    writeVaultFile,
    rewriteIfUnchanged,
    unlinkIfUnchanged,
    stat,
    listMarkdown,
  };
}
