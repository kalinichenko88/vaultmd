import { join, resolve as resolvePath } from 'node:path';

import { MdVaultError } from '../errors.ts';
import {
  type Sig,
  atomicWrite,
  atomicWriteIfUnchanged,
  unlinkIfUnchanged as fsUnlinkIfUnchanged,
  readConsistent,
  statSig,
} from '../fs-atomic/index.ts';
import { matches } from './allowlist.ts';
import { resolveCaseSensitive } from './case-sensitivity.ts';
import { listMarkdown as enumerateMarkdown } from './enumerate.ts';
import { globToRegExp } from './glob.ts';
import { canonPrefix, canonicalizeRelative } from './paths.ts';
import { realTargetWithinRoot } from './realpath-guard.ts';

export type Access = 'read' | 'write';
export type VaultPrefixes = { read: string[]; write: string[] };
export type VaultIoConfig = {
  root: string;
  prefixes: VaultPrefixes;
  caseSensitive?: boolean;
  ignore?: string[];
};
export type VaultIo = {
  toVaultRelative(rel: string): string;
  toKey(rel: string): string;
  can(rel: string, access: Access): boolean;
  resolveVaultPath(rel: string, access?: Access): string;
  readVaultFile(rel: string): Promise<{ content: string; sig: Sig } | null>;
  writeVaultFile(rel: string, content: string): Promise<Sig>;
  rewriteIfUnchanged(rel: string, content: string, expected: Sig): Promise<Sig>;
  unlinkIfUnchanged(rel: string, expected: Sig): Promise<boolean>;
  stat(rel: string): Promise<Sig | null>;
  listMarkdown(dir?: string): Promise<string[]>;
};

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
