/**
 * Describes how a note's YAML frontmatter block parsed:
 * - `'valid'` — present, and every value round-trips (safe to edit). Nested
 *   maps and arrays qualify; see `isValidFrontmatter` for what does not.
 * - `'present-but-invalid'` — a block exists but is unparseable YAML, has a
 *   non-map root, or holds a value that cannot round-trip. Its keys are NOT
 *   reported: `parseFrontmatter` returns an empty map for it.
 * - `'none'` — no frontmatter block found; the whole file is body content.
 */
export type FrontmatterValidity = 'valid' | 'present-but-invalid' | 'none';
