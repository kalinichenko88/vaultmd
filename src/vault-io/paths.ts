import { isAbsolute } from 'node:path';

import { MdVaultError } from '../errors.ts';

export function canonicalizeRelative(rel: string): string {
  if (isAbsolute(rel)) {
    throw new MdVaultError(
      'ALLOWLIST_VIOLATION',
      `vault path must be relative: ${rel}`,
    );
  }
  const nfc = rel.normalize('NFC').replaceAll('\\', '/');
  const out: string[] = [];
  for (const seg of nfc.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) {
        throw new MdVaultError(
          'ALLOWLIST_VIOLATION',
          `vault path escapes root: ${rel}`,
        );
      }
      out.pop();
      continue;
    }
    out.push(seg);
  }

  return out.join('/');
}

export function canonPrefix(p: string): string {
  // Prefixes are canonicalized like paths: NFC, '/'-separated, no trailing '/'.
  const nfc = p.normalize('NFC').replaceAll('\\', '/');
  const out: string[] = [];
  for (const seg of nfc.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      throw new MdVaultError(
        'ALLOWLIST_VIOLATION',
        `vault prefix may not contain '..': ${p}`,
      );
    }
    out.push(seg);
  }

  return out.join('/');
}
