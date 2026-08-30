import { existsSync, realpathSync } from 'node:fs';
import { dirname, relative, sep } from 'node:path';

// Where `full` lands once every symlink on its chain is followed, relative to
// the real root — the path both containment and the hidden-state rule are
// judged on. `null` when the target escapes the root; `''` when nothing
// resolves yet, which later IO surfaces as absence. A missing path is judged by
// its nearest existing ancestor, so a write into a symlinked directory is
// caught before the file exists.
export function realTargetRelativeToRoot(
  full: string,
  root: string,
): string | null {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return ''; // root absent: nothing on disk to follow; later IO surfaces it
  }
  let probe = full;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) {
      return ''; // reached fs root, nothing exists yet
    }
    probe = parent;
  }
  let real: string;
  try {
    real = realpathSync(probe);
  } catch {
    return '';
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    return null;
  }

  return relative(realRoot, real);
}
