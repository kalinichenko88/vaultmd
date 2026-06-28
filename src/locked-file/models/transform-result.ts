/** The result returned by {@link withFileTransform}. */
export type TransformResult = {
  /**
   * The file content after the operation: the new content when `outcome` is
   * `'created'` or `'updated'`, the original content when `'unchanged'`, or
   * `null` when the file was absent and no creation was requested.
   */
  content: string | null;
  /** Whether the transform created a new file, updated an existing one, or made no change. */
  outcome: 'created' | 'updated' | 'unchanged';
};
