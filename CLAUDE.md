# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`mdvault` is a headless markdown-vault data layer for **Bun**: CRUD over `.md`
notes plus a derived `bun:sqlite` index (collection queries, backlinks, keyword
search). The `.md` files on disk are the **source of truth**; the SQLite index is
a **rebuildable cache**. No Obsidian, no Electron. Internal imports use `@/`
tsconfig-path aliases; **`tsup` bundles `src/index.ts` → `dist/`** (ESM `.js` +
`.d.ts`, with `bun:sqlite` externalized), so the aliases are resolved in the
shipped artifact. `exports` points at `./dist/index.js`. The package publishes to
npm via a **tag-driven** GitHub Actions workflow (push a `v*` tag → `npm publish
--provenance`); the local `release` skill drives the version/CHANGELOG/README/tag
flow. It stays **Bun-only at runtime** (the bundle imports `bun:sqlite`).

## Commands

Runtime is Bun (the code uses `bun:sqlite`, `Bun.file`, `Bun.sleep` — do not run
it under Node).

```bash
bun test                          # full suite
bun test src/query                # one module's tests
bun test src/notes/__tests__/notes.test.ts   # one file
bun test -t "backlinks"           # tests matching a name

bun run check                     # biome check . && tsc --noEmit — the gate; run before claiming done
bun run typecheck                 # tsc --noEmit only
bun run lint                      # biome lint only
bun run format                    # biome format --write
bun run build                     # tsup bundle src/index.ts → dist/
bun run smoke                     # pack the tarball + install/import/typecheck it in a temp project
```

`tsconfig.include` is `["src"]`, so a single dangling import anywhere fails
`tsc --noEmit`. `bun run check` is the authoritative green/red gate.

## Architecture

### Layering (a DAG — keep it acyclic)

```
errors        ← everything
fs-atomic     ← vault-io, locked-file, notes        race-aware single-file fs ops (atomicWrite, CAS, exclusiveCreate, readConsistent)
locks         ← locked-file, notes                  concurrency control (in-process mutex + cross-process lockfile)
vault-io      ← query, notes, vault                 path→safe-IO security chokepoint
frontmatter   ← notes                               YAML frontmatter parse/edit (flat-only)
links         ← note-index, vault                    wikilink/relative link extraction + resolution
note-index    ← query, notes, vault                 SQLite schema + projection + reconcile
query         ← notes, vault                         read-only SQL over the index
notes         ← vault                                CRUD with write-through indexing
vault         (composition root: createVault)
```

`createVault` (`src/vault/create-vault.ts`) is the primary entry point and the
composition root — it wires `vault-io` + `note-index` + `query` + `notes`
together. Everything else is a lower-level primitive that `createVault`
assembles.

### Three API surfaces (do not conflate them)

1. **Package public API — `src/index.ts`.** The *only* `exports` entry (`"."`).
   Its exact name set is **frozen** and guarded by `src/__tests__/index.test.ts`
   (currently 36 names, value + type). Adding/removing/renaming an export means
   updating that test deliberately. No `mdvault/<subpath>` is reachable — only
   `"."` is exported.
2. **Module barrels — `<module>/index.ts`.** The stable *internal* integration
   surface. Intentionally broader than the package API (e.g. `fs-atomic` exposes
   `statSig`/`atomicWrite`, none package-public). Curated by hand — **named
   re-exports only, never `export *`**.
3. **Leaf files — `<module>/<part>.ts`.** Module-private. A leaf `export` exists
   so same-module siblings and white-box tests can import it. "Not on the barrel"
   is the privacy boundary, not "unexported."

**Import discipline:** production code imports *other* modules only through their
barrel, via the `@/` alias (`@/fs-atomic/index.ts` — never a relative
`../fs-atomic/index.ts`); *within* a module, import siblings with a relative path
(`./sig.ts`, or `../sig.ts` from a `models/`/`__tests__/` subfolder). A test in
`<module>/__tests__/` may import another module's leaf for white-box testing,
also via the alias (`@/fs-atomic/sig.ts`), while importing its own module's files
relatively. The package root barrel `@/index.ts` is **off-limits to production
code** — only the API-freeze test (`src/__tests__/index.test.ts`) imports it.
`@/*` maps to `./src/*` (`tsconfig.json`); keep the explicit `.ts` extension.

### Key invariants

- **Write-through indexing.** `notes` mutations (`createNote`, `updateNote`,
  `editFrontmatter`, `deleteNote`) update the SQLite index *inside the same
  per-file lock* as the file write, via the `indexCommit` onCommit seam (after
  the file commits, before the consumer `onCommit`). File write and index update
  are never split across locks.
- **Config fingerprint guard.** `IndexConfig` (`linkResolution`, `caseSensitive`,
  `ignore`) is fingerprinted into the index's `meta` table. On boot, a mismatch
  (or schema-version bump) triggers a rebuild **only if this instance owns the
  whole index** (its `prefixes.read` includes `''`); a non-owner throws
  `INDEX_UNAVAILABLE` rather than rebuilding a shared index out from under another
  scope.
- **Read-scope filtering.** `query` returns only notes the instance can read
  (`vaultIo.can(path, 'read')`). It scans matching rows, filters by scope, *then*
  paginates in JS for exact page fills — pagination happens after the scope
  filter, not in SQL.
- **Lazy reconcile.** Reads stay synchronous; the first read (and the first after
  each TTL window) fires one fire-and-forget background reconcile sweep whose
  result is visible to the *next* read. A failed sweep never breaks a read.
- **vault-io is the security chokepoint.** All path canonicalization (NFC,
  reject absolute/`..`-escape), allowlist matching, and realpath/symlink
  containment live here. Treat its pure helpers (`paths.ts`, `allowlist.ts`,
  `realpath-guard.ts`) as security-critical.
- **Index db location.** The index `.db` and its `-wal`/`-shm` sidecars must live
  in a data dir, **not** the synced vault, and stay gitignored (`*.db*` already
  is).

### Errors

All failures throw `MdVaultError` with a `code: MdVaultCode` (see
`src/errors.ts`). Catch and switch on `.code`, not on message strings.

## Conventions

- **ESM with explicit `.ts` extensions** on every relative import (required by
  `allowImportingTsExtensions` + `moduleResolution: bundler`).
- **`verbatimModuleSyntax`:** type-only imports use `import type`; mixed imports
  use the inline modifier (`import { type Sig, statSig }`).
- **`type`, never `interface`.** Biome: single quotes, 2-space indent. Blank line
  before `return` unless it's the first/only statement.
- **Always use full braced `if` blocks, expanded across three lines:**

  ```ts
  if (condition) {
    body;
  }
  ```

  Never write brace-less ifs (`if (x) return;`) **and never a one-line braced
  if** (`if (x) { return; }`). The body goes on its own line inside the braces,
  even for a single statement. This is enforced by `bun run check`: the
  `style/useBlockStatements` lint rule requires the braces, and the Biome
  formatter expands the braced block onto separate lines — so both halves fail
  the gate. No separate config is needed; just run the gate before committing.
- **One area per module folder**; each testable file has a co-located unit test
  in the module's `__tests__/`. Intra-file order: imports → primary export(s) →
  private helpers below.
- Tests are excluded from the npm tarball via `!`-negations in `package.json`
  `files`; verify packaging with `bun pm pack` / `npm pack --dry-run` when
  touching the file layout.
- **Domain types live in `<module>/models/`** — one entity per file
  (kebab-case). Private impl types (DB row shapes, parser intermediates, DI
  deps objects) stay inline in the leaf that uses them. The module barrel
  re-exports public types from `models/`; there is no `models/` sub-barrel.
- **Constants by reach:** inline in one file → `<module>/constants.ts` when used
  by ≥2 files of a module → a shared root only when used by ≥2 *independent*
  modules. If consumers all already depend on one module, the constant stays in
  that owner (e.g. `SCHEMA_VERSION` in `note-index`).
- **Reuse, don't duplicate:** a helper/type/constant needed by two modules is
  lifted to the lowest level both reach — *into the existing dependency* if one
  module already depends on the other, else to a shared root (`src/models/`,
  `src/lib/`, `src/constants.ts`, created lazily). Cross-module imports stay
  barrel-only. See `docs/superpowers/specs/2026-06-28-types-constants-reuse-design.md`.

## Planning docs

Design specs and implementation plans live in `docs/superpowers/`. The
module-reorg spec (`specs/2026-06-27-mdvault-module-reorg-design.md`) is the
canonical statement of the three-surface layering rules above.
