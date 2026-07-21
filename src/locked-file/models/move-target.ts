/**
 * One end of a {@link withFileMove} — pass `VaultIo.resolveWriteTarget(rel)`
 * verbatim, which returns exactly this shape.
 */
export type MoveTarget = {
  /** Absolute filesystem path of the target file. */
  full: string;
  /** Canonical/case-folded serialization key — `VaultIo.toKey(rel)`. */
  key: string;
  /** Display path written to `CommitEvent.path` — `VaultIo.toVaultRelative(rel)`. */
  relative: string;
};
