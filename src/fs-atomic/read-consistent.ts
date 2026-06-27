import { readFile } from 'node:fs/promises';

import { type Sig, sigsEqual, statSig } from './sig.ts';

type ConsistentRead =
  | { content: string; sig: Sig }
  | { content: null; sig: null };

// stat -> read -> stat: only return a (content, sig) pair captured while the
// file did not change under us. Missing file -> { content: null, sig: null }.
export async function readConsistent(
  fullPath: string,
): Promise<ConsistentRead> {
  for (;;) {
    const sig1 = await statSig(fullPath);
    if (sig1 === null) {
      return { content: null, sig: null };
    }
    let content: string;
    try {
      content = await readFile(fullPath, 'utf8');
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
