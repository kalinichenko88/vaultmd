import type { Sig } from '@/fs-atomic/index.ts';

import type { Access } from './access.ts';

/**
 * The IO chokepoint for a vault: canonicalization, allowlist enforcement, and
 * atomic file operations, all scoped to the vault root and prefix allowlists.
 * Obtain an instance via {@link createVaultIo} or from {@link Vault.io}.
 */
export type VaultIo = {
  /**
   * Canonicalize a vault-relative path (normalize separators and `.`/`..`
   * segments) without applying case-folding.
   * @param rel Vault-relative path to canonicalize.
   * @returns The canonical vault-relative form of `rel`.
   */
  toVaultRelative(rel: string): string;
  /**
   * Derive the index look-up key for a vault-relative path. On
   * case-insensitive volumes this lower-cases the canonical path; on
   * case-sensitive volumes it is identical to {@link toVaultRelative}.
   * @param rel Vault-relative path to key.
   * @returns The case-folded (or canonical) key string.
   */
  toKey(rel: string): string;
  /**
   * Test whether `rel` falls within the given access allowlist.
   * @param rel Vault-relative path to test.
   * @param access `'read'` or `'write'` allowlist to check against.
   * @returns `true` if the path is permitted; `false` otherwise.
   */
  can(rel: string, access: Access): boolean;
  /**
   * Resolve a vault-relative path to its absolute filesystem path, enforcing
   * the allowlist and the `.md` extension requirement.
   * @param rel Vault-relative `.md` path.
   * @param access Allowlist tier to enforce (default `'read'`).
   * @returns The absolute filesystem path.
   * @throws {@link MdVaultError} `NOT_MARKDOWN` if `rel` is not a `.md` path.
   * @throws {@link MdVaultError} `ALLOWLIST_VIOLATION` if `rel` is outside the allowlist.
   */
  resolveVaultPath(rel: string, access?: Access): string;
  /**
   * Resolve everything a write-path mutator needs in a single canonicalization
   * pass: the absolute filesystem path (write-allowlist + symlink enforced),
   * the case-folded index/lock key, and the canonical vault-relative path.
   * Equivalent to calling {@link resolveVaultPath} (`'write'`), {@link toKey},
   * and {@link toVaultRelative} together, but canonicalizes `rel` only once.
   * @param rel Vault-relative `.md` path.
   * @returns `{ full, key, relative }` for the write target.
   * @throws {@link MdVaultError} `NOT_MARKDOWN` if `rel` is not a `.md` path.
   * @throws {@link MdVaultError} `ALLOWLIST_VIOLATION` if `rel` is outside the
   * write allowlist or escapes the root via a symlink.
   */
  resolveWriteTarget(rel: string): {
    /** Absolute filesystem path of the write target. */
    full: string;
    /** Case-folded index/lock key — see {@link toKey}. */
    key: string;
    /** Canonical vault-relative path — see {@link toVaultRelative}. */
    relative: string;
  };
  /**
   * Read a vault file consistently, returning its content and filesystem
   * signature for optimistic-concurrency checks.
   * @param rel Vault-relative `.md` path.
   * @returns `{ content, sig }` if the file exists, or `null` if absent.
   */
  readVaultFile(rel: string): Promise<{
    /** The UTF-8 file content. */
    content: string;
    /** The mtime+size signature used for conflict detection. */
    sig: Sig;
  } | null>;
  /**
   * Atomically write `content` to a vault file, creating it if necessary.
   * @param rel Vault-relative `.md` path.
   * @param content New UTF-8 content.
   * @returns The {@link Sig} of the written file.
   */
  writeVaultFile(rel: string, content: string): Promise<Sig>;
  /**
   * Atomically overwrite a file only if its current signature matches
   * `expected`. Throws {@link MdVaultError} `MTIME_CONFLICT` on mismatch.
   * @param rel Vault-relative `.md` path.
   * @param content New UTF-8 content.
   * @param expected Signature the file must currently have.
   * @returns The {@link Sig} of the written file.
   */
  rewriteIfUnchanged(rel: string, content: string, expected: Sig): Promise<Sig>;
  /**
   * Unlink a file only if its current signature matches `expected`.
   * @param rel Vault-relative `.md` path.
   * @param expected Signature the file must currently have.
   * @returns `true` if the file was deleted; `false` only if the file was
   * already absent.
   * @throws {@link MdVaultError} `MTIME_CONFLICT` if the file's current
   * signature differs from `expected` (concurrent modification detected).
   */
  unlinkIfUnchanged(rel: string, expected: Sig): Promise<boolean>;
  /**
   * Stat a vault file, returning its filesystem signature.
   * @param rel Vault-relative `.md` path.
   * @returns The {@link Sig} of the file, or `null` if absent.
   */
  stat(rel: string): Promise<Sig | null>;
  /**
   * Enumerate all `.md` files under `dir` (default: vault root) that pass
   * the read allowlist and are not matched by the `ignore` patterns.
   * @param dir Optional vault-relative subdirectory to constrain the listing.
   * @returns Sorted vault-relative paths of enumerated `.md` files.
   */
  listMarkdown(dir?: string): Promise<string[]>;
};
