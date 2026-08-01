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
    expect(r.valid).toBe('valid');
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
    expect(r.valid).toBe('valid');
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe('body');
  });

  test('duplicate keys never throw (uniqueKeys:false)', () => {
    const content = '---\ntitle: A\ntitle: B\n---\nbody';
    expect(() => parseFrontmatter(content)).not.toThrow();
    const r = parseFrontmatter(content);
    expect(r.valid).toBe('valid');
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
    expect(r.valid).toBe('valid');
    expect(r.frontmatter.meta).toEqual({ a: 1 });
  });
});

describe('parseFrontmatter — invalid blocks return nothing', () => {
  test('a nested map is now valid and its keys survive', () => {
    const parsed = parseFrontmatter('---\nmeta:\n  x: 1\n---\nbody\n');

    expect(parsed.valid).toBe('valid');
    expect(parsed.frontmatter).toEqual({ meta: { x: 1 } });
  });

  test('a YAML cycle is present-but-invalid with an empty map', () => {
    const parsed = parseFrontmatter('---\na: &x\n  b: *x\n---\nbody\n');

    expect(parsed.valid).toBe('present-but-invalid');
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.tags).toEqual([]);
    expect(parsed.body).toBe('body\n');
  });

  // An anchored container reads back fine and belongs in the index — it is
  // only *editing* such a note that cannot work, which editFrontmatter reports
  // for itself rather than hiding the note's data from every reader.
  test('a map anchor reused across keys parses and keeps its values', () => {
    const parsed = parseFrontmatter('---\nx: &a\n  k: 1\ny: *a\n---\nbody\n');

    expect(parsed.valid).toBe('valid');
    expect(parsed.frontmatter).toEqual({ x: { k: 1 }, y: { k: 1 } });
  });

  test('a sequence anchor reused across keys parses and keeps its tags', () => {
    const parsed = parseFrontmatter(
      '---\ntags: &a [x, y]\naliases: *a\n---\nbody\n',
    );

    expect(parsed.valid).toBe('valid');
    expect(parsed.tags).toEqual(['x', 'y']);
  });

  test('a scalar anchor reused across keys stays valid', () => {
    const parsed = parseFrontmatter('---\nx: &a hi\ny: *a\n---\nbody\n');

    expect(parsed.valid).toBe('valid');
    expect(parsed.frontmatter).toEqual({ x: 'hi', y: 'hi' });
  });

  test('an invalid value drops the tags that shared the block', () => {
    const parsed = parseFrontmatter(
      '---\na: .nan\ntags: [x]\ntitle: kept\n---\nbody\n',
    );

    expect(parsed.valid).toBe('present-but-invalid');
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.tags).toEqual([]);
  });
});
