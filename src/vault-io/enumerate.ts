import type { Dirent } from 'node:fs';
import { readdir, stat as statEntry } from 'node:fs/promises';
import { join } from 'node:path';

import { realTargetWithinRoot } from './realpath-guard.ts';

type EnumerateDeps = {
  isIgnored(rel: string): boolean;
  resolveVaultPath(rel: string, access?: 'read' | 'write'): string;
  toVaultRelative(rel: string): string;
};

async function walk(
  root: string,
  absDir: string,
  relDir: string,
  out: string[],
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
      await walk(root, childAbs, childRel, out, deps);
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
      out.push(deps.toVaultRelative(childRel));
    }
  }
}

export async function listMarkdown(
  root: string,
  dir: string | undefined,
  deps: EnumerateDeps,
): Promise<string[]> {
  const startRel = dir === undefined ? '' : deps.toVaultRelative(dir);
  const startAbs = startRel === '' ? root : join(root, startRel);
  if (!realTargetWithinRoot(startAbs, root)) {
    return [];
  }
  const out: string[] = [];
  await walk(root, startAbs, startRel, out, deps);
  out.sort();

  return out;
}
