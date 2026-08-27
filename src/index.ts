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
  serializeFrontmatter,
} from '@/frontmatter/index.ts';
export type { Sig } from '@/fs-atomic/index.ts';
export type { Heading } from '@/headings/index.ts';
export { extractHeadings } from '@/headings/index.ts';
export type {
  ExtractedLinks,
  LinkResolution,
  StoredLink,
} from '@/links/index.ts';
export { extractLinks, storedLinksFor } from '@/links/index.ts';
export type {
  CommitEvent,
  CrossLock,
  MoveTarget,
  TransformOpts,
  TransformResult,
} from '@/locked-file/index.ts';
export {
  withFileDelete,
  withFileMove,
  withFileTransform,
} from '@/locked-file/index.ts';
export type { ReconcileResult } from '@/note-index/index.ts';
export type {
  NotesApi,
  ReadNoteResult,
  TransformOutcome,
  UpdateOp,
} from '@/notes/index.ts';
export type {
  Backlink,
  DanglingLink,
  NoteFilter,
  NoteHit,
  OrderField,
  OutboundLink,
  QueryApi,
  QueryOrder,
  SearchHit,
  TagFilter,
  TagInfo,
  WhereCondition,
  WhereMap,
  WhereValue,
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
