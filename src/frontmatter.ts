import { Document, parse, parseDocument } from 'yaml';

export type FrontmatterValidity = 'flat' | 'present-but-invalid' | 'none';

export type ParsedFrontmatter = {
  frontmatter: Record<string, unknown>;
  tags: string[];
  body: string;
  valid: FrontmatterValidity;
};

export type EditOutcome = 'edited' | 'unchanged' | 'unverifiable';

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    value instanceof Date ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function isScalarOrArrayOfScalar(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.every(isScalar);
  }

  return isScalar(value);
}

export function isFlatFrontmatter(fm: Record<string, unknown>): boolean {
  for (const value of Object.values(fm)) {
    if (!isScalarOrArrayOfScalar(value)) {
      return false;
    }
  }

  return true;
}

function toTagTokens(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(toTagTokens);
  }
  if (typeof value === 'string') {
    return value
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }

  return [];
}

export function deriveTags(frontmatter: Record<string, unknown>): string[] {
  const source =
    frontmatter.tags !== undefined ? frontmatter.tags : frontmatter.tag;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of toTagTokens(source)) {
    const stripped = token.replace(/^#+/, '');
    if (stripped && !seen.has(stripped)) {
      seen.add(stripped);
      out.push(stripped);
    }
  }

  return out;
}

type Block = { yaml: string; body: string };

function extractBlock(content: string): Block | null {
  const firstNl = content.indexOf('\n');
  if (firstNl === -1) {
    return null;
  }
  if (content.slice(0, firstNl).replace(/\r$/, '') !== '---') {
    return null;
  }
  const lines = content.slice(firstNl + 1).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].replace(/\r$/, '') === '---') {
      const yaml = lines.slice(0, i).join('\n');
      const body = lines.slice(i + 1).join('\n');

      return { yaml, body };
    }
  }

  return null;
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
  const block = extractBlock(content);
  if (!block) {
    return { frontmatter: {}, tags: [], body: content, valid: 'none' };
  }
  const { yaml: yamlText, body } = block;
  let parsed: unknown;
  try {
    parsed = parse(yamlText, { uniqueKeys: false });
  } catch {
    return { frontmatter: {}, tags: [], body, valid: 'present-but-invalid' };
  }
  if (parsed === null || parsed === undefined) {
    return { frontmatter: {}, tags: [], body, valid: 'flat' };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { frontmatter: {}, tags: [], body, valid: 'present-but-invalid' };
  }
  const frontmatter = parsed as Record<string, unknown>;
  const valid: FrontmatterValidity = isFlatFrontmatter(frontmatter)
    ? 'flat'
    : 'present-but-invalid';

  return { frontmatter, tags: deriveTags(frontmatter), body, valid };
}

export function editFrontmatter(
  content: string,
  mutate: (fm: Record<string, unknown>) => void,
): { content: string; outcome: EditOutcome } {
  const parsed = parseFrontmatter(content);
  if (parsed.valid === 'present-but-invalid') {
    return { content, outcome: 'unverifiable' };
  }
  if (parsed.valid === 'none') {
    const view: Record<string, unknown> = {};
    mutate(view);
    if (!isFlatFrontmatter(view)) {
      return { content, outcome: 'unverifiable' };
    }
    if (Object.keys(view).length === 0) {
      return { content, outcome: 'unchanged' };
    }
    const block = String(new Document(view)).replace(/\n$/, '');

    return { content: `---\n${block}\n---\n${content}`, outcome: 'edited' };
  }
  const ext = extractBlock(content);
  if (!ext) {
    return { content, outcome: 'unverifiable' };
  }
  const doc = parseDocument(ext.yaml, { uniqueKeys: false });
  const before = (doc.toJS() ?? {}) as Record<string, unknown>;
  const view = structuredClone(before);
  mutate(view);
  if (!isFlatFrontmatter(view)) {
    return { content, outcome: 'unverifiable' };
  }
  let changed = false;
  for (const key of Object.keys(before)) {
    if (!(key in view)) {
      doc.delete(key);
      changed = true;
    }
  }
  for (const key of Object.keys(view)) {
    if (
      !(key in before) ||
      JSON.stringify(before[key]) !== JSON.stringify(view[key])
    ) {
      doc.set(key, view[key]);
      changed = true;
    }
  }
  if (!changed) {
    return { content, outcome: 'unchanged' };
  }
  const serialized = String(doc);
  const block = serialized.endsWith('\n')
    ? serialized.slice(0, -1)
    : serialized;

  return { content: `---\n${block}\n---\n${ext.body}`, outcome: 'edited' };
}
