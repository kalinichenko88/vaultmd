# mdvault Module-Folder Reorganization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize `src/` from seven flat files into one folder-per-responsibility module layout (each module = one area, barrel + small single-purpose leaf files, co-located unit tests), with zero change to the package public API.

**Architecture:** Behavior-preserving refactor guarded by the existing test suite. Each module becomes `src/<module>/` with an `index.ts` barrel (curated named re-exports), single-purpose leaf files, and a `__tests__/` of per-file unit tests. `fs-atomic.ts` splits into `fs-atomic/` (atomic single-file ops) + a new `locks/` module (concurrency). `vault-io.ts`'s pure helpers are extracted out of its closure. The package barrel `src/index.ts` keeps its exact 26 exported names; only import paths move.

**Tech Stack:** Bun, TypeScript (ESM, `verbatimModuleSyntax`), `bun:test`, Biome, `yaml` (only runtime dep).

**Design spec:** `docs/superpowers/specs/2026-06-27-mdvault-module-reorg-design.md`

## Global Constraints

(Every task implicitly includes these. Values copied from the spec.)

- **Runtime:** Bun only. `engines.bun >= 1.1.0`. ESM, `"type":"module"`. No new dependencies (runtime dep stays `yaml` only).
- **Imports:** every relative import carries the explicit `.ts` extension. **Production cross-module imports go through the target module's barrel** (`../fs-atomic/index.ts`); **within** a module, sibling leaf imports are normal (`./sig.ts`); **tests may import leaf files** for white-box unit testing.
- **`verbatimModuleSyntax`:** type-only imports use `import type`; mixed value+type use the inline `type` modifier (`import { type Sig, statSig }`).
- **Style:** `type` never `interface`; Biome single-quote / 2-space; blank line before `return` unless it is the first/only statement in its block.
- **Barrels:** named re-exports only — **never `export *`**; types via `export type { … }`.
- **Behavior-preserving:** no control-flow/algorithm changes. The only non-move edits are: (a) `readConsistent` reuses `sigsEqual`; (b) `toVaultRelative`'s body becomes the pure `canonicalizeRelative`; (c) three vault-io helpers gain explicit params once de-closured (`realTargetWithinRoot(full, root)`, `matches(x, prefixes)`, `listMarkdown(root, dir, deps)`). All are covered by existing/relocated tests.
- **Package API frozen:** `src/index.ts` re-exports exactly these 26 names — 10 values (`MdVaultError`, `createVaultIo`, `deriveTags`, `editFrontmatter`, `extractLinks`, `isFlatFrontmatter`, `parseFrontmatter`, `storedLinksFor`, `withFileDelete`, `withFileTransform`) + 16 types (`Access`, `CommitEvent`, `CrossLock`, `EditOutcome`, `ExtractedLinks`, `FrontmatterValidity`, `LinkResolution`, `MdVaultCode`, `ParsedFrontmatter`, `Sig`, `StoredLink`, `TransformOpts`, `TransformResult`, `VaultIo`, `VaultIoConfig`, `VaultPrefixes`). Only `from` paths change.
- **Tests:** per-module `<module>/__tests__/`; the three root-level tests (`index.test.ts`, `errors.test.ts`, `scaffold.test.ts`) stay in `src/__tests__/`.
- **`tsconfig.include` is `["src"]`** → `tsc --noEmit` checks the whole tree. After every task the repo must typecheck and all tests must pass; no dangling imports, no temporary shims / `export *`.
- **"MOVE verbatim"** in a step means: cut the named symbols from the old file **unchanged** (do not retype bodies) and only adjust the file's import header as shown. Full code is given only for genuinely new/changed code.
- **Commits:** conventional, one per task, `--no-gpg-sign`.

## File Structure (end state)

```
src/
├── index.ts                  # package barrel (26 names; paths point at folder barrels)
├── errors.ts                 # unchanged
├── __tests__/{index,errors,scaffold}.test.ts
├── fs-atomic/{index,sig,atomic-write,read-consistent}.ts  + __tests__/{sig,atomic-write,read-consistent}.test.ts
├── locks/{index,in-process,cross-process}.ts              + __tests__/{in-process,cross-process}.test.ts
├── vault-io/{index,create-vault-io,paths,allowlist,realpath-guard,enumerate,case-sensitivity,glob}.ts
│                                                          + __tests__/{create-vault-io,paths,allowlist,realpath-guard,glob}.test.ts
├── locked-file/{index,types,commit,transform,delete}.ts   + __tests__/{transform,delete}.test.ts
├── frontmatter/{index,types,validate,tags,parse,edit}.ts  + __tests__/{validate,tags,parse,edit}.test.ts
└── links/{index,types,extract,resolve}.ts                 + __tests__/{extract,resolve}.test.ts
```

Tasks run in dependency order so the tree typechecks after each: **1** fs-atomic+locks → **2** vault-io → **3** locked-file → **4** frontmatter → **5** links → **6** strengthen `index.test.ts` → **7** packaging.

---

### Task 1: Split `fs-atomic.ts` into `fs-atomic/` + new `locks/`

**Files:**
- Create: `src/fs-atomic/sig.ts`, `src/fs-atomic/atomic-write.ts`, `src/fs-atomic/read-consistent.ts`, `src/fs-atomic/index.ts`
- Create: `src/locks/in-process.ts`, `src/locks/cross-process.ts`, `src/locks/index.ts`
- Create tests: `src/fs-atomic/__tests__/sig.test.ts`, `src/fs-atomic/__tests__/atomic-write.test.ts`, `src/fs-atomic/__tests__/read-consistent.test.ts` (NEW), `src/locks/__tests__/in-process.test.ts`, `src/locks/__tests__/cross-process.test.ts`
- Modify (importers): `src/index.ts`, `src/vault-io.ts`, `src/locked-file.ts`, `src/__tests__/locked-file.test.ts`
- Delete: `src/fs-atomic.ts`, `src/__tests__/fs-atomic.test.ts`

**Interfaces:**
- Consumes: `MdVaultError` from `./errors.ts` (unchanged).
- Produces (barrels):
  - `fs-atomic/index.ts` → `type Sig`, `statSig`, `atomicWrite`, `atomicWriteIfUnchanged`, `exclusiveCreate`, `unlinkIfUnchanged`, `readConsistent`
  - `locks/index.ts` → `withFileLock`, `withCrossProcessLock`

- [ ] **Step 1: Create `src/fs-atomic/sig.ts`** — MOVE verbatim from `src/fs-atomic.ts` the `Sig` type, `makeSig`, `sigsEqual`, `statSig`. Header:

```ts
import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';

export type Sig = { mtimeMs: number; size: number };

export function makeSig(st: Stats): Sig {
  return { mtimeMs: Math.trunc(st.mtimeMs), size: st.size };
}

export function sigsEqual(a: Sig, b: Sig): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

export async function statSig(fullPath: string): Promise<Sig | null> {
  try {
    return makeSig(await stat(fullPath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}
```

- [ ] **Step 2: Create `src/fs-atomic/atomic-write.ts`** — MOVE verbatim `tempPath`, `atomicWrite`, `atomicWriteIfUnchanged`, `exclusiveCreate`, `unlinkIfUnchanged` from `src/fs-atomic.ts`. Header (note `makeSig`/`sigsEqual`/`statSig`/`Sig` now imported from `./sig.ts`):

```ts
import { randomBytes } from 'node:crypto';
import { link, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { MdVaultError } from '../errors.ts';
import { type Sig, makeSig, sigsEqual, statSig } from './sig.ts';
```

(The five function bodies are unchanged from the original.)

- [ ] **Step 3: Create `src/fs-atomic/read-consistent.ts`** — MOVE `readConsistent` (and its local `ConsistentRead` type) from `src/fs-atomic.ts`, **changing the inline signature compare to `sigsEqual`** (the one non-move edit):

```ts
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
```

- [ ] **Step 4: Create `src/fs-atomic/index.ts`** (barrel):

```ts
export type { Sig } from './sig.ts';
export { statSig } from './sig.ts';
export {
  atomicWrite,
  atomicWriteIfUnchanged,
  exclusiveCreate,
  unlinkIfUnchanged,
} from './atomic-write.ts';
export { readConsistent } from './read-consistent.ts';
```

- [ ] **Step 5: Create `src/locks/in-process.ts`** — MOVE verbatim `fileLocks` + `withFileLock` from `src/fs-atomic.ts` (no imports needed):

```ts
const fileLocks = new Map<string, Promise<void>>();

export async function withFileLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  // ... body unchanged from fs-atomic.ts ...
}
```

- [ ] **Step 6: Create `src/locks/cross-process.ts`** — MOVE verbatim `delay`, `tryReclaim`, `withCrossProcessLock` from `src/fs-atomic.ts`. Header:

```ts
import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import * as path from 'node:path';

import { MdVaultError } from '../errors.ts';
```

- [ ] **Step 7: Create `src/locks/index.ts`** (barrel):

```ts
export { withFileLock } from './in-process.ts';
export { withCrossProcessLock } from './cross-process.ts';
```

- [ ] **Step 8: Delete `src/fs-atomic.ts`** (all symbols now live in the two new folders).

- [ ] **Step 9: Update importer `src/index.ts`** — change the one fs-atomic line:

```ts
export type { Sig } from './fs-atomic/index.ts';
```

- [ ] **Step 10: Update importer `src/vault-io.ts`** (still flat) — change its fs-atomic import block to the barrel path (names unchanged):

```ts
import {
  type Sig,
  atomicWrite,
  atomicWriteIfUnchanged,
  unlinkIfUnchanged as fsUnlinkIfUnchanged,
  readConsistent,
  statSig,
} from './fs-atomic/index.ts';
```

- [ ] **Step 11: Update importer `src/locked-file.ts`** (still flat) — split its single fs-atomic import into fs-atomic + locks:

```ts
import {
  atomicWrite,
  atomicWriteIfUnchanged,
  readConsistent,
  statSig,
  unlinkIfUnchanged,
} from './fs-atomic/index.ts';
import { withCrossProcessLock, withFileLock } from './locks/index.ts';
```

- [ ] **Step 12: Update importer `src/__tests__/locked-file.test.ts`** — it only uses `statSig` (assertions + the `MTIME_CONFLICT` spy). Retarget the namespace import to the **definition leaf** and rename the local alias:

  Replace `import * as fsAtomic from '../fs-atomic.ts';` with:
```ts
import * as fsSig from '../fs-atomic/sig.ts';
```
  Then replace every `fsAtomic.statSig` with `fsSig.statSig` (occurs at the 5 assertion sites and in `spyOn(fsSig, 'statSig')`). No other change.

- [ ] **Step 13: Move/split the fs-atomic tests.** Delete `src/__tests__/fs-atomic.test.ts` after distributing its 4 describes:
  - `src/fs-atomic/__tests__/sig.test.ts` — the `statSig returns null for a missing file` test (from the `statSig + atomicWrite` describe), importing `import { statSig } from '../sig.ts';`. Add a sig-shape assertion:
```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { statSig } from '../sig.ts';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mdvault-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('statSig', () => {
  test('returns null for a missing file', async () => {
    expect(await statSig(join(dir, 'nope.md'))).toBeNull();
  });

  test('returns an integer-ms sig for an existing file', async () => {
    const f = join(dir, 'a.md');
    await writeFile(f, 'hello');
    const sig = await statSig(f);
    expect(sig?.size).toBe(5);
    expect(Number.isInteger(sig?.mtimeMs)).toBe(true);
  });
});
```
  - `src/fs-atomic/__tests__/atomic-write.test.ts` — MOVE the remaining `statSig + atomicWrite` tests (atomicWrite / atomicWriteIfUnchanged) and the whole `exclusiveCreate + unlinkIfUnchanged` describe. Imports: `import { atomicWrite, atomicWriteIfUnchanged, exclusiveCreate, unlinkIfUnchanged } from '../atomic-write.ts';`, `import { statSig } from '../sig.ts';`, `import { MdVaultError } from '../../errors.ts';` (paths now `../../errors.ts`).
  - `src/locks/__tests__/in-process.test.ts` — MOVE the `withFileLock` describe; `import { withFileLock } from '../in-process.ts';`.
  - `src/locks/__tests__/cross-process.test.ts` — MOVE the `withCrossProcessLock` describe; `import { withCrossProcessLock } from '../cross-process.ts';`, `import { MdVaultError } from '../../errors.ts';`, and its `statSig` usage via `import { statSig } from '../../fs-atomic/sig.ts';`.

- [ ] **Step 14: Create `src/fs-atomic/__tests__/read-consistent.test.ts`** (NEW — deterministic retry via definition-leaf statSig spy):

```ts
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readConsistent } from '../read-consistent.ts';
import * as sig from '../sig.ts';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mdvault-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('readConsistent', () => {
  test('missing file → { content: null, sig: null }', async () => {
    expect(await readConsistent(join(dir, 'nope.md'))).toEqual({
      content: null,
      sig: null,
    });
  });

  test('stable file → content with a matching sig', async () => {
    const f = join(dir, 'a.md');
    await writeFile(f, 'hello');
    const res = await readConsistent(f);
    expect(res.content).toBe('hello');
    expect(res.sig).toEqual(await sig.statSig(f));
  });

  test('sig changes between the two stats → retries once, then converges', async () => {
    const f = join(dir, 'a.md');
    await writeFile(f, 'stable');
    const real = sig.statSig;
    let n = 0;
    const spy = spyOn(sig, 'statSig').mockImplementation(async (p: string) => {
      n++;
      const r = await real(p);
      // 2nd call is the post-read re-stat of iteration 1: make it disagree with
      // the pre-read stat so the loop retries; all later calls are real.
      if (n === 2 && r) {
        return { mtimeMs: r.mtimeMs + 1, size: r.size + 1 };
      }

      return r;
    });
    try {
      const res = await readConsistent(f);
      expect(res.content).toBe('stable');
      expect(res.sig).toEqual(await real(f));
      expect(n).toBeGreaterThanOrEqual(4); // looped at least twice
    } finally {
      spy.mockRestore();
    }
  });
});
```

- [ ] **Step 15: Run tests + typecheck.** `Run: bun test && bun run check`. Expected: all green (the moved suites pass at their new paths; the NEW read-consistent suite passes; `tsc --noEmit` resolves every import — `src/fs-atomic.ts` no longer referenced anywhere).

- [ ] **Step 16: Commit.**
```bash
git add -A && git commit --no-gpg-sign -m "refactor(fs-atomic,locks): split fs-atomic.ts into fs-atomic/ + locks/ modules with co-located tests"
```

---

### Task 2: Split `vault-io.ts` into `vault-io/`

**Files:**
- Create: `src/vault-io/paths.ts`, `src/vault-io/allowlist.ts`, `src/vault-io/realpath-guard.ts`, `src/vault-io/case-sensitivity.ts`, `src/vault-io/glob.ts`, `src/vault-io/enumerate.ts`, `src/vault-io/create-vault-io.ts`, `src/vault-io/index.ts`
- Create tests: `src/vault-io/__tests__/create-vault-io.test.ts`, `src/vault-io/__tests__/paths.test.ts` (NEW), `src/vault-io/__tests__/allowlist.test.ts` (NEW), `src/vault-io/__tests__/realpath-guard.test.ts` (NEW), `src/vault-io/__tests__/glob.test.ts` (NEW)
- Modify: `src/index.ts`
- Delete: `src/vault-io.ts`, `src/__tests__/vault-io.test.ts`

**Interfaces:**
- Consumes: `fs-atomic/index.ts` (`Sig`, `atomicWrite`, `atomicWriteIfUnchanged`, `readConsistent`, `statSig`, `unlinkIfUnchanged`), `./errors.ts`.
- Produces (`vault-io/index.ts`): `type Access`, `type VaultPrefixes`, `type VaultIoConfig`, `type VaultIo`, `createVaultIo`.

- [ ] **Step 1: Create `src/vault-io/paths.ts`** — `canonicalizeRelative` is the body of today's `toVaultRelative`; `canonPrefix` MOVED verbatim:

```ts
import { isAbsolute } from 'node:path';

import { MdVaultError } from '../errors.ts';

export function canonicalizeRelative(rel: string): string {
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

export function canonPrefix(p: string): string {
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
```

- [ ] **Step 2: Create `src/vault-io/allowlist.ts`** (de-closured `matches`):

```ts
export function matches(x: string, prefixes: string[]): boolean {
  for (const p of prefixes) {
    if (p === '') return true;
    if (x === p) return true;
    if (x.startsWith(`${p}/`)) return true;
  }

  return false;
}
```

- [ ] **Step 3: Create `src/vault-io/realpath-guard.ts`** (de-closured `realTargetWithinRoot(full, root)`):

```ts
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
```

- [ ] **Step 4: Create `src/vault-io/case-sensitivity.ts`** — MOVE verbatim `caseSensitiveCache`, `resolveCaseSensitive`, `detectCaseSensitive`:

```ts
import { statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const caseSensitiveCache = new Map<string, boolean>();

export function resolveCaseSensitive(root: string, override?: boolean): boolean {
  // ... body unchanged ...
}

export function detectCaseSensitive(root: string): boolean {
  // ... body unchanged ...
}
```

- [ ] **Step 5: Create `src/vault-io/glob.ts`** — MOVE verbatim `globToRegExp` (no imports).

- [ ] **Step 6: Create `src/vault-io/enumerate.ts`** — `walk` + `listMarkdown` de-closured (take `root` + a `deps` object; `realTargetWithinRoot` imported and called with `root`):

```ts
import { type Dirent, readdir, stat as statEntry } from 'node:fs/promises';
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
      if (name.startsWith('.')) continue;
      if (deps.isIgnored(childRel)) continue;
      if (!realTargetWithinRoot(childAbs, root)) continue;
      await walk(root, childAbs, childRel, out, deps);
      continue;
    }
    if (isFile && name.endsWith('.md')) {
      if (deps.isIgnored(childRel)) continue;
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
  if (!realTargetWithinRoot(startAbs, root)) return [];
  const out: string[] = [];
  await walk(root, startAbs, startRel, out, deps);
  out.sort();

  return out;
}
```

- [ ] **Step 7: Create `src/vault-io/create-vault-io.ts`** (the factory + public types; thin methods delegating to the extracted helpers):

```ts
import { join, resolve as resolvePath } from 'node:path';

import { MdVaultError } from '../errors.ts';
import {
  type Sig,
  atomicWrite,
  atomicWriteIfUnchanged,
  unlinkIfUnchanged as fsUnlinkIfUnchanged,
  readConsistent,
  statSig,
} from '../fs-atomic/index.ts';
import { matches } from './allowlist.ts';
import { resolveCaseSensitive } from './case-sensitivity.ts';
import { listMarkdown as enumerateMarkdown } from './enumerate.ts';
import { globToRegExp } from './glob.ts';
import { canonPrefix, canonicalizeRelative } from './paths.ts';
import { realTargetWithinRoot } from './realpath-guard.ts';

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

export function createVaultIo(config: VaultIoConfig): VaultIo {
  const root = resolvePath(config.root);
  const caseSensitive = resolveCaseSensitive(root, config.caseSensitive);
  const canonPrefixes: VaultPrefixes = {
    read: config.prefixes.read.map(canonPrefix),
    write: config.prefixes.write.map(canonPrefix),
  };
  const ignoreRes = (config.ignore ?? []).map(globToRegExp);

  function toVaultRelative(rel: string): string {
    return canonicalizeRelative(rel);
  }

  function toKey(rel: string): string {
    const canonical = canonicalizeRelative(rel);

    return caseSensitive ? canonical : canonical.toLowerCase();
  }

  function can(rel: string, access: Access): boolean {
    let x: string;
    try {
      x = canonicalizeRelative(rel);
    } catch {
      return false;
    }

    return matches(x, canonPrefixes[access]);
  }

  function resolveVaultPath(rel: string, access: Access = 'read'): string {
    const canonical = canonicalizeRelative(rel);
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
    if (!realTargetWithinRoot(full, root)) {
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
    return atomicWrite(resolveVaultPath(rel, 'write'), content);
  }

  async function rewriteIfUnchanged(
    rel: string,
    content: string,
    expected: Sig,
  ): Promise<Sig> {
    return atomicWriteIfUnchanged(resolveVaultPath(rel, 'write'), content, expected);
  }

  async function unlinkIfUnchanged(rel: string, expected: Sig): Promise<boolean> {
    return fsUnlinkIfUnchanged(resolveVaultPath(rel, 'write'), expected);
  }

  async function stat(rel: string): Promise<Sig | null> {
    return statSig(resolveVaultPath(rel, 'read'));
  }

  function isIgnored(rel: string): boolean {
    return ignoreRes.some((re) => re.test(rel));
  }

  function listMarkdown(dir?: string): Promise<string[]> {
    return enumerateMarkdown(root, dir, {
      isIgnored,
      resolveVaultPath,
      toVaultRelative,
    });
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
```

- [ ] **Step 8: Create `src/vault-io/index.ts`** (barrel):

```ts
export type {
  Access,
  VaultIo,
  VaultIoConfig,
  VaultPrefixes,
} from './create-vault-io.ts';
export { createVaultIo } from './create-vault-io.ts';
```

- [ ] **Step 9: Delete `src/vault-io.ts`.**

- [ ] **Step 10: Update importer `src/index.ts`** — change the two vault-io lines:

```ts
export type {
  Access,
  VaultIo,
  VaultIoConfig,
  VaultPrefixes,
} from './vault-io/index.ts';
export { createVaultIo } from './vault-io/index.ts';
```

- [ ] **Step 11: Move the createVaultIo suite.** MOVE `src/__tests__/vault-io.test.ts` → `src/vault-io/__tests__/create-vault-io.test.ts` unchanged except imports: `import { createVaultIo } from '../index.ts';` (module barrel) and `import { MdVaultError } from '../../errors.ts';`. This keeps every existing vault-io assertion (canonicalization, `can` boundary, `resolveVaultPath` symlink, atomic IO, `listMarkdown` enumeration/ignore, `toKey` case-folding) — i.e. it covers `enumerate` and `case-sensitivity`. Then delete `src/__tests__/vault-io.test.ts`.

- [ ] **Step 12: Create `src/vault-io/__tests__/paths.test.ts`** (NEW):

```ts
import { describe, expect, test } from 'bun:test';

import { MdVaultError } from '../../errors.ts';
import { canonPrefix, canonicalizeRelative } from '../paths.ts';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof MdVaultError ? e.code : String(e);
  }

  return 'NO_THROW';
}

describe('canonicalizeRelative', () => {
  test('collapses ./, dup-slash, . and resolves ..; case-preserving', () => {
    expect(canonicalizeRelative('a/./b.md')).toBe('a/b.md');
    expect(canonicalizeRelative('./a//b.md')).toBe('a/b.md');
    expect(canonicalizeRelative('a/b/../c.md')).toBe('a/c.md');
    expect(canonicalizeRelative('Notes/Daily.md')).toBe('Notes/Daily.md');
  });

  test('NFC-normalizes unicode segments', () => {
    expect(canonicalizeRelative('café/n.md')).toBe('café/n.md');
  });

  test('rejects absolute and ..-escape with ALLOWLIST_VIOLATION', () => {
    expect(code(() => canonicalizeRelative('/abs/x.md'))).toBe('ALLOWLIST_VIOLATION');
    expect(code(() => canonicalizeRelative('../escape.md'))).toBe('ALLOWLIST_VIOLATION');
    expect(code(() => canonicalizeRelative('a/../../escape.md'))).toBe('ALLOWLIST_VIOLATION');
  });
});

describe('canonPrefix', () => {
  test('canonicalizes like a path (trailing slash dropped; empty stays empty)', () => {
    expect(canonPrefix('Public/')).toBe('Public');
    expect(canonPrefix('./a//b/')).toBe('a/b');
    expect(canonPrefix('')).toBe('');
  });

  test('rejects .. with ALLOWLIST_VIOLATION', () => {
    expect(code(() => canonPrefix('../x'))).toBe('ALLOWLIST_VIOLATION');
  });
});
```

- [ ] **Step 13: Create `src/vault-io/__tests__/allowlist.test.ts`** (NEW):

```ts
import { describe, expect, test } from 'bun:test';

import { matches } from '../allowlist.ts';

describe('matches (boundary-aware)', () => {
  test("'foo' matches the folder + exact entry but NOT 'foobar.md'", () => {
    expect(matches('foobar.md', ['foo'])).toBe(false);
    expect(matches('foo/note.md', ['foo'])).toBe(true);
    expect(matches('foo', ['foo'])).toBe(true);
  });

  test("'' matches everything", () => {
    expect(matches('anything/deep/x.md', [''])).toBe(true);
  });

  test('no matching prefix → false', () => {
    expect(matches('Private/x.md', ['Public'])).toBe(false);
  });
});
```

- [ ] **Step 14: Create `src/vault-io/__tests__/realpath-guard.test.ts`** (NEW):

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { realTargetWithinRoot } from '../realpath-guard.ts';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'mdvault-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('realTargetWithinRoot', () => {
  test('a path inside the root is contained', async () => {
    await writeFile(join(root, 'a.md'), 'x');
    expect(realTargetWithinRoot(join(root, 'a.md'), root)).toBe(true);
  });

  test('a not-yet-existing path inside the root is allowed (nearest ancestor)', () => {
    expect(realTargetWithinRoot(join(root, 'sub', 'new.md'), root)).toBe(true);
  });

  test('a symlink escaping the root is rejected', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'mdvault-out-'));
    await writeFile(join(outside, 'secret.md'), 's');
    await symlink(join(outside, 'secret.md'), join(root, 'leak.md'));
    expect(realTargetWithinRoot(join(root, 'leak.md'), root)).toBe(false);
    await rm(outside, { recursive: true, force: true });
  });
});
```

- [ ] **Step 15: Create `src/vault-io/__tests__/glob.test.ts`** (NEW):

```ts
import { describe, expect, test } from 'bun:test';

import { globToRegExp } from '../glob.ts';

describe('globToRegExp', () => {
  test('* matches within a segment, not across /', () => {
    expect(globToRegExp('*.md').test('a.md')).toBe(true);
    expect(globToRegExp('*.md').test('sub/a.md')).toBe(false);
  });

  test('**/ matches zero or more leading segments', () => {
    const re = globToRegExp('**/x.md');
    expect(re.test('x.md')).toBe(true);
    expect(re.test('a/b/x.md')).toBe(true);
  });

  test('trailing ** matches anything including /', () => {
    expect(globToRegExp('build/**').test('build/a/b.md')).toBe(true);
  });

  test('? matches one non-/ char; literals are escaped', () => {
    expect(globToRegExp('a?b.md').test('axb.md')).toBe(true);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
  });
});
```

- [ ] **Step 16: Run tests + typecheck.** `Run: bun test && bun run check`. Expected: all green (relocated createVaultIo suite + 4 NEW helper suites pass; `tsc` resolves `../fs-atomic/index.ts` from the deeper `vault-io/` path).

- [ ] **Step 17: Commit.**
```bash
git add -A && git commit --no-gpg-sign -m "refactor(vault-io): split into create-vault-io factory + extracted pure helpers with unit tests"
```

---

### Task 3: Split `locked-file.ts` into `locked-file/`

**Files:**
- Create: `src/locked-file/types.ts`, `src/locked-file/commit.ts`, `src/locked-file/transform.ts`, `src/locked-file/delete.ts`, `src/locked-file/index.ts`
- Create tests: `src/locked-file/__tests__/transform.test.ts`, `src/locked-file/__tests__/delete.test.ts`
- Modify: `src/index.ts`
- Delete: `src/locked-file.ts`, `src/__tests__/locked-file.test.ts`

**Interfaces:**
- Consumes: `fs-atomic/index.ts` (`atomicWrite`, `atomicWriteIfUnchanged`, `readConsistent`, `statSig`, `unlinkIfUnchanged`), `locks/index.ts` (`withFileLock`, `withCrossProcessLock`), `./errors.ts`.
- Produces (`locked-file/index.ts`): `type CommitEvent`, `type CrossLock`, `type TransformOpts`, `type TransformResult`, `withFileTransform`, `withFileDelete`.

- [ ] **Step 1: Create `src/locked-file/types.ts`** — MOVE verbatim the four exported types `CommitEvent`, `CrossLock`, `TransformOpts`, `TransformResult` from `src/locked-file.ts`.

- [ ] **Step 2: Create `src/locked-file/commit.ts`** — MOVE verbatim `emitCommit`:

```ts
import { MdVaultError } from '../errors.ts';
import type { CommitEvent } from './types.ts';

export async function emitCommit(
  onCommit: ((e: CommitEvent) => void | Promise<void>) | undefined,
  event: CommitEvent,
): Promise<void> {
  // ... body unchanged ...
}
```

- [ ] **Step 3: Create `src/locked-file/transform.ts`** — MOVE verbatim `withFileTransform` (keep `Bun.sleep`). Header:

```ts
import { MdVaultError } from '../errors.ts';
import {
  atomicWrite,
  atomicWriteIfUnchanged,
  readConsistent,
} from '../fs-atomic/index.ts';
import { withCrossProcessLock, withFileLock } from '../locks/index.ts';
import { emitCommit } from './commit.ts';
import type { TransformOpts, TransformResult } from './types.ts';
```
(`withFileTransform`'s body references only `TransformOpts` + `TransformResult`; the `CommitEvent`/`CrossLock` types are reached through `TransformOpts`. If the moved body carries an explicit annotation that needs them, add them — `bun run check` flags either a missing or an unused import. Keep the existing `@param` doc-comment above `withFileTransform`.)

- [ ] **Step 4: Create `src/locked-file/delete.ts`** — MOVE verbatim `withFileDelete`. Header:

```ts
import {
  statSig,
  unlinkIfUnchanged,
} from '../fs-atomic/index.ts';
import { withCrossProcessLock, withFileLock } from '../locks/index.ts';
import { emitCommit } from './commit.ts';
import type { CommitEvent, CrossLock } from './types.ts';
```
(Keep the existing `@param` doc-comment above `withFileDelete`.)

- [ ] **Step 5: Create `src/locked-file/index.ts`** (barrel):

```ts
export type {
  CommitEvent,
  CrossLock,
  TransformOpts,
  TransformResult,
} from './types.ts';
export { withFileTransform } from './transform.ts';
export { withFileDelete } from './delete.ts';
```

- [ ] **Step 6: Delete `src/locked-file.ts`.**

- [ ] **Step 7: Update importer `src/index.ts`** — change the two locked-file lines:

```ts
export type {
  CommitEvent,
  CrossLock,
  TransformOpts,
  TransformResult,
} from './locked-file/index.ts';
export { withFileDelete, withFileTransform } from './locked-file/index.ts';
```

- [ ] **Step 8: Split the locked-file suite into `src/locked-file/__tests__/`** and delete `src/__tests__/locked-file.test.ts`:
  - `transform.test.ts` — MOVE the `withFileTransform` describe + the shared `beforeEach`/`afterEach`/`CommitSpy` scaffolding. Imports: `import { withFileTransform } from '../index.ts';`, `import { MdVaultError } from '../../errors.ts';`, and the `node:fs`/`node:fs/promises`/`node:os`/`node:path` builtins it already uses. (No statSig spy here; the few `statSig` reads can import `import { statSig } from '../../fs-atomic/sig.ts';`.)
  - `delete.test.ts` — MOVE the `withFileDelete` describe. Imports: `import { withFileDelete } from '../index.ts';`, `import { MdVaultError } from '../../errors.ts';`, and for the `MTIME_CONFLICT` spy the **definition leaf**: `import * as fsSig from '../../fs-atomic/sig.ts';` with `spyOn(fsSig, 'statSig')` and `fsSig.statSig` for the `realStatSig` capture (i.e. the same spy body as today, retargeted one level deeper than Task 1's interim path).

- [ ] **Step 9: Run tests + typecheck.** `Run: bun test && bun run check`. Expected: green — the delete `MTIME_CONFLICT` spy must still observe the mock (definition-leaf seam intercepts `withFileDelete`'s internal `statSig`).

- [ ] **Step 10: Commit.**
```bash
git add -A && git commit --no-gpg-sign -m "refactor(locked-file): split into types/commit/transform/delete with co-located tests"
```

---

### Task 4: Split `frontmatter.ts` into `frontmatter/`

**Files:**
- Create: `src/frontmatter/types.ts`, `src/frontmatter/validate.ts`, `src/frontmatter/tags.ts`, `src/frontmatter/parse.ts`, `src/frontmatter/edit.ts`, `src/frontmatter/index.ts`
- Create tests: `src/frontmatter/__tests__/validate.test.ts`, `src/frontmatter/__tests__/tags.test.ts`, `src/frontmatter/__tests__/parse.test.ts`, `src/frontmatter/__tests__/edit.test.ts`
- Modify: `src/index.ts`
- Delete: `src/frontmatter.ts`, `src/__tests__/frontmatter.test.ts`

**Interfaces:**
- Consumes: `yaml` only.
- Produces (`frontmatter/index.ts`): `type FrontmatterValidity`, `type ParsedFrontmatter`, `type EditOutcome`, `isFlatFrontmatter`, `deriveTags`, `parseFrontmatter`, `editFrontmatter`.

- [ ] **Step 1: Create `src/frontmatter/types.ts`** — MOVE verbatim `FrontmatterValidity`, `ParsedFrontmatter`, `EditOutcome`.

- [ ] **Step 2: Create `src/frontmatter/validate.ts`** — MOVE verbatim `isScalar`, `isScalarOrArrayOfScalar`, `isFlatFrontmatter` (no imports).

- [ ] **Step 3: Create `src/frontmatter/tags.ts`** — MOVE verbatim `toTagTokens`, `deriveTags` (no imports).

- [ ] **Step 4: Create `src/frontmatter/parse.ts`** — MOVE verbatim `Block` type, `extractBlock`, `parseFrontmatter`. Header:

```ts
import { parse } from 'yaml';

import { deriveTags } from './tags.ts';
import type { FrontmatterValidity, ParsedFrontmatter } from './types.ts';
import { isFlatFrontmatter } from './validate.ts';
```
(`parseFrontmatter`'s body annotates `const valid: FrontmatterValidity` and returns `ParsedFrontmatter` — both imported above. `extractBlock` must be `export`ed from this file for `edit.ts`; it stays off the barrel.)

- [ ] **Step 5: Create `src/frontmatter/edit.ts`** — MOVE verbatim `editFrontmatter`. Header:

```ts
import { Document, parseDocument } from 'yaml';

import { extractBlock, parseFrontmatter } from './parse.ts';
import type { EditOutcome } from './types.ts';
import { isFlatFrontmatter } from './validate.ts';
```
(This requires `extractBlock` to be exported from `parse.ts` — export it there; it stays off the barrel.)

- [ ] **Step 6: Create `src/frontmatter/index.ts`** (barrel):

```ts
export type {
  EditOutcome,
  FrontmatterValidity,
  ParsedFrontmatter,
} from './types.ts';
export { isFlatFrontmatter } from './validate.ts';
export { deriveTags } from './tags.ts';
export { parseFrontmatter } from './parse.ts';
export { editFrontmatter } from './edit.ts';
```

- [ ] **Step 7: Delete `src/frontmatter.ts`.**

- [ ] **Step 8: Update importer `src/index.ts`** — change the two frontmatter lines:

```ts
export type {
  EditOutcome,
  FrontmatterValidity,
  ParsedFrontmatter,
} from './frontmatter/index.ts';
export {
  deriveTags,
  editFrontmatter,
  isFlatFrontmatter,
  parseFrontmatter,
} from './frontmatter/index.ts';
```

- [ ] **Step 9: Split the frontmatter suite** into `src/frontmatter/__tests__/{validate,tags,parse,edit}.test.ts`, distributing today's `src/__tests__/frontmatter.test.ts` describes by the function under test (each importing its leaf — `../validate.ts`, `../tags.ts`, `../parse.ts`, `../edit.ts`). Then delete `src/__tests__/frontmatter.test.ts`. (Existing assertions move verbatim; only the import path changes. A describe that exercises `parseFrontmatter`'s tag derivation can import both `../parse.ts` and `../tags.ts` as needed.)

- [ ] **Step 10: Run tests + typecheck.** `Run: bun test && bun run check`. Expected: green.

- [ ] **Step 11: Commit.**
```bash
git add -A && git commit --no-gpg-sign -m "refactor(frontmatter): split into types/validate/tags/parse/edit with co-located tests"
```

---

### Task 5: Split `links.ts` into `links/`

**Files:**
- Create: `src/links/types.ts`, `src/links/extract.ts`, `src/links/resolve.ts`, `src/links/index.ts`
- Create tests: `src/links/__tests__/extract.test.ts`, `src/links/__tests__/resolve.test.ts`
- Modify: `src/index.ts`
- Delete: `src/links.ts`, `src/__tests__/links.test.ts`

**Interfaces:**
- Consumes: `node:path` only.
- Produces (`links/index.ts`): `type ExtractedLinks`, `type LinkResolution`, `type StoredLink`, `extractLinks`, `storedLinksFor`.

- [ ] **Step 1: Create `src/links/types.ts`** — MOVE verbatim `ExtractedLinks`, `LinkResolution`, `StoredLink`.

- [ ] **Step 2: Create `src/links/extract.ts`** — MOVE verbatim `stripFencedCode`, `mdLinkUrl`, `extractLinks`. Header:

```ts
import type { ExtractedLinks } from './types.ts';
```

- [ ] **Step 3: Create `src/links/resolve.ts`** — MOVE verbatim `normalizeWikiTarget`, `resolveRelativeTarget`, `storedLinksFor`. Header:

```ts
import { posix } from 'node:path';

import { extractLinks } from './extract.ts';
import type { LinkResolution, StoredLink } from './types.ts';
```

- [ ] **Step 4: Create `src/links/index.ts`** (barrel):

```ts
export type { ExtractedLinks, LinkResolution, StoredLink } from './types.ts';
export { extractLinks } from './extract.ts';
export { storedLinksFor } from './resolve.ts';
```

- [ ] **Step 5: Delete `src/links.ts`.**

- [ ] **Step 6: Update importer `src/index.ts`** — change the two links lines:

```ts
export type { ExtractedLinks, LinkResolution, StoredLink } from './links/index.ts';
export { extractLinks, storedLinksFor } from './links/index.ts';
```

- [ ] **Step 7: Split the links suite** into `src/links/__tests__/extract.test.ts` (the `extractLinks` describe, `import { extractLinks } from '../extract.ts';`) and `src/links/__tests__/resolve.test.ts` (the `storedLinksFor` describe, `import { storedLinksFor } from '../resolve.ts';`). Delete `src/__tests__/links.test.ts`.

- [ ] **Step 8: Run tests + typecheck.** `Run: bun test && bun run check`. Expected: green.

- [ ] **Step 9: Commit.**
```bash
git add -A && git commit --no-gpg-sign -m "refactor(links): split into types/extract/resolve with co-located tests"
```

---

### Task 6: Strengthen the package-API freeze test

**Files:**
- Modify: `src/__tests__/index.test.ts`

**Interfaces:**
- Consumes: `../index.ts` (the package barrel, now pointing at all folder barrels). No production change.

- [ ] **Step 1: Replace `src/__tests__/index.test.ts`** with the exact-freeze guard (source-level 26-name set + runtime value liveness):

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

import * as mdvault from '../index.ts';

// The frozen Plan 1 package public API. Changing this set must be deliberate:
// adding/removing/renaming any export fails these tests.
const VALUE_EXPORTS = [
  'MdVaultError',
  'createVaultIo',
  'deriveTags',
  'editFrontmatter',
  'extractLinks',
  'isFlatFrontmatter',
  'parseFrontmatter',
  'storedLinksFor',
  'withFileDelete',
  'withFileTransform',
].sort();

const ALL_EXPORTS = [
  ...VALUE_EXPORTS,
  'Access',
  'CommitEvent',
  'CrossLock',
  'EditOutcome',
  'ExtractedLinks',
  'FrontmatterValidity',
  'LinkResolution',
  'MdVaultCode',
  'ParsedFrontmatter',
  'Sig',
  'StoredLink',
  'TransformOpts',
  'TransformResult',
  'VaultIo',
  'VaultIoConfig',
  'VaultPrefixes',
].sort();

function exportedNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.add(name);
    }
  }

  return [...names].sort();
}

describe('package public API freeze', () => {
  test('src/index.ts exports exactly the frozen 26 names (value + type)', () => {
    const src = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(exportedNames(src)).toEqual(ALL_EXPORTS);
  });

  test('runtime value exports are exactly the 10 live values', () => {
    expect(Object.keys(mdvault).sort()).toEqual(VALUE_EXPORTS);
  });
});
```

- [ ] **Step 2: Run.** `Run: bun test src/__tests__/index.test.ts && bun run check`. Expected: PASS — `exportedNames(src)` equals the 26; `Object.keys(mdvault).sort()` equals the 10 values. (If the source-set assertion fails, `src/index.ts` drifted from the frozen API — investigate before "fixing" the list.)

- [ ] **Step 3: Verify the package-API diff is path-only.** `Run: git diff 31e708b -- src/index.ts`. Expected: only the `from '...'` paths changed (flat `./x.ts` → `./x/index.ts`); every exported name is identical.

- [ ] **Step 4: Commit.**
```bash
git add src/__tests__/index.test.ts && git commit --no-gpg-sign -m "test(index): exact package-API freeze (source 26-name set + runtime value liveness)"
```

---

### Task 7: Packaging hygiene — keep tests out of the tarball

**Files:**
- Modify: `package.json`

**Interfaces:**
- None (build/publish only).

- [ ] **Step 1: Confirm the current leak.** The file listing prints on **stderr** (`npm notice` lines), so merge it: `Run: npm_config_cache=$(mktemp -d) npm pack --dry-run 2>&1 | grep -c '__tests__'`. Expected: a non-zero count (tests currently ship). (The `npm_config_cache=$(mktemp -d)` prefix sidesteps the `~/.npm` permission error.)

- [ ] **Step 2: Edit `package.json` `files`** to exclude test paths via negation (a `files` allowlist overrides `.npmignore`, so the exclusion must live here):

```json
  "files": [
    "src",
    "README.md",
    "LICENSE",
    "!src/**/*.test.ts",
    "!src/**/__tests__/**"
  ],
```

- [ ] **Step 3: Verify the tarball is clean and complete.** `Run: npm_config_cache=$(mktemp -d) npm pack --dry-run 2>&1 | grep -E '__tests__|\.test\.ts'`. Expected: **no output** (no test paths). Then `Run: npm_config_cache=$(mktemp -d) npm pack --dry-run 2>&1 | grep -E 'src/index.ts|src/vault-io/index.ts'`. Expected: both runtime files listed (the source still ships).

- [ ] **Step 4: Final full gate.** `Run: bun test && bun run check`. Expected: all green.

- [ ] **Step 5: Commit.**
```bash
git add package.json && git commit --no-gpg-sign -m "chore(pkg): exclude tests from the published tarball via files negation"
```

---

## Self-Review

**Spec coverage** (each spec section → task):
- Three-layer API model / barrels curated, no `export *` → barrels in Tasks 1–5; Global Constraints.
- `fs-atomic` one area + `locks` extracted → Task 1.
- `vault-io` pure-helper extraction + de-closured signatures → Task 2.
- `locked-file` / `frontmatter` / `links` splits → Tasks 3 / 4 / 5.
- `readConsistent` uses `sigsEqual` → Task 1 Step 3.
- Co-located per-file unit tests; assembly-level for enumerate/case-sensitivity/emitCommit → Tasks 1–5 (enumerate/case-sensitivity in Task 2 Step 11; emitCommit in Task 3 Step 8).
- 5 NEW unit files (read-consistent, paths, allowlist, realpath-guard, glob) → Tasks 1–2.
- Exact API freeze (source set + runtime liveness) → Task 6.
- In-step repo-wide importer rewrites; no shim; tsc green each task → every task's importer steps + run step.
- Definition-leaf statSig spy (no engine bump) → Task 1 Step 12, Task 3 Step 8, Task 1 Step 14.
- Packaging negation + pack-dry-run gate (no `__tests__/`) → Task 7.
- Root tests stay in `src/__tests__/` → unchanged in Tasks; `errors.test.ts`/`scaffold.test.ts` untouched; `index.test.ts` only strengthened (Task 6).

**Placeholder scan:** none — every changed/new file shows full code; verbatim moves name exact symbols + show the changed import header.

**Type/name consistency:** barrel export names match the package-API freeze list (Task 6) and `src/index.ts` (Tasks 1–5). De-closured signatures (`realTargetWithinRoot(full, root)`, `matches(x, prefixes)`, `listMarkdown(root, dir, deps)`) are defined in Task 2 and consumed consistently within `create-vault-io.ts` / `enumerate.ts`. The `statSig` spy seam is the definition leaf `fs-atomic/sig.ts` in every test that uses it.
