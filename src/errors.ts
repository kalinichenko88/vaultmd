/**
 * Union of all stable error codes thrown by {@link MdVaultError}. Use this
 * type for exhaustive switch/case handling of vault errors without coupling to
 * message strings.
 */
export type MdVaultCode =
  | 'ALLOWLIST_VIOLATION'
  | 'NOT_MARKDOWN'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'NO_MATCH'
  | 'AMBIGUOUS_MATCH'
  | 'MTIME_CONFLICT'
  | 'REFUSE_CREATE'
  | 'FRONTMATTER_INVALID'
  | 'VALIDATION_ERROR'
  | 'COMMIT_FAILED'
  | 'INDEX_UNAVAILABLE';

/**
 * Structured error thrown by all vaultmd operations. Carries a
 * {@link MdVaultCode} so callers can branch on the failure kind without
 * parsing the human-readable message.
 *
 * @example
 * ```ts
 * try {
 *   await vault.notes.readNote('missing.md');
 * } catch (e) {
 *   if (e instanceof MdVaultError && e.code === 'NOT_FOUND') {
 *     // handle missing file
 *   }
 * }
 * ```
 */
export class MdVaultError extends Error {
  /** The stable error code identifying the failure kind. */
  readonly code: MdVaultCode;

  constructor(
    code: MdVaultCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.code = code;
    this.name = 'MdVaultError';
  }
}
