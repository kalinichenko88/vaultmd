import { describe, expect, test } from 'bun:test';

import { editFrontmatter } from '../edit.ts';

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
