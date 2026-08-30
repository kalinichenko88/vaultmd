import { isAbsolute } from 'node:path';

import { MdVaultError } from '@/errors.ts';

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
    if (seg === '' || seg === '.') {
      continue;
    }
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

// A path is hidden if any segment starts with a dot — the rule the enumeration
// walk applies to folders, here to whole paths. Splits on either separator so a
// `relative()` result works untouched. An empty path is the vault root itself,
// which is never hidden.
export function isHidden(path: string): boolean {
  return path.split(/[/\\]/).some((seg) => seg.startsWith('.'));
}

export function canonPrefix(p: string): string {
  // Prefixes are canonicalized like paths: NFC, '/'-separated, no trailing '/'.
  const nfc = p.normalize('NFC').replaceAll('\\', '/');
  const out: string[] = [];
  for (const seg of nfc.split('/')) {
    if (seg === '' || seg === '.') {
      continue;
    }
    if (seg === '..') {
      throw new MdVaultError(
        'ALLOWLIST_VIOLATION',
        `vault prefix may not contain '..': ${p}`,
      );
    }
    // Hidden state is unreachable through the chokepoint, so a hidden prefix is
    // unsatisfiable: fail here rather than dead-end every later call.
    if (seg.startsWith('.')) {
      throw new MdVaultError(
        'ALLOWLIST_VIOLATION',
        `vault prefix may not be hidden: ${p}`,
      );
    }
    out.push(seg);
  }

  return out.join('/');
}
