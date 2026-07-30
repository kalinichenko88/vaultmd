import { describe, expect, test } from 'bun:test';

import { editFrontmatter } from '../edit.ts';
import { parseFrontmatter } from '../parse.ts';

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

  test('a long scalar written into an EXISTING block stays on one line', () => {
    const source =
      'Imported from the Q2 architecture review deck, slide 14, transcribed by the ingestion agent and reconciled against the meeting minutes.';
    const r = editFrontmatter('---\ntitle: x\n---\nbody', (fm) => {
      fm.source = source;
    });
    expect(r.outcome).toBe('edited');
    // Same no-folding contract as the fresh-block path: an edit to a note that
    // already has frontmatter is the commoner write, and folding there would
    // break the caller's flat-value guarantee just as thoroughly.
    expect(r.content).toContain(`source: ${source}\n`);
  });

  test('a value ending in a newline round-trips (no |+ block scalar)', () => {
    // A `|+` block scalar as the last key is ambiguous against the closing
    // `---` fence: yaml emits it, the parser gives the newline back to the
    // fence, and the value silently loses it on every read.
    for (const note of ['a\n', 'a\n\n', 'a\nb\n\n\n']) {
      const r = editFrontmatter('---\ntitle: x\n---\nbody', (fm) => {
        fm.note = note;
      });
      expect(r.content).not.toContain('|+');
      expect(parseFrontmatter(r.content).frontmatter).toEqual({
        title: 'x',
        note,
      });
    }
  });

  test('editing a duplicated key writes the pair readers actually resolve to', () => {
    // yaml parses with uniqueKeys: false and every reader is last-wins, but
    // doc.set/doc.delete hit the FIRST pair — so without the shadow drop the
    // write lands where nothing reads it and vanishes on the next parse.
    const dup = '---\ntags: a\ntags: b\ntitle: x\n---\nbody';

    const set = editFrontmatter(dup, (fm) => {
      fm.tags = 'z';
    });
    expect(set.outcome).toBe('edited');
    expect(parseFrontmatter(set.content).frontmatter).toEqual({
      tags: 'z',
      title: 'x',
    });

    const del = editFrontmatter(dup, (fm) => {
      delete fm.tags;
    });
    expect(del.outcome).toBe('edited');
    expect(parseFrontmatter(del.content).frontmatter).toEqual({ title: 'x' });

    // An unchanged note is still returned byte-for-byte: the shadow drop is not
    // a licence to rewrite a file nobody asked to edit.
    expect(editFrontmatter(dup, () => {}).content).toBe(dup);
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
