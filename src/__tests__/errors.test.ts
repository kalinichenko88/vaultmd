import { describe, expect, test } from 'bun:test';

import { MdVaultError } from '../errors.ts';

describe('MdVaultError', () => {
  test('sets a readable, stable code', () => {
    const err = new MdVaultError('ALLOWLIST_VIOLATION', 'outside read scope');

    expect(err.code).toBe('ALLOWLIST_VIOLATION');
  });

  test('passes the message through to Error', () => {
    const err = new MdVaultError('NOT_MARKDOWN', 'only .md files are allowed');

    expect(err.message).toBe('only .md files are allowed');
  });

  test('is a real Error and an MdVaultError (instanceof both)', () => {
    const err = new MdVaultError('NOT_FOUND', 'missing');

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MdVaultError);
  });

  test('sets name to "MdVaultError" (survives stringification)', () => {
    const err = new MdVaultError('MTIME_CONFLICT', 'changed under us');

    expect(err.name).toBe('MdVaultError');
    expect(String(err)).toBe('MdVaultError: changed under us');
  });

  test('preserves the original error as cause', () => {
    const original = new Error('onCommit blew up');
    const err = new MdVaultError('COMMIT_FAILED', 'commit hook failed', {
      cause: original,
    });

    expect(err.cause).toBe(original);
  });

  test('preserves a non-Error cause value', () => {
    const err = new MdVaultError('INDEX_UNAVAILABLE', 'probe failed', {
      cause: 'FTS5 missing',
    });

    expect(err.cause).toBe('FTS5 missing');
  });

  test('cause is undefined when no options given', () => {
    const err = new MdVaultError('REFUSE_CREATE', 'will not create');

    expect(err.cause).toBeUndefined();
  });

  test('is catchable by code after being thrown', () => {
    const throwing = () => {
      throw new MdVaultError('AMBIGUOUS_MATCH', 'more than one match');
    };

    try {
      throwing();
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MdVaultError);
      expect((e as MdVaultError).code).toBe('AMBIGUOUS_MATCH');
    }
  });
});
