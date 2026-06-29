import { Document } from 'yaml';

import { MdVaultError } from '@/errors.ts';

import { isFlatFrontmatter } from './validate.ts';

/**
 * Serialize a flat frontmatter map to a fenced YAML block ready to prepend to
 * a markdown note. The output is byte-identical to the frontmatter block that
 * {@link editFrontmatter} / `createNote` emit for the same input.
 *
 * @param frontmatter Flat key-value map (scalars and arrays of scalars only).
 * @returns A string of the form `---\n<yaml>\n---\n`.
 * @throws {@link MdVaultError} with code `FRONTMATTER_INVALID` when the input
 *   contains nested objects or arrays of non-scalars.
 *
 * @example
 * ```ts
 * const header = serializeFrontmatter({ title: 'Hello', tags: ['a', 'b'] });
 * // "---\ntitle: Hello\ntags:\n  - a\n  - b\n---\n"
 * ```
 */
export function serializeFrontmatter(
  frontmatter: Record<string, unknown>,
): string {
  if (!isFlatFrontmatter(frontmatter)) {
    throw new MdVaultError(
      'FRONTMATTER_INVALID',
      `frontmatter is not flat: ${Object.keys(frontmatter).join(', ')}`,
    );
  }

  const block = String(new Document(frontmatter)).replace(/\n$/, '');

  return `---\n${block}\n---\n`;
}
