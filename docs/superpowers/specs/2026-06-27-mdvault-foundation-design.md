# mdvault — foundation design

**Date:** 2026-06-27
**Status:** draft (brainstorm) — pending spec self-review + user review
**Package:** `mdvault` (npm, MIT)
**Repo home:** `/Users/ivan_kalinichenko/Dev/Personal/mdvault`

## What this is

`mdvault` is a **headless, framework-agnostic TypeScript/Bun library** that
provides a generic data layer over a folder of Markdown notes (an
Obsidian-*compatible* vault, but **not** Obsidian-*coupled* — no running
Obsidian, no plugin, no Electron). It gives consumers:

- **CRUD primitives** over `.md` files (read / create / update / delete /
  append / edit-by-match / set-frontmatter), with the
  atomic-write + per-file-lock + mtime-retry discipline required to survive
  an **external concurrent writer** (a vault syncer rewriting the same files).
- A **derived SQLite index** (notes / tags / links / full-text) that powers
  **collection queries** (filter by frontmatter / tags / folder),
  **backlinks**, and **keyword search** — kept fresh by a defined
  **reconcile model**.
- Optional, behind interfaces: a **graph adapter** (graphology, for
  algorithms) and a **pluggable search backend** (built-in FTS5, or an
  external semantic engine such as `qmd`).

The Markdown files on disk are the **single source of truth**. The SQLite
index is a **derived cache**, rebuildable from the files at any time, living
in the consumer's data directory — **never** inside the vault.

`mdvault` is the **mechanism**. It is consumed by two projects —
`machine-spirit` (personal) and `selgeo-brain` (work) — each of which writes
its own **allowlist- and policy-respecting tools** on top. Per-persona
isolation, deny-policies, sync, and the model-facing tool surface live in
the consuming projects, not here.

## Why a separate library (build-vs-buy summary)

A GitHub/npm sweep (45 candidates, 15 deep-verified) found **no turnkey
embeddable Bun/TS read+write vault library** that fits the constraints:

- The Obsidian REST/MCP options (`obsidian-local-rest-api`,
  `cyanheads/obsidian-mcp-server`, `obsidian-sdk`) all require a **running
  Obsidian** app/CLI — disqualified for headless servers.
- Most TS-native libraries (`markdowndb`, `velite`, `content-collections`,
  `contentlayer`, vault parsers) are **read/index-only** — no write CRUD.
- The write-capable headless options are young MCP/HTTP **sidecars** that
  **own the vault** (their own index + git auto-commit), which would **fight
  the consumers' existing syncers** (`ob` / git-sync) — exactly the
  external-writer race class the projects already battle.
- **None** respects the consumers' load-bearing invariants: per-persona
  allowlist + symlink-escape guard, atomic + mtime-guarded writes, isolation.

Conclusion: **build the CRUD + index core** (where the value is precisely
the invariants nobody else honours), and **adopt behind interfaces** the two
things that are wasteful to hand-roll — `graphology` (graph algorithms,
optional) and `qmd` (semantic search, optional sidecar). This mirrors the
`telegram-agent-kit` extraction precedent.

Full evaluation context lives in the machine-spirit conversation that
produced this spec; the verdict is summarised above.

## Scope

### In scope (v1)

1. `VaultIo` — path resolution + **allowlist enforcement mechanism**
   (parameterised by allowed prefixes) + symlink-escape (realpath) guard.
2. Atomic write + per-file lock + mtime-guard + bounded retry
   (`withFileTransform` / locked-file core), with `allowCreate` opt.
3. Frontmatter parse (total / never-throws, flat-YAML, tolerant of duplicate
   keys) + serialize (preserve unknown keys) + single-field set.
4. Link extraction (`[[wikilinks]]`, embeds `![[…]]`, relative `[](…md)`).
5. CRUD primitives over notes (read / create / update{edit-by-match | append}
   / delete / set-frontmatter), all **write-through** to the index.
6. SQLite index (`bun:sqlite`): notes / note_tags / note_links / FTS5, with
   `indexNote` / `dropNote` / `reconcile` / `reconcilePaths` primitives.
7. Query API: collection queries (frontmatter / tags / folder), backlinks +
   outbound links, keyword full-text (FTS5).
8. Reconcile model (write-through + lazy stat-sweep + boot reconcile /
   build-if-missing).
9. `SearchBackend` interface + built-in `Fts5Backend`.
10. Optional `GraphAdapter` over graphology (peer/optional dependency).

### Out of scope (v1 — YAGNI)

- **Persona / policy logic** (deny-prefixes, read-only personas, main-vs-
  subagent gating) — lives in the consuming projects.
- **The sync layer** (`ob` sidecar, git-sync) — lives in the projects; the
  library only provides the reconcile *primitives* the projects drive.
- **A bundled qmd/semantic backend** — the library defines the
  `SearchBackend` contract; a concrete `qmd` adapter is a separate concern
  (project-owned or a sibling package), so the core stays free of qmd's
  native deps.
- **Wikilink-integrity on rename/move** (rewriting inbound `[[links]]` when a
  note moves) — flagged as a future feature.
- **HTTP / MCP server** — consumers wire their own transport.
- **Typed frontmatter schemas (zod)** — the library returns raw parsed
  frontmatter; per-note-type zod schemas remain a project concern (keeps the
  core dep-light).
- **A file watcher** — see Reconcile model; deferred as a latency
  optimisation, not a correctness mechanism.
- **Node runtime support** — v1 targets Bun (`bun:sqlite`); the index module
  isolates SQL behind a driver boundary so a Node adapter can land later.

## Architecture — two layers

| Concern | `mdvault` (library) | Consuming project |
|---|---|---|
| Path resolve + allowlist **enforcement** | ✅ mechanism (`createVaultIo({ root, allowedPrefixes })`) | supplies the prefixes |
| Atomic write + lock + mtime-retry | ✅ | — |
| Frontmatter parse/serialize/set | ✅ | per-note-type zod schemas (optional) |
| Link extraction | ✅ | — |
| CRUD primitives | ✅ | binds them into model-facing **tools** |
| SQLite index + query + reconcile primitives | ✅ | drives *when/what* to reconcile (per its sync) |
| Search backend interface + FTS5 | ✅ | chooses backend (FTS5 / qmd) |
| Graph adapter (graphology) | ✅ optional | opts in if it wants algorithms |
| **Deny-policy / persona isolation** | ❌ | ✅ |
| **Sync (ob / git)** | ❌ | ✅ |
| **MCP / HTTP transport** | ❌ | ✅ |

The **allowlist enforcement is in the library** (parameterised); only the
**policy** (which prefixes, which deny rules, which persona) is in the
project. This prevents re-implementing the security boundary twice.

## Core modules (public surface)

Each module is independently testable with a single clear purpose.

- **`vault-io`** — `createVaultIo({ root, allowedPrefixes })` →
  `{ resolveVaultPath, toVaultRelative, readVaultFile, writeVaultFile, stat, listMarkdown }`.
  Rejects absolute paths, `..` escapes, out-of-allowlist prefixes, and
  symlink escapes (realpath containment). `toVaultRelative` exposes the
  canonical vault-relative form used as the lock key (so non-canonical model
  input like `a/./b.md` locks on the same key as its canonical form).
- **`locked-file`** —
  `withFileTransform(fullPath, lockKey, transform, opts)`: locked
  read → decide → `atomicWriteIfUnchanged(mtime)` with read-consistency
  double-stat + linear-backoff retry (`maxRetries = 3`, `50ms × (attempt+1)`).
  `opts.allowCreate` (default `false`): when false, a transform returning
  content for a missing file throws `refusing to create missing file`; when
  true, creates via `atomicWrite` (mkdir -p parent).
- **`frontmatter`** — `parseFrontmatter(content)` →
  `{ frontmatter: Record<string, unknown>, tags: string[], body: string }`
  (YAML, `uniqueKeys: false`, never throws); `serializeFrontmatter(fields, body)`
  (flat YAML, preserves unknown keys); `setFrontmatterField(content, key, value)`
  (round-trips the block, preserves the rest). Soft coercers
  (`softString` / `softNumber`) exported as utilities.
- **`links`** — `extractLinks(content)` → `{ wikilinks, embeds, mdLinks }`
  (raw targets; resolution to paths is the index's job).
- **`notes`** (CRUD over `VaultIo` + `locked-file`):
  - `readNote(path, { withGraph? })` → `{ frontmatter, tags, body, links }`,
    and when `withGraph`, `{ outbound, backlinks }` (backlinks from the index).
  - `createNote(path, { frontmatter?, body })` (allowCreate).
  - `updateNote(path, op)` where `op` is **exactly one** of
    `{ editByMatch: { old, new } }` (unique single-occurrence replace; errors
    on 0 or >1 matches; existing-file only) **or**
    `{ append: string }` (append-to-end with create-if-missing; newline rule:
    insert one `\n` before the appended text iff existing non-empty content
    lacks a trailing newline).
  - `setFrontmatter(path, key, value)`.
  - `deleteNote(path)`.
  - **No full-overwrite mode** (the model must not truncate a whole note).
  - Every write runs inside `withFileTransform` keyed by `toVaultRelative`,
    and updates the index **in the same lock** (write-through).
- **`index`** (`bun:sqlite`) — schema below + `indexNote(path)` /
  `dropNote(path)` / `reconcile()` / `reconcilePaths(paths)` + raw query
  helpers. SQL is isolated behind a thin internal driver boundary.
- **`query`** — `queryNotes({ tag?, where?, folder?, limit? })` (structured),
  `backlinks(path)` / `outboundLinks(path)`, `searchText(q, filters?)`
  (FTS5).
- **`search`** — `SearchBackend` interface (`search(query, filters)`);
  `Fts5Backend` (built-in, over the index). Semantic backends (e.g. `qmd`)
  implement the same interface out-of-tree.
- **`graph`** (optional) — `createGraphAdapter()` builds a graphology graph
  from `note_links`; exposes `pagerank`, `shortestPath`, `communities`,
  `neighborhood(path, depth)`. Degree-1 links/backlinks do **not** need this
  (served by SQL); graphology earns its place only for algorithms.

## Data model — the SQLite index

Lives at a **consumer-supplied path in `DATA_DIR`** (e.g.
`data/vault-index.db`), **outside the vault** (so a derived index is never
synced between machines). Derived and rebuildable.

```sql
notes(
  path        TEXT PRIMARY KEY,   -- canonical vault-relative
  mtime_ms    INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  title       TEXT,
  frontmatter TEXT NOT NULL       -- JSON
);
note_tags(path TEXT, tag TEXT);                 -- idx on (tag), (path)
note_links(src TEXT, dst TEXT);                 -- idx on (dst) for backlinks
-- FTS5 virtual table over note bodies:
notes_fts USING fts5(path UNINDEXED, body);
meta(key TEXT PRIMARY KEY, value TEXT);         -- schema_version, etc.
```

- Queries: tag → `note_tags WHERE tag = ?`; collection →
  `notes WHERE json_extract(frontmatter, '$.status') = ?`; backlinks →
  `note_links WHERE dst = ?`; keyword → `notes_fts MATCH ?`.
- `schema_version` in `meta`; on boot, a version mismatch / missing / corrupt
  index triggers a **full rebuild** from the files.

## Indexing & reconciliation

Two branches keep the index consistent with the files:

### ① Internal writes — write-through (exact, synchronous)

CRUD writes go through the library, so it **knows** about the change and
updates the affected index rows **inside the same lock**, right after the
file write, using the already-parsed content. The post-write `mtime`/`size`
are stored, so reconcile won't redo the work. Immediate and exact.

### ② External writes — reconcile (the human via Obsidian / the syncer)

Edits arriving through the syncer bypass the library (no callback). Detected
by comparing on-disk `(mtime, size)` against stored values:

- **`reconcile()`** — full stat-sweep over the allowlisted tree: re-parse
  files whose `(mtime, size)` diverged, insert new files, drop rows for files
  that vanished. `stat` is cheap (single-digit–tens of ms for hundreds–
  thousands of notes); only changed files pay parse cost.
- **`reconcilePaths(paths)`** — targeted reindex of a known changeset.

**Who drives reconcile (the one sync-specific difference):**
- `selgeo-brain` (git-sync): after `git pull`, derive the changeset
  (`git diff --name-only`) and call `reconcilePaths(changed)`.
- `machine-spirit` (opaque `ob`/Obsidian-Sync): call `reconcile()`
  (stat-sweep) — no changeset available.

### Composition (v1)

1. **Write-through** on every internal CRUD write.
2. **Lazy reconcile before queries**, gated by a short TTL (e.g. ≤ once per
   ~2 s) — the correctness backbone for external edits; no daemon required;
   works in CLI and server alike.
3. **Boot reconcile / build-if-missing** — reconcile once on start; full
   rebuild if the index is absent / corrupt / version-mismatched.
4. **Watcher (chokidar): out of scope for v1** — an optimisation, not
   correctness (syncer atomic-renames / bulk checkouts defeat watchers, so a
   periodic full sweep is required regardless). Add later if query latency
   demands it.

### Edge cases

- **Delete:** reconcile drops `notes` + `note_tags` + `note_links` +
  `notes_fts` rows for vanished paths.
- **Rename/move:** appears as delete + add to the sweep (correct). Inbound
  `[[wikilink]]` integrity is **out of scope** (a separate future feature).
- **mtime granularity:** detection uses `(mtime, size)`; a content-hash
  column is a documented future upgrade for syncers that preserve mtime
  (git checkout bumps mtime, so machine-spirit's stat-sweep is safe; selgeo
  is changeset-driven anyway).
- **Corruption / version bump:** full rebuild from files.

## Search backends

```
interface SearchBackend { search(query: string, filters?): Promise<NoteRef[]> }
  ├─ Fts5Backend   // built-in, over the SQLite index — keyword + fielded
  └─ <external>    // e.g. a qmd adapter (semantic) — out-of-tree, same iface
```

- The **personal base (`machine-spirit`)** uses `Fts5Backend` — cheap,
  headless, fits a 2 GB box (no models).
- **`selgeo-brain`** may plug in a `qmd` adapter (semantic + rerank) behind
  the same interface; qmd runs as a Node sidecar over MCP/CLI and is **never
  imported into the Bun runtime** (its native `node-llama-cpp` /
  `better-sqlite3` ABI stack would conflict with the Bun-first rule). Keeping
  qmd behind `SearchBackend` keeps its weight out of the core entirely.

Note: a semantic search engine is **not** a substitute for the structured
index — collection/tag queries (exact, `WHERE` over frontmatter) and content
search (fuzzy/semantic) are different tiers, both needed.

## Graph

Optional. `graphology` (+ chosen `graphology-*` algorithm modules) is an
**optional peer dependency**: the personal base need not install it. Degree-1
links and backlinks are served directly from `note_links` (SQL); the graph
adapter exists only for algorithms (pagerank, shortest path, communities,
n-hop neighbourhood). The adapter builds the in-memory graph from the index
on demand and may cache it.

## Runtime & packaging

- **Bun-first.** `bun:sqlite` (built-in, no native dep), `Bun.file` for I/O.
  Both consumers are Bun, so this is zero-friction. The `index` module
  isolates all SQL behind a small driver boundary so a **Node adapter**
  (`node:sqlite` / `better-sqlite3`) can be added later without touching
  callers (future).
- **ESM**, `"type": "module"`, `exports` + bundled `.d.ts`. No `bin` (it is a
  library). License **MIT**. Package name **`mdvault`**.
- **Dependencies:** runtime — `yaml` only (frontmatter). `graphology` (+
  algorithm modules) as **optional peer**. No native addons in the core.
- **Conventions** (match the two consuming repos): Biome single-quote /
  2-space / grouped imports; `type` not `interface`; lazy config; tests in
  `__tests__/` using `spyOn` (**never** `mock.module`); blank line before
  `return`; module-folder split when a file outgrows ~3 exports or one read.

## How the two projects consume it (follow-up, not v1 of the lib)

Each repo migrates **separately**, after `mdvault` v1 exists:

- **machine-spirit:** replace `src/runtime/vault-io.ts`,
  `domain/section-edit.ts` (`withFileTransform`), `runtime/frontmatter-schema.ts`,
  `runtime/markdown.ts` with `mdvault` imports; the in-flight
  `read_note` / `update_note` cross-agent tools bind `mdvault` CRUD with the
  persona's allowlist + `denyPrefixes` policy; add `query_notes` (collections)
  + `search_notes` (FTS5) tools. Frontmatter becomes writable
  (`setFrontmatter`), enabling agent tag edits + the index write-through.
- **selgeo-brain:** replace its ported `vault-io` / `frontmatter` /
  `markdown` with `mdvault`; keep its git-sync layer, driving
  `reconcilePaths` from the pull changeset; tools bind `mdvault` CRUD with the
  three-prefix-set policy + provenance; optionally wire a `qmd` `SearchBackend`.

These migrations are **separate specs**; this spec only defines the library.

## Testing strategy

- **Security:** allowlist escape (`..`, absolute, symlink-to-outside),
  `.md`-only guard, canonical lock-key coincidence (`a/./b.md`).
- **Concurrency:** `withFileTransform` mtime-retry under a simulated external
  writer; two concurrent appends leave no lost update (mirrors the
  machine-spirit `h-create` race test); `allowCreate` true/false branches.
- **CRUD:** edit-by-match 0 / 1 / >1 matches; append newline rule (both
  trailing-`\n` and not); create-if-missing; `setFrontmatter` preserves
  unknown keys + body; delete removes the file.
- **Index/reconcile:** write-through updates rows in-lock; `reconcile()`
  detects external add/modify/delete; `reconcilePaths` targets correctly;
  rebuild-on-corrupt; **property: a full rebuild equals the incrementally
  maintained index** (golden invariant).
- **Query:** tag, frontmatter-`where`, folder, backlinks/outbound, FTS5
  keyword; index lives in `DATA_DIR`, not the vault.
- **Frontmatter:** total/never-throws on malformed + duplicate keys.

## Open source & licensing

MIT, generic-only (no proprietary content — domain schemas, personas, sync
all stay in the consuming repos). Same model as `telegram-agent-kit` (the
user's published package that `selgeo-brain` already depends on), so a
personal OSS package consumed by a work repo is established precedent. Repo
home: `/Users/ivan_kalinichenko/Dev/Personal/mdvault`.

## Open questions

1. **qmd adapter location** — project-owned wiring vs a sibling
   `mdvault-qmd` package. (Lean: project-owned first; extract if both repos
   need it.)
2. **Typed frontmatter** — keep zod entirely in projects (current plan), or
   ship an optional `parseFrontmatterWith(schema)` helper that accepts a
   validator without a hard zod dep?
3. **Node support timing** — Bun-only v1 is fine for both consumers; when (if)
   to add the Node sqlite adapter.
4. **Index granularity for tags** — `note_tags` join table (current plan) vs
   `json_each` over the frontmatter JSON; decide on query ergonomics +
   index-ability during implementation.
