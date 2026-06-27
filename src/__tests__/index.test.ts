import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import * as mdvault from '../index.ts';

// The frozen Plan 1 package public API. Changing this set must be deliberate:
// adding/removing/renaming any export fails these tests.
const VALUE_EXPORTS = [
  'MdVaultError',
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
  ...VALUE_EXPORTS,
  'Access',
  'CommitEvent',
  'CrossLock',
  'EditOutcome',
  'ExtractedLinks',
  'FrontmatterValidity',
  'LinkResolution',
  'MdVaultCode',
  'ParsedFrontmatter',
  'Sig',
  'StoredLink',
  'TransformOpts',
  'TransformResult',
  'VaultIo',
  'VaultIoConfig',
  'VaultPrefixes',
].sort();

function exportedNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw
        .trim()
        .split(/\s+as\s+/)[0]
        .trim();
      if (name) names.add(name);
    }
  }

  return [...names].sort();
}

describe('package public API freeze', () => {
  test('src/index.ts exports exactly the frozen 26 names (value + type)', () => {
    const src = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(exportedNames(src)).toEqual(ALL_EXPORTS);
  });

  test('runtime value exports are exactly the 10 live values', () => {
    expect(Object.keys(mdvault).sort()).toEqual(VALUE_EXPORTS);
  });
});
