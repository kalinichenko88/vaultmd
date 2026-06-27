import { expect, test } from 'bun:test';

import * as mdvault from '../index.ts';

test('barrel exposes the Plan 1 public surface', () => {
  expect(typeof mdvault.MdVaultError).toBe('function');
  expect(typeof mdvault.createVaultIo).toBe('function');
  expect(typeof mdvault.withFileTransform).toBe('function');
  expect(typeof mdvault.withFileDelete).toBe('function');
  expect(typeof mdvault.parseFrontmatter).toBe('function');
  expect(typeof mdvault.editFrontmatter).toBe('function');
  expect(typeof mdvault.deriveTags).toBe('function');
  expect(typeof mdvault.isFlatFrontmatter).toBe('function');
  expect(typeof mdvault.extractLinks).toBe('function');
  expect(typeof mdvault.storedLinksFor).toBe('function');
});
