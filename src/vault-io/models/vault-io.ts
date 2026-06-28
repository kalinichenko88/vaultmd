import type { Sig } from '../../fs-atomic/index.ts';
import type { Access } from './access.ts';

export type VaultIo = {
  toVaultRelative(rel: string): string;
  toKey(rel: string): string;
  can(rel: string, access: Access): boolean;
  resolveVaultPath(rel: string, access?: Access): string;
  readVaultFile(rel: string): Promise<{ content: string; sig: Sig } | null>;
  writeVaultFile(rel: string, content: string): Promise<Sig>;
  rewriteIfUnchanged(rel: string, content: string, expected: Sig): Promise<Sig>;
  unlinkIfUnchanged(rel: string, expected: Sig): Promise<boolean>;
  stat(rel: string): Promise<Sig | null>;
  listMarkdown(dir?: string): Promise<string[]>;
};
