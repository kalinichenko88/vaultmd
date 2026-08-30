import { readFile } from 'node:fs/promises';

import type { Sig } from './models/sig.ts';
import { sigsEqual, statSig } from './sig.ts';

type ConsistentRead<T> =
  | { content: T; sig: Sig }
  | { content: null; sig: null };

// stat -> read -> stat: only return a (content, sig) pair captured while the
// file did not change under us. Missing file -> { content: null, sig: null }.
export async function readConsistent(
  fullPath: string,
): Promise<ConsistentRead<string>> {
  return readStable(fullPath, (p) => readFile(p, 'utf8'));
}

// readConsistent for files that are not text — same race guard, raw bytes.
export async function readConsistentBytes(
  fullPath: string,
): Promise<ConsistentRead<Uint8Array>> {
  return readStable(fullPath, async (p) => {
    const buf = await readFile(p);

    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  });
}

async function readStable<T>(
  fullPath: string,
  read: (path: string) => Promise<T>,
): Promise<ConsistentRead<T>> {
  for (;;) {
    const sig1 = await statSig(fullPath);
    if (sig1 === null) {
      return { content: null, sig: null };
    }
    let content: T;
    try {
      content = await read(fullPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }

      throw err;
    }
    const sig2 = await statSig(fullPath);
    if (sig2 !== null && sigsEqual(sig1, sig2)) {
      return { content, sig: sig2 };
    }
  }
}
