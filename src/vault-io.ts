import {
  type Dirent,
  existsSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { readdir, stat as statEntry } from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  resolve as resolvePath,
  sep,
} from 'node:path';

import { MdVaultError } from './errors.ts';
import {
  type Sig,
  atomicWrite,
  atomicWriteIfUnchanged,
  unlinkIfUnchanged as fsUnlinkIfUnchanged,
  readConsistent,
  statSig,
} from './fs-atomic.ts';

export type Access = 'read' | 'write';
export type VaultPrefixes = { read: string[]; write: string[] };
export type VaultIoConfig = {
  root: string;
  prefixes: VaultPrefixes;
  caseSensitive?: boolean;
  ignore?: string[];
};
export type VaultIo = {
  toVaultRelative(rel: string): string;
  toKey(rel: string): string;
  can(rel: string, access: Access): boolean;
  resolveVaultPath(rel: string, access?: Access): string;
  readVaultFile(rel: string): Promise<{ content: string; sig: Sig } | null>;
  writeVaultFile(rel: string, content: string): Promise<Sig>;
  rewriteIfUnchanged(rel: string, content: string, expected: Sig): Promise<Sig>;
  unlinkIfUnchanged(rel: string, expected: Sig): Promise<boolean>;
  stat(rel: string): Promise<Sig | null>;
  listMarkdown(dir?: string): Promise<string[]>;
};

const caseSensitiveCache = new Map<string, boolean>();

export function createVaultIo(config: VaultIoConfig): VaultIo {
  const root = resolvePath(config.root);
  const caseSensitive = resolveCaseSensitive(root, config.caseSensitive);
  const canonPrefixes: VaultPrefixes = {
    read: config.prefixes.read.map(canonPrefix),
    write: config.prefixes.write.map(canonPrefix),
  };
  const ignoreRes = (config.ignore ?? []).map(globToRegExp);

  function toVaultRelative(rel: string): string {
    if (isAbsolute(rel)) {
      throw new MdVaultError(
        'ALLOWLIST_VIOLATION',
        `vault path must be relative: ${rel}`,
      );
    }
    const nfc = rel.normalize('NFC').replaceAll('\\', '/');
    const out: string[] = [];
    for (const seg of nfc.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (out.length === 0) {
          throw new MdVaultError(
            'ALLOWLIST_VIOLATION',
            `vault path escapes root: ${rel}`,
          );
        }
        out.pop();
        continue;
      }
      out.push(seg);
    }

    return out.join('/');
  }

  function toKey(rel: string): string {
    const canonical = toVaultRelative(rel);

    return caseSensitive ? canonical : canonical.toLowerCase();
  }

  function matches(x: string, prefixes: string[]): boolean {
    for (const p of prefixes) {
      if (p === '') return true;
      if (x === p) return true;
      if (x.startsWith(`${p}/`)) return true;
    }

    return false;
  }

  function can(rel: string, access: Access): boolean {
    let x: string;
    try {
      x = toVaultRelative(rel);
    } catch {
      return false;
    }

    return matches(x, canonPrefixes[access]);
  }

  function realTargetWithinRoot(full: string): boolean {
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

  function resolveVaultPath(rel: string, access: Access = 'read'): string {
    const canonical = toVaultRelative(rel);
    if (!canonical.endsWith('.md')) {
      throw new MdVaultError('NOT_MARKDOWN', `not a markdown path: ${rel}`);
    }
    if (!matches(canonical, canonPrefixes[access])) {
      throw new MdVaultError(
        'ALLOWLIST_VIOLATION',
        `path outside ${access} allowlist: ${rel}`,
      );
    }
    const full = join(root, canonical);
    if (!realTargetWithinRoot(full)) {
      throw new MdVaultError(
        'ALLOWLIST_VIOLATION',
        `vault path escapes root (symlink): ${rel}`,
      );
    }

    return full;
  }

  async function readVaultFile(
    rel: string,
  ): Promise<{ content: string; sig: Sig } | null> {
    const full = resolveVaultPath(rel, 'read');
    const result = await readConsistent(full);
    if (result.content === null) {
      return null;
    }

    return { content: result.content, sig: result.sig };
  }

  async function writeVaultFile(rel: string, content: string): Promise<Sig> {
    const full = resolveVaultPath(rel, 'write');

    return atomicWrite(full, content);
  }

  async function rewriteIfUnchanged(
    rel: string,
    content: string,
    expected: Sig,
  ): Promise<Sig> {
    const full = resolveVaultPath(rel, 'write');

    return atomicWriteIfUnchanged(full, content, expected);
  }

  async function unlinkIfUnchanged(
    rel: string,
    expected: Sig,
  ): Promise<boolean> {
    const full = resolveVaultPath(rel, 'write');

    return fsUnlinkIfUnchanged(full, expected);
  }

  async function stat(rel: string): Promise<Sig | null> {
    const full = resolveVaultPath(rel, 'read');

    return statSig(full);
  }

  function isIgnored(rel: string): boolean {
    return ignoreRes.some((re) => re.test(rel));
  }

  async function walk(
    absDir: string,
    relDir: string,
    out: string[],
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
          const st = await statEntry(childAbs); // follows the link to classify the target
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue; // dangling symlink
        }
      }
      if (isDir) {
        if (name.startsWith('.')) continue; // dotfolders: .obsidian/.trash/.git/...
        if (isIgnored(childRel)) continue;
        if (!realTargetWithinRoot(childAbs)) continue; // don't descend an escaping symlinked dir
        await walk(childAbs, childRel, out);
        continue;
      }
      if (isFile && name.endsWith('.md')) {
        if (isIgnored(childRel)) continue;
        try {
          resolveVaultPath(childRel, 'read'); // realpath-guard + read-scope before indexing
        } catch {
          continue;
        }
        out.push(toVaultRelative(childRel));
      }
    }
  }

  async function listMarkdown(dir?: string): Promise<string[]> {
    const startRel = dir === undefined ? '' : toVaultRelative(dir);
    const startAbs = startRel === '' ? root : join(root, startRel);
    if (!realTargetWithinRoot(startAbs)) return [];
    const out: string[] = [];
    await walk(startAbs, startRel, out);
    out.sort();

    return out;
  }

  return {
    toVaultRelative,
    toKey,
    can,
    resolveVaultPath,
    readVaultFile,
    writeVaultFile,
    rewriteIfUnchanged,
    unlinkIfUnchanged,
    stat,
    listMarkdown,
  };
}

function canonPrefix(p: string): string {
  // Prefixes are canonicalized like paths: NFC, '/'-separated, no trailing '/'.
  const nfc = p.normalize('NFC').replaceAll('\\', '/');
  const out: string[] = [];
  for (const seg of nfc.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      throw new MdVaultError(
        'ALLOWLIST_VIOLATION',
        `vault prefix may not contain '..': ${p}`,
      );
    }
    out.push(seg);
  }

  return out.join('/');
}

function resolveCaseSensitive(root: string, override?: boolean): boolean {
  if (override !== undefined) return override;
  const cached = caseSensitiveCache.get(root);
  if (cached !== undefined) return cached;
  const detected = detectCaseSensitive(root);
  caseSensitiveCache.set(root, detected);

  return detected;
}

function detectCaseSensitive(root: string): boolean {
  const probe = join(root, `.mdvault-case-probe-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(probe, 'x');
    const flipped =
      probe === probe.toUpperCase() ? probe.toLowerCase() : probe.toUpperCase();
    try {
      const a = statSync(probe);
      const b = statSync(flipped);

      return !(a.ino === b.ino && a.dev === b.dev);
    } catch {
      return true;
    }
  } catch {
    return true;
  } finally {
    try {
      unlinkSync(probe);
    } catch {
      // best-effort cleanup
    }
  }
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i += 2;
      if (glob[i] === '/') {
        re += '(?:.*/)?'; // **/ -> zero or more leading path segments
        i += 1;
      } else {
        re += '.*'; // trailing ** -> anything, including '/'
      }
      continue;
    }
    if (c === '*') {
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }

  return new RegExp(`^${re}$`);
}
