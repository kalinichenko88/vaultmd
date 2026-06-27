import { describe, expect, test } from 'bun:test';

import {
  deriveTags,
  editFrontmatter,
  isFlatFrontmatter,
  parseFrontmatter,
} from '../frontmatter.ts';

describe('deriveTags', () => {
  test('scalar string -> single tag', () => {
    expect(deriveTags({ tags: 'foo' })).toEqual(['foo']);
  });

  test('comma-separated string -> list', () => {
    expect(deriveTags({ tags: 'a, b, c' })).toEqual(['a', 'b', 'c']);
  });

  test('space-separated string -> list', () => {
    expect(deriveTags({ tags: 'a b c' })).toEqual(['a', 'b', 'c']);
  });

  test('yaml list -> list', () => {
    expect(deriveTags({ tags: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  test('strips leading # and dedups, case-preserving', () => {
    expect(deriveTags({ tags: ['#Foo', '#foo', 'Bar', 'Bar'] })).toEqual([
      'Foo',
      'foo',
      'Bar',
    ]);
  });

  test('falls back to singular "tag" key', () => {
    expect(deriveTags({ tag: 'solo' })).toEqual(['solo']);
  });

  test('absent / empty -> []', () => {
    expect(deriveTags({})).toEqual([]);
    expect(deriveTags({ tags: '' })).toEqual([]);
  });
});

describe('parseFrontmatter', () => {
  test('flat frontmatter -> parsed map + tags + body split', () => {
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

  test('empty frontmatter block -> flat empty', () => {
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

  test('nested map frontmatter -> present-but-invalid (parsed but not flat)', () => {
    const content = '---\ntitle: x\nmeta:\n  a: 1\n---\nbody';
    const r = parseFrontmatter(content);
    expect(r.valid).toBe('present-but-invalid');
    expect(r.frontmatter.meta).toEqual({ a: 1 });
  });
});

describe('editFrontmatter', () => {
  test('multi-field mutate preserves comments, order, 1.0, empty aliases', () => {
    const content = `---
# top comment
title: Old
order: [b, a]
weight: 1.0
aliases:
---
body text
`;
    const r = editFrontmatter(content, (fm) => {
      fm.title = 'New';
      fm.status = 'done';
    });
    expect(r.outcome).toBe('edited');
    expect(r.content).toContain('# top comment');
    expect(r.content).toContain('title: New');
    expect(r.content).toContain('weight: 1.0'); // numeric literal not collapsed to 1
    expect(r.content).not.toContain('weight: 1\n');
    expect(r.content).toMatch(/^aliases:[ \t]*$/m); // empty value preserved
    const idx = (s: string) => r.content.indexOf(s);
    expect(idx('title')).toBeLessThan(idx('order'));
    expect(idx('order')).toBeLessThan(idx('weight'));
    expect(idx('weight')).toBeLessThan(idx('aliases'));
    expect(idx('status')).toBeGreaterThan(idx('aliases')); // new key appended last
    expect(r.content.endsWith('body text\n')).toBe(true); // body preserved
  });

  test('deleting a key removes it, outcome edited', () => {
    const content = '---\nkeep: 1\ndrop: 2\n---\nb';
    const r = editFrontmatter(content, (fm) => {
      // biome-ignore lint/performance/noDelete: test intent is key removal
      delete fm.drop;
    });
    expect(r.outcome).toBe('edited');
    expect(r.content).toContain('keep: 1');
    expect(r.content).not.toContain('drop:');
    expect(r.content.endsWith('---\nb')).toBe(true);
  });

  test('absent frontmatter -> creates a new block at the top', () => {
    const content = '# Title\n\nSome body.\n';
    const r = editFrontmatter(content, (fm) => {
      fm.title = 'Created';
    });
    expect(r.outcome).toBe('edited');
    expect(r.content.startsWith('---\ntitle: Created\n---\n')).toBe(true);
    expect(r.content.endsWith(content)).toBe(true);
  });

  test('no-op mutate -> unchanged, content untouched', () => {
    const content = '---\ntitle: x\n---\nbody';
    const r = editFrontmatter(content, () => {});
    expect(r.outcome).toBe('unchanged');
    expect(r.content).toBe(content);
  });

  test('present-but-invalid -> unverifiable, no write', () => {
    const content = '---\nfoo: [unclosed\n---\nbody';
    const r = editFrontmatter(content, (fm) => {
      fm.title = 'x';
    });
    expect(r.outcome).toBe('unverifiable');
    expect(r.content).toBe(content);
  });

  test('mutate introducing a nested map -> unverifiable, no write', () => {
    const content = '---\ntitle: x\n---\nbody';
    const r = editFrontmatter(content, (fm) => {
      fm.meta = { a: 1 };
    });
    expect(r.outcome).toBe('unverifiable');
    expect(r.content).toBe(content);
  });
});

describe('isFlatFrontmatter', () => {
  test('scalars + array-of-scalar + null -> true', () => {
    expect(
      isFlatFrontmatter({ a: 1, b: 'x', c: true, d: ['p', 'q'], e: null }),
    ).toBe(true);
  });

  test('empty object -> true', () => {
    expect(isFlatFrontmatter({})).toBe(true);
  });

  test('nested map -> false', () => {
    expect(isFlatFrontmatter({ a: 1, meta: { x: 1 } })).toBe(false);
  });

  test('array-of-object -> false', () => {
    expect(isFlatFrontmatter({ a: [{ x: 1 }] })).toBe(false);
  });
});
