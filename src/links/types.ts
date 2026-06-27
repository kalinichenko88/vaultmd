export type ExtractedLinks = {
  wikilinks: string[];
  embeds: string[];
  mdLinks: string[];
};

export type LinkResolution = 'wikilink' | 'relative';

export type StoredLink = {
  target: string;
  base: string | null;
  kind: 'wikilink' | 'embed' | 'mdlink';
};
