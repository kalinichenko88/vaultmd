/** Raw link tokens extracted from a markdown file by {@link extractLinks}. */
export type ExtractedLinks = {
  /** `[[Target]]` wikilink targets (raw, before normalisation). */
  wikilinks: string[];
  /** `![[Embed]]` embed targets (raw, before normalisation). */
  embeds: string[];
  /** Standard `[text](url)` link URLs (raw, before normalisation). */
  mdLinks: string[];
};
