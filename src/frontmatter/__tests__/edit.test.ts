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

  test('mutate introducing a non-round-trippable value -> unverifiable, no write', () => {
    const content = '---\ntitle: x\n---\nbody';
    const r = editFrontmatter(content, (fm) => {
      fm.when = new Date();
    });
    expect(r.outcome).toBe('unverifiable');
    expect(r.content).toBe(content);
  });
});

describe('editFrontmatter — nested is read-only', () => {
  // Reading a nested note is supported; rewriting one is not. Editing a key of
  // a nested block means re-emitting a shape this package did not author, and
  // every attempt at doing that surgically cost a comment, a block scalar or a
  // shadowed pair. The note is left alone and the caller is told so.
  test('mutating a nested value is refused, not written', () => {
    const src = '---\ntitle: keep\nmeta:\n  status: open\n---\nbody\n';
    const { content, outcome } = editFrontmatter(src, (fm) => {
      (fm.meta as Record<string, unknown>).status = 'done';
    });

    expect(parseFrontmatter(src).valid).toBe('nested');
    expect(outcome).toBe('unverifiable');
    expect(content).toBe(src);
  });

  test('a flat note stays flat: adding a nested key is refused', () => {
    const src = '---\ntitle: keep\n---\nbody\n';
    const { content, outcome } = editFrontmatter(src, (fm) => {
      fm.meta = { status: 'open' };
    });

    expect(outcome).toBe('unverifiable');
    expect(content).toBe(src);
  });

  test('a map-anchor block is nested, so it is refused', () => {
    const src = '---\nx: &a\n  k: 1\ny: *a\n---\nbody\n';
    const { content, outcome } = editFrontmatter(src, (fm) => {
      fm.x = { k: 2 };
    });

    expect(outcome).toBe('unverifiable');
    expect(content).toBe(src);
  });

  // An anchored array of scalars IS flat, so it edits. The alias means the two
  // keys are one value, so mutating through either updates both — and the
  // anchor dissolves into two literal lists. Style is lost, data is not; this
  // is what main did too.
  test('an anchored array of scalars edits, unrolling the alias', () => {
    const src = '---\nx: &a [1, 2]\ny: *a\n---\nbody\n';
    const { content, outcome } = editFrontmatter(src, (fm) => {
      (fm.x as number[]).push(3);
    });

    expect(parseFrontmatter(src).valid).toBe('flat');
    expect(outcome).toBe('edited');
    expect(content).not.toContain('&a');
    expect(parseFrontmatter(content).frontmatter).toEqual({
      x: [1, 2, 3],
      y: [1, 2, 3],
    });
  });

  test('a scalar-anchor block still edits and keeps its anchor', () => {
    const { content, outcome } = editFrontmatter(
      '---\nx: &a hi\ny: *a\n---\nbody\n',
      (fm) => {
        fm.z = 1;
      },
    );

    expect(outcome).toBe('edited');
    expect(content).toContain('&a');
    expect(content).toContain('*a');
  });

  // Removing or replacing the pair that OWNS an anchor orphans every `*a` that
  // refers to it, and yaml then refuses to emit — a raw, code-less throw out of
  // a function documented never to throw for bad frontmatter. The note is left
  // alone instead. `parseFrontmatter` reports these as `'valid'`, so the value
  // graph cannot see the problem: only one live reference survives resolution.
  test('deleting the owner of a scalar anchor is refused, not thrown', () => {
    const src = '---\nx: &a hi\ny: *a\n---\nbody\n';
    const { content, outcome } = editFrontmatter(src, (fm) => {
      delete fm.x;
    });

    expect(outcome).toBe('unverifiable');
    expect(content).toBe(src);
  });

  test('replacing a scalar anchor with a container is refused, not thrown', () => {
    const src = '---\nx: &a hi\ny: *a\n---\nbody\n';
    const { content, outcome } = editFrontmatter(src, (fm) => {
      fm.x = { k: 1 };
    });

    expect(outcome).toBe('unverifiable');
    expect(content).toBe(src);
  });

  // The guard must not swallow the edits that work. yaml rewrites a scalar in
  // place, so the anchor survives a scalar-to-scalar replacement.
  test('replacing a scalar anchor with another scalar still edits', () => {
    const { content, outcome } = editFrontmatter(
      '---\nx: &a hi\ny: *a\n---\nbody\n',
      (fm) => {
        fm.x = 'bye';
      },
    );

    expect(outcome).toBe('edited');
    expect(content).toContain('x: &a bye');
    expect(content).toContain('*a');
  });

  test('deleting the alias side still edits', () => {
    const { outcome } = editFrontmatter(
      '---\nx: &a hi\ny: *a\n---\nbody\n',
      (fm) => {
        delete fm.y;
      },
    );

    expect(outcome).toBe('edited');
  });

  test('a mutation that introduces a shared reference is refused', () => {
    const src = '---\ntitle: keep\n---\nbody\n';
    const { content, outcome } = editFrontmatter(src, (fm) => {
      const shared = { k: 1 };
      fm.a = shared;
      fm.b = shared;
    });

    expect(outcome).toBe('unverifiable');
    expect(content).toBe(src);
  });

  // A repeated top-level key is legal (uniqueKeys: false, last-wins), and
  // parse()'s last-wins collapse means only ONE live reference to the anchored
  // container survives the parsed object — the validator's `seen` set never
  // sees a repeat, so `parseFrontmatter` reports 'valid'. But editFrontmatter
  // works from parseDocument + dropShadowedKeys, which deletes the pair
  // carrying `&a` (the shadowed FIRST `x`) — orphaning `*a` — and doc.toJS()
  // then cannot resolve it. Without a guard this escapes as a raw
  // `ReferenceError`, not an `MdVaultCode`.
  test('a map anchor orphaned by a shadowed duplicate key is refused, not a raw throw', () => {
    const src = '---\nx: &a\n  k: 1\nx: 3\ny: *a\n---\nbody\n';
    // The surviving `y` holds a map, so this one is caught as nested before
    // the orphan can arise. The sequence form below is the case that actually
    // reaches the guard.
    expect(parseFrontmatter(src).valid).toBe('nested');

    const { content, outcome } = editFrontmatter(src, (fm) => {
      fm.z = 1;
    });

    expect(outcome).toBe('unverifiable');
    expect(content).toBe(src);
  });

  // Same hole, sequence form. This one throws on `main` too (pre-existing,
  // not a regression from nested frontmatter) but gets the same fix here.
  test('a sequence anchor orphaned by a shadowed duplicate key is refused, not a raw throw', () => {
    const src = '---\nx: &a [1, 2]\nx: 3\ny: *a\n---\nbody\n';
    expect(parseFrontmatter(src).valid).toBe('flat');

    const { content, outcome } = editFrontmatter(src, (fm) => {
      fm.z = 1;
    });

    expect(outcome).toBe('unverifiable');
    expect(content).toBe(src);
  });

  // Guard against over-catching: a duplicate key with no anchor involved must
  // keep working exactly as dropShadowedKeys' last-wins behaviour intends.
  test('a duplicate key with no anchor still edits normally', () => {
    const src = '---\nx: 1\nx: 2\ny: 3\n---\nbody\n';
    const { content, outcome } = editFrontmatter(src, (fm) => {
      fm.y = 4;
    });

    expect(outcome).toBe('edited');
    expect(parseFrontmatter(content).frontmatter).toEqual({ x: 2, y: 4 });
  });

  // The depth bound is what keeps this an outcome rather than a raw RangeError
  // out of the emitter — editFrontmatter never throws for bad frontmatter.
  test('a mutation nesting past the depth bound is refused, not thrown', () => {
    const src = '---\ntitle: keep\n---\nbody\n';
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 20_000; i++) {
      deep = { n: deep };
    }
    const { content, outcome } = editFrontmatter(src, (fm) => {
      fm.deep = deep;
    });

    expect(outcome).toBe('unverifiable');
    expect(content).toBe(src);
  });
});
