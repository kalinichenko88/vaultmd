# Changelog

## 0.4.0 — 2026-06-30

- **`query.tags()`** — a new read-only query returning the vault's existing tags
  as `{ tag, count }[]`, ranked most-used first, so callers can reuse and extend
  tags instead of inventing duplicates. Optional filters: `prefix` (case-sensitive
  hierarchy navigation, e.g. `project/`), `contains` (ASCII case-insensitive
  substring search), `folder` (restrict to a folder subtree), and `limit` (top-N).
  Results are read-scope filtered like every other query, and `count` reflects
  only the notes the instance is allowed to read.
- **`TagInfo`** — the `{ tag: string; count: number }` shape `query.tags()`
  returns, added to the public API.
- **`query` folder filter** now treats `%` and `_` in a folder name as literal
  characters instead of SQL `LIKE` wildcards — `queryNotes`, `searchText`, and
  `tags` with a `folder` such as `foo_1` no longer over-match unrelated paths.

## 0.3.0 — 2026-06-29

- **`serializeFrontmatter`** — the inverse of `parseFrontmatter`: converts a
  flat frontmatter map to a fenced YAML block (`---\n…\n---\n`), or the empty
  string for an empty map. Output is byte-identical to the fresh block
  `createNote`/`editFrontmatter` write to a note with no existing frontmatter
  (an existing block's styling is preserved by `editFrontmatter`, not reproduced
  here). Every accepted input round-trips, including multi-line strings. Throws
  `MdVaultError('FRONTMATTER_INVALID')`, naming the offending keys, on input that
  cannot round-trip — nested objects, arrays of non-scalars, `Date`s, or
  non-finite numbers (`NaN`, `Infinity`). Non-empty arrays serialize as YAML
  block sequences (Obsidian-style `- item` lines, not flow `[a, b]`).
- **`isFlatFrontmatter`** now treats `Date`s and non-finite numbers (`NaN`,
  `Infinity`) as non-flat, since neither survives a serialize/parse round-trip.
  `createNote`/`editFrontmatter` therefore reject those frontmatter values
  instead of silently storing a lossy string.

## 0.2.0 — 2026-06-29

- **Public types** — `Backlink` and `OutboundLink` are now exported from the
  package root, and the `vault.notes` / `vault.query` bundles have named
  interfaces `NotesApi` / `QueryApi` (previously inferred). Additive and
  non-breaking; enables the generated API reference.
- **`transformNote`** — a new `NotesApi` method: run a caller-supplied
  whole-note transform inside the per-file lock with write-through indexing,
  returning `'edited' | 'unchanged'` (`TransformOutcome`). `allowCreate` is
  false (a missing file + non-null transform throws `REFUSE_CREATE`). The
  callback is re-invoked on mtime-conflict retries and must be pure. Enables an
  atomic "conditionally edit frontmatter + body in one commit" for consumers.

## 0.1.0 — 2026-06-28

First public release — a headless markdown-vault data layer for Bun. The `.md`
files on disk are the source of truth; a derived `bun:sqlite` index provides
collection queries, backlinks, and search.

- **`createVault`** — the composition root and primary entry point, wiring the
  IO chokepoint, index, query, and notes layers into a single `Vault`.
- **Notes CRUD** — `createNote`, `readNote`, `updateNote`, `editFrontmatter`,
  and `deleteNote` over `.md` files with flat YAML frontmatter. Edits preserve
  formatting and are write-through indexed inside the same per-file lock as the
  file write, so the file and its index row never drift.
- **Derived SQLite index** — a rebuildable cache, never the source of truth:
  `queryNotes` filters by tag, frontmatter field, or folder with ordering and
  pagination; `backlinks` / `outboundLinks` walk the link graph; `searchText`
  runs FTS5 keyword search with highlighted snippets.
- **Links** — `[[wikilink]]` and relative-link extraction with asymmetric
  resolution (`linkResolution: 'wikilink' | 'relative'`).
- **vault-io security chokepoint** — per-instance read/write path allowlists,
  NFC path canonicalization, and realpath/symlink containment. Queries return
  only notes the instance is allowed to read.
- **Concurrency & durability** — atomic writes with mtime compare-and-swap, an
  in-process mutex plus optional cross-process lockfiles, and lazy background
  reconcile that picks up out-of-band edits without blocking reads.
- **Typed errors** — every failure throws `MdVaultError` with a stable `code`
  (`ALREADY_EXISTS`, `NOT_FOUND`, `ALLOWLIST_VIOLATION`, `MTIME_CONFLICT`, …).
- **Lower-level primitives** exported for advanced use: `createVaultIo`,
  `withFileTransform`, `withFileDelete`, `parseFrontmatter`, `editFrontmatter`,
  `extractLinks`, `storedLinksFor`, and more.
- Ships as a bundled ESM `dist/` with type declarations. Bun-only at runtime
  (the bundle imports `bun:sqlite`).
