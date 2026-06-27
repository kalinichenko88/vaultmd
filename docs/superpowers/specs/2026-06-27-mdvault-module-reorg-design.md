# mdvault — module-folder reorganization design

**Date:** 2026-06-27
**Status:** draft — revised after review round 1 + test-layout decision (pending user review)
**Package:** `mdvault` (npm, MIT)
**Scope:** internal source + test layout only — a behavior-preserving refactor of
the Plan 1 foundation primitives. No package public API change, no logic change,
no new features. Tests are restructured into per-module `__tests__/` folders as
co-located unit tests, with a handful of additive unit tests and one packaging
fix (keep tests out of the npm tarball).

## Goal

Reorganize `src/` from seven flat files into **one folder per responsibility**,
so that before open-sourcing every module owns exactly **one area**, the files
inside it are small and single-purpose, and **each unit has a co-located unit
test inside its module**. The **package** public surface (`src/index.ts`, the
only `exports` entry in `package.json`) keeps its exact set of exported names;
only import paths move.

This is the "module-folder split past ~3 exports / one read" convention from the
foundation design, applied across the codebase, plus removal of two structural
debts hiding in the two largest files.

## Motivation — the debt we are removing

1. **`fs-atomic.ts` (268 lines) owns two areas.** It mixes race-aware
   single-file filesystem primitives (`atomicWrite`, CAS, `exclusiveCreate`,
   guarded delete, `readConsistent`) with **concurrency control** (`withFileLock`
   in-process mutex, `withCrossProcessLock` lockfile). Locking is a distinct
   concern and becomes its own module.
2. **`vault-io.ts` (359 lines) is a 5-concern closure.** Path canonicalization,
   allowlist matching, realpath/symlink containment, atomic-IO delegation, and
   recursive enumeration all live in one factory, alongside two standalone
   utilities (volume case-sensitivity detection and glob→RegExp compilation).
   The security-critical pure logic is invisible inside the closure — neither
   readable nor independently testable. After extraction it is both, and this
   refactor adds the direct unit tests (see Tests).
3. **Test placement.** Tests live in a central `src/__tests__/` and exercise
   several helpers only through the public/factory surface (not as isolated
   units). They move next to their module and gain direct units where the unit
   is pure/isolable.
4. **Minor:** `readConsistent` re-inlines the signature comparison
   (`sig2.mtimeMs === sig1.mtimeMs && sig2.size === sig1.size`) instead of
   reusing `sigsEqual`. Folded into the move.

## API surface — three layers

The reorg separates three surfaces. Conflating them is what review round 1
flagged; pinning them is part of the design.

1. **Package public API — `src/index.ts`.** The *only* thing listed in
   `package.json` `exports` (`"."`). Its set of exported names is **frozen** by
   this refactor and **guarded** by a strengthened `index.test.ts` (exact key
   set + type-only compile fixture — see Tests). Paths inside change; names do
   not.
2. **Module barrels — `<module>/index.ts`.** A **stable internal integration
   surface**: the seam in-package consumers (today `vault-io`, `locked-file`;
   tomorrow Plan 2's `notes` / `index` / `query` / `createVault`) import a module
   through. Intentionally **broader** than the package API — e.g. the `fs-atomic`
   barrel exports `statSig` / `atomicWrite` / `readConsistent`, none of which are
   package-public (only `Sig` is). Barrels are **not** published, **not** in
   `exports`, curated by hand (named re-exports only, never `export *`). Plan 2
   will depend on a barrel's shape — treat it as a real internal contract.
3. **Leaf files — `<module>/<part>.ts`.** Module-private implementation. A leaf
   `export` exists so **same-module siblings** and **white-box tests** can import
   it; it is **not** re-exported from the barrel and **no other module's
   production code** imports it. "Not on the barrel" is the privacy boundary —
   not "unexported."

## Principles

- **One area per module.** Each top-level folder under `src/` owns a single
  area. A file that mixed two areas splits into two modules (so `locks/` leaves
  `fs-atomic/`).
- **The barrel is the module's only cross-module door.** Cross-module production
  imports target the barrel (`../fs-atomic/index.ts`); files **within** a folder
  import siblings directly (`./sig.ts`).
- **Each unit has a co-located unit test** in its module's `__tests__/` folder
  (assembly-only helpers are covered through the factory/seam that assembles
  them — see Tests).
- **Package API frozen.** The names re-exported by `src/index.ts` are unchanged;
  only `from` paths change.
- **Behavior-preserving.** No control-flow or algorithm change. The only
  non-move edits are pure-function extractions already covered by existing tests
  (e.g. `canonicalizeRelative`) and the `sigsEqual` reuse. New tests are
  additive.
- **Acyclic dependencies.** The module graph stays a DAG.

## Target structure

Each module folder holds its sources plus a `__tests__/` with one unit test per
testable file. Root-level modules (`errors.ts` and the package barrel
`index.ts`) keep their tests in `src/__tests__/`.

```
src/
├── index.ts                  # package public API — only `from` paths change
├── errors.ts                 # unchanged (2 exports → stays a flat non-barrel file)
├── __tests__/
│   ├── index.test.ts         # STRENGTHENED: exact key set + type-only compile fixture
│   ├── errors.test.ts        # relocated, unchanged content
│   └── scaffold.test.ts      # smoke test (kept)
│
├── fs-atomic/                # AREA: race-aware single-file fs operations
│   ├── index.ts              # barrel
│   ├── sig.ts                # Sig, makeSig, sigsEqual, statSig
│   ├── atomic-write.ts       # tempPath, atomicWrite, atomicWriteIfUnchanged, exclusiveCreate, unlinkIfUnchanged
│   ├── read-consistent.ts    # readConsistent (now via sigsEqual)
│   └── __tests__/
│       ├── sig.test.ts
│       ├── atomic-write.test.ts
│       └── read-consistent.test.ts        # NEW unit (was indirect-only)
│
├── locks/                    # AREA: concurrency control  (extracted from fs-atomic)
│   ├── index.ts              # barrel
│   ├── in-process.ts         # withFileLock (+ fileLocks map)
│   ├── cross-process.ts      # withCrossProcessLock (+ delay, tryReclaim)
│   └── __tests__/
│       ├── in-process.test.ts
│       └── cross-process.test.ts
│
├── vault-io/                 # AREA: path → safe IO security chokepoint
│   ├── index.ts              # barrel
│   ├── create-vault-io.ts    # factory + types + thin delegating methods (assembles helpers)
│   ├── paths.ts              # canonicalizeRelative, canonPrefix
│   ├── allowlist.ts          # matches
│   ├── realpath-guard.ts     # realTargetWithinRoot
│   ├── enumerate.ts          # walk, listMarkdown  (deps-injected)
│   ├── case-sensitivity.ts   # resolveCaseSensitive, detectCaseSensitive (+ cache)
│   ├── glob.ts               # globToRegExp
│   └── __tests__/
│       ├── create-vault-io.test.ts        # assembled VaultIo: IO/symlink/enumerate/toKey-folding
│       ├── paths.test.ts                  # NEW unit (security)
│       ├── allowlist.test.ts              # NEW unit (security)
│       ├── realpath-guard.test.ts         # NEW unit (security)
│       └── glob.test.ts                   # NEW unit
│                                          # enumerate + case-sensitivity covered via create-vault-io
│
├── locked-file/              # AREA: locked transform/delete seam
│   ├── index.ts              # barrel
│   ├── types.ts              # CommitEvent, CrossLock, TransformOpts, TransformResult
│   ├── commit.ts             # emitCommit (covered via transform/delete onCommit)
│   ├── transform.ts          # withFileTransform
│   ├── delete.ts             # withFileDelete
│   └── __tests__/
│       ├── transform.test.ts
│       └── delete.test.ts                 # statSig spy = symmetric barrel seam
│
├── frontmatter/              # AREA: frontmatter parse / edit
│   ├── index.ts              # barrel
│   ├── types.ts              # FrontmatterValidity, ParsedFrontmatter, EditOutcome
│   ├── validate.ts           # isScalar, isScalarOrArrayOfScalar, isFlatFrontmatter
│   ├── tags.ts               # toTagTokens, deriveTags
│   ├── parse.ts              # extractBlock, parseFrontmatter
│   ├── edit.ts               # editFrontmatter
│   └── __tests__/
│       ├── validate.test.ts
│       ├── tags.test.ts
│       ├── parse.test.ts
│       └── edit.test.ts
│
└── links/                    # AREA: link extraction / resolution
    ├── index.ts              # barrel
    ├── types.ts              # ExtractedLinks, LinkResolution, StoredLink
    ├── extract.ts            # stripFencedCode, mdLinkUrl, extractLinks
    ├── resolve.ts            # normalizeWikiTarget, resolveRelativeTarget, storedLinksFor
    └── __tests__/
        ├── extract.test.ts
        └── resolve.test.ts
```

## Move map (symbol → destination)

Every existing symbol lands in exactly one new file. "Barrel" = named-re-exported
from the folder's `index.ts` (integration surface); "internal" = leaf-only
(reachable by same-module siblings and white-box tests, never another module's
production code).

### `fs-atomic/`  (from `fs-atomic.ts`)

| Symbol | File | On barrel? |
|---|---|---|
| `Sig` (type) | `sig.ts` | yes |
| `makeSig`, `sigsEqual` | `sig.ts` | internal |
| `statSig` | `sig.ts` | yes |
| `tempPath` | `atomic-write.ts` | internal |
| `atomicWrite`, `atomicWriteIfUnchanged`, `exclusiveCreate`, `unlinkIfUnchanged` | `atomic-write.ts` | yes |
| `readConsistent` (+ `ConsistentRead` type) | `read-consistent.ts` | yes (`readConsistent`) |

`atomic-write.ts` and `read-consistent.ts` import `makeSig`/`sigsEqual`/`statSig`/`Sig` from `./sig.ts` and `MdVaultError` from `../errors.ts`. `read-consistent.ts` replaces its inline signature compare with `sigsEqual`.

### `locks/`  (from `fs-atomic.ts`)

| Symbol | File | On barrel? |
|---|---|---|
| `fileLocks` (map), `withFileLock` | `in-process.ts` | yes (`withFileLock`) |
| `delay`, `tryReclaim` | `cross-process.ts` | internal |
| `withCrossProcessLock` | `cross-process.ts` | yes |

`cross-process.ts` imports `MdVaultError` (`../errors.ts`), `createHash` (`node:crypto`), `mkdir`/`readFile`/`unlink`/`writeFile` (`node:fs/promises`), `hostname` (`node:os`), `node:path`.

### `vault-io/`  (from `vault-io.ts`)

| Symbol | File | On barrel? |
|---|---|---|
| `canonicalizeRelative` (extracted from `toVaultRelative`'s body), `canonPrefix` | `paths.ts` | internal |
| `matches` | `allowlist.ts` | internal |
| `realTargetWithinRoot` | `realpath-guard.ts` | internal |
| `caseSensitiveCache`, `resolveCaseSensitive`, `detectCaseSensitive` | `case-sensitivity.ts` | internal |
| `globToRegExp` | `glob.ts` | internal |
| `walk`, `listMarkdown` | `enumerate.ts` | internal |
| `Access`, `VaultPrefixes`, `VaultIoConfig`, `VaultIo` (types) | `create-vault-io.ts` | yes |
| `createVaultIo` (factory + closure methods) | `create-vault-io.ts` | yes |

**De-closured helper signatures (pinned).** Three helpers currently close over
factory state and take it explicitly once extracted:

- `realTargetWithinRoot(full: string, root: string): boolean` — gains `root`.
  Callers pass it: `resolveVaultPath` (factory has `root`); `walk` / `listMarkdown`
  (receive `root`).
- `matches(x: string, prefixes: string[]): boolean` — already pure; standalone
  export in `allowlist.ts`.
- `canonicalizeRelative(rel: string): string` — the body of today's
  `toVaultRelative` (already uses only its argument); throws
  `ALLOWLIST_VIOLATION` (imports `MdVaultError`).

The factory's `toVaultRelative` method delegates to `canonicalizeRelative`;
`toKey`, `can`, `resolveVaultPath`, the five IO methods, and `isIgnored` stay as
closure methods in `create-vault-io.ts` (they close over `root` /
`caseSensitive` / `canonPrefixes` / `ignoreRes`) and call the extracted pure
helpers. `enumerate.ts` exposes `listMarkdown(root, dir, deps)` (it computes
`startRel` from `dir` via `deps.toVaultRelative`) where
`deps = { isIgnored, resolveVaultPath, toVaultRelative }`; `walk` is its private
helper, receives `root`, and imports `realTargetWithinRoot` from
`./realpath-guard.ts`. The factory builds `ignoreRes` via `globToRegExp`, closes
it into `isIgnored`, and passes the deps object in.

### `locked-file/`  (from `locked-file.ts`)

| Symbol | File | On barrel? |
|---|---|---|
| `CommitEvent`, `CrossLock`, `TransformOpts`, `TransformResult` | `types.ts` | yes |
| `emitCommit` | `commit.ts` | internal |
| `withFileTransform` | `transform.ts` | yes |
| `withFileDelete` | `delete.ts` | yes |

`transform.ts` imports `atomicWrite`/`atomicWriteIfUnchanged`/`readConsistent` from `../fs-atomic/index.ts` and `withFileLock`/`withCrossProcessLock` from `../locks/index.ts`. `delete.ts` imports `statSig`/`unlinkIfUnchanged` from `../fs-atomic/index.ts` and the two locks. Both import `emitCommit` (`./commit.ts`) and types (`./types.ts`). `Bun.sleep` in `transform.ts` is kept.

### `frontmatter/`  (from `frontmatter.ts`)

| Symbol | File | On barrel? |
|---|---|---|
| `FrontmatterValidity`, `ParsedFrontmatter`, `EditOutcome` | `types.ts` | yes |
| `isScalar`, `isScalarOrArrayOfScalar` | `validate.ts` | internal |
| `isFlatFrontmatter` | `validate.ts` | yes |
| `toTagTokens` | `tags.ts` | internal |
| `deriveTags` | `tags.ts` | yes |
| `extractBlock` (+ `Block` type) | `parse.ts` | internal |
| `parseFrontmatter` | `parse.ts` | yes |
| `editFrontmatter` | `edit.ts` | yes |

`parse.ts` imports `parse` (`yaml`), `isFlatFrontmatter` (`./validate.ts`), `deriveTags` (`./tags.ts`). `edit.ts` imports `Document`/`parseDocument` (`yaml`), `parseFrontmatter`+`extractBlock` (`./parse.ts`), `isFlatFrontmatter` (`./validate.ts`).

### `links/`  (from `links.ts`)

| Symbol | File | On barrel? |
|---|---|---|
| `ExtractedLinks`, `LinkResolution`, `StoredLink` | `types.ts` | yes |
| `stripFencedCode`, `mdLinkUrl` | `extract.ts` | internal |
| `extractLinks` | `extract.ts` | yes |
| `normalizeWikiTarget`, `resolveRelativeTarget` | `resolve.ts` | internal |
| `storedLinksFor` | `resolve.ts` | yes |

`resolve.ts` imports `extractLinks` (`./extract.ts`), `posix` (`node:path`), and the types.

## Package public API freeze (Layer 1)

`src/index.ts` re-exports exactly these names after the move (only `from` paths
change to folder barrels):

- from `./errors.ts`: `MdVaultCode` (type), `MdVaultError`
- from `./fs-atomic/index.ts`: `Sig` (type)
- from `./vault-io/index.ts`: `Access`, `VaultIo`, `VaultIoConfig`, `VaultPrefixes` (types), `createVaultIo`
- from `./locked-file/index.ts`: `CommitEvent`, `CrossLock`, `TransformOpts`, `TransformResult` (types), `withFileDelete`, `withFileTransform`
- from `./frontmatter/index.ts`: `EditOutcome`, `FrontmatterValidity`, `ParsedFrontmatter` (types), `deriveTags`, `editFrontmatter`, `isFlatFrontmatter`, `parseFrontmatter`
- from `./links/index.ts`: `ExtractedLinks`, `LinkResolution`, `StoredLink` (types), `extractLinks`, `storedLinksFor`

**10 runtime value exports** and **16 type-only exports** (26 names). Verified:
`Object.keys` of the current barrel returns exactly the 10 values
(`MdVaultError`, `createVaultIo`, `deriveTags`, `editFrontmatter`, `extractLinks`,
`isFlatFrontmatter`, `parseFrontmatter`, `storedLinksFor`, `withFileDelete`,
`withFileTransform`).

## Dependency graph (acyclic)

```
errors      ← fs-atomic, locks, vault-io, locked-file
fs-atomic   ← vault-io, locked-file
locks       ← locked-file
frontmatter ← (yaml only)
links       ← (node:path only)
index       ← all module barrels
```

No module imports `vault-io`. Within `vault-io/`, `create-vault-io.ts` depends on
the helper files and `enumerate.ts` depends on `realpath-guard.ts` — a local DAG.

## Conventions (applied to every new file)

- **ESM, explicit `.ts`** on every relative import (`./sig.ts`,
  `../fs-atomic/index.ts`; from a `__tests__/` file: `../sig.ts`, `../../errors.ts`).
- **`verbatimModuleSyntax`:** type-only imports use `import type`; mixed
  value+type imports use the inline `type` modifier (`import { type Sig, statSig }`).
- **Named barrel re-exports only.** No `export *`. Types via `export type { … }`.
- **Import discipline.** Production imports **other** modules only through their
  barrel; **within** a module, sibling leaf imports are normal. A unit test in
  `<module>/__tests__/` imports the unit under test directly — the leaf
  (`../paths.ts`, white-box) or the module barrel (`../index.ts`) when testing
  the assembled surface — and cross-module helpers via their barrel
  (`../../fs-atomic/index.ts`) or `../../errors.ts`.
- **`type`, never `interface`.** Biome single-quote / 2-space. Blank line before
  `return` unless first/only statement.
- **Intra-file order:** imports → primary public export(s) → private helpers
  below.

## Methodology — behavior-preserving, test-guarded

Existing tests are the safety net; they stay green at every step.

1. Refactor **one module at a time** in dependency order: `fs-atomic` + `locks`
   (they share the source file) → `vault-io` → `locked-file` → `frontmatter` →
   `links` → strengthen `src/index.ts` + `src/__tests__/index.test.ts` → packaging.
2. For each: create the folder + files (cut/paste symbols, fix imports, curated
   barrel), move/split that module's tests into `<module>/__tests__/`, update
   importers, then run `bun test <module>` and `bun run check`
   (Biome + `tsc --noEmit`).
3. Only after a module is green move to the next.
4. Final gate: full `bun test` + `bun run check` green; strengthened
   `index.test.ts` proves the package API name-set; `git diff src/index.ts`
   path-only; `npm pack --dry-run` (or `bun pm pack`) shows **no** `*.test.ts`
   in the tarball.

No algorithm changes. The single extraction (`canonicalizeRelative`) and the
`sigsEqual` reuse are covered by existing tests.

## Tests

One unit test per testable file, in the module's `__tests__/`. Existing
assertions are preserved 1:1 — split out of today's central files and relocated.
Additive units are marked NEW.

**Root — `src/__tests__/`**
- **`index.test.ts` (strengthened — closes the API-freeze gap).** Replace the
  `typeof === 'function'` spot-check with:
  - **Runtime exact set:** `expect(Object.keys(mdvault).sort()).toEqual([...])`
    over the 10 value exports — catches a **missing** *and* an **extra** runtime
    export.
  - **Compile-time:** module-level aliases for all 16 type exports
    (`type _Sig = mdvault.Sig;` …, erased at runtime, so `import * as mdvault`
    stays a real value import). Dropping/renaming a type fails `tsc --noEmit`.
    This is the only guard for type-only exports.
- **`errors.test.ts`** — relocated, content unchanged. **`scaffold.test.ts`** — kept.

**`fs-atomic/__tests__/`**
- `sig.test.ts` — `statSig` (null on missing; sig shape). Split from today's
  `statSig + atomicWrite` describe.
- `atomic-write.test.ts` — `atomicWrite` / `atomicWriteIfUnchanged` /
  `exclusiveCreate` / `unlinkIfUnchanged` (relocated).
- `read-consistent.test.ts` (**NEW**) — `readConsistent`: missing → null;
  stat→read→stat returns content+sig; converges when the file changes mid-read.

**`locks/__tests__/`**
- `in-process.test.ts` — `withFileLock` (serialize same key; different keys
  concurrent; release on throw). Moved from `fs-atomic.test.ts`.
- `cross-process.test.ts` — `withCrossProcessLock` (create/release; reclaim dead
  same-host pid; wait → `MTIME_CONFLICT` on live pid). Moved from `fs-atomic.test.ts`.

**`vault-io/__tests__/`**
- `create-vault-io.test.ts` — the assembled `VaultIo` (relocated bulk of today's
  `vault-io.test.ts`): `resolveVaultPath` end-to-end incl. symlink-escape, IO
  round-trips + per-access scope routing, `listMarkdown` enumeration + ignore +
  no escaping-symlink descent, `toKey` case-folding. **This is where `enumerate`
  and `case-sensitivity` are covered** (no isolated stub tests for them).
- `paths.test.ts` (**NEW**, security) — `canonicalizeRelative` (rejects
  absolute / `..`-escape; NFC; collapses `.`/dup-slash; case-preserving) +
  `canonPrefix` (canon; rejects `..`).
- `allowlist.test.ts` (**NEW**, security) — `matches`: `foo` ∌ `foobar.md`;
  `foo` ∋ `foo` and `foo/x`; `''` ∋ everything.
- `realpath-guard.test.ts` (**NEW**, security) — `realTargetWithinRoot(full, root)`:
  in-root → true; symlink-escape → false; nonexistent target inside root → true.
- `glob.test.ts` (**NEW**) — `globToRegExp`: `**/`, trailing `**`, `*`, `?`,
  literal escaping.

**`locked-file/__tests__/`**
- `transform.test.ts` — `withFileTransform` (all describes incl. concurrency +
  `MTIME_CONFLICT` retry + `onCommit` create/update + `COMMIT_FAILED`). Covers
  `emitCommit`.
- `delete.test.ts` — `withFileDelete` incl. the `MTIME_CONFLICT` **statSig spy**
  via the **symmetric-barrel seam**: production (`delete.ts`) imports `statSig`
  through `../fs-atomic/index.ts`, and the test spies that same barrel
  (`import * as fsAtomic from '../../fs-atomic/index.ts'; spyOn(fsAtomic, 'statSig')`).
  This is today's proven "production and test reference the same module
  namespace" pattern, module now = barrel. **Verified empirically** (Bun 1.3.13):
  a `spyOn` on a re-export barrel namespace intercepts a consumer importing
  through it. The test run remains the gate.

**`frontmatter/__tests__/`** — `validate.test.ts`, `tags.test.ts`,
`parse.test.ts`, `edit.test.ts` (today's `frontmatter.test.ts` split per file).

**`links/__tests__/`** — `extract.test.ts`, `resolve.test.ts` (today's
`links.test.ts` split per file).

## Packaging hygiene

Co-locating tests under `src/` plus `files: ["src", …]` would ship `*.test.ts`
in the npm tarball. Because a `files` allowlist is present, it takes precedence
over `.npmignore` (a `.npmignore` cannot subtract from what `files` includes),
so the exclusion must be a **negation inside `files`**:
`["src", "README.md", "LICENSE", "!src/**/*.test.ts", "!src/**/__tests__/**"]`
(`npm-packlist` honors `!` negations). Verify with `npm pack --dry-run` (or
`bun pm pack`) — the file list must contain the runtime `*.ts` and **no** test
files. (The package already publishes source `.ts`, since `exports` points at
`./src/index.ts`; only test files are newly excluded.)

## Open questions — resolved

- **Folder barrels: stable internal API or refactor convenience?** → **Stable
  internal integration APIs** (Layer 2). Plan 2 imports through them; curated by
  hand, not `export *`. Still internal (not in `exports`).
- **May tests import private leaf modules?** → **Yes** — a unit test in
  `<module>/__tests__/` imports its leaf directly (`../paths.ts`) for white-box
  testing. Production stays barrel-only across modules. The `statSig` spy uses
  the symmetric-barrel seam, not a leaf import.

## Out of scope

- Any package public API change (names, signatures, types).
- Any logic / behavior change beyond the two noted micro-edits.
- Rewriting existing test assertions (only relocation/splitting into per-module
  `__tests__/`, the `index.test.ts` strengthening, and the additive NEW units).
- Plan 2 modules (`index`/SQLite, `query`, `notes`, `createVault`). Note: the
  SQLite "index" module should pick a folder name avoiding collision with barrel
  `index.ts` files (e.g. `note-index/` or `db/`) — decided then.
- Heavy doc-comment rewriting. A one-line module purpose comment may be added to
  a barrel where it has none; existing inline comments preserved verbatim.

## Done criteria

- `src/` matches the target tree; `errors.ts` is the only flat non-barrel source
  module; `src/index.ts` is the package-API barrel; every module folder has a
  `__tests__/` with a unit per testable file.
- `bun test` and `bun run check` are green.
- `index.test.ts` asserts the exact value-export key set **and** type-checks all
  16 type exports; `git diff src/index.ts` is path-only.
- `npm pack --dry-run` lists no `*.test.ts`.
- No `export *`; no import cycle; every file is single-purpose and reads in one
  pass.
