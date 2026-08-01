import { type Dirent, realpathSync } from 'node:fs';
import { readdir, stat as statEntry } from 'node:fs/promises';
import { join, sep } from 'node:path';

type EnumerateDeps = {
  can(rel: string, access: 'read' | 'write'): boolean;
  isIgnored(rel: string): boolean;
  resolveVaultPath(rel: string, access?: 'read' | 'write'): string;
  toVaultRelative(rel: string): string;
};

type Walked = { files: string[]; folders: string[] };

async function walk(
  realRoot: string,
  absDir: string,
  realDir: string, // fully-resolved location of absDir
  relDir: string,
  out: Walked,
  deps: EnumerateDeps,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return; // missing / unreadable dir
  }
  for (const ent of entries) {
    const name = ent.name;
    const childRel = relDir === '' ? name : `${relDir}/${name}`;
    const childAbs = join(absDir, name);
    let isDir = ent.isDirectory();
    let isFile = ent.isFile();
    if (ent.isSymbolicLink()) {
      try {
        const st = await statEntry(childAbs);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue; // dangling symlink
      }
    }
    if (isDir) {
      if (name.startsWith('.')) {
        continue;
      }
      if (deps.isIgnored(childRel)) {
        continue;
      }
      // A real subdirectory of an in-root directory is trivially in-root, so
      // only a symlink can leave the vault — or aim back at ground we are
      // standing on and loop: `ln -s .. vault/notes/loop` otherwise
      // re-enumerates the whole vault at every level. Two *sibling* links to
      // one target are not a cycle, so the result never depends on readdir order.
      const childReal = ent.isSymbolicLink()
        ? realTarget(childAbs)
        : join(realDir, name);
      if (
        childReal === null ||
        !isUnder(childReal, realRoot) ||
        isUnder(realDir, childReal)
      ) {
        continue;
      }
      if (deps.can(childRel, 'read')) {
        out.folders.push(deps.toVaultRelative(childRel));
      }
      await walk(realRoot, childAbs, childReal, childRel, out, deps);
      continue;
    }
    if (isFile && name.endsWith('.md')) {
      if (deps.isIgnored(childRel)) {
        continue;
      }
      try {
        deps.resolveVaultPath(childRel, 'read');
      } catch {
        continue;
      }
      out.files.push(deps.toVaultRelative(childRel));
    }
  }
}

export async function listMarkdown(
  root: string,
  dir: string | undefined,
  deps: EnumerateDeps,
): Promise<string[]> {
  return (await enumerate(root, dir, deps)).files.sort();
}

export async function listFolders(
  root: string,
  dir: string | undefined,
  deps: EnumerateDeps,
): Promise<string[]> {
  return (await enumerate(root, dir, deps)).folders.sort();
}

async function enumerate(
  root: string,
  dir: string | undefined,
  deps: EnumerateDeps,
): Promise<Walked> {
  const out: Walked = { files: [], folders: [] };
  const startRel = dir === undefined ? '' : deps.toVaultRelative(dir);
  const startAbs = startRel === '' ? root : join(root, startRel);
  const realRoot = realTarget(root);
  const startReal = realTarget(startAbs);
  if (
    realRoot === null ||
    startReal === null ||
    !isUnder(startReal, realRoot)
  ) {
    return out;
  }
  await walk(realRoot, startAbs, startReal, startRel, out, deps);

  return out;
}

// `p` is `ancestor` itself or something beneath it. The trailing separators
// keep `/vault/notes` from reading as a child of `/vault/note`.
function isUnder(p: string, ancestor: string): boolean {
  return (p + sep).startsWith(ancestor + sep);
}

function realTarget(abs: string): string | null {
  try {
    return realpathSync(abs);
  } catch {
    return null;
  }
}
