import { type Dirent, realpathSync } from 'node:fs';
import { readdir, stat as statEntry } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { realTargetWithinRoot } from './realpath-guard.ts';

type EnumerateDeps = {
  can(rel: string, access: 'read' | 'write'): boolean;
  isIgnored(rel: string): boolean;
  resolveVaultPath(rel: string, access?: 'read' | 'write'): string;
  toVaultRelative(rel: string): string;
};

type Walked = { files: string[]; folders: string[] };

async function walk(
  root: string,
  absDir: string,
  // Fully-resolved location of absDir. Tracked so a symlink that jumps back
  // onto our own ancestry is recognised as the cycle it is; see enterable().
  realDir: string,
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
      if (!realTargetWithinRoot(childAbs, root)) {
        continue;
      }
      const childReal = ent.isSymbolicLink()
        ? realTarget(childAbs)
        : join(realDir, name);
      if (childReal === null || !enterable(childReal, realDir)) {
        continue;
      }
      if (deps.can(childRel, 'read')) {
        out.folders.push(deps.toVaultRelative(childRel));
      }
      await walk(root, childAbs, childReal, childRel, out, deps);
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
  const startReal = realTarget(startAbs);
  if (startReal === null || !realTargetWithinRoot(startAbs, root)) {
    return out;
  }
  await walk(root, startAbs, startReal, startRel, out, deps);

  return out;
}

// Whether descending into a directory whose real location is `childReal`
// advances the walk rather than re-entering ground we are standing on. A dir
// symlink aimed at its own ancestor (`ln -s .. vault/notes/loop`) otherwise
// re-enumerates the whole vault under an aliased path at every level until the
// kernel's symlink limit stops it, indexing each note dozens of times over.
// Two *sibling* links to one target are not a cycle and are both walked, so the
// result never depends on readdir order.
function enterable(childReal: string, realDir: string): boolean {
  return childReal !== realDir && !realDir.startsWith(childReal + sep);
}

function realTarget(abs: string): string | null {
  try {
    return realpathSync(abs);
  } catch {
    return null;
  }
}
