import { describe, expect, test } from 'bun:test';

import { editFrontmatter } from '../edit.ts';
import { parseFrontmatter } from '../parse.ts';
import { serializeFrontmatter } from '../serialize.ts';

describe('serializeFrontmatter', () => {
  test('round-trip: parseFrontmatter(serializeFrontmatter(fm)) yields flat and deep-equals fm', () => {
    const fm: Record<string, unknown> = {
      title: 'Hello',
      count: 42,
      active: true,
      meta: null,
      tags: ['a', 'b', 'c'],
    };
    const serialized = serializeFrontmatter(fm);
    const parsed = parseFrontmatter(serialized);
    expect(parsed.valid).toBe('flat');
    expect(parsed.frontmatter).toEqual(fm);
  });

  test('non-flat input throws MdVaultError with code FRONTMATTER_INVALID', () => {
    const { MdVaultError } = require('../../errors.ts');
    expect(() => serializeFrontmatter({ a: { b: 1 } })).toThrow(MdVaultError);
    try {
      serializeFrontmatter({ a: { b: 1 } });
    } catch (e: unknown) {
      expect((e as InstanceType<typeof MdVaultError>).code).toBe(
        'FRONTMATTER_INVALID',
      );
    }
  });

  test('consistency: frontmatter block is byte-identical to what editFrontmatter produces', () => {
    const fm: Record<string, unknown> = {
      title: 'Consistency',
      count: 7,
      active: false,
      tags: ['x', 'y'],
    };

    // editFrontmatter on an empty string with no prior frontmatter creates
    // `---\n<block>\n---\n<original-content>`. Extract the header portion.
    const { content: fromEdit } = editFrontmatter('', (view) => {
      for (const [k, v] of Object.entries(fm)) {
        view[k] = v;
      }
    });
    // The result is `---\n<block>\n---\n` (body is empty string, so trailing newline only)
    const headerFromEdit = `${fromEdit.replace(/\n$/, '')}\n`; // normalise trailing newline

    const fromSerialize = serializeFrontmatter(fm);

    expect(fromSerialize).toBe(headerFromEdit);
  });

  test('flat array serializes as block sequence (no flow [a,b] style), no comments', () => {
    const fm: Record<string, unknown> = { tags: ['alpha', 'beta'] };
    const serialized = serializeFrontmatter(fm);
    // Block sequence uses `- item` lines, NOT `[alpha, beta]`
    expect(serialized).toContain('- alpha');
    expect(serialized).toContain('- beta');
    expect(serialized).not.toMatch(/\[alpha/);
    // No YAML comments
    expect(serialized).not.toMatch(/#/);
  });

  test('output is wrapped in --- fences with trailing newline', () => {
    const fm: Record<string, unknown> = { title: 'Test' };
    const result = serializeFrontmatter(fm);
    expect(result.startsWith('---\n')).toBe(true);
    expect(result).toContain('\n---\n');
    expect(result.endsWith('\n')).toBe(true);
  });
});
