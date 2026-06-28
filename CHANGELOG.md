# Changelog

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
