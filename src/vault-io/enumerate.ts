import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { isHidden } from './paths.ts';
import { passesSymlink } from './symlink-guard.ts';

type EnumerateDeps = {
  can(rel: string, access: 'read' | 'write'): boolean;
  isIgnored(rel: string): boolean;
  resolveVaultPath(rel: string, access?: 'read' | 'write'): string;
  toVaultRelative(rel: string): string;
};

type Walked = { files: string[]; folders: string[] };

async function walk(
  absDir: string,
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
    // A symlink is skipped, never followed: one file has one path. With no
    // link to follow, the walk can neither leave the root nor loop.
    if (ent.isSymbolicLink()) {
      continue;
    }
    const name = ent.name;
    const childRel = relDir === '' ? name : `${relDir}/${name}`;
    if (ent.isDirectory()) {
      if (name.startsWith('.')) {
        continue;
      }
      if (deps.isIgnored(childRel)) {
        continue;
      }
      if (deps.can(childRel, 'read')) {
        out.folders.push(deps.toVaultRelative(childRel));
      }
      await walk(join(absDir, name), childRel, out, deps);
      continue;
    }
    if (ent.isFile() && name.endsWith('.md')) {
      if (deps.isIgnored(childRel)) {
        continue;
      }
      // The full gate, not just the read scope: a name's canonical form can
      // differ from the walked name (a `\` in it on POSIX, NFC), and it is the
      // canonical path that reconcile will resolve.
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
  // Nothing under a hidden folder can be listed, so it is not walked.
  if (isHidden(startRel) || passesSymlink(root, startRel)) {
    return out;
  }
  await walk(join(root, startRel), startRel, out, deps);

  return out;
}
