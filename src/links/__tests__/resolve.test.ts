import { describe, expect, test } from 'bun:test';

import { storedLinksFor } from '../resolve.ts';

describe('storedLinksFor (wikilink mode)', () => {
  test('preserves path-qualified target and derives case-folded base', () => {
    const out = storedLinksFor('link to [[Folder/Foo]]', 'src.md', 'wikilink');
    expect(out).toEqual([
      { target: 'Folder/Foo', base: 'foo', kind: 'wikilink' },
    ]);
  });

  test('strips heading / block / alias; bare link base = lowercased name', () => {
    const md = '[[Foo#Section|Alias]] [[Bar#^block123]] [[Baz]]';
    const out = storedLinksFor(md, 'src.md', 'wikilink');
    expect(out).toEqual([
      { target: 'Foo', base: 'foo', kind: 'wikilink' },
      { target: 'Bar', base: 'bar', kind: 'wikilink' },
      { target: 'Baz', base: 'baz', kind: 'wikilink' },
    ]);
  });

  test('embeds get kind embed; trailing .md dropped; md links ignored', () => {
    const md = '![[Notes/Daily.md]] plus [ignored](other.md)';
    const out = storedLinksFor(md, 'src.md', 'wikilink');
    expect(out).toEqual([
      { target: 'Notes/Daily', base: 'daily', kind: 'embed' },
    ]);
  });
});

describe('storedLinksFor (relative mode)', () => {
  test('resolves md link against the source dir', () => {
    const out = storedLinksFor(
      'see [a](../x.md)',
      'folder/note.md',
      'relative',
    );
    expect(out).toEqual([{ target: 'x.md', base: null, kind: 'mdlink' }]);
  });

  test('resolves nested and dot-relative paths, keeping the .md key', () => {
    const out = storedLinksFor(
      '[a](sub/deep.md) and [b](./same.md)',
      'a/b/note.md',
      'relative',
    );
    expect(out).toEqual([
      { target: 'a/b/sub/deep.md', base: null, kind: 'mdlink' },
      { target: 'a/b/same.md', base: null, kind: 'mdlink' },
    ]);
  });

  test('drops external, anchor, image, non-md, absolute, and root-escaping links', () => {
    const md = [
      '[ext](https://example.com/page.md)',
      '[mail](mailto:a@b.com)',
      '[anchor](#section)',
      '[img](pic.png)',
      '[txt](readme.txt)',
      '[abs](/vault/root.md)',
      '[escape](../../outside.md)',
      '[ok](kept.md)',
    ].join('\n');
    const out = storedLinksFor(md, 'note.md', 'relative');
    expect(out).toEqual([{ target: 'kept.md', base: null, kind: 'mdlink' }]);
  });

  test('strips anchor from an internal md link before resolving', () => {
    const out = storedLinksFor('[a](target.md#section)', 'note.md', 'relative');
    expect(out).toEqual([{ target: 'target.md', base: null, kind: 'mdlink' }]);
  });

  test('wikilinks are ignored in relative mode', () => {
    const out = storedLinksFor('[[Foo]] and [a](x.md)', 'note.md', 'relative');
    expect(out).toEqual([{ target: 'x.md', base: null, kind: 'mdlink' }]);
  });
});
