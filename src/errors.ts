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

export class MdVaultError extends Error {
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
