import { describe, expect, test } from 'bun:test';

import { MdVaultError } from '@/errors.ts';

import { canonicalizeRelative, canonPrefix } from '../paths.ts';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof MdVaultError ? e.code : String(e);
  }

  return 'NO_THROW';
}

describe('canonicalizeRelative', () => {
  test('collapses ./, dup-slash, . and resolves ..; case-preserving', () => {
    expect(canonicalizeRelative('a/./b.md')).toBe('a/b.md');
    expect(canonicalizeRelative('./a//b.md')).toBe('a/b.md');
    expect(canonicalizeRelative('a/b/../c.md')).toBe('a/c.md');
    expect(canonicalizeRelative('Notes/Daily.md')).toBe('Notes/Daily.md');
  });

  test('NFC-normalizes unicode segments', () => {
    expect(canonicalizeRelative('cafe\u0301/n.md')).toBe('caf\u00e9/n.md');
  });

  test('rejects absolute and ..-escape with ALLOWLIST_VIOLATION', () => {
    expect(code(() => canonicalizeRelative('/abs/x.md'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
    expect(code(() => canonicalizeRelative('../escape.md'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
    expect(code(() => canonicalizeRelative('a/../../escape.md'))).toBe(
      'ALLOWLIST_VIOLATION',
    );
  });
});

describe('canonPrefix', () => {
  test('canonicalizes like a path (trailing slash dropped; empty stays empty)', () => {
    expect(canonPrefix('Public/')).toBe('Public');
    expect(canonPrefix('./a//b/')).toBe('a/b');
    expect(canonPrefix('')).toBe('');
  });

  test('rejects .. with ALLOWLIST_VIOLATION', () => {
    expect(code(() => canonPrefix('../x'))).toBe('ALLOWLIST_VIOLATION');
  });
});
