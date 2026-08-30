/**
 * Allowlist prefixes that scope the read and write surfaces of a {@link VaultIo}.
 * An empty string `''` in either list grants access to the entire vault root.
 *
 * A prefix may not contain `..`, and may not be hidden (any segment starting
 * with a dot) — hidden state is unreachable through the chokepoint, so such a
 * prefix could never be satisfied. Either throws `ALLOWLIST_VIOLATION` from
 * {@link createVaultIo}.
 */
export type VaultPrefixes = {
  /** Vault-relative path prefixes that are permitted for read operations. */
  read: string[];
  /** Vault-relative path prefixes that are permitted for write operations. */
  write: string[];
};
