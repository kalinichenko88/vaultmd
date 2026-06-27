# mdvault — module-folder reorganization design

**Date:** 2026-06-27
**Status:** draft — revised after review round 1 (pending user review)
**Package:** `mdvault` (npm, MIT)
**Scope:** internal source layout only — a behavior-preserving refactor of the
Plan 1 foundation primitives. No package public API change, no logic change, no
new features (the one added piece is **tests**, not behavior — see Tests).

## Goal

Reorganize `src/` from seven flat files into **one folder per responsibility**,
so that before open-sourcing every module owns exactly **one area** and the
files inside it are small, single-purpose, and readable in one pass. The
**package** public surface (`src/index.ts`, the only `exports` entry in
`package.json`) keeps its exact set of exported names; only import paths move.

This is the "module-folder split past ~3 exports / one read" convention from the
foundation design, applied across the codebase, plus the removal of two genuine
structural debts hiding in the two largest files.

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
   readable nor independently testable. After extraction it is both (and this
   refactor adds the direct unit tests — see Tests).
3. **Minor:** `readConsistent` re-inlines the signature comparison
   (`sig2.mtimeMs === sig1.mtimeMs && sig2.size === sig1.size`) instead of
   reusing `sigsEqual`. Folded into the move.

## API surface — three layers (this refactor introduces a clear boundary)

The reorg deliberately separates three surfaces. Conflating them is what the
review flagged; pinning them is part of the design.

1. **Package public API — `src/index.ts`.** The *only* thing listed in
   `package.json` `exports` (`"."`). This is what external consumers (and the
   two downstream projects) import. Its set of exported names is **frozen** by
   this refactor and **guarded** by a strengthened `index.test.ts` (exact key
   set + type-only compile fixture — see Tests). Paths inside change; names do
   not.
2. **Module barrels — `<module>/index.ts`.** A **stable internal integration
   surface**: the seam that in-package consumers (today `vault-io`,
   `locked-file`; tomorrow Plan 2's `notes` / `index` / `query` / `createVault`)
   import a module through. Intentionally **broader** than the package API — e.g.
   the `fs-atomic` barrel exports `statSig` / `atomicWrite` / `readConsistent`
   etc., none of which are package-public (only `Sig` is). Barrels are **not**
   published, **not** in `package.json` `exports`, and are curated by hand
   (named re-exports only, never `export *`). Treat a barrel's shape as a real
   internal contract — Plan 2 will depend on it.
3. **Leaf files — `<module>/<part>.ts`.** Module-private implementation. A leaf
   `export` exists so **same-module siblings** can import it (and white-box
   **tests** may — see Conventions); it is **not** re-exported from the module
   barrel and **no other module's production code** imports it. "Not on the
   barrel" is the privacy boundary — not "unexported" (an exported leaf symbol
   is reachable by path; the discipline is that only same-module code and tests
   take that path).

## Principles

- **One area per module.** Each top-level folder under `src/` owns a single
  area. A file that mixed two areas splits into two modules (this is why
  `locks/` leaves `fs-atomic/`).
- **The barrel is the module's only cross-module door.** Cross-module production
  imports target the barrel (`../fs-atomic/index.ts`); files **within** a folder
  import siblings directly (`./sig.ts`). Barrels named-re-export only the
  module's intended integration surface (never `export *`).
- **Package API frozen.** The set of names re-exported by `src/index.ts` is
  unchanged; only the `from` paths change. (See the three-layer model above for
  why barrels may expose more.)
- **Behavior-preserving.** No control-flow or algorithm changes. The only
  non-move edits are pure-function extractions already covered by existing tests
  (e.g. `canonicalizeRelative`) and the `sigsEqual` reuse above. New **tests**
  are additive.
- **Acyclic dependencies.** The module graph stays a DAG (see below).

## Target structure

```
src/
├── index.ts                  # package public API — only `from` paths change
├── errors.ts                 # unchanged (2 exports → stays a flat non-barrel file)
│
├── fs-atomic/                # AREA: race-aware single-file fs operations
│   ├── index.ts              # barrel
│   ├── sig.ts                # Sig, makeSig, sigsEqual, statSig
│   ├── atomic-write.ts       # tempPath, atomicWrite, atomicWriteIfUnchanged, exclusiveCreate, unlinkIfUnchanged
│   └── read-consistent.ts    # readConsistent (now via sigsEqual)
│
├── locks/                    # AREA: concurrency control  (extracted from fs-atomic)
│   ├── index.ts              # barrel
│   ├── in-process.ts         # withFileLock (+ fileLocks map)
│   └── cross-process.ts      # withCrossProcessLock (+ delay, tryReclaim)
│
├── vault-io/                 # AREA: path → safe IO security chokepoint
│   ├── index.ts              # barrel
│   ├── create-vault-io.ts    # createVaultIo factory + types + thin delegating methods
│   ├── paths.ts              # canonicalizeRelative, canonPrefix  (canonicalization)
│   ├── allowlist.ts          # matches  (boundary-aware membership)
│   ├── realpath-guard.ts     # realTargetWithinRoot  (symlink containment)
│   ├── enumerate.ts          # walk, listMarkdown  (deps-injected)
│   ├── case-sensitivity.ts   # resolveCaseSensitive, detectCaseSensitive (+ cache)
│   └── glob.ts               # globToRegExp  (private ignore-matching helper)
│
├── locked-file/              # AREA: locked transform/delete seam
│   ├── index.ts              # barrel
│   ├── types.ts              # CommitEvent, CrossLock, TransformOpts, TransformResult
│   ├── commit.ts             # emitCommit (onCommit seam)
│   ├── transform.ts          # withFileTransform
│   └── delete.ts             # withFileDelete
│
├── frontmatter/              # AREA: frontmatter parse / edit
│   ├── index.ts              # barrel
│   ├── types.ts              # FrontmatterValidity, ParsedFrontmatter, EditOutcome
│   ├── validate.ts           # isScalar, isScalarOrArrayOfScalar, isFlatFrontmatter
│   ├── tags.ts               # toTagTokens, deriveTags
│   ├── parse.ts              # extractBlock, parseFrontmatter
│   └── edit.ts               # editFrontmatter
│
├── links/                    # AREA: link extraction / resolution
│   ├── index.ts              # barrel
│   ├── types.ts              # ExtractedLinks, LinkResolution, StoredLink
│   ├── extract.ts            # stripFencedCode, mdLinkUrl, extractLinks
│   └── resolve.ts            # normalizeWikiTarget, resolveRelativeTarget, storedLinksFor
│
└── __tests__/                # central location kept; 1 test file per module
    ├── errors.test.ts        # imports unchanged
    ├── fs-atomic.test.ts     # keeps the 2 atomic describes; lock describes removed
    ├── locks.test.ts         # NEW: the withFileLock + withCrossProcessLock describes
    ├── vault-io.test.ts      # path → barrel; + direct describes for the pure security helpers
    ├── locked-file.test.ts   # import paths updated; statSig spy = symmetric barrel seam (see Tests)
    ├── frontmatter.test.ts   # import path → ../frontmatter/index.ts
    ├── links.test.ts         # import path → ../links/index.ts
    ├── index.test.ts         # STRENGTHENED: exact key set + type-only compile fixture
    └── scaffold.test.ts      # unchanged
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
factory state and must take it explicitly once extracted:

- `realTargetWithinRoot(full: string, root: string): boolean` — gains `root`.
  Callers pass it: `resolveVaultPath` (factory has `root`); `walk` / `listMarkdown`
  (receive `root`, see below).
- `matches(x: string, prefixes: string[]): boolean` — already pure; now a
  standalone export in `allowlist.ts`.
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

`transform.ts` imports `atomicWrite`/`atomicWriteIfUnchanged`/`readConsistent` from `../fs-atomic/index.ts` and `withFileLock`/`withCrossProcessLock` from `../locks/index.ts`. `delete.ts` imports `statSig`/`unlinkIfUnchanged` from `../fs-atomic/index.ts` and the two locks. Both import `emitCommit` (`./commit.ts`) and types (`./types.ts`). `Bun.sleep` in `transform.ts` is kept as-is.

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

That is **10 runtime value exports** and **16 type-only exports** (26 names).
The freeze is guarded by a strengthened `index.test.ts` (see Tests) — not the
current spot-check.

## Dependency graph (acyclic)

```
errors      ← fs-atomic, locks, vault-io, locked-file
fs-atomic   ← vault-io, locked-file
locks       ← locked-file
frontmatter ← (yaml only)
links       ← (node:path only)
index       ← all module barrels
```

No module imports `vault-io`. Within `vault-io/`, `create-vault-io.ts` depends
on the five helper files and `enumerate.ts` depends on `realpath-guard.ts` — a
local DAG, no cycles.

## Conventions (applied to every new file)

- **ESM, explicit `.ts`** on every relative import (`./sig.ts`,
  `../fs-atomic/index.ts`).
- **`verbatimModuleSyntax`:** type-only imports use `import type`; mixed
  value+type imports use the inline `type` modifier (`import { type Sig, statSig }`),
  matching the current code.
- **Named barrel re-exports only.** No `export *`. Types re-exported with
  `export type { … }`. A barrel exposes the module's intended integration
  surface (Layer 2), which may exceed the package API (Layer 1).
- **Import discipline.** Production code imports **other** modules only through
  their barrel; **within** a module, sibling leaf imports are normal. **Tests
  may import leaf files** for white-box unit-testing of internal helpers (this
  is the one sanctioned exception to "barrel-only").
- **`type`, never `interface`.** Biome single-quote / 2-space. Blank line
  before `return` unless it is the first/only statement.
- **Intra-file order:** imports → primary public export(s) → private helpers
  below (helpers hoist, so top-down reads as narrative).

## Methodology — behavior-preserving, test-guarded

Existing tests are the safety net; they stay green at every step.

1. Refactor **one module at a time** in dependency order: `fs-atomic` + `locks`
   (together — they share the source file) → `vault-io` → `locked-file` →
   `frontmatter` → `links` → strengthen `src/index.ts` + `index.test.ts`.
2. For each: create the folder + files (cut/paste symbols, fix imports, add the
   curated barrel), update importers and the matching test file, then run
   `bun test` for that test file and `bun run check` (Biome + `tsc --noEmit`).
3. Only after a module is green move to the next.
4. Final gate: full `bun test` + `bun run check` green; the strengthened
   `index.test.ts` proves the package API name-set is intact;
   `git diff src/index.ts` shows **path-only** changes.

No algorithm changes. The single extraction (`canonicalizeRelative`) and the
`sigsEqual` reuse are covered by existing `vault-io` / `fs-atomic` tests.

## Tests

One test file per module, kept in `src/__tests__/`:

- **`index.test.ts` (strengthened — closes the API-freeze gap).** Replace the
  `typeof === 'function'` spot-check with two guards:
  - **Runtime, exact value set:** `expect(Object.keys(mdvault).sort())
    .toEqual([...])` against the 10 value exports — this catches a **missing**
    *and* an **extra** runtime export (the current test catches neither).
  - **Compile-time, type exports:** module-level type aliases referencing every
    one of the 16 type exports (`type _Sig = mdvault.Sig;` …, erased at runtime,
    so the `import * as mdvault` stays a real value import). If any type export
    is dropped or renamed, `tsc --noEmit` (in `bun run check`) fails. This is
    the only way to guard type-only exports, which no runtime assertion can see.
- **`fs-atomic.test.ts`** → keep the `statSig + atomicWrite` and
  `exclusiveCreate + unlinkIfUnchanged` describes; update the import to
  `../fs-atomic/index.ts`. Remove the two lock describes.
- **`locks.test.ts`** (new) → the moved `withFileLock` and
  `withCrossProcessLock` describes, importing from `../locks/index.ts`
  (plus `MdVaultError` from `../errors.ts` and the same node builtins).
- **`locked-file.test.ts`** → import `withFileDelete`/`withFileTransform` from
  `../locked-file/index.ts`. The `MTIME_CONFLICT` test spies **only** `statSig`.
  Use the **symmetric-barrel seam**: production (`delete.ts`) imports `statSig`
  through the `fs-atomic` barrel, and the test spies that **same** barrel —
  `import * as fsAtomic from '../fs-atomic/index.ts'; spyOn(fsAtomic, 'statSig')`.
  This is exactly today's proven "production and test reference the same module
  namespace" pattern, with the module now being the barrel. **Verified
  empirically** (Bun 1.3.13): a `spyOn` on a re-export barrel namespace
  intercepts a consumer that imports the symbol through that barrel. (Spying the
  definition leaf `sig.ts` also works, but the symmetric-barrel seam keeps both
  production and test barrel-only — no leaf reach for this case.) The existing
  test run is still the gate: the "statSig fails only on the verification
  re-stat" assertion must observe the mock.
- **`vault-io.test.ts`** → update the `createVaultIo` import to
  `../vault-io/index.ts`; existing (black-box) describes unchanged. **Add direct
  white-box describes** for the extracted **security-critical** pure helpers,
  importing each leaf:
  - `paths.ts` → `canonicalizeRelative`: rejects absolute / `..`-escape;
    NFC-normalizes; collapses `.` and dup-slashes; case-preserving.
  - `allowlist.ts` → `matches`: boundary-aware (`foo` ∌ `foobar.md`; `foo` ∋
    `foo` and `foo/x`; `''` ∋ everything).
  - `realpath-guard.ts` → `realTargetWithinRoot(full, root)`: in-root → true;
    symlink-escape → false; nonexistent target inside root → true.
  These make the motivation ("independently testable") real at the unit level
  and pin the security contract per-helper, not only through `createVaultIo`.
  (Keeping them in `vault-io.test.ts` preserves one-test-file-per-module; they
  can split out later if the file grows unwieldy.)
- **`frontmatter.test.ts`, `links.test.ts`** → update the single import path to
  the folder barrel; content unchanged.
- **`errors.test.ts`, `scaffold.test.ts`** → unchanged.

`readConsistent` keeps its current indirect coverage (via `readVaultFile` /
`withFileTransform`); `globToRegExp` keeps its coverage via the `vault-io`
ignore-glob tests. Direct tests for those two remain optional.

## Open questions — resolved

- **Are folder barrels stable internal APIs or just refactor convenience?**
  → **Stable internal integration APIs** (Layer 2). Plan 2 modules will import
  through them, so a barrel's shape is a real contract; it is curated by hand,
  not auto-`export *`. It is still *internal* (not in `package.json` `exports`).
- **May tests import private leaf modules, or only barrels?**
  → **Tests may import leaf files** for white-box unit-testing of internal
  helpers (e.g. the new `realpath-guard` / `matches` / `canonicalizeRelative`
  describes). Production code stays barrel-only across modules. The `statSig`
  spy specifically does **not** need a leaf import — it uses the symmetric-barrel
  seam.

## Out of scope

- Any package public API change (names, signatures, types).
- Any logic / behavior change beyond the two noted micro-edits.
- Rewriting existing test assertions (only import paths, the lock-describe
  relocation, the `index.test.ts` strengthening, and the additive `vault-io`
  helper describes).
- Moving tests out of `src/__tests__/` (the central convention is kept).
- Plan 2 modules (`index`/SQLite, `query`, `notes`, `createVault`). Note for
  Plan 2: the SQLite "index" module should pick a folder name that does not
  collide with barrel `index.ts` files (e.g. `note-index/` or `db/`) — decided
  then, not now.
- Heavy doc-comment rewriting. A one-line module purpose comment may be added
  to a barrel where it has none; existing inline comments are preserved verbatim.

## Done criteria

- `src/` matches the target tree; `errors.ts` and `src/index.ts` are the only
  flat files (`errors.ts` the only flat **non-barrel source** module;
  `src/index.ts` the package-API barrel).
- `bun test` and `bun run check` are green.
- `index.test.ts` asserts the exact value-export key set **and** type-checks all
  16 type exports; `git diff src/index.ts` is path-only.
- No `export *`; no import cycle; every file is single-purpose and reads in one
  pass.
