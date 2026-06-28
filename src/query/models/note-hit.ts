export type NoteHit = {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
};
