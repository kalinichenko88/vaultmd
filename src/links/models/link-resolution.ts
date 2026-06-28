/**
 * Strategy used when resolving outbound links from a note into the index:
 * - `'wikilink'` — resolve `[[Target]]` and `![[Embed]]` by filename stem.
 * - `'relative'` — resolve standard `[text](./path.md)` markdown hrefs relative to the note.
 */
export type LinkResolution = 'wikilink' | 'relative';
