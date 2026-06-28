export type StoredLink = {
  target: string;
  base: string | null;
  kind: 'wikilink' | 'embed' | 'mdlink';
};
