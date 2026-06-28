import type { VaultPrefixes } from './vault-prefixes.ts';

export type VaultIoConfig = {
  root: string;
  prefixes: VaultPrefixes;
  caseSensitive?: boolean;
  ignore?: string[];
};
