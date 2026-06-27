import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';

export type Sig = { mtimeMs: number; size: number };

export function makeSig(st: Stats): Sig {
  return { mtimeMs: Math.trunc(st.mtimeMs), size: st.size };
}

export function sigsEqual(a: Sig, b: Sig): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

export async function statSig(fullPath: string): Promise<Sig | null> {
  try {
    return makeSig(await stat(fullPath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}
