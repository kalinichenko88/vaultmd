import { describe, expect, test } from 'bun:test';

import { extractHeadings } from '../extract.ts';

/** Text + level pairs, for tests that do not care about offsets. */
function shape(content: string): [string, number][] {
  return extractHeadings(content).map((h) => [h.text, h.level]);
}

describe('extractHeadings — grammar', () => {
  test('accepts levels 1 through 6', () => {
    const md = '# a\n## b\n### c\n#### d\n##### e\n###### f\n';
    expect(shape(md).map(([, level]) => level)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('strips a closing hash sequence', () => {
    expect(shape('## Notes ##\n')).toEqual([['Notes', 2]]);
  });

  test('a bare hash is a level-1 heading with empty text', () => {
    expect(shape('#\n')).toEqual([['', 1]]);
  });

  test('requires whitespace after the hashes', () => {
    expect(shape('#Notes\n')).toEqual([]);
  });

  test('rejects seven hashes', () => {
    expect(shape('####### Notes\n')).toEqual([]);
  });

  test('allows 0-3 spaces of indent but not 4', () => {
    expect(shape('   # Three\n')).toEqual([['Three', 1]]);
    expect(shape('    # Four\n')).toEqual([]);
  });

  test('handles CRLF line endings', () => {
    // `.` excludes \r and `$` anchors at end-of-input, so an unstripped \r
    // makes the ATX regex fail to match at all.
    expect(shape('## Notes\r\n')).toEqual([['Notes', 2]]);
    expect(shape('#\r\n')).toEqual([['', 1]]);
    expect(shape('## Notes ##\r\n')).toEqual([['Notes', 2]]);
  });

  test('ignores headings inside a fenced block', () => {
    expect(shape('```\n# hidden\n```\n# real\n')).toEqual([['real', 1]]);
  });

  test('a mismatched marker does not reopen the scan', () => {
    expect(shape('```ts\n~~~\n## Fake\n```\n## Real\n')).toEqual([['Real', 2]]);
  });

  test('empty content yields no headings', () => {
    expect(shape('')).toEqual([]);
  });
});

describe('extractHeadings — spans', () => {
  test('a section ends at the next same-or-shallower heading', () => {
    const md = '## Notes\nfirst\n### Sub\nmore\n## Links\ntail\n';
    const notes = extractHeadings(md).find((h) => h.text === 'Notes');
    expect(md.slice(notes?.bodyStart, notes?.end)).toBe(
      'first\n### Sub\nmore\n',
    );
  });

  test('a subsection span stops at its parent boundary', () => {
    const md = '## Notes\nfirst\n### Sub\nmore\n## Links\ntail\n';
    const sub = extractHeadings(md).find((h) => h.text === 'Sub');
    expect(md.slice(sub?.bodyStart, sub?.end)).toBe('more\n');
  });

  test('a section runs to EOF when nothing follows', () => {
    const md = '## Notes\nfirst\n';
    const [notes] = extractHeadings(md);
    expect(notes.end).toBe(md.length);
    expect(md.slice(notes.bodyStart, notes.end)).toBe('first\n');
  });

  test('blank lines at both edges sit outside the span', () => {
    const md = '## Notes\n\nfirst\n\n## Links\n';
    const [notes] = extractHeadings(md);
    expect(md.slice(notes.bodyStart, notes.end)).toBe('first\n');
    expect(md[notes.bodyStart - 1]).toBe('\n');
  });

  test('interior blank lines stay inside the span', () => {
    const md = '## Notes\na\n\nb\n## Links\n';
    const [notes] = extractHeadings(md);
    expect(md.slice(notes.bodyStart, notes.end)).toBe('a\n\nb\n');
  });

  test('an empty section collapses to the line after the heading', () => {
    const md = '## Notes\n\n## Links\n';
    const [notes] = extractHeadings(md);
    expect(notes.bodyStart).toBe(notes.end);
    expect(notes.bodyStart).toBe('## Notes\n'.length);
    expect(md.slice(notes.bodyStart, notes.end)).toBe('');
  });

  test('a body of only blank lines is an empty section', () => {
    const md = '## Notes\n\n\n\n## Links\n';
    const [notes] = extractHeadings(md);
    expect(md.slice(notes.bodyStart, notes.end)).toBe('');
  });

  test('a heading as the last line, with and without a trailing newline', () => {
    const withNl = '## Notes\n';
    const [a] = extractHeadings(withNl);
    expect(a.bodyStart).toBe(withNl.length);
    expect(a.end).toBe(withNl.length);

    const without = '## Notes';
    const [b] = extractHeadings(without);
    expect(b.bodyStart).toBe(without.length);
    expect(b.end).toBe(without.length);
  });

  test('a final line without a trailing newline is still inside the span', () => {
    const md = '## Notes\nlast';
    const [notes] = extractHeadings(md);
    expect(md.slice(notes.bodyStart, notes.end)).toBe('last');
    expect(notes.end).toBe(md.length);
  });

  test('start points at the heading line first hash', () => {
    const md = 'intro\n\n## Notes\nbody\n';
    const [notes] = extractHeadings(md);
    expect(md.slice(notes.start, notes.start + 8)).toBe('## Notes');
  });
});
