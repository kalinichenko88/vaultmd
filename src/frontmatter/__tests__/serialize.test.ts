import { describe, expect, test } from 'bun:test';

import { MdVaultError } from '@/errors.ts';

import { editFrontmatter } from '../edit.ts';
import { parseFrontmatter } from '../parse.ts';
import { serializeFrontmatter } from '../serialize.ts';

describe('serializeFrontmatter', () => {
  test('round-trip: parseFrontmatter(serializeFrontmatter(fm)) yields valid and deep-equals fm', () => {
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

  test('long scalars stay on one line and round-trip (no 80-column folding)', () => {
    const url = `https://example.com/wiki/Long_Article_Title?section=${'a'.repeat(90)}&ref=vault`;
    const source =
      'Imported from the Q2 architecture review deck, slide 14, transcribed by the ingestion agent and reconciled against the meeting minutes.';
    const fm: Record<string, unknown> = { source, url, tags: ['ingested'] };
    const serialized = serializeFrontmatter(fm);

    expect(source.length).toBeGreaterThan(80);
    // The value sits on the same line as its key — the property the consumer
    // reads the file for. yaml's default lineWidth: 80 would wrap it onto
    // indented continuation lines instead.
    expect(serialized).toContain(`source: ${source}\n`);
    expect(serialized).toContain(`url: ${url}\n`);
    expect(parseFrontmatter(serialized).frontmatter).toEqual(fm);
  });

  test('a value containing a newline still spans lines — it has to carry them', () => {
    // The no-folding guarantee is about a COLUMN limit, not about newlines a
    // value actually contains. Documented as the one exception; asserted here
    // so nobody reads "stays on one line" as a promise this can keep.
    const note = `${'Line one of the summary, quite long indeed'}\nLine two continues here`;
    const serialized = serializeFrontmatter({ note });
    expect(serialized.split('\n').length).toBeGreaterThan(4);
    expect(parseFrontmatter(serialized).frontmatter).toEqual({ note });
  });

  test('round-trip preserves an empty array value', () => {
    const fm: Record<string, unknown> = { tags: [] };
    const parsed = parseFrontmatter(serializeFrontmatter(fm));
    expect(parsed.frontmatter).toEqual(fm);
  });

  test('an empty map serializes to an empty string (no block), like editFrontmatter', () => {
    expect(serializeFrontmatter({})).toBe('');
  });

  test('non-round-trippable input throws FRONTMATTER_INVALID naming only the offending keys', () => {
    let err: MdVaultError | undefined;
    try {
      serializeFrontmatter({ title: 'ok', count: 3, bad: new Date() });
    } catch (e) {
      err = e as MdVaultError;
    }
    expect(err).toBeInstanceOf(MdVaultError);
    expect(err?.code).toBe('FRONTMATTER_INVALID');
    expect(err?.message).toContain('bad');
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

// Everything this package WRITES is flat, even though a nested block read off
// disk is indexed and returned. Emitting nesting would mean owning a shape
// `editFrontmatter` cannot then rewrite a key at a time.
describe('serializeFrontmatter — the write gate is flat', () => {
  test('a nested map throws FRONTMATTER_INVALID naming the key', () => {
    let caught: unknown;
    try {
      serializeFrontmatter({ title: 'x', meta: { status: 'open' } });
    } catch (err) {
      caught = err;
    }

    expect((caught as MdVaultError).code).toBe('FRONTMATTER_INVALID');
    expect((caught as MdVaultError).message).toContain('meta');
  });

  test('an array of maps throws FRONTMATTER_INVALID', () => {
    expect(() => serializeFrontmatter({ items: [{ name: 'a' }] })).toThrow(
      expect.objectContaining({ code: 'FRONTMATTER_INVALID' }),
    );
  });

  // One array bound to two keys is ordinary JS and stays flat, but yaml's
  // default emits it as an &a1/*a1 anchor pair — producing a note whose next
  // edit orphans the alias. Written out twice instead.
  test('a shared array reference is written out twice, not anchored', () => {
    const shared = [1, 2];
    const block = serializeFrontmatter({ tags: shared, aliases: shared });

    expect(block).not.toContain('&');
    expect(block).not.toContain('*');
    expect(parseFrontmatter(`${block}body\n`).frontmatter).toEqual({
      tags: [1, 2],
      aliases: [1, 2],
    });
  });
});
