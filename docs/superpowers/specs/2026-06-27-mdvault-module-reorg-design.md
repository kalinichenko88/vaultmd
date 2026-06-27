# mdvault — module-folder reorganization design

**Date:** 2026-06-27
**Status:** draft — pending user review
**Package:** `mdvault` (npm, MIT)
**Scope:** internal source layout only — a behavior-preserving refactor of the
Plan 1 foundation primitives. No public API change, no logic change, no new
features.

## Goal

Reorganize `src/` from seven flat files into **one folder per responsibility**,
so that before open-sourcing every module owns exactly **one area** and the
files inside it are small, single-purpose, and readable in one pass. The public
package surface (`src/index.ts`) stays **byte-identical in exported names**;
only import paths move.

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
   The security-critical pure logic is invisible inside the closure and cannot
   be read or unit-tested in isolation.
3. **Minor:** `readConsistent` re-inlines the signature comparison
   (`sig2.mtimeMs === sig1.mtimeMs && sig2.size === sig1.size`) instead of
   reusing `sigsEqual`. Folded into the move.

## Principles

- **One area per module.** Each top-level folder under `src/` is responsible
  for a single area. If a file mixed two areas, the areas split into two
  modules (this is why `locks/` leaves `fs-atomic/`).
- **The barrel is the only door.** Each module folder has an `index.ts` that
  **named-re-exports only its public surface** (never `export *`, so internal
  helpers never leak). Cross-module imports target the barrel
  (`../fs-atomic/index.ts`); files **within** a folder import siblings directly
  (`./sig.ts`).
- **Public API frozen.** The set of names re-exported by `src/index.ts` is
  unchanged; only the `from` paths change.
- **Behavior-preserving.** No control-flow or algorithm changes. The only
  non-move edits are pure-function extractions already covered by existing
  tests (e.g. `canonicalizeRelative`) and the `sigsEqual` reuse above.
- **Acyclic dependencies.** The module graph stays a DAG (see below).

## Target structure

```
src/
├── index.ts                  # public barrel — only `from` paths change
├── errors.ts                 # unchanged (2 exports → stays a flat file)
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
    ├── vault-io.test.ts      # import path → ../vault-io/index.ts
    ├── locked-file.test.ts   # import paths updated; statSig spy retargeted (see Tests)
    ├── frontmatter.test.ts   # import path → ../frontmatter/index.ts
    ├── links.test.ts         # import path → ../links/index.ts
    ├── index.test.ts         # imports unchanged (../index.ts)
    └── scaffold.test.ts      # unchanged
```

## Move map (symbol → destination)

Every existing symbol lands in exactly one new file. "Barrel" = re-exported
from the folder's `index.ts`; "internal" = folder-private (not in the barrel).

### `fs-atomic/`  (from `fs-atomic.ts`)

| Symbol | File | Barrel? |
|---|---|---|
| `Sig` (type) | `sig.ts` | yes |
| `makeSig`, `sigsEqual` | `sig.ts` | internal |
| `statSig` | `sig.ts` | yes |
| `tempPath` | `atomic-write.ts` | internal |
| `atomicWrite`, `atomicWriteIfUnchanged`, `exclusiveCreate`, `unlinkIfUnchanged` | `atomic-write.ts` | yes |
| `readConsistent` (+ `ConsistentRead` type) | `read-consistent.ts` | yes (`readConsistent`) |

`atomic-write.ts` and `read-consistent.ts` import `makeSig`/`sigsEqual`/`statSig`/`Sig` from `./sig.ts` and `MdVaultError` from `../errors.ts`. `read-consistent.ts` replaces its inline signature compare with `sigsEqual`.

### `locks/`  (from `fs-atomic.ts`)

| Symbol | File | Barrel? |
|---|---|---|
| `fileLocks` (map), `withFileLock` | `in-process.ts` | yes (`withFileLock`) |
| `delay`, `tryReclaim` | `cross-process.ts` | internal |
| `withCrossProcessLock` | `cross-process.ts` | yes |

`cross-process.ts` imports `MdVaultError` (`../errors.ts`), `createHash` (`node:crypto`), `mkdir`/`readFile`/`unlink`/`writeFile` (`node:fs/promises`), `hostname` (`node:os`), `node:path`.

### `vault-io/`  (from `vault-io.ts`)

| Symbol | File | Barrel? |
|---|---|---|
| `canonicalizeRelative` (extracted from `toVaultRelative`'s body), `canonPrefix` | `paths.ts` | internal |
| `matches` | `allowlist.ts` | internal |
| `realTargetWithinRoot` | `realpath-guard.ts` | internal |
| `caseSensitiveCache`, `resolveCaseSensitive`, `detectCaseSensitive` | `case-sensitivity.ts` | internal |
| `globToRegExp` | `glob.ts` | internal |
| `walk`, `listMarkdown` | `enumerate.ts` | internal |
| `Access`, `VaultPrefixes`, `VaultIoConfig`, `VaultIo` (types) | `create-vault-io.ts` | yes |
| `createVaultIo` (factory + closure methods) | `create-vault-io.ts` | yes |

- `toVaultRelative` is already pure (uses only its argument); its body becomes
  `canonicalizeRelative(rel)` in `paths.ts`, and the factory method delegates to
  it. `toKey`, `can`, `resolveVaultPath`, the five IO methods, and `isIgnored`
  stay as closure methods in `create-vault-io.ts` (they close over `root` /
  `caseSensitive` / `canonPrefixes` / `ignoreRes`) and call the extracted pure
  helpers.
- `enumerate.ts` exposes `listMarkdown(root, dir, deps)` (it computes
  `startRel` from `dir` via `deps.toVaultRelative`) where
  `deps = { isIgnored, resolveVaultPath, toVaultRelative }`; `walk` is its
  private helper and imports `realTargetWithinRoot` from `./realpath-guard.ts`
  directly. The factory builds `ignoreRes` via `globToRegExp`, closes it into
  `isIgnored`, and passes the deps object in.

### `locked-file/`  (from `locked-file.ts`)

| Symbol | File | Barrel? |
|---|---|---|
| `CommitEvent`, `CrossLock`, `TransformOpts`, `TransformResult` | `types.ts` | yes |
| `emitCommit` | `commit.ts` | internal |
| `withFileTransform` | `transform.ts` | yes |
| `withFileDelete` | `delete.ts` | yes |

`transform.ts` imports `atomicWrite`/`atomicWriteIfUnchanged`/`readConsistent` from `../fs-atomic/index.ts` and `withFileLock`/`withCrossProcessLock` from `../locks/index.ts`. `delete.ts` imports `statSig`/`unlinkIfUnchanged` from `../fs-atomic/index.ts` and the two locks. Both import `emitCommit` (`./commit.ts`) and types (`./types.ts`). `Bun.sleep` in `transform.ts` is kept as-is.

### `frontmatter/`  (from `frontmatter.ts`)

| Symbol | File | Barrel? |
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

| Symbol | File | Barrel? |
|---|---|---|
| `ExtractedLinks`, `LinkResolution`, `StoredLink` | `types.ts` | yes |
| `stripFencedCode`, `mdLinkUrl` | `extract.ts` | internal |
| `extractLinks` | `extract.ts` | yes |
| `normalizeWikiTarget`, `resolveRelativeTarget` | `resolve.ts` | internal |
| `storedLinksFor` | `resolve.ts` | yes |

`resolve.ts` imports `extractLinks` (`./extract.ts`), `posix` (`node:path`), and the types.

## Public API freeze

`src/index.ts` re-exports exactly these names after the move (only `from` paths
change to folder barrels):

- from `./errors.ts`: `MdVaultCode` (type), `MdVaultError`
- from `./fs-atomic/index.ts`: `Sig` (type)
- from `./vault-io/index.ts`: `Access`, `VaultIo`, `VaultIoConfig`, `VaultPrefixes` (types), `createVaultIo`
- from `./locked-file/index.ts`: `CommitEvent`, `CrossLock`, `TransformOpts`, `TransformResult` (types), `withFileDelete`, `withFileTransform`
- from `./frontmatter/index.ts`: `EditOutcome`, `FrontmatterValidity`, `ParsedFrontmatter` (types), `deriveTags`, `editFrontmatter`, `isFlatFrontmatter`, `parseFrontmatter`
- from `./links/index.ts`: `ExtractedLinks`, `LinkResolution`, `StoredLink` (types), `extractLinks`, `storedLinksFor`

`src/__tests__/index.test.ts` (imports `* as mdvault`) is the regression guard
that this set is intact.

## Dependency graph (acyclic)

```
errors      ← fs-atomic, locks, vault-io, locked-file
fs-atomic   ← vault-io, locked-file
locks       ← locked-file
frontmatter ← (yaml only)
links       ← (node:path only)
index       ← all module barrels
```

No module imports `vault-io`, so its inward edges are only outward. Within
`vault-io/`, `create-vault-io.ts` depends on the five helper files and
`enumerate.ts` depends on `realpath-guard.ts` — a local DAG, no cycles.

## Conventions (applied to every new file)

- **ESM, explicit `.ts`** on every relative import (`./sig.ts`,
  `../fs-atomic/index.ts`).
- **`verbatimModuleSyntax`:** type-only imports use `import type`; mixed
  value+type imports use the inline `type` modifier (`import { type Sig, statSig }`),
  matching the current code.
- **Named barrel re-exports only.** No `export *`. Types re-exported with
  `export type { … }`.
- **`type`, never `interface`.** Biome single-quote / 2-space. Blank line
  before `return` unless it is the first/only statement.
- **Intra-file order:** imports → primary public export(s) → private helpers
  below (helpers hoist, so top-down reads as narrative).

## Methodology — behavior-preserving, test-guarded

Existing tests are the safety net; they stay green at every step.

1. Refactor **one module at a time** in dependency order: `fs-atomic` + `locks`
   (together — they share the source file) → `vault-io` → `locked-file` →
   `frontmatter` → `links` → update `src/index.ts`.
2. For each: create the folder + files (cut/paste symbols, fix imports, add the
   barrel), update the importers and the matching test file, then run
   `bun test` for that test file and `bun run check` (Biome + `tsc --noEmit`).
3. Only after a module is green move to the next.
4. Final gate: full `bun test` + `bun run check` green; `git diff` on the
   exported-name set of `src/index.ts` shows **path-only** changes.

No algorithm changes. The single extraction (`canonicalizeRelative`) and the
`sigsEqual` reuse are covered by existing `vault-io` / `fs-atomic` tests.

## Tests

One test file per module, kept in `src/__tests__/`:

- **`fs-atomic.test.ts`** → keep the `statSig + atomicWrite` and
  `exclusiveCreate + unlinkIfUnchanged` describes; update the import to
  `../fs-atomic/index.ts`. Remove the two lock describes.
- **`locks.test.ts`** (new) → the moved `withFileLock` and
  `withCrossProcessLock` describes, importing from `../locks/index.ts`
  (plus `MdVaultError` from `../errors.ts` and the same node builtins).
- **`locked-file.test.ts`** → import `withFileDelete`/`withFileTransform` from
  `../locked-file/index.ts`. It spies **only** `statSig`
  (`spyOn(fsAtomic, 'statSig')`, the repo-blessed live-binding pattern). Because
  `statSig` now lives in `fs-atomic/sig.ts`, retarget the spy namespace import to
  the module whose binding the production code resolves to — the **definition
  module** `../fs-atomic/sig.ts` (recommended: closest to the current proven
  same-module pattern), falling back to the `../fs-atomic/index.ts` barrel if
  re-export live-binding does not propagate the spy. **Verify by
  running `bun test src/__tests__/locked-file.test.ts`**: the
  "statSig fails only on the verification re-stat" test must still observe the
  mock. If the spy does not intercept, that test fails loudly — it is the gate,
  not an afterthought.
- **`vault-io.test.ts`, `frontmatter.test.ts`, `links.test.ts`** → update the
  single import path to the folder barrel; content unchanged.
- **`errors.test.ts`, `index.test.ts`, `scaffold.test.ts`** → unchanged.

The extracted pure helpers (`canonicalizeRelative`, `matches`,
`realTargetWithinRoot`, `globToRegExp`) remain covered through the existing
`vault-io` tests (canonicalization, boundary-aware allowlist, symlink-escape,
ignore-glob). `readConsistent` keeps its current indirect coverage (via
`readVaultFile` / `withFileTransform`). Adding direct unit tests for these is a
**future** option, not part of this refactor.

## Out of scope

- Any public API change (names, signatures, types).
- Any logic / behavior change beyond the two noted micro-edits.
- Rewriting test assertions (only import paths and the lock-describe relocation).
- Moving tests out of `src/__tests__/` (the central-`__tests__` convention is
  kept).
- Plan 2 modules (`index`/SQLite, `query`, `notes`, `createVault`). Note for
  Plan 2: the SQLite "index" module should pick a folder name that does not
  collide with barrel `index.ts` files (e.g. `note-index/` or `db/`) — decided
  then, not now.
- Heavy doc-comment rewriting. A one-line module purpose comment may be added
  to a barrel where it has none; existing inline comments are preserved verbatim.

## Done criteria

- `src/` matches the target tree; `errors.ts` is the only remaining flat
  source file.
- `bun test` and `bun run check` are green.
- `src/index.ts` exports the frozen name set, paths-only changed.
- No `export *`; no import cycle; every file is single-purpose and reads in one
  pass.
