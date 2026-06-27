import { describe, expect, test } from 'bun:test';

import { extractLinks } from '../extract.ts';

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
