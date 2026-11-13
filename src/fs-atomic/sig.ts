import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';

import type { Sig } from './models/sig.ts';

export function makeSig(st: Stats): Sig {
  return { mtimeMs: Math.trunc(st.mtimeMs), size: st.size };
}

export function sigsEqual(a: Sig, b: Sig): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

export async function statSig(fullPath: string): Promise<Sig | null> {
  const st = await statOrNull(fullPath);

  return st && makeSig(st);
}

export async function statOrNull(fullPath: string): Promise<Stats | null> {
  try {
    return await stat(fullPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}
