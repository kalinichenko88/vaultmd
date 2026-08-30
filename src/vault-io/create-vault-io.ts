import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve as resolvePath } from 'node:path';

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
import {
  listFolders as enumerateFolders,
  listMarkdown as enumerateMarkdown,
} from './enumerate.ts';
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

  function keyFromCanonical(canonical: string): string {
    return caseSensitive ? canonical : canonical.toLowerCase();
  }

  // Run the .md/allowlist/symlink guards on an ALREADY-canonical path and return
  // the absolute fs path. `rel` is only used for error messages. The single
  // security gate shared by resolveVaultPath, resolveWriteTarget and readBinary
  // — only the last opts out of the extension check, never out of the rest.
  function resolveCanonical(
    canonical: string,
    access: Access,
    rel: string,
    requireMarkdown = true,
  ): string {
    if (requireMarkdown && !canonical.endsWith('.md')) {
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

  function toVaultRelative(rel: string): string {
    return canonicalizeRelative(rel);
  }

  function toKey(rel: string): string {
    return keyFromCanonical(canonicalizeRelative(rel));
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
    return resolveCanonical(canonicalizeRelative(rel), access, rel);
  }

  function resolveWriteTarget(rel: string): {
    full: string;
    key: string;
    relative: string;
  } {
    const canonical = canonicalizeRelative(rel);

    return {
      full: resolveCanonical(canonical, 'write', rel),
      key: keyFromCanonical(canonical),
      relative: canonical,
    };
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

  async function readBinary(rel: string): Promise<Uint8Array | null> {
    // Lifting the .md requirement widens what the read allowlist reaches, so
    // hidden state stays out: `.git`, `.env`, `.obsidian`, and the index's own
    // `.db` sidecars — the same dot-segments the enumeration walk skips.
    const canonical = canonicalizeRelative(rel);
    refuseHidden(canonical, rel);
    const full = resolveCanonical(canonical, 'read', rel, false);
    // The requested path is not the whole story: a symlink that never leaves
    // the vault — so the containment guard passes it — can still aim at hidden
    // state (`assets/logo.png` -> `.env`). Only the resolved target shows it.
    // realpathSync doubles as the existence check; it throws for a missing file
    // and for a dangling link, both of which read as absent.
    try {
      refuseHidden(relative(realpathSync(root), realpathSync(full)), rel);
    } catch (err) {
      if (err instanceof MdVaultError) {
        throw err;
      }

      return null;
    }
    try {
      const buf = await readFile(full);

      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Unlinked under us, or a directory: absent as far as a byte read goes.
      if (code === 'ENOENT' || code === 'EISDIR') {
        return null;
      }

      throw err;
    }
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

  const enumerateDeps = { can, isIgnored, resolveVaultPath, toVaultRelative };

  function listMarkdown(dir?: string): Promise<string[]> {
    return enumerateMarkdown(root, dir, enumerateDeps);
  }

  function listFolders(dir?: string): Promise<string[]> {
    return enumerateFolders(root, dir, enumerateDeps);
  }

  return {
    toVaultRelative,
    toKey,
    can,
    resolveVaultPath,
    resolveWriteTarget,
    readVaultFile,
    readBinary,
    writeVaultFile,
    rewriteIfUnchanged,
    unlinkIfUnchanged,
    stat,
    listMarkdown,
    listFolders,
  };
}

// A path is hidden if any segment starts with a dot — the rule the enumeration
// walk applies to folders, here applied to whole paths on both sides of a
// symlink. Splits on either separator so a `relative()` result works untouched.
function refuseHidden(path: string, rel: string): void {
  if (path.split(/[/\\]/).some((seg) => seg.startsWith('.'))) {
    throw new MdVaultError(
      'ALLOWLIST_VIOLATION',
      `vault path is hidden: ${rel}`,
    );
  }
}
