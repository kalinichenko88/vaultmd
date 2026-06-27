import { describe, expect, test } from 'bun:test';

import { globToRegExp } from '../glob.ts';

describe('globToRegExp', () => {
  test('* matches within a segment, not across /', () => {
    expect(globToRegExp('*.md').test('a.md')).toBe(true);
    expect(globToRegExp('*.md').test('sub/a.md')).toBe(false);
  });

  test('**/ matches zero or more leading segments', () => {
    const re = globToRegExp('**/x.md');
    expect(re.test('x.md')).toBe(true);
    expect(re.test('a/b/x.md')).toBe(true);
  });

  test('trailing ** matches anything including /', () => {
    expect(globToRegExp('build/**').test('build/a/b.md')).toBe(true);
  });

  test('? matches one non-/ char; literals are escaped', () => {
    expect(globToRegExp('a?b.md').test('axb.md')).toBe(true);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
  });
});
