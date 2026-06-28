import { statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const caseSensitiveCache = new Map<string, boolean>();

export function resolveCaseSensitive(
  root: string,
  override?: boolean,
): boolean {
  if (override !== undefined) {
    return override;
  }
  const cached = caseSensitiveCache.get(root);
  if (cached !== undefined) {
    return cached;
  }
  const detected = detectCaseSensitive(root);
  caseSensitiveCache.set(root, detected);

  return detected;
}

export function detectCaseSensitive(root: string): boolean {
  const probe = join(root, `.vaultmd-case-probe-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(probe, 'x');
    const flipped =
      probe === probe.toUpperCase() ? probe.toLowerCase() : probe.toUpperCase();
    try {
      const a = statSync(probe);
      const b = statSync(flipped);

      return !(a.ino === b.ino && a.dev === b.dev);
    } catch {
      return true;
    }
  } catch {
    return true;
  } finally {
    try {
      unlinkSync(probe);
    } catch {
      // best-effort cleanup
    }
  }
}
