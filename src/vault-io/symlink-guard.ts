import { lstatSync } from 'node:fs';
import { join } from 'node:path';

// Whether a symlink sits on `canonical` under `root`, the path itself included,
// dangling or not. The vault keeps one path per file (docs/pdr/0001), so such a
// path is refused — and with no link on it, it can neither leave the root nor
// reach hidden state under a visible name. The root is not judged: it may be a
// link, and so may its parents. The walk stops at the first segment that does
// not exist, or that has a file above it: a write creates real directories
// there, and a read finds nothing. Any other lstat error is thrown, not read as
// "no symlink": the guard never fails open.
export function passesSymlink(root: string, canonical: string): boolean {
  let probe = root;
  for (const segment of canonical.split('/').filter(Boolean)) {
    probe = join(probe, segment);
    try {
      if (lstatSync(probe).isSymbolicLink()) {
        return true;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return false;
      }
      throw err;
    }
  }

  return false;
}
