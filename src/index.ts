export type { MdVaultCode } from '@/errors.ts';
export { MdVaultError } from '@/errors.ts';
export type {
  EditOutcome,
  FrontmatterValidity,
  ParsedFrontmatter,
} from '@/frontmatter/index.ts';
export {
  deriveTags,
  editFrontmatter,
  isFlatFrontmatter,
  parseFrontmatter,
} from '@/frontmatter/index.ts';
export type { Sig } from '@/fs-atomic/index.ts';
export type {
  ExtractedLinks,
  LinkResolution,
  StoredLink,
} from '@/links/index.ts';
export { extractLinks, storedLinksFor } from '@/links/index.ts';
export type {
  CommitEvent,
  CrossLock,
  TransformOpts,
  TransformResult,
} from '@/locked-file/index.ts';
export { withFileDelete, withFileTransform } from '@/locked-file/index.ts';
export type { ReadNoteResult, UpdateOp } from '@/notes/index.ts';
export type {
  NoteHit,
  OrderField,
  QueryOrder,
  SearchHit,
  WhereMap,
} from '@/query/index.ts';
export type { CreateVaultConfig, Vault } from '@/vault/index.ts';
export { createVault } from '@/vault/index.ts';
export type {
  Access,
  VaultIo,
  VaultIoConfig,
  VaultPrefixes,
} from '@/vault-io/index.ts';
export { createVaultIo } from '@/vault-io/index.ts';
