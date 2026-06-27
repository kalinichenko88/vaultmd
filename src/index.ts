export type { MdVaultCode } from './errors.ts';
export { MdVaultError } from './errors.ts';
export type { Sig } from './fs-atomic.ts';
export type {
  Access,
  VaultIo,
  VaultIoConfig,
  VaultPrefixes,
} from './vault-io.ts';
export { createVaultIo } from './vault-io.ts';
export type {
  CommitEvent,
  CrossLock,
  TransformOpts,
  TransformResult,
} from './locked-file.ts';
export { withFileDelete, withFileTransform } from './locked-file.ts';
export type {
  EditOutcome,
  FrontmatterValidity,
  ParsedFrontmatter,
} from './frontmatter.ts';
export {
  deriveTags,
  editFrontmatter,
  isFlatFrontmatter,
  parseFrontmatter,
} from './frontmatter.ts';
export type { ExtractedLinks, LinkResolution, StoredLink } from './links.ts';
export { extractLinks, storedLinksFor } from './links.ts';
