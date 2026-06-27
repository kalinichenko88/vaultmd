import { describe, expect, test } from 'bun:test';

import { matches } from '../allowlist.ts';

describe('matches (boundary-aware)', () => {
  test("'foo' matches the folder + exact entry but NOT 'foobar.md'", () => {
    expect(matches('foobar.md', ['foo'])).toBe(false);
    expect(matches('foo/note.md', ['foo'])).toBe(true);
    expect(matches('foo', ['foo'])).toBe(true);
  });

  test("'' matches everything", () => {
    expect(matches('anything/deep/x.md', [''])).toBe(true);
  });

  test('no matching prefix → false', () => {
    expect(matches('Private/x.md', ['Public'])).toBe(false);
  });
});
