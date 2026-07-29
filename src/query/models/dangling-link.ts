/**
 * A link that resolves to nothing — the vault-wide counterpart of an
 * {@link OutboundLink} whose `resolved` is `null`. Returned by
 * {@link QueryApi.danglingLinks}.
 */
export type DanglingLink = {
  /** Vault-relative path of the note containing the link. */
  from: string;
  /** Normalised link target as stored in the index (it matches no note). */
  target: string;
};
