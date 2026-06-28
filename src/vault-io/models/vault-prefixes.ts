/**
 * Allowlist prefixes that scope the read and write surfaces of a {@link VaultIo}.
 * An empty string `''` in either list grants access to the entire vault root.
 */
export type VaultPrefixes = {
  /** Vault-relative path prefixes that are permitted for read operations. */
  read: string[];
  /** Vault-relative path prefixes that are permitted for write operations. */
  write: string[];
};
