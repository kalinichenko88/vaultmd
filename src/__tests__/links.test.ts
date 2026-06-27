import { describe, expect, test } from 'bun:test';

import { extractLinks } from '../links.ts';

describe('extractLinks', () => {
  test('finds wikilinks, embeds, and markdown links with raw targets', () => {
    const md = [
      'See [[Foo]] and [[Folder/Bar#heading|Alias]].',
      'Embed: ![[Image.png]] and ![[Note]].',
      'A [link text](notes/target.md) here.',
    ].join('\n');
    const { wikilinks, embeds, mdLinks } = extractLinks(md);
    expect(wikilinks).toEqual(['Foo', 'Folder/Bar#heading|Alias']);
    expect(embeds).toEqual(['Image.png', 'Note']);
    expect(mdLinks).toEqual(['notes/target.md']);
  });

  test('ignores links inside fenced code blocks', () => {
    const md = [
      'Real [[Outside]] link.',
      '```ts',
      'const x = "[[Inside]]"',
      'const y = "[txt](inside.md)"',
      '```',
      'Another [out](real.md).',
    ].join('\n');
    const { wikilinks, embeds, mdLinks } = extractLinks(md);
    expect(wikilinks).toEqual(['Outside']);
    expect(embeds).toEqual([]);
    expect(mdLinks).toEqual(['real.md']);
  });

  test('strips markdown link titles and unwraps angle-bracket urls', () => {
    const md = '[a](path.md "Some Title") and [b](<spaced name.md>)';
    const { mdLinks } = extractLinks(md);
    expect(mdLinks).toEqual(['path.md', 'spaced name.md']);
  });

  test('does not treat image embeds as markdown links', () => {
    const md = '![alt](pic.png) but [real](doc.md)';
    const { mdLinks } = extractLinks(md);
    expect(mdLinks).toEqual(['doc.md']);
  });
});

import { storedLinksFor } from '../links.ts';

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
