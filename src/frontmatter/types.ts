export type FrontmatterValidity = 'flat' | 'present-but-invalid' | 'none';

export type ParsedFrontmatter = {
  frontmatter: Record<string, unknown>;
  tags: string[];
  body: string;
  valid: FrontmatterValidity;
};

export type EditOutcome = 'edited' | 'unchanged' | 'unverifiable';
