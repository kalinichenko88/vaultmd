# mdvault Plan 1 — Foundation Primitives — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the headless, no-SQLite foundation of `mdvault` — typed errors, atomic+locked filesystem primitives, the allowlist-guarded `VaultIo`, the locked-file transform/delete seam, format-preserving frontmatter, and link extraction/resolution — each fully unit-tested.

**Architecture:** Pure Bun/TypeScript leaf modules, no database. `errors` is the shared typed-error base; `fs-atomic` provides atomic write / CAS / in-process + cross-process locks; `vault-io` is the security chokepoint (per-access allowlist + realpath/symlink guard + canonical keys); `locked-file` composes `fs-atomic` into a transform/delete seam with an `onCommit` hook; `frontmatter` and `links` are standalone parsers. Plan 2 (index + query + notes CRUD + composition root) layers SQLite on top.

**Tech Stack:** Bun, TypeScript (ESM), `bun:test`, Biome, `yaml` (only runtime dep).

## Global Constraints

- **Runtime:** Bun only. `engines.bun >= 1.1.0`. Use `node:fs/promises`, `node:path`, `node:os`, `node:crypto`. No `bun:sqlite` in Plan 1 (that is Plan 2). No native addons.
- **Single runtime dependency:** `yaml` (frontmatter only). Nothing else in `dependencies`.
- **Module style:** ESM, `"type": "module"`; relative imports carry the explicit `.ts` extension (`import { MdVaultError } from './errors.ts'`).
- **Types:** `type`, never `interface`.
- **Formatting (Biome):** single quotes, 2-space indent. Blank line before `return` unless it is the only/first statement in its block.
- **Tests:** live in `src/__tests__/<module>.test.ts`, use `bun:test`. **Never** `mock.module()`; use `spyOn` on an imported namespace if a stub is needed. Each fs-touching test makes a unique temp dir (`mkdtemp(path.join(os.tmpdir(), 'mdvault-'))`) in `beforeEach` and `rm -rf`s it in `afterEach`.
- **Security invariants (carried from spec):** all vault I/O routes through `resolveVaultPath` (per-access allowlist + `..`/absolute reject + realpath symlink-escape guard, nearest-existing-ancestor on create); boundary-aware prefix match (`foo` must NOT match `foobar.md`); `.md`-only.
- **License:** MIT, generic-only — no domain/persona/sync content in this package.
- **Commits:** conventional (`feat(<module>): …`), one per task. History is unsigned (use `--no-gpg-sign` if the signing agent is unavailable).

## File Structure

```
mdvault/
├── package.json            # name "mdvault", type module, yaml dep, bun scripts
├── tsconfig.json           # bundler resolution, allowImportingTsExtensions, strict
├── biome.json              # single-quote, 2-space, recommended
├── .gitignore
├── LICENSE                 # MIT
├── README.md
└── src/
    ├── index.ts            # public barrel                          (Task 8)
    ├── errors.ts           # MdVaultError + MdVaultCode             (Task 2)
    ├── fs-atomic.ts        # Sig, atomicWrite/CAS/exclusiveCreate, locks (Task 3)
    ├── vault-io.ts         # createVaultIo — chokepoint             (Task 4)
    ├── locked-file.ts      # withFileTransform / withFileDelete     (Task 5)
    ├── frontmatter.ts      # parse / edit / tags                    (Task 6)
    ├── links.ts            # extractLinks / storedLinksFor          (Task 7)
    └── __tests__/
        ├── scaffold.test.ts
        ├── errors.test.ts
        ├── fs-atomic.test.ts
        ├── vault-io.test.ts
        ├── locked-file.test.ts
        ├── frontmatter.test.ts
        ├── links.test.ts
        └── index.test.ts
```

Tasks build in dependency order: **1** scaffold → **2** errors → **3** fs-atomic → **4** vault-io → **5** locked-file → **6** frontmatter → **7** links → **8** package surface.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `biome.json`, `.gitignore`, `src/index.ts`
- Test: `src/__tests__/scaffold.test.ts`

**Interfaces:**
- Consumes: none
- Produces: a buildable Bun/TS package; `bun test` and `bun run check` both run green.

- [ ] **Step: Create `package.json`**

```json
{
  "name": "mdvault",
  "version": "0.1.0",
  "description": "Headless markdown-vault data layer for Bun — CRUD + SQLite index, no Obsidian required",
  "type": "module",
  "license": "MIT",
  "author": "Ivan Kalinichenko",
  "engines": { "bun": ">=1.1.0" },
  "exports": { ".": { "types": "./src/index.ts", "import": "./src/index.ts" } },
  "files": ["src", "README.md", "LICENSE"],
  "dependencies": { "yaml": "^2.5.0" },
  "devDependencies": { "@biomejs/biome": "^1.9.4", "@types/bun": "latest", "typescript": "^5.6.0" },
  "scripts": {
    "test": "bun test",
    "check": "biome check . && tsc --noEmit",
    "format": "biome format --write .",
    "lint": "biome lint .",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "module": "ESNext",
    "target": "ESNext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "types": ["bun"]
  },
  "include": ["src"]
}
```

- [ ] **Step: Create `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2 },
  "javascript": { "formatter": { "quoteStyle": "single" } },
  "linter": { "enabled": true, "rules": { "recommended": true } }
}
```

- [ ] **Step: Create `.gitignore`**

```
node_modules/
*.db
*.db-shm
*.db-wal
.DS_Store
```

- [ ] **Step: Create a placeholder `src/index.ts`** (the real barrel is Task 8)

```ts
export {};
```

- [ ] **Step: Write a scaffold smoke test** — `src/__tests__/scaffold.test.ts`

```ts
import { expect, test } from 'bun:test';

test('test runner works', () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step: Install deps and verify the toolchain**

Run: `bun install && bun run format && bun test src/__tests__/scaffold.test.ts && bun run check`
Expected: install succeeds; `biome format` normalizes the config/source files; the smoke test PASSES; `biome check` and `tsc --noEmit` exit 0.

- [ ] **Step: Commit**

```bash
git add package.json tsconfig.json biome.json .gitignore src/index.ts src/__tests__/scaffold.test.ts bun.lock && git commit --no-gpg-sign -m "chore: scaffold mdvault package (bun + ts + biome)"
```

---
### Task 2: errors

**Files:**
- Create: `src/errors.ts`
- Test: `src/__tests__/errors.test.ts`

**Interfaces:**
- Consumes: none
- Produces:
  ```ts
  export type MdVaultCode =
    | 'ALLOWLIST_VIOLATION' | 'NOT_MARKDOWN' | 'NOT_FOUND' | 'ALREADY_EXISTS'
    | 'NO_MATCH' | 'AMBIGUOUS_MATCH' | 'MTIME_CONFLICT' | 'REFUSE_CREATE'
    | 'FRONTMATTER_INVALID' | 'VALIDATION_ERROR' | 'COMMIT_FAILED' | 'INDEX_UNAVAILABLE'
  export class MdVaultError extends Error {
    readonly code: MdVaultCode
    constructor(code: MdVaultCode, message: string, options?: { cause?: unknown })
  }
  ```

**TDD cycle — typed error carries a stable code, is a real `Error`, preserves `cause`, names itself**

- [ ] **Step: Write the failing test(s) for the `MdVaultError` shape** — create `src/__tests__/errors.test.ts`:
  ```ts
  import { describe, expect, test } from 'bun:test';

  import { MdVaultError } from '../errors.ts';

  describe('MdVaultError', () => {
    test('sets a readable, stable code', () => {
      const err = new MdVaultError('ALLOWLIST_VIOLATION', 'outside read scope');

      expect(err.code).toBe('ALLOWLIST_VIOLATION');
    });

    test('passes the message through to Error', () => {
      const err = new MdVaultError('NOT_MARKDOWN', 'only .md files are allowed');

      expect(err.message).toBe('only .md files are allowed');
    });

    test('is a real Error and an MdVaultError (instanceof both)', () => {
      const err = new MdVaultError('NOT_FOUND', 'missing');

      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(MdVaultError);
    });

    test('sets name to "MdVaultError" (survives stringification)', () => {
      const err = new MdVaultError('MTIME_CONFLICT', 'changed under us');

      expect(err.name).toBe('MdVaultError');
      expect(String(err)).toBe('MdVaultError: changed under us');
    });

    test('preserves the original error as cause', () => {
      const original = new Error('onCommit blew up');
      const err = new MdVaultError('COMMIT_FAILED', 'commit hook failed', {
        cause: original,
      });

      expect(err.cause).toBe(original);
    });

    test('preserves a non-Error cause value', () => {
      const err = new MdVaultError('INDEX_UNAVAILABLE', 'probe failed', {
        cause: 'FTS5 missing',
      });

      expect(err.cause).toBe('FTS5 missing');
    });

    test('cause is undefined when no options given', () => {
      const err = new MdVaultError('REFUSE_CREATE', 'will not create');

      expect(err.cause).toBeUndefined();
    });

    test('is catchable by code after being thrown', () => {
      const throwing = () => {
        throw new MdVaultError('AMBIGUOUS_MATCH', 'more than one match');
      };

      try {
        throwing();
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(MdVaultError);
        expect((e as MdVaultError).code).toBe('AMBIGUOUS_MATCH');
      }
    });
  });
  ```

- [ ] **Step: Run to verify it fails** — `Run: bun test src/__tests__/errors.test.ts`. Expected: FAIL — `src/errors.ts` does not exist yet, so the import of `MdVaultError` cannot resolve (module-not-found).

- [ ] **Step: Implement the typed error** — create `src/errors.ts`:
  ```ts
  export type MdVaultCode =
    | 'ALLOWLIST_VIOLATION'
    | 'NOT_MARKDOWN'
    | 'NOT_FOUND'
    | 'ALREADY_EXISTS'
    | 'NO_MATCH'
    | 'AMBIGUOUS_MATCH'
    | 'MTIME_CONFLICT'
    | 'REFUSE_CREATE'
    | 'FRONTMATTER_INVALID'
    | 'VALIDATION_ERROR'
    | 'COMMIT_FAILED'
    | 'INDEX_UNAVAILABLE';

  export class MdVaultError extends Error {
    readonly code: MdVaultCode;

    constructor(code: MdVaultCode, message: string, options?: { cause?: unknown }) {
      super(message, { cause: options?.cause });
      this.code = code;
      this.name = 'MdVaultError';
    }
  }
  ```

- [ ] **Step: Run to verify pass** — `Run: bun test src/__tests__/errors.test.ts`. Expected: PASS — all 8 assertions green (`code` readable, message pass-through, `instanceof Error`/`MdVaultError`, `name === 'MdVaultError'`, both Error and non-Error `cause` preserved, absent `cause` is `undefined`, throw/catch round-trip).

- [ ] **Step: Commit** —
  ```bash
  git add src/errors.ts src/__tests__/errors.test.ts && git commit -m "feat(errors): typed MdVaultError with stable codes and cause"
  ```

---

### Task 3: fs-atomic

**Files:**
- Create: `src/fs-atomic.ts`
- Test: `src/__tests__/fs-atomic.test.ts`

**Interfaces:**
- Consumes: `MdVaultError` from `./errors.ts` — `class MdVaultError extends Error { readonly code: MdVaultCode; constructor(code: MdVaultCode, message: string, options?: { cause?: unknown }) }` (Task 2). `MdVaultCode` union includes `'MTIME_CONFLICT'` and `'ALREADY_EXISTS'`.
- Produces:
  - `type Sig = { mtimeMs: number; size: number }`
  - `function statSig(fullPath: string): Promise<Sig | null>`
  - `function atomicWrite(fullPath: string, content: string): Promise<Sig>`
  - `function atomicWriteIfUnchanged(fullPath: string, content: string, expected: Sig): Promise<Sig>`
  - `function exclusiveCreate(fullPath: string, content: string): Promise<Sig>`
  - `function unlinkIfUnchanged(fullPath: string, expected: Sig): Promise<boolean>`
  - `function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T>`
  - `function withCrossProcessLock<T>(lockDir: string, key: string, busyTimeoutMs: number, fn: () => Promise<T>): Promise<T>`

---

#### Cycle 1 — `statSig` + `atomicWrite` + `atomicWriteIfUnchanged`

- [ ] **Step: Write the failing test(s) for stat signatures and atomic (CAS) writes** — create `src/__tests__/fs-atomic.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { MdVaultError } from '../errors.ts';
import { atomicWrite, atomicWriteIfUnchanged, statSig } from '../fs-atomic.ts';

describe('statSig + atomicWrite', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mdvault-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('statSig returns null for a missing file', async () => {
    expect(await statSig(path.join(dir, 'nope.md'))).toBeNull();
  });

  test('atomicWrite creates parent dirs and returns the post-write sig', async () => {
    const file = path.join(dir, 'a', 'b', 'note.md');
    const sig = await atomicWrite(file, 'hello');

    expect(await readFile(file, 'utf8')).toBe('hello');
    expect(sig.size).toBe(5);
    expect(Number.isInteger(sig.mtimeMs)).toBe(true);
    expect(await statSig(file)).toEqual(sig);
  });

  test('atomicWriteIfUnchanged rewrites when the sig matches', async () => {
    const file = path.join(dir, 'note.md');
    const first = await atomicWrite(file, 'one');
    const second = await atomicWriteIfUnchanged(file, 'changed', first);

    expect(await readFile(file, 'utf8')).toBe('changed');
    expect(second.size).toBe(7);
    expect(await statSig(file)).toEqual(second);
  });

  test('atomicWriteIfUnchanged throws MTIME_CONFLICT on a stale sig', async () => {
    const file = path.join(dir, 'note.md');
    await atomicWrite(file, 'one');

    const stale = { mtimeMs: 1, size: 999 };
    let caught: unknown;
    try {
      await atomicWriteIfUnchanged(file, 'two', stale);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(MdVaultError);
    expect((caught as MdVaultError).code).toBe('MTIME_CONFLICT');
    expect(await readFile(file, 'utf8')).toBe('one'); // original untouched
  });
});
```

- [ ] **Step: Run to verify it fails** — `Run: bun test src/__tests__/fs-atomic.test.ts` — Expected: FAIL — `src/fs-atomic.ts` does not exist yet (module resolution error: cannot find `../fs-atomic.ts`).

- [ ] **Step: Implement stat sigs + atomic writes** — create `src/fs-atomic.ts`:

```ts
import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { MdVaultError } from './errors.ts';

export type Sig = { mtimeMs: number; size: number };

function makeSig(st: Stats): Sig {
  return { mtimeMs: Math.trunc(st.mtimeMs), size: st.size };
}

function sigsEqual(a: Sig, b: Sig): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function tempPath(fullPath: string): string {
  const dir = path.dirname(fullPath);
  const base = path.basename(fullPath);

  return path.join(dir, `.${base}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
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

export async function atomicWrite(fullPath: string, content: string): Promise<Sig> {
  await mkdir(path.dirname(fullPath), { recursive: true });
  const tmp = tempPath(fullPath);
  await writeFile(tmp, content, 'utf8');
  try {
    await rename(tmp, fullPath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }

  return makeSig(await stat(fullPath));
}

export async function atomicWriteIfUnchanged(
  fullPath: string,
  content: string,
  expected: Sig,
): Promise<Sig> {
  const tmp = tempPath(fullPath);
  await writeFile(tmp, content, 'utf8');
  try {
    const current = await statSig(fullPath);
    if (!current || !sigsEqual(current, expected)) {
      throw new MdVaultError('MTIME_CONFLICT', `file changed under write: ${fullPath}`);
    }
    await rename(tmp, fullPath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }

  return makeSig(await stat(fullPath));
}
```

- [ ] **Step: Run to verify pass** — `Run: bun test src/__tests__/fs-atomic.test.ts` — Expected: PASS (4 tests).

---

#### Cycle 2 — `exclusiveCreate` + `unlinkIfUnchanged`

- [ ] **Step: Write the failing test(s) for exclusive create and guarded delete** — extend the `../fs-atomic.ts` import to `import { atomicWrite, atomicWriteIfUnchanged, exclusiveCreate, statSig, unlinkIfUnchanged } from '../fs-atomic.ts';` and append to `src/__tests__/fs-atomic.test.ts`:

```ts
describe('exclusiveCreate + unlinkIfUnchanged', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mdvault-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('exclusiveCreate writes a new file and returns its sig', async () => {
    const file = path.join(dir, 'sub', 'new.md');
    const sig = await exclusiveCreate(file, 'fresh');

    expect(await readFile(file, 'utf8')).toBe('fresh');
    expect(sig).toEqual(await statSig(file));
  });

  test('exclusiveCreate throws ALREADY_EXISTS and does not clobber the target', async () => {
    const file = path.join(dir, 'dupe.md');
    await atomicWrite(file, 'orig');

    let caught: unknown;
    try {
      await exclusiveCreate(file, 'second');
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(MdVaultError);
    expect((caught as MdVaultError).code).toBe('ALREADY_EXISTS');
    expect(await readFile(file, 'utf8')).toBe('orig');
  });

  test('unlinkIfUnchanged returns false (no-op) for a missing file', async () => {
    const ghost = path.join(dir, 'ghost.md');
    expect(await unlinkIfUnchanged(ghost, { mtimeMs: 1, size: 1 })).toBe(false);
  });

  test('unlinkIfUnchanged throws MTIME_CONFLICT on a sig mismatch', async () => {
    const file = path.join(dir, 'note.md');
    await atomicWrite(file, 'data');

    let caught: unknown;
    try {
      await unlinkIfUnchanged(file, { mtimeMs: 1, size: 99 });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(MdVaultError);
    expect((caught as MdVaultError).code).toBe('MTIME_CONFLICT');
    expect(await statSig(file)).not.toBeNull();
  });

  test('unlinkIfUnchanged deletes and returns true on a matching sig', async () => {
    const file = path.join(dir, 'note.md');
    const sig = await atomicWrite(file, 'data');

    expect(await unlinkIfUnchanged(file, sig)).toBe(true);
    expect(await statSig(file)).toBeNull();
  });
});
```

- [ ] **Step: Run to verify it fails** — `Run: bun test src/__tests__/fs-atomic.test.ts` — Expected: FAIL — `exclusiveCreate` and `unlinkIfUnchanged` are not exported from `../fs-atomic.ts` (undefined import → TypeError on call).

- [ ] **Step: Implement exclusive create + guarded delete** — add `link` to the `node:fs/promises` import line (`import { link, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';`) and append to `src/fs-atomic.ts`:

```ts
export async function exclusiveCreate(fullPath: string, content: string): Promise<Sig> {
  await mkdir(path.dirname(fullPath), { recursive: true });
  const tmp = tempPath(fullPath);
  await writeFile(tmp, content, 'utf8');
  try {
    await link(tmp, fullPath); // O_EXCL via hardlink: fails EEXIST if target present
  } catch (err) {
    await unlink(tmp).catch(() => {});
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new MdVaultError('ALREADY_EXISTS', `already exists: ${fullPath}`, { cause: err });
    }
    throw err;
  }
  await unlink(tmp).catch(() => {});

  return makeSig(await stat(fullPath));
}

export async function unlinkIfUnchanged(fullPath: string, expected: Sig): Promise<boolean> {
  const current = await statSig(fullPath);
  if (!current) {
    return false;
  }
  if (!sigsEqual(current, expected)) {
    throw new MdVaultError('MTIME_CONFLICT', `file changed before delete: ${fullPath}`);
  }
  await unlink(fullPath);

  return true;
}
```

- [ ] **Step: Run to verify pass** — `Run: bun test src/__tests__/fs-atomic.test.ts` — Expected: PASS (9 tests).

---

#### Cycle 3 — `withFileLock` (in-process per-key mutex)

- [ ] **Step: Write the failing test(s) for in-process serialization** — extend the `../fs-atomic.ts` import to add `withFileLock` and append to `src/__tests__/fs-atomic.test.ts`:

```ts
describe('withFileLock', () => {
  test('serializes concurrent fns sharing a key', async () => {
    const order: string[] = [];

    const slow = withFileLock('k', async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('a-end');

      return 'a';
    });
    const fast = withFileLock('k', async () => {
      order.push('b-start');
      order.push('b-end');

      return 'b';
    });

    const [ra, rb] = await Promise.all([slow, fast]);
    expect(ra).toBe('a');
    expect(rb).toBe('b');
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  test('different keys run concurrently', async () => {
    const order: string[] = [];

    const p1 = withFileLock('k1', async () => {
      order.push('1-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('1-end');
    });
    const p2 = withFileLock('k2', async () => {
      order.push('2-start');
      order.push('2-end');
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual(['1-start', '2-start', '2-end', '1-end']);
  });

  test('a rejecting fn still releases the lock for the next holder', async () => {
    await expect(
      withFileLock('z', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // next acquirer must not deadlock behind the failed one
    expect(await withFileLock('z', async () => 'ok')).toBe('ok');
  });
});
```

- [ ] **Step: Run to verify it fails** — `Run: bun test src/__tests__/fs-atomic.test.ts` — Expected: FAIL — `withFileLock` is not exported from `../fs-atomic.ts`.

- [ ] **Step: Implement the in-process per-key mutex** — append to `src/fs-atomic.ts` (no new imports):

```ts
const fileLocks = new Map<string, Promise<void>>();

export async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mine = prev.then(() => gate);
  fileLocks.set(key, mine);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (fileLocks.get(key) === mine) {
      fileLocks.delete(key); // self-clean when no waiter chained behind us
    }
  }
}
```

- [ ] **Step: Run to verify pass** — `Run: bun test src/__tests__/fs-atomic.test.ts` — Expected: PASS (12 tests).

---

#### Cycle 4 — `withCrossProcessLock` (O_EXCL lockfile + stale reclaim)

- [ ] **Step: Write the failing test(s) for the cross-process lockfile** — extend the `../fs-atomic.ts` import to add `withCrossProcessLock`, add the node imports `import { createHash } from 'node:crypto';`, `writeFile` to the `node:fs/promises` import, and `hostname` to the `node:os` import (`import { hostname, tmpdir } from 'node:os';`). Append to `src/__tests__/fs-atomic.test.ts`:

```ts
describe('withCrossProcessLock', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mdvault-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const lockPath = (lockDir: string, key: string) =>
    path.join(lockDir, `${createHash('sha256').update(key).digest('hex')}.lock`);

  test('runs fn, creating lockDir if missing, then releases the lockfile', async () => {
    const nested = path.join(dir, 'locks');
    const result = await withCrossProcessLock(nested, 'x.md', 500, async () => 'ok');

    expect(result).toBe('ok');
    expect(await statSig(lockPath(nested, 'x.md'))).toBeNull(); // released in finally
  });

  test('reclaims a lockfile held by a dead same-host pid', async () => {
    const key = 'note.md';
    await writeFile(
      lockPath(dir, key),
      JSON.stringify({ pid: 999999999, host: hostname(), createdAt: Date.now() }),
    );

    let ran = false;
    const result = await withCrossProcessLock(dir, key, 1000, async () => {
      ran = true;

      return 42;
    });

    expect(ran).toBe(true);
    expect(result).toBe(42);
    expect(await statSig(lockPath(dir, key))).toBeNull();
  });

  test('waits then throws MTIME_CONFLICT when held by a live pid', async () => {
    const key = 'note.md';
    await writeFile(
      lockPath(dir, key),
      JSON.stringify({ pid: process.pid, host: hostname(), createdAt: Date.now() }),
    );

    const start = Date.now();
    let caught: unknown;
    try {
      await withCrossProcessLock(dir, key, 150, async () => 'never');
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(MdVaultError);
    expect((caught as MdVaultError).code).toBe('MTIME_CONFLICT');
    expect(Date.now() - start).toBeGreaterThanOrEqual(140); // polled to the deadline
    expect(await statSig(lockPath(dir, key))).not.toBeNull(); // live holder untouched
  });
});
```

- [ ] **Step: Run to verify it fails** — `Run: bun test src/__tests__/fs-atomic.test.ts` — Expected: FAIL — `withCrossProcessLock` is not exported from `../fs-atomic.ts`.

- [ ] **Step: Implement the cross-process lock** — update the `node:crypto` import to `import { createHash, randomBytes } from 'node:crypto';`, the `node:fs/promises` import to `import { link, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';`, add `import { hostname } from 'node:os';`, and append to `src/fs-atomic.ts`:

```ts
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryReclaim(lockfile: string, payload: string): Promise<boolean> {
  let holder: { pid?: number; host?: string };
  try {
    holder = JSON.parse(await readFile(lockfile, 'utf8'));
  } catch {
    return false; // unreadable / vanished — let the caller re-poll
  }
  if (holder.host !== hostname() || typeof holder.pid !== 'number') {
    return false; // foreign host or malformed — never reclaim
  }
  try {
    process.kill(holder.pid, 0);

    return false; // signal delivered -> pid alive
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      return false; // EPERM etc. -> alive but not ours
    }
  }
  // dead same-host pid: drop the stale lockfile and re-acquire
  await unlink(lockfile).catch(() => {});
  try {
    await writeFile(lockfile, payload, { flag: 'wx' });

    return true;
  } catch {
    return false; // lost the race; caller re-polls
  }
}

export async function withCrossProcessLock<T>(
  lockDir: string,
  key: string,
  busyTimeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  await mkdir(lockDir, { recursive: true });
  const lockfile = path.join(lockDir, `${createHash('sha256').update(key).digest('hex')}.lock`);
  const payload = JSON.stringify({ pid: process.pid, host: hostname(), createdAt: Date.now() });
  const deadline = Date.now() + busyTimeoutMs;

  for (;;) {
    try {
      await writeFile(lockfile, payload, { flag: 'wx' });
      break; // acquired
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
      if (await tryReclaim(lockfile, payload)) {
        break;
      }
      if (Date.now() >= deadline) {
        throw new MdVaultError('MTIME_CONFLICT', `cross-process lock busy: ${lockfile}`);
      }
      await delay(50);
    }
  }

  try {
    return await fn();
  } finally {
    await unlink(lockfile).catch(() => {});
  }
}
```

- [ ] **Step: Run to verify pass** — `Run: bun test src/__tests__/fs-atomic.test.ts` — Expected: PASS (15 tests).

---

- [ ] **Step: Commit** —

```bash
git add src/fs-atomic.ts src/__tests__/fs-atomic.test.ts && \
git commit -m "feat(fs-atomic): atomic write/create/delete with mtime CAS + in-process and cross-process locks"
```

---

### Task 4: vault-io (path policy + allowlist + atomic IO + enumeration)

**Files:**
- Create: `src/vault-io.ts`
- Test: `src/__tests__/vault-io.test.ts`

**Interfaces:**
- Consumes (imported from earlier tasks):
  - `./errors.ts` → `class MdVaultError extends Error { readonly code: MdVaultCode; constructor(code: MdVaultCode, message: string, options?: { cause?: unknown }) }`
  - `./fs-atomic.ts` → `type Sig = { mtimeMs: number; size: number }`, `statSig(fullPath: string): Promise<Sig | null>`, `atomicWrite(fullPath: string, content: string): Promise<Sig>`, `atomicWriteIfUnchanged(fullPath: string, content: string, expected: Sig): Promise<Sig>`, `unlinkIfUnchanged(fullPath: string, expected: Sig): Promise<boolean>`
- Produces (later tasks rely on these — verbatim from contracts):
  - `type Access = 'read' | 'write'`
  - `type VaultPrefixes = { read: string[]; write: string[] }`
  - `type VaultIoConfig = { root: string; prefixes: VaultPrefixes; caseSensitive?: boolean; ignore?: string[] }`
  - `type VaultIo = { toVaultRelative(rel: string): string; toKey(rel: string): string; can(rel: string, access: Access): boolean; resolveVaultPath(rel: string, access?: Access): string; readVaultFile(rel: string): Promise<{ content: string; sig: Sig } | null>; writeVaultFile(rel: string, content: string): Promise<Sig>; rewriteIfUnchanged(rel: string, content: string, expected: Sig): Promise<Sig>; unlinkIfUnchanged(rel: string, expected: Sig): Promise<boolean>; stat(rel: string): Promise<Sig | null>; listMarkdown(dir?: string): Promise<string[]> }`
  - `function createVaultIo(config: VaultIoConfig): VaultIo`

> The file is built up incrementally across four cycles. Each cycle's `return { … }` only exposes the methods implemented so far, so the newly-added behavior's tests genuinely fail at runtime (Bun does not type-check on `bun test`) before its implement step. The `: VaultIo` return annotation is added in the final cycle once every method exists. Imports grow per cycle (keep each version free of unused imports).

---

#### Cycle 1 — Canonicalization + per-access boundary-aware allowlist (`toVaultRelative`, `toKey`, `can`) + case-sensitivity auto-detect

- [ ] **Step: Write the failing test(s) for path canonicalization, key folding, and boundary-aware prefix matching**

```ts
// src/__tests__/vault-io.test.ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MdVaultError } from '../errors.ts';
import { createVaultIo } from '../vault-io.ts';

let vault: string;

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), 'mdvault-'));
});

afterEach(async () => {
  await rm(vault, { recursive: true, force: true });
});

function syncCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof MdVaultError ? e.code : String(e);
  }

  return 'NO_THROW';
}

async function asyncCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return e instanceof MdVaultError ? e.code : String(e);
  }

  return 'NO_THROW';
}

describe('toVaultRelative / toKey', () => {
  test('canonicalizes ./, dup-slash, . segments, and resolving ..', () => {
    const io = createVaultIo({ root: vault, prefixes: { read: [''], write: [''] } });
    expect(io.toVaultRelative('a/./b.md')).toBe('a/b.md');
    expect(io.toVaultRelative('./a//b.md')).toBe('a/b.md');
    expect(io.toVaultRelative('a/b/../c.md')).toBe('a/c.md');
    expect(io.toVaultRelative('Notes/Daily.md')).toBe('Notes/Daily.md'); // case-preserving
  });

  test('NFC-normalizes unicode path segments', () => {
    const io = createVaultIo({ root: vault, prefixes: { read: [''], write: [''] } });
    expect(io.toVaultRelative('cafe\u0301/note.md')).toBe('caf\u00e9/note.md');
  });

  test('rejects absolute paths and ..-escapes with ALLOWLIST_VIOLATION', () => {
    const io = createVaultIo({ root: vault, prefixes: { read: [''], write: [''] } });
    expect(syncCode(() => io.toVaultRelative('/abs/x.md'))).toBe('ALLOWLIST_VIOLATION');
    expect(syncCode(() => io.toVaultRelative('../escape.md'))).toBe('ALLOWLIST_VIOLATION');
    expect(syncCode(() => io.toVaultRelative('a/../../escape.md'))).toBe('ALLOWLIST_VIOLATION');
  });

  test('toKey case-folds only when caseSensitive is false', () => {
    const ci = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
      caseSensitive: false,
    });
    expect(ci.toKey('Notes/Daily.md')).toBe('notes/daily.md');
    expect(ci.toVaultRelative('Notes/Daily.md')).toBe('Notes/Daily.md');

    const cs = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
      caseSensitive: true,
    });
    expect(cs.toKey('Notes/Daily.md')).toBe('Notes/Daily.md');
  });

  test('auto-detects volume case sensitivity for toKey when unspecified', async () => {
    const io = createVaultIo({ root: vault, prefixes: { read: [''], write: [''] } });
    await writeFile(join(vault, 'CaseProbe.md'), 'x');
    let insensitive = false;
    try {
      await stat(join(vault, 'caseprobe.md'));
      insensitive = true;
    } catch {
      insensitive = false;
    }
    expect(io.toKey('Note.md')).toBe(insensitive ? 'note.md' : 'Note.md');
  });
});

describe('can (per-access boundary-aware prefix match)', () => {
  test("boundary: 'foo' matches the folder and exact entry but NOT 'foobar.md'", () => {
    const io = createVaultIo({ root: vault, prefixes: { read: ['foo'], write: ['foo'] } });
    expect(io.can('foobar.md', 'read')).toBe(false);
    expect(io.can('foo/note.md', 'read')).toBe(true);
    expect(io.can('foo', 'read')).toBe(true);
  });

  test("'' matches everything", () => {
    const io = createVaultIo({ root: vault, prefixes: { read: [''], write: [''] } });
    expect(io.can('anything/deep/x.md', 'read')).toBe(true);
    expect(io.can('top.md', 'read')).toBe(true);
  });

  test('read and write prefixes are independent; trailing slash canonicalized', () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: ['Public/', 'Shared/'], write: ['Public/'] },
    });
    expect(io.can('Public/x.md', 'read')).toBe(true);
    expect(io.can('Public/x.md', 'write')).toBe(true);
    expect(io.can('Shared/x.md', 'read')).toBe(true);
    expect(io.can('Shared/x.md', 'write')).toBe(false);
    expect(io.can('Private/x.md', 'read')).toBe(false);
  });

  test('an absolute / escaping path is never in the allowlist', () => {
    const io = createVaultIo({ root: vault, prefixes: { read: [''], write: [''] } });
    expect(io.can('/abs/x.md', 'read')).toBe(false);
    expect(io.can('../escape.md', 'read')).toBe(false);
  });
});
```

- [ ] **Step: Run to verify it fails** — `Run: bun test src/__tests__/vault-io.test.ts`
  Expected: FAIL — `src/vault-io.ts` does not exist yet, so `createVaultIo` cannot be imported.

- [ ] **Step: Implement canonicalization, key folding, allowlist, and case detection** — full initial `src/vault-io.ts`:

```ts
// src/vault-io.ts
import { statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';

import { MdVaultError } from './errors.ts';
import type { Sig } from './fs-atomic.ts';

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

export function createVaultIo(config: VaultIoConfig) {
  const root = resolvePath(config.root);
  const caseSensitive = resolveCaseSensitive(root, config.caseSensitive);
  const canonPrefixes: VaultPrefixes = {
    read: config.prefixes.read.map(canonPrefix),
    write: config.prefixes.write.map(canonPrefix),
  };

  function toVaultRelative(rel: string): string {
    if (isAbsolute(rel)) {
      throw new MdVaultError('ALLOWLIST_VIOLATION', `vault path must be relative: ${rel}`);
    }
    const nfc = rel.normalize('NFC').replaceAll('\\', '/');
    const out: string[] = [];
    for (const seg of nfc.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (out.length === 0) {
          throw new MdVaultError('ALLOWLIST_VIOLATION', `vault path escapes root: ${rel}`);
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

  return { toVaultRelative, toKey, can };
}

function canonPrefix(p: string): string {
  // Prefixes are canonicalized like paths: NFC, '/'-separated, no trailing '/'.
  const nfc = p.normalize('NFC').replaceAll('\\', '/');
  const out: string[] = [];
  for (const seg of nfc.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') continue;
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
    const flipped = probe === probe.toUpperCase() ? probe.toLowerCase() : probe.toUpperCase();
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
```

- [ ] **Step: Run to verify pass** — `Run: bun test src/__tests__/vault-io.test.ts`
  Expected: PASS (all canonicalization / key / `can` tests green).

---

#### Cycle 2 — `resolveVaultPath`: `.md` guard, allowlist enforcement, realpath containment (symlink + symlinked-parent-on-create escapes)

- [ ] **Step: Write the failing test(s) for resolution guards and realpath containment**

```ts
// append to src/__tests__/vault-io.test.ts
describe('resolveVaultPath', () => {
  test('returns the lexical absolute path for an allowed .md target (need not exist)', () => {
    const io = createVaultIo({ root: vault, prefixes: { read: ['Public/'], write: ['Public/'] } });
    expect(io.resolveVaultPath('Public/a.md', 'write')).toBe(join(vault, 'Public/a.md'));
    expect(io.resolveVaultPath('Public/a.md')).toBe(join(vault, 'Public/a.md')); // default access 'read'
  });

  test('.md guard fires before allowlist (NOT_MARKDOWN)', () => {
    const io = createVaultIo({ root: vault, prefixes: { read: ['Public/'], write: ['Public/'] } });
    expect(syncCode(() => io.resolveVaultPath('Public/note.txt'))).toBe('NOT_MARKDOWN');
  });

  test('per-access allowlist violations throw ALLOWLIST_VIOLATION', () => {
    const io = createVaultIo({ root: vault, prefixes: { read: ['Public/'], write: ['Public/'] } });
    expect(syncCode(() => io.resolveVaultPath('Private/x.md', 'read'))).toBe('ALLOWLIST_VIOLATION');
    expect(syncCode(() => io.resolveVaultPath('Private/x.md', 'write'))).toBe('ALLOWLIST_VIOLATION');
  });

  test('rejects a symlink that escapes the vault root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'mdvault-out-'));
    await writeFile(join(outside, 'secret.md'), '# secret');
    await symlink(join(outside, 'secret.md'), join(vault, 'leak.md'));
    const io = createVaultIo({ root: vault, prefixes: { read: [''], write: [''] } });
    expect(syncCode(() => io.resolveVaultPath('leak.md', 'read'))).toBe('ALLOWLIST_VIOLATION');
    await rm(outside, { recursive: true, force: true });
  });

  test('rejects symlinked-parent escape on create via nearest-existing-ancestor realpath', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'mdvault-out-'));
    await symlink(outside, join(vault, 'link')); // link/ -> outside the vault
    const io = createVaultIo({ root: vault, prefixes: { read: [''], write: [''] } });
    expect(syncCode(() => io.resolveVaultPath('link/new.md', 'write'))).toBe('ALLOWLIST_VIOLATION');
    await rm(outside, { recursive: true, force: true });
  });

  test('an in-vault symlink that stays inside the root resolves fine', async () => {
    await mkdir(join(vault, 'real'));
    await writeFile(join(vault, 'real', 'a.md'), '# a');
    await symlink(join(vault, 'real'), join(vault, 'alias'));
    const io = createVaultIo({ root: vault, prefixes: { read: [''], write: [''] } });
    expect(io.resolveVaultPath('alias/a.md', 'read')).toBe(join(vault, 'alias/a.md'));
  });
});
```

- [ ] **Step: Run to verify it fails** — `Run: bun test src/__tests__/vault-io.test.ts`
  Expected: FAIL — the Cycle-1 return omits `resolveVaultPath`, so `io.resolveVaultPath(...)` is `undefined` (TypeError: not a function); earlier tests still pass.

- [ ] **Step: Implement `resolveVaultPath` + realpath containment** — extend `src/vault-io.ts`:

```ts
// 1) extend the node:fs import at the top of the file:
import { existsSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';

// 2) extend the node:path import at the top of the file:
import { dirname, isAbsolute, join, resolve as resolvePath, sep } from 'node:path';

// 3) add these two functions INSIDE createVaultIo (after `can`, before `return`):
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
      throw new MdVaultError('ALLOWLIST_VIOLATION', `path outside ${access} allowlist: ${rel}`);
    }
    const full = join(root, canonical);
    if (!realTargetWithinRoot(full)) {
      throw new MdVaultError('ALLOWLIST_VIOLATION', `vault path escapes root (symlink): ${rel}`);
    }

    return full;
  }

// 4) extend the returned object:
  return { toVaultRelative, toKey, can, resolveVaultPath };
```

- [ ] **Step: Run to verify pass** — `Run: bun test src/__tests__/vault-io.test.ts`
  Expected: PASS (resolution + realpath-containment tests green).

---

#### Cycle 3 — Atomic IO methods (`readVaultFile`, `writeVaultFile`, `rewriteIfUnchanged`, `unlinkIfUnchanged`, `stat`)

- [ ] **Step: Write the failing test(s) for read/write/rewrite/unlink/stat**

```ts
// append to src/__tests__/vault-io.test.ts
describe('atomic IO', () => {
  test('writeVaultFile + readVaultFile round-trip carry a matching sig; missing -> null', async () => {
    const io = createVaultIo({ root: vault, prefixes: { read: [''], write: [''] } });
    const sig = await io.writeVaultFile('notes/a.md', '# hi'); // atomicWrite mkdir -p parent
    expect(sig.size).toBe(4);
    const read = await io.readVaultFile('notes/a.md');
    expect(read?.content).toBe('# hi');
    expect(read?.sig).toEqual(sig);
    expect(await io.readVaultFile('notes/missing.md')).toBeNull();
  });

  test('writeVaultFile / stat go through the write / read scope respectively', async () => {
    const io = createVaultIo({ root: vault, prefixes: { read: ['R/'], write: ['W/'] } });
    expect(await asyncCode(() => io.writeVaultFile('R/x.md', 'x'))).toBe('ALLOWLIST_VIOLATION');
    await io.writeVaultFile('W/x.md', 'x');
    expect(await asyncCode(() => io.stat('W/x.md'))).toBe('ALLOWLIST_VIOLATION'); // W not in read scope
  });

  test('rewriteIfUnchanged guards on a stale sig with MTIME_CONFLICT', async () => {
    const io = createVaultIo({ root: vault, prefixes: { read: [''], write: [''] } });
    const sig1 = await io.writeVaultFile('x.md', 'AAA'); // size 3
    const sig2 = await io.rewriteIfUnchanged('x.md', 'BBBBB', sig1); // size 5
    expect((await io.readVaultFile('x.md'))?.content).toBe('BBBBB');
    expect(await asyncCode(() => io.rewriteIfUnchanged('x.md', 'CCCCCCC', sig1))).toBe(
      'MTIME_CONFLICT',
    );
    expect(await io.stat('x.md')).toEqual(sig2);
  });

  test('unlinkIfUnchanged deletes on match and is a no-op (false) when already gone', async () => {
    const io = createVaultIo({ root: vault, prefixes: { read: [''], write: [''] } });
    const sig = await io.writeVaultFile('y.md', 'hello');
    expect(await io.unlinkIfUnchanged('y.md', sig)).toBe(true);
    expect(await io.stat('y.md')).toBeNull();
    expect(await io.unlinkIfUnchanged('y.md', sig)).toBe(false);
  });
});
```

- [ ] **Step: Run to verify it fails** — `Run: bun test src/__tests__/vault-io.test.ts`
  Expected: FAIL — IO methods are not on the Cycle-2 returned object (TypeError: not a function); earlier tests still pass.

- [ ] **Step: Implement the atomic IO methods** — extend `src/vault-io.ts`:

```ts
// 1) extend the node:fs/promises import (add this import line near the top):
import { readFile } from 'node:fs/promises';

// 2) replace the `import type { Sig } from './fs-atomic.ts';` line with the value+type import:
import {
  type Sig,
  atomicWrite,
  atomicWriteIfUnchanged,
  statSig,
  unlinkIfUnchanged as fsUnlinkIfUnchanged,
} from './fs-atomic.ts';

// 3) add these methods INSIDE createVaultIo (after `resolveVaultPath`, before `return`):
  async function readVaultFile(rel: string): Promise<{ content: string; sig: Sig } | null> {
    const full = resolveVaultPath(rel, 'read');
    let content: string;
    try {
      content = await readFile(full, 'utf8');
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return null;
      throw e;
    }
    const sig = await statSig(full);
    if (sig === null) return null;

    return { content, sig };
  }

  async function writeVaultFile(rel: string, content: string): Promise<Sig> {
    const full = resolveVaultPath(rel, 'write');

    return atomicWrite(full, content);
  }

  async function rewriteIfUnchanged(rel: string, content: string, expected: Sig): Promise<Sig> {
    const full = resolveVaultPath(rel, 'write');

    return atomicWriteIfUnchanged(full, content, expected);
  }

  async function unlinkIfUnchanged(rel: string, expected: Sig): Promise<boolean> {
    const full = resolveVaultPath(rel, 'write');

    return fsUnlinkIfUnchanged(full, expected);
  }

  async function stat(rel: string): Promise<Sig | null> {
    const full = resolveVaultPath(rel, 'read');

    return statSig(full);
  }

// 4) extend the returned object:
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
  };
```

- [ ] **Step: Run to verify pass** — `Run: bun test src/__tests__/vault-io.test.ts`
  Expected: PASS (IO round-trip, scope routing, mtime-guard, idempotent unlink green).

---

#### Cycle 4 — `listMarkdown`: recursive enumeration, dotfolder/ignore skips, no escaping-symlink descent, per-`.md` realpath guard

- [ ] **Step: Write the failing test(s) for recursive enumeration and its security filters**

```ts
// append to src/__tests__/vault-io.test.ts
describe('listMarkdown', () => {
  test('recurses, returns sorted vault-relative .md, ignores non-.md, missing dir -> []', async () => {
    const io = createVaultIo({ root: vault, prefixes: { read: [''], write: [''] } });
    await writeFile(join(vault, 'a.md'), '# a');
    await writeFile(join(vault, 'notes.txt'), 'skip');
    await mkdir(join(vault, 'sub'));
    await writeFile(join(vault, 'sub', 'b.md'), '# b');
    const found = await io.listMarkdown();
    expect(found).toEqual(['a.md', 'sub/b.md']);
    expect(await io.listMarkdown('nope')).toEqual([]);
  });

  test('skips dotfolders (.obsidian/.trash/.git) and configured ignore globs', async () => {
    const io = createVaultIo({
      root: vault,
      prefixes: { read: [''], write: [''] },
      ignore: ['Drafts/**', '**/_*'],
    });
    await writeFile(join(vault, 'keep.md'), 'k');
    await mkdir(join(vault, '.obsidian'));
    await writeFile(join(vault, '.obsidian', 'cfg.md'), 'c');
    await mkdir(join(vault, 'Drafts'));
    await writeFile(join(vault, 'Drafts', 'secret.md'), 's');
    await writeFile(join(vault, '_template.md'), 't');
    const found = await io.listMarkdown();
    expect(found).toEqual(['keep.md']);
  });

  test('only lists under the read scope', async () => {
    const io = createVaultIo({ root: vault, prefixes: { read: ['Public/'], write: [''] } });
    await mkdir(join(vault, 'Public'));
    await writeFile(join(vault, 'Public', 'p.md'), 'p');
    await mkdir(join(vault, 'Private'));
    await writeFile(join(vault, 'Private', 's.md'), 's');
    const found = await io.listMarkdown();
    expect(found).toEqual(['Public/p.md']);
  });

  test('does NOT follow a vault-escaping symlinked dir, nor an escaping symlinked .md', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'mdvault-out-'));
    await writeFile(join(outside, 'secret.md'), '# secret');
    const io = createVaultIo({ root: vault, prefixes: { read: [''], write: [''] } });
    await writeFile(join(vault, 'a.md'), '# a');
    await mkdir(join(vault, 'sub'));
    await writeFile(join(vault, 'sub', 'b.md'), '# b');
    await symlink(outside, join(vault, 'evil')); // dir symlink -> outside
    await symlink(join(outside, 'secret.md'), join(vault, 'leak.md')); // file symlink -> outside
    const found = await io.listMarkdown();
    expect(found).toContain('a.md');
    expect(found).toContain('sub/b.md');
    expect(found).not.toContain('evil/secret.md');
    expect(found).not.toContain('leak.md');
    await rm(outside, { recursive: true, force: true });
  });
});
```

- [ ] **Step: Run to verify it fails** — `Run: bun test src/__tests__/vault-io.test.ts`
  Expected: FAIL — `listMarkdown` is not on the Cycle-3 returned object (TypeError: not a function); earlier tests still pass.

- [ ] **Step: Implement `listMarkdown` (+ ignore globs) and finalize the `: VaultIo` return type** — extend `src/vault-io.ts`:

```ts
// 1) extend the node:fs import to also bring the Dirent type:
import {
  type Dirent,
  existsSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

// 2) extend the node:fs/promises import:
import { readFile, readdir, stat as statEntry } from 'node:fs/promises';

// 3) add ONE line at the top of createVaultIo, right after canonPrefixes:
  const ignoreRes = (config.ignore ?? []).map(globToRegExp);

// 4) add these functions INSIDE createVaultIo (after `stat`, before `return`):
  function isIgnored(rel: string): boolean {
    return ignoreRes.some((re) => re.test(rel));
  }

  async function walk(absDir: string, relDir: string, out: string[]): Promise<void> {
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

// 5) pin the public return type and expose listMarkdown.
//    Change the factory signature to:  export function createVaultIo(config: VaultIoConfig): VaultIo {
//    and replace the returned object with the full surface:
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

// 6) add this module-level helper (alongside canonPrefix / detectCaseSensitive):
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
```

- [ ] **Step: Run to verify pass** — `Run: bun test src/__tests__/vault-io.test.ts`
  Expected: PASS (all four cycles green). Then `Run: bun run check` — Expected: PASS (Biome + `tsc --noEmit` clean; `createVaultIo` now returns the full `VaultIo`).

- [ ] **Step: Commit**

```bash
git add src/vault-io.ts src/__tests__/vault-io.test.ts && git commit -m "feat(vault-io): boundary-aware allowlist, realpath containment, atomic IO, listMarkdown"
```

---

### Task 5: locked-file

**Files:**
- Create: `src/locked-file.ts`
- Test: `src/__tests__/locked-file.test.ts`

**Interfaces:**
- Consumes:
  - From `./errors.ts` (Task 1): `class MdVaultError extends Error { readonly code: MdVaultCode; constructor(code: MdVaultCode, message: string, options?: { cause?: unknown }) }`
  - From `./fs-atomic.ts` (Task 2): `type Sig = { mtimeMs: number; size: number }`; `statSig(fullPath: string): Promise<Sig | null>`; `atomicWrite(fullPath: string, content: string): Promise<Sig>`; `atomicWriteIfUnchanged(fullPath: string, content: string, expected: Sig): Promise<Sig>` (throws `MdVaultError('MTIME_CONFLICT')`); `unlinkIfUnchanged(fullPath: string, expected: Sig): Promise<boolean>` (mismatch → `MTIME_CONFLICT`, ENOENT → `false`); `withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T>`; `withCrossProcessLock<T>(lockDir: string, key: string, busyTimeoutMs: number, fn: () => Promise<T>): Promise<T>`
- Produces (later tasks `notes` CRUD rely on these verbatim):
  - `type CommitEvent = { op: 'create' | 'update'; path: string; content: string } | { op: 'delete'; path: string }`
  - `type CrossLock = { lockDir: string; busyTimeoutMs: number }`
  - `type TransformOpts = { allowCreate?: boolean; onCommit?: (e: CommitEvent) => void | Promise<void>; maxRetries?: number; cross?: CrossLock | false }`
  - `type TransformResult = { content: string | null; outcome: 'created' | 'updated' | 'unchanged' }`
  - `function withFileTransform(fullPath: string, lockKey: string, relForCommit: string, transform: (current: string | null) => string | null, opts?: TransformOpts): Promise<TransformResult>`
  - `function withFileDelete(fullPath: string, lockKey: string, relForCommit: string, opts?: { onCommit?: (e: CommitEvent) => void | Promise<void>; cross?: CrossLock | false }): Promise<{ deleted: boolean }>`

> Note: `locked-file` operates on **absolute paths** + a canonical `lockKey` and does **not** import `vault-io`. The `opts.cross` branch is wired here but its serialize/stale-reclaim semantics are pinned by `fs-atomic`'s own tests (Task 2) — not re-tested here.

---

#### Cycle 1 — `withFileTransform` (read-consistency, create/refuse/unchanged/update, retry, onCommit)

- [ ] **Step: Write the failing test(s) for `withFileTransform`** — covers REFUSE_CREATE, create, unchanged (present + missing), update, onCommit create/update events, COMMIT_FAILED with cause, two concurrent appends (no lost update), and mtime-retry convergence under a simulated external mid-flight write.

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MdVaultError } from '../errors.ts'
import * as fsAtomic from '../fs-atomic.ts'
import { withFileTransform } from '../locked-file.ts'

let dir: string
let file: string
const KEY = 'note.md'
const REL = 'note.md'

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mdvault-locked-'))
  file = join(dir, 'note.md')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('withFileTransform', () => {
  test('missing file + allowCreate:false → REFUSE_CREATE, nothing written', async () => {
    let err: unknown
    try {
      await withFileTransform(file, KEY, REL, () => 'hello')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(MdVaultError)
    expect((err as MdVaultError).code).toBe('REFUSE_CREATE')
    expect(await fsAtomic.statSig(file)).toBeNull()
  })

  test('missing file + allowCreate:true → created, on disk, onCommit create event', async () => {
    const events: CommitSpy[] = []
    const res = await withFileTransform(file, KEY, REL, () => 'hello', {
      allowCreate: true,
      onCommit: (e) => {
        events.push(e)
      },
    })
    expect(res).toEqual({ content: 'hello', outcome: 'created' })
    expect(await readFile(file, 'utf8')).toBe('hello')
    expect(events).toEqual([{ op: 'create', path: REL, content: 'hello' }])
  })

  test('transform returns null on a present file → unchanged, untouched', async () => {
    await writeFile(file, 'orig')
    const before = await fsAtomic.statSig(file)
    const res = await withFileTransform(file, KEY, REL, () => null)
    expect(res).toEqual({ content: 'orig', outcome: 'unchanged' })
    expect(await readFile(file, 'utf8')).toBe('orig')
    expect(await fsAtomic.statSig(file)).toEqual(before)
  })

  test('transform returns null on a missing file → unchanged with null content (no REFUSE_CREATE)', async () => {
    const res = await withFileTransform(file, KEY, REL, () => null)
    expect(res).toEqual({ content: null, outcome: 'unchanged' })
    expect(await fsAtomic.statSig(file)).toBeNull()
  })

  test('present file changed → updated, disk updated, onCommit update event', async () => {
    await writeFile(file, 'a')
    const events: CommitSpy[] = []
    const res = await withFileTransform(file, KEY, REL, (c) => `${c}b`, {
      onCommit: (e) => {
        events.push(e)
      },
    })
    expect(res).toEqual({ content: 'ab', outcome: 'updated' })
    expect(await readFile(file, 'utf8')).toBe('ab')
    expect(events).toEqual([{ op: 'update', path: REL, content: 'ab' }])
  })

  test('onCommit throw → COMMIT_FAILED with cause, file already written (no rollback)', async () => {
    await writeFile(file, 'a')
    const boom = new Error('git commit failed')
    let err: unknown
    try {
      await withFileTransform(file, KEY, REL, () => 'NEW', {
        onCommit: () => {
          throw boom
        },
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(MdVaultError)
    expect((err as MdVaultError).code).toBe('COMMIT_FAILED')
    expect((err as MdVaultError).cause).toBe(boom)
    expect(await readFile(file, 'utf8')).toBe('NEW')
  })

  test('two concurrent appends on the same lockKey → no lost update', async () => {
    await writeFile(file, 'start\n')
    await Promise.all([
      withFileTransform(file, KEY, REL, (c) => `${c}X\n`),
      withFileTransform(file, KEY, REL, (c) => `${c}Y\n`),
    ])
    const final = await readFile(file, 'utf8')
    expect(final.startsWith('start\n')).toBe(true)
    expect(final).toContain('X')
    expect(final).toContain('Y')
    expect(final.length).toBe('start\nX\nY\n'.length)
  })

  test('external mid-flight write → retries on MTIME_CONFLICT and converges', async () => {
    await writeFile(file, 'base\n')
    let injected = false
    const res = await withFileTransform(file, KEY, REL, (c) => {
      if (!injected) {
        injected = true
        // External writer lands AFTER our consistent read, BEFORE our guarded write.
        // Size differs from 'base\n', so the pre-rename re-stat is guaranteed to mismatch.
        writeFileSync(file, 'base\nEXTERNAL\n')
      }

      return `${c}A`
    })
    expect(res.outcome).toBe('updated')
    expect(await readFile(file, 'utf8')).toBe('base\nEXTERNAL\nA')
  })
})

type CommitSpy =
  | { op: 'create' | 'update'; path: string; content: string }
  | { op: 'delete'; path: string }
```

- [ ] **Step: Run to verify it fails** — `Run: bun test src/__tests__/locked-file.test.ts`. Expected: FAIL — `src/locked-file.ts` does not exist / `withFileTransform` is not exported, so the import fails to resolve and every test errors.

- [ ] **Step: Implement `withFileTransform`** — full module with the read-consistency loop (`stat→read→stat`), bounded linear-backoff retry on `MTIME_CONFLICT`, the `allowCreate`/REFUSE_CREATE branch, the `onCommit` seam wrapping throws as `COMMIT_FAILED`, and optional cross-process lock wiring.

```ts
import { readFile } from 'node:fs/promises'

import { MdVaultError } from './errors.ts'
import {
  type Sig,
  atomicWrite,
  atomicWriteIfUnchanged,
  statSig,
  withCrossProcessLock,
  withFileLock,
} from './fs-atomic.ts'

export type CommitEvent =
  | { op: 'create' | 'update'; path: string; content: string }
  | { op: 'delete'; path: string }

export type CrossLock = { lockDir: string; busyTimeoutMs: number }

export type TransformOpts = {
  allowCreate?: boolean
  onCommit?: (e: CommitEvent) => void | Promise<void>
  maxRetries?: number
  cross?: CrossLock | false
}

export type TransformResult = {
  content: string | null
  outcome: 'created' | 'updated' | 'unchanged'
}

type ConsistentRead = { content: string; sig: Sig } | { content: null; sig: null }

// stat -> read -> stat: only return a (content, sig) pair captured while the
// file did not change under us. Missing file -> { content: null, sig: null }.
async function readConsistent(fullPath: string): Promise<ConsistentRead> {
  for (;;) {
    const sig1 = await statSig(fullPath)
    if (sig1 === null) {
      return { content: null, sig: null }
    }
    let content: string
    try {
      content = await readFile(fullPath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }

      throw err
    }
    const sig2 = await statSig(fullPath)
    if (sig2 !== null && sig2.mtimeMs === sig1.mtimeMs && sig2.size === sig1.size) {
      return { content, sig: sig2 }
    }
  }
}

async function emitCommit(
  onCommit: ((e: CommitEvent) => void | Promise<void>) | undefined,
  event: CommitEvent,
): Promise<void> {
  if (!onCommit) {
    return
  }
  try {
    await onCommit(event)
  } catch (cause) {
    throw new MdVaultError('COMMIT_FAILED', `onCommit failed for ${event.path}`, { cause })
  }
}

export function withFileTransform(
  fullPath: string,
  lockKey: string,
  relForCommit: string,
  transform: (current: string | null) => string | null,
  opts: TransformOpts = {},
): Promise<TransformResult> {
  const { allowCreate = false, onCommit, maxRetries = 3, cross = false } = opts

  const run = async (): Promise<TransformResult> => {
    let attempt = 0
    for (;;) {
      const read = await readConsistent(fullPath)
      const next = transform(read.content)

      if (next === null) {
        return { content: read.content, outcome: 'unchanged' }
      }
      if (read.content === null) {
        if (!allowCreate) {
          throw new MdVaultError('REFUSE_CREATE', `refusing to create missing file: ${relForCommit}`)
        }
        await atomicWrite(fullPath, next)
        await emitCommit(onCommit, { op: 'create', path: relForCommit, content: next })

        return { content: next, outcome: 'created' }
      }
      try {
        await atomicWriteIfUnchanged(fullPath, next, read.sig)
      } catch (err) {
        if (err instanceof MdVaultError && err.code === 'MTIME_CONFLICT' && attempt < maxRetries) {
          await Bun.sleep(50 * (attempt + 1))
          attempt++

          continue
        }

        throw err
      }
      await emitCommit(onCommit, { op: 'update', path: relForCommit, content: next })

      return { content: next, outcome: 'updated' }
    }
  }

  const locked = () => withFileLock(lockKey, run)

  if (cross) {
    return withCrossProcessLock(cross.lockDir, lockKey, cross.busyTimeoutMs, locked)
  }

  return locked()
}
```

- [ ] **Step: Run to verify pass** — `Run: bun test src/__tests__/locked-file.test.ts`. Expected: PASS — all `withFileTransform` tests green (retry converges to `base\nEXTERNAL\nA`; concurrent appends serialized by `withFileLock`).

---

#### Cycle 2 — `withFileDelete` (CAS-like delete)

- [ ] **Step: Write the failing test(s) for `withFileDelete`** — missing → `{ deleted: false }` with no `onCommit`; present → unlink + `onCommit` delete event; signature changed under us → `MTIME_CONFLICT`, file left intact. Add `spyOn` to the `bun:test` import and `withFileDelete` to the `../locked-file.ts` import at the top of the file, then append:

```ts
// update existing top imports to:
//   import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
//   import { withFileDelete, withFileTransform } from '../locked-file.ts'

describe('withFileDelete', () => {
  test('missing file → { deleted:false }, onCommit not called', async () => {
    const events: CommitSpy[] = []
    const res = await withFileDelete(file, KEY, REL, {
      onCommit: (e) => {
        events.push(e)
      },
    })
    expect(res).toEqual({ deleted: false })
    expect(events).toEqual([])
  })

  test('present file → unlink + onCommit delete event, { deleted:true }', async () => {
    await writeFile(file, 'bye')
    const events: CommitSpy[] = []
    const res = await withFileDelete(file, KEY, REL, {
      onCommit: (e) => {
        events.push(e)
      },
    })
    expect(res).toEqual({ deleted: true })
    expect(events).toEqual([{ op: 'delete', path: REL }])
    expect(await fsAtomic.statSig(file)).toBeNull()
  })

  test('signature changed under us → MTIME_CONFLICT, file not deleted', async () => {
    await writeFile(file, 'bye')
    // Bun ESM live-binding + spyOn (the repo-blessed pattern): make ONLY the
    // first statSig call (the one inside withFileDelete) return a stale sig;
    // unlinkIfUnchanged then re-stats the real file -> size mismatch -> conflict.
    const realStatSig = fsAtomic.statSig
    let n = 0
    const spy = spyOn(fsAtomic, 'statSig').mockImplementation(async (p: string) => {
      n++
      const real = await realStatSig(p)
      if (n === 1 && real) {
        return { mtimeMs: real.mtimeMs, size: real.size + 7 }
      }

      return real
    })
    let err: unknown
    try {
      await withFileDelete(file, KEY, REL)
    } catch (e) {
      err = e
    } finally {
      spy.mockRestore()
    }
    expect(err).toBeInstanceOf(MdVaultError)
    expect((err as MdVaultError).code).toBe('MTIME_CONFLICT')
    expect(await readFile(file, 'utf8')).toBe('bye')
  })
})
```

- [ ] **Step: Run to verify it fails** — `Run: bun test src/__tests__/locked-file.test.ts`. Expected: FAIL — `withFileDelete` is not exported from `src/locked-file.ts` yet, so the named import fails to link and the new delete tests error.

- [ ] **Step: Implement `withFileDelete`** — add `unlinkIfUnchanged` to the `./fs-atomic.ts` import, then append the function. Under the lock: `statSig` → missing returns `{ deleted: false }` (no `onCommit`); else `unlinkIfUnchanged(sig)` (ENOENT race → `false` → `{ deleted: false }`; sig mismatch → `MTIME_CONFLICT` propagates); on success → `onCommit({ op: 'delete' })` → `{ deleted: true }`.

```ts
// extend the './fs-atomic.ts' import to include unlinkIfUnchanged:
//   import {
//     type Sig,
//     atomicWrite,
//     atomicWriteIfUnchanged,
//     statSig,
//     unlinkIfUnchanged,
//     withCrossProcessLock,
//     withFileLock,
//   } from './fs-atomic.ts'

export function withFileDelete(
  fullPath: string,
  lockKey: string,
  relForCommit: string,
  opts: { onCommit?: (e: CommitEvent) => void | Promise<void>; cross?: CrossLock | false } = {},
): Promise<{ deleted: boolean }> {
  const { onCommit, cross = false } = opts

  const run = async (): Promise<{ deleted: boolean }> => {
    const sig = await statSig(fullPath)
    if (sig === null) {
      return { deleted: false }
    }
    const removed = await unlinkIfUnchanged(fullPath, sig)
    if (!removed) {
      return { deleted: false }
    }
    await emitCommit(onCommit, { op: 'delete', path: relForCommit })

    return { deleted: true }
  }

  const locked = () => withFileLock(lockKey, run)

  if (cross) {
    return withCrossProcessLock(cross.lockDir, lockKey, cross.busyTimeoutMs, locked)
  }

  return locked()
}
```

- [ ] **Step: Run to verify pass** — `Run: bun test src/__tests__/locked-file.test.ts`. Expected: PASS — all `withFileTransform` and `withFileDelete` tests green.

---

- [ ] **Step: Commit**

```bash
git add src/locked-file.ts src/__tests__/locked-file.test.ts && git commit -m "feat(locked-file): atomic transform/delete with per-key lock, mtime-retry, onCommit seam"
```

---

### Task 6: frontmatter

**Files:**
- Create: `src/frontmatter.ts`
- Test: `src/__tests__/frontmatter.test.ts`

**Interfaces:**
- Consumes: none from siblings. Runtime dep only: `yaml` (`import { Document, parse, parseDocument } from 'yaml'`). Install with `bun add yaml`.
- Produces:
  - `export type FrontmatterValidity = 'flat' | 'present-but-invalid' | 'none'`
  - `export type ParsedFrontmatter = { frontmatter: Record<string, unknown>; tags: string[]; body: string; valid: FrontmatterValidity }`
  - `export function parseFrontmatter(content: string): ParsedFrontmatter` — NEVER throws; `'---'` fenced block; `uniqueKeys:false`; body = content after block
  - `export type EditOutcome = 'edited' | 'unchanged' | 'unverifiable'`
  - `export function editFrontmatter(content: string, mutate: (fm: Record<string, unknown>) => void): { content: string; outcome: EditOutcome }`
  - `export function deriveTags(frontmatter: Record<string, unknown>): string[]`
  - `export function isFlatFrontmatter(fm: Record<string, unknown>): boolean`

---

- [ ] **Step: Write the failing test(s) for `deriveTags` + `isFlatFrontmatter`** (pure helpers, no `yaml`).
```ts
import { describe, expect, test } from 'bun:test';

import { deriveTags, isFlatFrontmatter } from '../frontmatter.ts';

describe('deriveTags', () => {
  test('scalar string -> single tag', () => {
    expect(deriveTags({ tags: 'foo' })).toEqual(['foo']);
  });

  test('comma-separated string -> list', () => {
    expect(deriveTags({ tags: 'a, b, c' })).toEqual(['a', 'b', 'c']);
  });

  test('space-separated string -> list', () => {
    expect(deriveTags({ tags: 'a b c' })).toEqual(['a', 'b', 'c']);
  });

  test('yaml list -> list', () => {
    expect(deriveTags({ tags: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  test('strips leading # and dedups, case-preserving', () => {
    expect(deriveTags({ tags: ['#Foo', '#foo', 'Bar', 'Bar'] })).toEqual([
      'Foo',
      'foo',
      'Bar',
    ]);
  });

  test('falls back to singular "tag" key', () => {
    expect(deriveTags({ tag: 'solo' })).toEqual(['solo']);
  });

  test('absent / empty -> []', () => {
    expect(deriveTags({})).toEqual([]);
    expect(deriveTags({ tags: '' })).toEqual([]);
  });
});

describe('isFlatFrontmatter', () => {
  test('scalars + array-of-scalar + null -> true', () => {
    expect(
      isFlatFrontmatter({ a: 1, b: 'x', c: true, d: ['p', 'q'], e: null }),
    ).toBe(true);
  });

  test('empty object -> true', () => {
    expect(isFlatFrontmatter({})).toBe(true);
  });

  test('nested map -> false', () => {
    expect(isFlatFrontmatter({ a: 1, meta: { x: 1 } })).toBe(false);
  });

  test('array-of-object -> false', () => {
    expect(isFlatFrontmatter({ a: [{ x: 1 }] })).toBe(false);
  });
});
```

- [ ] **Step: Run to verify it fails** — `Run: bun test src/__tests__/frontmatter.test.ts` — Expected: FAIL (cannot resolve `../frontmatter.ts` / `deriveTags` and `isFlatFrontmatter` are not exported).

- [ ] **Step: Implement `deriveTags` + `isFlatFrontmatter`** — create `src/frontmatter.ts` with the types and the two pure helpers (no `yaml` import yet).
```ts
export type FrontmatterValidity = 'flat' | 'present-but-invalid' | 'none';

export type ParsedFrontmatter = {
  frontmatter: Record<string, unknown>;
  tags: string[];
  body: string;
  valid: FrontmatterValidity;
};

export type EditOutcome = 'edited' | 'unchanged' | 'unverifiable';

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    value instanceof Date ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function isScalarOrArrayOfScalar(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.every(isScalar);
  }

  return isScalar(value);
}

export function isFlatFrontmatter(fm: Record<string, unknown>): boolean {
  for (const value of Object.values(fm)) {
    if (!isScalarOrArrayOfScalar(value)) {
      return false;
    }
  }

  return true;
}

function toTagTokens(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(toTagTokens);
  }
  if (typeof value === 'string') {
    return value
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }

  return [];
}

export function deriveTags(frontmatter: Record<string, unknown>): string[] {
  const source =
    frontmatter.tags !== undefined ? frontmatter.tags : frontmatter.tag;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of toTagTokens(source)) {
    const stripped = token.replace(/^#+/, '');
    if (stripped && !seen.has(stripped)) {
      seen.add(stripped);
      out.push(stripped);
    }
  }

  return out;
}
```

- [ ] **Step: Run to verify pass** — `Run: bun test src/__tests__/frontmatter.test.ts` — Expected: PASS.

---

- [ ] **Step: Write the failing test(s) for `parseFrontmatter`** (never-throws / validity classification / body split).
```ts
import { parseFrontmatter } from '../frontmatter.ts';

describe('parseFrontmatter', () => {
  test('flat frontmatter -> parsed map + tags + body split', () => {
    const content = `---
title: Hello
tags: [a, b]
---

# Heading
text`;
    const r = parseFrontmatter(content);
    expect(r.valid).toBe('flat');
    expect(r.frontmatter.title).toBe('Hello');
    expect(r.tags).toEqual(['a', 'b']);
    expect(r.body).toBe('\n# Heading\ntext');
  });

  test('absent frontmatter -> valid "none", body is full content', () => {
    const content = '# Just a heading\n\nbody';
    const r = parseFrontmatter(content);
    expect(r.valid).toBe('none');
    expect(r.frontmatter).toEqual({});
    expect(r.tags).toEqual([]);
    expect(r.body).toBe(content);
  });

  test('empty frontmatter block -> flat empty', () => {
    const r = parseFrontmatter('---\n---\nbody');
    expect(r.valid).toBe('flat');
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe('body');
  });

  test('duplicate keys never throw (uniqueKeys:false)', () => {
    const content = '---\ntitle: A\ntitle: B\n---\nbody';
    expect(() => parseFrontmatter(content)).not.toThrow();
    const r = parseFrontmatter(content);
    expect(r.valid).toBe('flat');
    expect(r.body).toBe('body');
    expect(r.frontmatter.title).toBeDefined();
  });

  test('malformed YAML -> present-but-invalid, still splits body, never throws', () => {
    const content = '---\nfoo: [unclosed\n---\nbody';
    expect(() => parseFrontmatter(content)).not.toThrow();
    const r = parseFrontmatter(content);
    expect(r.valid).toBe('present-but-invalid');
    expect(r.body).toBe('body');
  });

  test('nested map frontmatter -> present-but-invalid (parsed but not flat)', () => {
    const content = '---\ntitle: x\nmeta:\n  a: 1\n---\nbody';
    const r = parseFrontmatter(content);
    expect(r.valid).toBe('present-but-invalid');
    expect(r.frontmatter.meta).toEqual({ a: 1 });
  });
});
```

- [ ] **Step: Run to verify it fails** — `Run: bun test src/__tests__/frontmatter.test.ts` — Expected: FAIL (`parseFrontmatter` is not exported).

- [ ] **Step: Implement `parseFrontmatter`** — first run `bun add yaml`, then add the `yaml` import at the top of `src/frontmatter.ts` and the block extractor + `parseFrontmatter` below the helpers.
```ts
// At the top of src/frontmatter.ts (external-package group):
import { parse } from 'yaml';

// ...types + isFlatFrontmatter + deriveTags from the previous cycle stay above...

type Block = { yaml: string; body: string };

function extractBlock(content: string): Block | null {
  const firstNl = content.indexOf('\n');
  if (firstNl === -1) {
    return null;
  }
  if (content.slice(0, firstNl).replace(/\r$/, '') !== '---') {
    return null;
  }
  const lines = content.slice(firstNl + 1).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].replace(/\r$/, '') === '---') {
      const yaml = lines.slice(0, i).join('\n');
      const body = lines.slice(i + 1).join('\n');

      return { yaml, body };
    }
  }

  return null;
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
  const block = extractBlock(content);
  if (!block) {
    return { frontmatter: {}, tags: [], body: content, valid: 'none' };
  }
  const { yaml: yamlText, body } = block;
  let parsed: unknown;
  try {
    parsed = parse(yamlText, { uniqueKeys: false });
  } catch {
    return { frontmatter: {}, tags: [], body, valid: 'present-but-invalid' };
  }
  if (parsed === null || parsed === undefined) {
    return { frontmatter: {}, tags: [], body, valid: 'flat' };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { frontmatter: {}, tags: [], body, valid: 'present-but-invalid' };
  }
  const frontmatter = parsed as Record<string, unknown>;
  const valid: FrontmatterValidity = isFlatFrontmatter(frontmatter)
    ? 'flat'
    : 'present-but-invalid';

  return { frontmatter, tags: deriveTags(frontmatter), body, valid };
}
```

- [ ] **Step: Run to verify pass** — `Run: bun test src/__tests__/frontmatter.test.ts` — Expected: PASS.

---

- [ ] **Step: Write the failing test(s) for `editFrontmatter`** (format-preserving multi-field mutate, delete, absent→create, unchanged, fail-closed on invalid/nested).
```ts
import { editFrontmatter } from '../frontmatter.ts';

describe('editFrontmatter', () => {
  test('multi-field mutate preserves comments, order, 1.0, empty aliases', () => {
    const content = `---
# top comment
title: Old
order: [b, a]
weight: 1.0
aliases:
---
body text
`;
    const r = editFrontmatter(content, (fm) => {
      fm.title = 'New';
      fm.status = 'done';
    });
    expect(r.outcome).toBe('edited');
    expect(r.content).toContain('# top comment');
    expect(r.content).toContain('title: New');
    expect(r.content).toContain('weight: 1.0'); // numeric literal not collapsed to 1
    expect(r.content).not.toContain('weight: 1\n');
    expect(r.content).toMatch(/^aliases:[ \t]*$/m); // empty value preserved
    const idx = (s: string) => r.content.indexOf(s);
    expect(idx('title')).toBeLessThan(idx('order'));
    expect(idx('order')).toBeLessThan(idx('weight'));
    expect(idx('weight')).toBeLessThan(idx('aliases'));
    expect(idx('status')).toBeGreaterThan(idx('aliases')); // new key appended last
    expect(r.content.endsWith('body text\n')).toBe(true); // body preserved
  });

  test('deleting a key removes it, outcome edited', () => {
    const content = '---\nkeep: 1\ndrop: 2\n---\nb';
    const r = editFrontmatter(content, (fm) => {
      delete fm.drop;
    });
    expect(r.outcome).toBe('edited');
    expect(r.content).toContain('keep: 1');
    expect(r.content).not.toContain('drop:');
    expect(r.content.endsWith('---\nb')).toBe(true);
  });

  test('absent frontmatter -> creates a new block at the top', () => {
    const content = '# Title\n\nSome body.\n';
    const r = editFrontmatter(content, (fm) => {
      fm.title = 'Created';
    });
    expect(r.outcome).toBe('edited');
    expect(r.content.startsWith('---\ntitle: Created\n---\n')).toBe(true);
    expect(r.content.endsWith(content)).toBe(true);
  });

  test('no-op mutate -> unchanged, content untouched', () => {
    const content = '---\ntitle: x\n---\nbody';
    const r = editFrontmatter(content, () => {});
    expect(r.outcome).toBe('unchanged');
    expect(r.content).toBe(content);
  });

  test('present-but-invalid -> unverifiable, no write', () => {
    const content = '---\nfoo: [unclosed\n---\nbody';
    const r = editFrontmatter(content, (fm) => {
      fm.title = 'x';
    });
    expect(r.outcome).toBe('unverifiable');
    expect(r.content).toBe(content);
  });

  test('mutate introducing a nested map -> unverifiable, no write', () => {
    const content = '---\ntitle: x\n---\nbody';
    const r = editFrontmatter(content, (fm) => {
      fm.meta = { a: 1 };
    });
    expect(r.outcome).toBe('unverifiable');
    expect(r.content).toBe(content);
  });
});
```

- [ ] **Step: Run to verify it fails** — `Run: bun test src/__tests__/frontmatter.test.ts` — Expected: FAIL (`editFrontmatter` is not exported).

- [ ] **Step: Implement `editFrontmatter`** — widen the `yaml` import to include `Document` + `parseDocument`, then append `editFrontmatter`.
```ts
// Update the existing import line at the top of src/frontmatter.ts to:
import { Document, parse, parseDocument } from 'yaml';

// Append below parseFrontmatter:

export function editFrontmatter(
  content: string,
  mutate: (fm: Record<string, unknown>) => void,
): { content: string; outcome: EditOutcome } {
  const parsed = parseFrontmatter(content);
  if (parsed.valid === 'present-but-invalid') {
    return { content, outcome: 'unverifiable' };
  }
  if (parsed.valid === 'none') {
    const view: Record<string, unknown> = {};
    mutate(view);
    if (!isFlatFrontmatter(view)) {
      return { content, outcome: 'unverifiable' };
    }
    if (Object.keys(view).length === 0) {
      return { content, outcome: 'unchanged' };
    }
    const block = String(new Document(view)).replace(/\n$/, '');

    return { content: `---\n${block}\n---\n${content}`, outcome: 'edited' };
  }
  const ext = extractBlock(content);
  if (!ext) {
    return { content, outcome: 'unverifiable' };
  }
  const doc = parseDocument(ext.yaml, { uniqueKeys: false });
  const before = (doc.toJS() ?? {}) as Record<string, unknown>;
  const view = structuredClone(before);
  mutate(view);
  if (!isFlatFrontmatter(view)) {
    return { content, outcome: 'unverifiable' };
  }
  let changed = false;
  for (const key of Object.keys(before)) {
    if (!(key in view)) {
      doc.delete(key);
      changed = true;
    }
  }
  for (const key of Object.keys(view)) {
    if (
      !(key in before) ||
      JSON.stringify(before[key]) !== JSON.stringify(view[key])
    ) {
      doc.set(key, view[key]);
      changed = true;
    }
  }
  if (!changed) {
    return { content, outcome: 'unchanged' };
  }
  const serialized = String(doc);
  const block = serialized.endsWith('\n')
    ? serialized.slice(0, -1)
    : serialized;

  return { content: `---\n${block}\n---\n${ext.body}`, outcome: 'edited' };
}
```

- [ ] **Step: Run to verify pass** — `Run: bun test src/__tests__/frontmatter.test.ts` — Expected: PASS (all cycles green). Also run `Run: bun run check` (Biome + tsc) — Expected: clean.

---

- [ ] **Step: Commit**
```bash
git add src/frontmatter.ts src/__tests__/frontmatter.test.ts package.json bun.lock && git commit -m "feat(frontmatter): total parse + format-preserving editFrontmatter, tag derivation"
```

---

I have enough context. Here is the complete Task 7 block.

### Task 7: links

**Files:**
- Create: `src/links.ts`
- Test: `src/__tests__/links.test.ts`

**Interfaces:**
- Consumes: none (standalone module; uses `node:path` `posix` only)
- Produces:
  - `export type ExtractedLinks = { wikilinks: string[]; embeds: string[]; mdLinks: string[] }`
  - `export function extractLinks(content: string): ExtractedLinks`
  - `export type LinkResolution = 'wikilink' | 'relative'`
  - `export type StoredLink = { target: string; base: string | null; kind: 'wikilink' | 'embed' | 'mdlink' }`
  - `export function storedLinksFor(content: string, srcRel: string, mode: LinkResolution): StoredLink[]`

---

#### Cycle 1 — `extractLinks` (wikilinks / embeds / mdLinks, fenced-code skip)

- [ ] **Step: Write the failing test(s) for `extractLinks`**

```ts
import { describe, expect, test } from 'bun:test'

import { extractLinks } from '../links.ts'

describe('extractLinks', () => {
  test('finds wikilinks, embeds, and markdown links with raw targets', () => {
    const md = [
      'See [[Foo]] and [[Folder/Bar#heading|Alias]].',
      'Embed: ![[Image.png]] and ![[Note]].',
      'A [link text](notes/target.md) here.',
    ].join('\n')
    const { wikilinks, embeds, mdLinks } = extractLinks(md)
    expect(wikilinks).toEqual(['Foo', 'Folder/Bar#heading|Alias'])
    expect(embeds).toEqual(['Image.png', 'Note'])
    expect(mdLinks).toEqual(['notes/target.md'])
  })

  test('ignores links inside fenced code blocks', () => {
    const md = [
      'Real [[Outside]] link.',
      '```ts',
      'const x = "[[Inside]]"',
      'const y = "[txt](inside.md)"',
      '```',
      'Another [out](real.md).',
    ].join('\n')
    const { wikilinks, embeds, mdLinks } = extractLinks(md)
    expect(wikilinks).toEqual(['Outside'])
    expect(embeds).toEqual([])
    expect(mdLinks).toEqual(['real.md'])
  })

  test('strips markdown link titles and unwraps angle-bracket urls', () => {
    const md = '[a](path.md "Some Title") and [b](<spaced name.md>)'
    const { mdLinks } = extractLinks(md)
    expect(mdLinks).toEqual(['path.md', 'spaced name.md'])
  })

  test('does not treat image embeds as markdown links', () => {
    const md = '![alt](pic.png) but [real](doc.md)'
    const { mdLinks } = extractLinks(md)
    expect(mdLinks).toEqual(['doc.md'])
  })
})
```

- [ ] **Step: Run to verify it fails** — `Run: bun test src/__tests__/links.test.ts`
  Expected: FAIL with `Cannot find module '../links.ts'` (the module does not exist yet).

- [ ] **Step: Implement `extractLinks`**

```ts
export type ExtractedLinks = {
  wikilinks: string[]
  embeds: string[]
  mdLinks: string[]
}

function stripFencedCode(content: string): string {
  const lines = content.split('\n')
  const out: string[] = []
  let inFence = false
  for (const line of lines) {
    if (/^[ \t]*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (!inFence) {
      out.push(line)
    }
  }

  return out.join('\n')
}

function mdLinkUrl(raw: string): string {
  const t = raw.trim()
  if (t.startsWith('<')) {
    const end = t.indexOf('>')

    return (end >= 0 ? t.slice(1, end) : t.slice(1)).trim()
  }

  return t.split(/\s+/)[0]
}

export function extractLinks(content: string): ExtractedLinks {
  const src = stripFencedCode(content)
  const wikilinks: string[] = []
  const embeds: string[] = []
  const mdLinks: string[] = []

  const wikiRe = /(!?)\[\[([^\]\n]+)\]\]/g
  let m: RegExpExecArray | null
  while ((m = wikiRe.exec(src)) !== null) {
    const raw = m[2].trim()
    if (!raw) continue
    if (m[1] === '!') {
      embeds.push(raw)
    } else {
      wikilinks.push(raw)
    }
  }

  const mdRe = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g
  while ((m = mdRe.exec(src)) !== null) {
    const url = mdLinkUrl(m[1])
    if (!url) continue
    mdLinks.push(url)
  }

  return { wikilinks, embeds, mdLinks }
}
```

- [ ] **Step: Run to verify pass** — `Run: bun test src/__tests__/links.test.ts`
  Expected: PASS (4 tests).

---

#### Cycle 2 — `storedLinksFor` wikilink mode (path-qualified target, case-folded base, strip `#`/`^`/`|`, embeds)

- [ ] **Step: Write the failing test(s) for wikilink-mode storage**

```ts
import { storedLinksFor } from '../links.ts'

describe('storedLinksFor (wikilink mode)', () => {
  test('preserves path-qualified target and derives case-folded base', () => {
    const out = storedLinksFor('link to [[Folder/Foo]]', 'src.md', 'wikilink')
    expect(out).toEqual([{ target: 'Folder/Foo', base: 'foo', kind: 'wikilink' }])
  })

  test('strips heading / block / alias; bare link base = lowercased name', () => {
    const md = '[[Foo#Section|Alias]] [[Bar#^block123]] [[Baz]]'
    const out = storedLinksFor(md, 'src.md', 'wikilink')
    expect(out).toEqual([
      { target: 'Foo', base: 'foo', kind: 'wikilink' },
      { target: 'Bar', base: 'bar', kind: 'wikilink' },
      { target: 'Baz', base: 'baz', kind: 'wikilink' },
    ])
  })

  test('embeds get kind embed; trailing .md dropped; md links ignored', () => {
    const md = '![[Notes/Daily.md]] plus [ignored](other.md)'
    const out = storedLinksFor(md, 'src.md', 'wikilink')
    expect(out).toEqual([{ target: 'Notes/Daily', base: 'daily', kind: 'embed' }])
  })
})
```

- [ ] **Step: Run to verify it fails** — `Run: bun test src/__tests__/links.test.ts`
  Expected: FAIL with `Export named 'storedLinksFor' not found in module '.../src/links.ts'` (function not yet exported).

- [ ] **Step: Implement `storedLinksFor` (wikilink branch)** — append the types + helper + function to `src/links.ts`:

```ts
export type LinkResolution = 'wikilink' | 'relative'

export type StoredLink = {
  target: string
  base: string | null
  kind: 'wikilink' | 'embed' | 'mdlink'
}

function normalizeWikiTarget(raw: string): string {
  let t = raw
  const pipe = t.indexOf('|')
  if (pipe >= 0) t = t.slice(0, pipe)
  const hash = t.indexOf('#')
  if (hash >= 0) t = t.slice(0, hash)
  t = t.trim().replace(/\\/g, '/').normalize('NFC')
  if (t.startsWith('./')) t = t.slice(2)
  t = t.replace(/\.md$/i, '')

  return t
}

export function storedLinksFor(
  content: string,
  srcRel: string,
  mode: LinkResolution,
): StoredLink[] {
  const links = extractLinks(content)
  const out: StoredLink[] = []

  if (mode === 'wikilink') {
    const push = (raw: string, kind: 'wikilink' | 'embed') => {
      const target = normalizeWikiTarget(raw)
      if (!target) return
      const base = (target.split('/').pop() ?? target).toLowerCase()
      out.push({ target, base, kind })
    }
    for (const w of links.wikilinks) push(w, 'wikilink')
    for (const e of links.embeds) push(e, 'embed')

    return out
  }

  // relative mode: implemented in the next cycle
  return out
}
```

- [ ] **Step: Run to verify pass** — `Run: bun test src/__tests__/links.test.ts`
  Expected: PASS (7 tests).

---

#### Cycle 3 — `storedLinksFor` relative mode (resolve against src dir, drop external/anchor/image/non-`.md`/absolute/escape)

- [ ] **Step: Write the failing test(s) for relative-mode storage**

```ts
describe('storedLinksFor (relative mode)', () => {
  test('resolves md link against the source dir', () => {
    const out = storedLinksFor('see [a](../x.md)', 'folder/note.md', 'relative')
    expect(out).toEqual([{ target: 'x.md', base: null, kind: 'mdlink' }])
  })

  test('resolves nested and dot-relative paths, keeping the .md key', () => {
    const out = storedLinksFor('[a](sub/deep.md) and [b](./same.md)', 'a/b/note.md', 'relative')
    expect(out).toEqual([
      { target: 'a/b/sub/deep.md', base: null, kind: 'mdlink' },
      { target: 'a/b/same.md', base: null, kind: 'mdlink' },
    ])
  })

  test('drops external, anchor, image, non-md, absolute, and root-escaping links', () => {
    const md = [
      '[ext](https://example.com/page.md)',
      '[mail](mailto:a@b.com)',
      '[anchor](#section)',
      '[img](pic.png)',
      '[txt](readme.txt)',
      '[abs](/vault/root.md)',
      '[escape](../../outside.md)',
      '[ok](kept.md)',
    ].join('\n')
    const out = storedLinksFor(md, 'note.md', 'relative')
    expect(out).toEqual([{ target: 'kept.md', base: null, kind: 'mdlink' }])
  })

  test('strips anchor from an internal md link before resolving', () => {
    const out = storedLinksFor('[a](target.md#section)', 'note.md', 'relative')
    expect(out).toEqual([{ target: 'target.md', base: null, kind: 'mdlink' }])
  })

  test('wikilinks are ignored in relative mode', () => {
    const out = storedLinksFor('[[Foo]] and [a](x.md)', 'note.md', 'relative')
    expect(out).toEqual([{ target: 'x.md', base: null, kind: 'mdlink' }])
  })
})
```

- [ ] **Step: Run to verify it fails** — `Run: bun test src/__tests__/links.test.ts`
  Expected: FAIL — relative branch returns `[]`, so each relative assertion fails (`expected [...] to equal []`).

- [ ] **Step: Implement `storedLinksFor` (full, final file)** — `src/links.ts` in its complete form:

```ts
import { posix } from 'node:path'

export type ExtractedLinks = {
  wikilinks: string[]
  embeds: string[]
  mdLinks: string[]
}

export type LinkResolution = 'wikilink' | 'relative'

export type StoredLink = {
  target: string
  base: string | null
  kind: 'wikilink' | 'embed' | 'mdlink'
}

function stripFencedCode(content: string): string {
  const lines = content.split('\n')
  const out: string[] = []
  let inFence = false
  for (const line of lines) {
    if (/^[ \t]*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (!inFence) {
      out.push(line)
    }
  }

  return out.join('\n')
}

function mdLinkUrl(raw: string): string {
  const t = raw.trim()
  if (t.startsWith('<')) {
    const end = t.indexOf('>')

    return (end >= 0 ? t.slice(1, end) : t.slice(1)).trim()
  }

  return t.split(/\s+/)[0]
}

export function extractLinks(content: string): ExtractedLinks {
  const src = stripFencedCode(content)
  const wikilinks: string[] = []
  const embeds: string[] = []
  const mdLinks: string[] = []

  const wikiRe = /(!?)\[\[([^\]\n]+)\]\]/g
  let m: RegExpExecArray | null
  while ((m = wikiRe.exec(src)) !== null) {
    const raw = m[2].trim()
    if (!raw) continue
    if (m[1] === '!') {
      embeds.push(raw)
    } else {
      wikilinks.push(raw)
    }
  }

  const mdRe = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g
  while ((m = mdRe.exec(src)) !== null) {
    const url = mdLinkUrl(m[1])
    if (!url) continue
    mdLinks.push(url)
  }

  return { wikilinks, embeds, mdLinks }
}

function normalizeWikiTarget(raw: string): string {
  let t = raw
  const pipe = t.indexOf('|')
  if (pipe >= 0) t = t.slice(0, pipe)
  const hash = t.indexOf('#')
  if (hash >= 0) t = t.slice(0, hash)
  t = t.trim().replace(/\\/g, '/').normalize('NFC')
  if (t.startsWith('./')) t = t.slice(2)
  t = t.replace(/\.md$/i, '')

  return t
}

function resolveRelativeTarget(raw: string, srcDir: string): string | null {
  let t = raw.trim()
  if (!t) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return null // external scheme (http(s)/mailto/...)
  if (t.startsWith('#')) return null // bare in-note anchor
  t = t.split('#')[0]
  if (!t) return null
  if (t.startsWith('/')) return null // absolute path
  let resolved = posix.normalize(posix.join(srcDir, t)).normalize('NFC')
  if (resolved.startsWith('../') || resolved === '..') return null // escapes root
  if (resolved.startsWith('./')) resolved = resolved.slice(2)
  if (!resolved) return null
  if (!/\.md$/i.test(resolved)) return null // only vault-internal .md

  return resolved
}

export function storedLinksFor(
  content: string,
  srcRel: string,
  mode: LinkResolution,
): StoredLink[] {
  const links = extractLinks(content)
  const out: StoredLink[] = []

  if (mode === 'wikilink') {
    const push = (raw: string, kind: 'wikilink' | 'embed') => {
      const target = normalizeWikiTarget(raw)
      if (!target) return
      const base = (target.split('/').pop() ?? target).toLowerCase()
      out.push({ target, base, kind })
    }
    for (const w of links.wikilinks) push(w, 'wikilink')
    for (const e of links.embeds) push(e, 'embed')

    return out
  }

  const srcDir = posix.dirname(srcRel.trim().replace(/\\/g, '/').normalize('NFC'))
  for (const raw of links.mdLinks) {
    const target = resolveRelativeTarget(raw, srcDir)
    if (!target) continue
    out.push({ target, base: null, kind: 'mdlink' })
  }

  return out
}
```

- [ ] **Step: Run to verify pass** — `Run: bun test src/__tests__/links.test.ts`
  Expected: PASS (12 tests).

---

- [ ] **Step: Commit**

```bash
git add src/links.ts src/__tests__/links.test.ts && git commit -m "feat(links): extraction + asymmetric wikilink/relative resolution"
```

---

### Task 8: Public barrel + package surface

**Files:**
- Modify: `src/index.ts`
- Create: `LICENSE`, `README.md`
- Test: `src/__tests__/index.test.ts`

**Interfaces:**
- Consumes: all public exports from Tasks 2–7 (`MdVaultError`, `createVaultIo`, `withFileTransform`, `withFileDelete`, `parseFrontmatter`, `editFrontmatter`, `deriveTags`, `isFlatFrontmatter`, `extractLinks`, `storedLinksFor`, plus their types).
- Produces: the package public surface importable as `import { ... } from 'mdvault'`.

- [ ] **Step: Write the barrel re-export test** — `src/__tests__/index.test.ts`

```ts
import { expect, test } from 'bun:test';

import * as mdvault from '../index.ts';

test('barrel exposes the Plan 1 public surface', () => {
  expect(typeof mdvault.MdVaultError).toBe('function');
  expect(typeof mdvault.createVaultIo).toBe('function');
  expect(typeof mdvault.withFileTransform).toBe('function');
  expect(typeof mdvault.withFileDelete).toBe('function');
  expect(typeof mdvault.parseFrontmatter).toBe('function');
  expect(typeof mdvault.editFrontmatter).toBe('function');
  expect(typeof mdvault.deriveTags).toBe('function');
  expect(typeof mdvault.isFlatFrontmatter).toBe('function');
  expect(typeof mdvault.extractLinks).toBe('function');
  expect(typeof mdvault.storedLinksFor).toBe('function');
});
```

- [ ] **Step: Run to verify it fails**

Run: `bun test src/__tests__/index.test.ts`
Expected: FAIL — `src/index.ts` is still the placeholder `export {}`, so the named exports are `undefined`.

- [ ] **Step: Write the barrel** — replace `src/index.ts`:

```ts
export type { MdVaultCode } from './errors.ts';
export { MdVaultError } from './errors.ts';
export type { Sig } from './fs-atomic.ts';
export type { Access, VaultIo, VaultIoConfig, VaultPrefixes } from './vault-io.ts';
export { createVaultIo } from './vault-io.ts';
export type { CommitEvent, CrossLock, TransformOpts, TransformResult } from './locked-file.ts';
export { withFileDelete, withFileTransform } from './locked-file.ts';
export type { EditOutcome, FrontmatterValidity, ParsedFrontmatter } from './frontmatter.ts';
export { deriveTags, editFrontmatter, isFlatFrontmatter, parseFrontmatter } from './frontmatter.ts';
export type { ExtractedLinks, LinkResolution, StoredLink } from './links.ts';
export { extractLinks, storedLinksFor } from './links.ts';
```

- [ ] **Step: Run to verify pass**

Run: `bun test src/__tests__/index.test.ts`
Expected: PASS.

- [ ] **Step: Create `LICENSE` (MIT)**

```
MIT License

Copyright (c) 2026 Ivan Kalinichenko

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step: Create `README.md`**

```markdown
# mdvault

Headless markdown-vault data layer for Bun — CRUD over `.md` notes plus a
derived SQLite index (collection queries, backlinks, keyword search). No
Obsidian, no plugin, no Electron. The `.md` files on disk are the source of
truth; the index is a rebuildable cache.

**Status:** Plan 1 (foundation primitives) — `errors`, `fs-atomic`,
`vault-io`, `locked-file`, `frontmatter`, `links`. The SQLite index, queries,
note CRUD, and the `createVault` composition root land in Plan 2.

Design: `docs/superpowers/specs/2026-06-27-mdvault-foundation-design.md`.

## Install

```bash
bun add mdvault
```

## License

MIT — generic vault mechanics only; domain/persona/sync logic lives in the
consuming applications.
```

- [ ] **Step: Final verification**

Run: `bun run format && bun test && bun run check`
Expected: all module test suites PASS (errors, fs-atomic, vault-io, locked-file, frontmatter, links, index, scaffold); `biome check` and `tsc --noEmit` exit 0.

- [ ] **Step: Commit**

```bash
git add src/index.ts src/__tests__/index.test.ts LICENSE README.md && git commit --no-gpg-sign -m "feat: public barrel, MIT license, and README"
```

---

## Plan 1 complete — what's next

When all eight tasks are green, `mdvault` has a fully-tested, no-database
foundation. **Plan 2 (index & API)** is authored next — it layers
`bun:sqlite` on top: the index schema (`notes` / `note_tags` / `note_links` /
standalone FTS5 keyed by `rowid`), `indexNote`/`dropNote`/`reconcile`/
`reconcilePaths`/`rebuild`, the `query` surface (collection/tag/folder/
backlinks/outbound/keyword with read-scope filtering, `orderBy` allowlist,
pagination), the `notes` CRUD layer (write-through, exclusive create, edit-by-
match, CAS delete), and the async `createVault` composition root (WAL +
`busy_timeout`, FTS5+JSON1 + config-fingerprint probes, lazy/boot reconcile).
Plan 2's tasks consume the **real** signatures these eight tasks produced.
