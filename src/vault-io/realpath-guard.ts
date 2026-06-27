import { existsSync, realpathSync } from 'node:fs';
import { dirname, sep } from 'node:path';

export function realTargetWithinRoot(full: string, root: string): boolean {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return true; // root absent: nothing on disk to follow; later IO surfaces it
  }
  let probe = full;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return true; // reached fs root, nothing exists yet
    probe = parent;
  }
  let real: string;
  try {
    real = realpathSync(probe);
  } catch {
    return true;
  }

  return real === realRoot || real.startsWith(realRoot + sep);
}
