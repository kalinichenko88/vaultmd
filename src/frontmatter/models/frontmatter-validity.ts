/**
 * Describes how a note's YAML frontmatter block parsed:
 * - `'flat'` — present and all values are scalars or arrays of scalars (safe to edit).
 * - `'present-but-invalid'` — YAML exists but contains nested objects or is unparseable.
 * - `'none'` — no frontmatter block found; the whole file is body content.
 */
export type FrontmatterValidity = 'flat' | 'present-but-invalid' | 'none';
