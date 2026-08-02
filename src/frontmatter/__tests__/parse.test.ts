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

  test('a map anchor reused across keys is present-but-invalid', () => {
    const parsed = parseFrontmatter('---\nx: &a\n  k: 1\ny: *a\n---\nbody\n');

    expect(parsed.valid).toBe('present-but-invalid');
    expect(parsed.frontmatter).toEqual({});
  });

  // Flat today, and editFrontmatter throws a raw Error on it. Now refused.
  test('a sequence anchor reused across keys is present-but-invalid', () => {
    const parsed = parseFrontmatter('---\nx: &a [1, 2]\ny: *a\n---\nbody\n');

    expect(parsed.valid).toBe('present-but-invalid');
    expect(parsed.frontmatter).toEqual({});
  });

  test('a scalar anchor reused across keys stays valid', () => {
    const parsed = parseFrontmatter('---\nx: &a hi\ny: *a\n---\nbody\n');

    expect(parsed.valid).toBe('valid');
    expect(parsed.frontmatter).toEqual({ x: 'hi', y: 'hi' });
  });

  // One unusable value costs the reader that key, not the whole block. The
  // note stays findable by its tags and keeps its title.
  test('an invalid value costs its own key and no others', () => {
    const parsed = parseFrontmatter(
      '---\na: .nan\ntags: [x]\ntitle: kept\n---\nbody\n',
    );

    expect(parsed.valid).toBe('present-but-invalid');
    expect(parsed.frontmatter).toEqual({ tags: ['x'], title: 'kept' });
    expect(parsed.tags).toEqual(['x']);
  });

  // The filter is what keeps a cyclic value away from projectRow's
  // JSON.stringify, so it has to actually drop the offending key.
  test('a cyclic key is dropped while its siblings survive', () => {
    const parsed = parseFrontmatter(
      '---\na: &x\n  b: *x\ntitle: kept\n---\nbody\n',
    );

    expect(parsed.valid).toBe('present-but-invalid');
    expect(parsed.frontmatter).toEqual({ title: 'kept' });
    expect(() => JSON.stringify(parsed.frontmatter)).not.toThrow();
  });
});
