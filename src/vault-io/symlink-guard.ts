import { lstatSync } from 'node:fs';
import { join } from 'node:path';

// Whether a symlink sits on `canonical` under `root`, the path itself included,
// dangling or not. The vault keeps one path per file (docs/pdr/0001), so such a
// path is refused — and with no link on it, it can neither leave the root nor
// reach hidden state under a visible name. The root is not judged: it may be a
// link, and so may its parents.
export function passesSymlink(root: string, canonical: string): boolean {
  let probe = root;
  for (const segment of canonical.split('/').filter(Boolean)) {
    probe = join(probe, segment);
    try {
      if (lstatSync(probe).isSymbolicLink()) {
        return true;
      }
    } catch (err) {
      // Any other error may hide a link: refuse the path, never fail open.
      return !walkStops.has((err as NodeJS.ErrnoException).code ?? '');
    }
  }

  return false;
}

// lstat errors after which the IO on the same path fails the same way, so
// nothing can be reached through a link there: a missing segment, a file
// above it (a write creates real folders there, a read finds nothing), a
// folder this process may not search, a name the OS does not take.
const walkStops = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'ENAMETOOLONG']);
