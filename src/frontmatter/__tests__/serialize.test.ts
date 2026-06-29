import { describe, expect, test } from 'bun:test';

import { MdVaultError } from '@/errors.ts';

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
    const parsed = parseFrontmatter(serializeFrontmatter(fm));
    expect(parsed.valid).toBe('flat');
    expect(parsed.frontmatter).toEqual(fm);
  });

  test('round-trip preserves multi-line strings, including trailing blank lines', () => {
    for (const note of ['a\nb', 'text\n', 'text\n\n', 'a\nb\n\n\n']) {
      const fm: Record<string, unknown> = { title: 'T', note, count: 3 };
      const parsed = parseFrontmatter(serializeFrontmatter(fm));
      expect(parsed.frontmatter).toEqual(fm);
    }
  });

  test('round-trip preserves an empty array value', () => {
    const fm: Record<string, unknown> = { tags: [] };
    const parsed = parseFrontmatter(serializeFrontmatter(fm));
    expect(parsed.frontmatter).toEqual(fm);
  });

  test('an empty map serializes to an empty string (no block), like editFrontmatter', () => {
    expect(serializeFrontmatter({})).toBe('');
  });

  test('non-flat input throws FRONTMATTER_INVALID naming only the offending keys', () => {
    let err: MdVaultError | undefined;
    try {
      serializeFrontmatter({ title: 'ok', count: 3, nested: { x: 1 } });
    } catch (e) {
      err = e as MdVaultError;
    }
    expect(err).toBeInstanceOf(MdVaultError);
    expect(err?.code).toBe('FRONTMATTER_INVALID');
    expect(err?.message).toContain('nested');
    expect(err?.message).not.toContain('title');
    expect(err?.message).not.toContain('count');
  });

  test('Date values are rejected (they cannot round-trip)', () => {
    expect(() => serializeFrontmatter({ published: new Date() })).toThrow(
      MdVaultError,
    );
  });

  test('non-finite numbers (NaN / Infinity) are rejected', () => {
    expect(() => serializeFrontmatter({ score: Number.NaN })).toThrow(
      MdVaultError,
    );
    expect(() =>
      serializeFrontmatter({ score: Number.POSITIVE_INFINITY }),
    ).toThrow(MdVaultError);
  });

  test('flat array serializes as block sequence (no flow [a,b] style), no comments', () => {
    const serialized = serializeFrontmatter({ tags: ['alpha', 'beta'] });
    // Block sequence uses `- item` lines, NOT `[alpha, beta]`
    expect(serialized).toContain('- alpha');
    expect(serialized).toContain('- beta');
    expect(serialized).not.toMatch(/\[alpha/);
    // No YAML comments
    expect(serialized).not.toMatch(/#/);
  });

  test('output is wrapped in --- fences with trailing newline', () => {
    const result = serializeFrontmatter({ title: 'Test' });
    expect(result.startsWith('---\n')).toBe(true);
    expect(result).toContain('\n---\n');
    expect(result.endsWith('\n')).toBe(true);
  });

  test('block is byte-identical to the fresh block editFrontmatter writes, across inputs', () => {
    const inputs: Record<string, unknown>[] = [
      { title: 'Consistency', count: 7, active: false, tags: ['x', 'y'] },
      { only: 'one' },
      { note: 'a\nb\n\n', count: 3 },
    ];
    for (const fm of inputs) {
      // editFrontmatter on empty content with no prior frontmatter writes
      // `---\n<block>\n---\n` (body is the empty string), the fresh-block path.
      const { content: fromEdit } = editFrontmatter('', (view) => {
        for (const [k, v] of Object.entries(fm)) {
          view[k] = v;
        }
      });
      expect(serializeFrontmatter(fm)).toBe(fromEdit);
    }
  });
});
