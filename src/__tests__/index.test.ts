import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import * as vaultmd from '@/index.ts';

// The frozen Plan 1 + Plan 2 package public API. Changing this set must be deliberate:
// adding/removing/renaming any export fails these tests.
const VALUE_EXPORTS = [
  'MdVaultError',
  'createVault',
  'createVaultIo',
  'deriveTags',
  'editFrontmatter',
  'extractLinks',
  'isFlatFrontmatter',
  'parseFrontmatter',
  'storedLinksFor',
  'withFileDelete',
  'withFileTransform',
].sort();

const ALL_EXPORTS = [
  // — Plan 1 (existing 26) —
  'Access',
  'CommitEvent',
  'CrossLock',
  'EditOutcome',
  'ExtractedLinks',
  'FrontmatterValidity',
  'LinkResolution',
  'MdVaultCode',
  'MdVaultError',
  'ParsedFrontmatter',
  'Sig',
  'StoredLink',
  'TransformOpts',
  'TransformResult',
  'VaultIo',
  'VaultIoConfig',
  'VaultPrefixes',
  'createVaultIo',
  'deriveTags',
  'editFrontmatter',
  'extractLinks',
  'isFlatFrontmatter',
  'parseFrontmatter',
  'storedLinksFor',
  'withFileDelete',
  'withFileTransform',
  // — Plan 2 (new 10) —
  'CreateVaultConfig',
  'NoteHit',
  'OrderField',
  'QueryOrder',
  'ReadNoteResult',
  'SearchHit',
  'UpdateOp',
  'Vault',
  'WhereMap',
  'createVault',
  // — Plan 3 (docs API firming) (new 4) —
  'Backlink',
  'NotesApi',
  'OutboundLink',
  'QueryApi',
].sort();

function exportedNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const raw of m[1].split(',')) {
      // For a re-export `internalName as PublicName`, freeze the PUBLIC
      // (exported) name — the last segment — not the source-side name.
      const parts = raw.trim().split(/\s+as\s+/);
      const name = parts[parts.length - 1].trim();
      if (name) {
        names.add(name);
      }
    }
  }

  return [...names].sort();
}

describe('package public API freeze', () => {
  test('src/index.ts exports exactly the frozen 40 names (Plan 1 + Plan 2 + Plan 3)', () => {
    const src = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(exportedNames(src)).toEqual(ALL_EXPORTS);
  });

  test('runtime value exports are exactly the 11 live values', () => {
    expect(Object.keys(vaultmd).sort()).toEqual(VALUE_EXPORTS);
  });

  test('createVault is a live function export', () => {
    expect(typeof vaultmd.createVault).toBe('function');
  });

  test('the barrel uses no `export *` (every export is named)', () => {
    const src = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/export\s+\*/);
  });
});
