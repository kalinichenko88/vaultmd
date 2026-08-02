import { describe, expect, test } from 'bun:test';

import { parseFrontmatter } from '../parse.ts';

describe('parseFrontmatter', () => {
  test('valid frontmatter -> parsed map + tags + body split', () => {
    const content = `---
title: Hello
tags: [a, b]
---

# Heading
text`;
    const r = parseFrontmatter(content);
    expect(r.valid).toBe('flat');
    expect(r.frontmatter.title).toBe('Hello');
    expect(r.tags).toEqual(['a', 'b']);
    expect(r.body).toBe('\n# Heading\ntext');
  });

  test('absent frontmatter -> valid "none", body is full content', () => {
    const content = '# Just a heading\n\nbody';
    const r = parseFrontmatter(content);
    expect(r.valid).toBe('none');
    expect(r.frontmatter).toEqual({});
    expect(r.tags).toEqual([]);
    expect(r.body).toBe(content);
  });

  test('empty frontmatter block -> valid empty', () => {
    const r = parseFrontmatter('---\n---\nbody');
    expect(r.valid).toBe('flat');
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe('body');
  });

  test('duplicate keys never throw (uniqueKeys:false)', () => {
    const content = '---\ntitle: A\ntitle: B\n---\nbody';
    expect(() => parseFrontmatter(content)).not.toThrow();
    const r = parseFrontmatter(content);
    expect(r.valid).toBe('flat');
    expect(r.body).toBe('body');
    expect(r.frontmatter.title).toBeDefined();
  });

  test('malformed YAML -> present-but-invalid, still splits body, never throws', () => {
    const content = '---\nfoo: [unclosed\n---\nbody';
    expect(() => parseFrontmatter(content)).not.toThrow();
    const r = parseFrontmatter(content);
    expect(r.valid).toBe('present-but-invalid');
    expect(r.body).toBe('body');
  });

  test('nested map frontmatter -> valid', () => {
    const content = '---\ntitle: x\nmeta:\n  a: 1\n---\nbody';
    const r = parseFrontmatter(content);
    expect(r.valid).toBe('nested');
    expect(r.frontmatter.meta).toEqual({ a: 1 });
  });
});

// A nested block is READ — its keys come back and are indexed — and marked
// 'nested' so a caller knows editFrontmatter will refuse it. Only a block that
// cannot be stored at all comes back empty.
describe('parseFrontmatter — nested is read, unstorable is not', () => {
  test('a nested map yields its keys, marked nested', () => {
    const parsed = parseFrontmatter('---\nmeta:\n  x: 1\ntags: [t]\n---\nb\n');

    expect(parsed.valid).toBe('nested');
    expect(parsed.frontmatter).toEqual({ meta: { x: 1 }, tags: ['t'] });
    expect(parsed.tags).toEqual(['t']);
  });

  test('an array of maps yields its keys, marked nested', () => {
    const parsed = parseFrontmatter('---\nitems:\n  - name: a\n---\nb\n');

    expect(parsed.valid).toBe('nested');
    expect(parsed.frontmatter).toEqual({ items: [{ name: 'a' }] });
  });

  // An anchored container is readable — JSON.stringify duplicates it — so it
  // is indexed like any other nested block. Only editing it is refused.
  test('a map anchor reused across keys is readable', () => {
    const parsed = parseFrontmatter('---\nx: &a\n  k: 1\ny: *a\n---\nb\n');

    expect(parsed.valid).toBe('nested');
    expect(parsed.frontmatter).toEqual({ x: { k: 1 }, y: { k: 1 } });
  });

  test('an anchored array of scalars is flat, and readable', () => {
    const parsed = parseFrontmatter('---\nx: &a [1, 2]\ny: *a\n---\nb\n');

    expect(parsed.valid).toBe('flat');
    expect(parsed.frontmatter).toEqual({ x: [1, 2], y: [1, 2] });
  });

  test('a scalar anchor reused across keys is flat', () => {
    const parsed = parseFrontmatter('---\nx: &a hi\ny: *a\n---\nb\n');

    expect(parsed.valid).toBe('flat');
    expect(parsed.frontmatter).toEqual({ x: 'hi', y: 'hi' });
  });

  // The unstorable cases: each would reach projectRow's JSON.stringify and
  // throw a raw TypeError out of indexNote, aborting the reconcile sweep.
  test('a YAML cycle is present-but-invalid with an empty map', () => {
    const parsed = parseFrontmatter('---\na: &x\n  b: *x\n---\nbody\n');

    expect(parsed.valid).toBe('present-but-invalid');
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.tags).toEqual([]);
    expect(parsed.body).toBe('body\n');
  });

  test('a non-finite number makes the block unstorable', () => {
    const parsed = parseFrontmatter(
      '---\na: .nan\ntags: [x]\ntitle: kept\n---\nbody\n',
    );

    expect(parsed.valid).toBe('present-but-invalid');
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.tags).toEqual([]);
  });

  test('nesting past the depth bound makes the block unstorable', () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      lines.push(`${'  '.repeat(i)}n:`);
    }
    lines.push(`${'  '.repeat(200)}leaf: 1`);
    const parsed = parseFrontmatter(`---\n${lines.join('\n')}\n---\nbody\n`);

    expect(parsed.valid).toBe('present-but-invalid');
    expect(parsed.frontmatter).toEqual({});
  });
});
