# mdvault — foundation design

**Date:** 2026-06-27
**Status:** draft — revised after adversarial spec review (pending user review)
**Package:** `mdvault` (npm, MIT)
**Repo home:** `/Users/ivan_kalinichenko/Dev/Personal/mdvault`

## What this is

`mdvault` is a **headless, framework-agnostic TypeScript/Bun library** that
provides a generic data layer over a folder of Markdown notes (an
Obsidian-*compatible* vault, but **not** Obsidian-*coupled* — no running
Obsidian, no plugin, no Electron). It gives consumers:

- **CRUD primitives** over `.md` files (read / create / update / delete /
  append / edit-by-match / edit-frontmatter), with the
  atomic-write + per-file-lock + mtime-retry discipline required to survive
  an **external concurrent writer** (a vault syncer rewriting the same files).
- A **derived SQLite index** (notes / tags / links / full-text) that powers
  **collection queries** (filter by frontmatter / tags / folder),
  **backlinks**, and **keyword search**, kept fresh by a defined
  **reconcile model**.

The Markdown files on disk are the **single source of truth**. The SQLite
index is a **derived cache**, rebuildable from the files at any time, living
in the consumer's data directory — **never** inside the vault.

`mdvault` is the **mechanism**. It is consumed by two projects —
`machine-spirit` (personal) and `selgeo-brain` (work) — each of which writes
its own **policy-respecting tools** on top. Per-persona deny-policies,
isolation, sync (`ob` / git), and the model-facing tool surface live in the
consuming projects, not here.

### Deferred to v1.1+ (explicitly NOT in this spec)

The adversarial review flagged three pieces as speculative generality with no
v1 consumer. They are deferred and will get their own specs when a consumer
actually needs them:

- **Graph algorithms** (`graphology` adapter: pagerank / communities /
  shortest-path). Degree-1 links + backlinks are served by SQL in v1; no
  consumer asks for an algorithm yet.
- **A pluggable `SearchBackend` interface** (and any semantic / `qmd`
  backend). v1 ships **one concrete** keyword search (`searchText`, FTS5);
  the interface is extracted on the second implementation, when qmd's real
  contract is known.
- **Node runtime support** / a SQLite-driver abstraction. v1 is written
  directly against `bun:sqlite`; both consumers are Bun. The driver boundary
  is extracted in the PR that actually adds Node support.

## Why a separate library (build-vs-buy summary)

A GitHub/npm sweep (45 candidates, 15 deep-verified) found **no turnkey
embeddable Bun/TS read+write vault library** that fits the constraints:

- The Obsidian REST/MCP options require a **running Obsidian** app/CLI —
  disqualified for headless servers.
- Most TS-native libraries (`markdowndb`, `velite`, `content-collections`,
  parsers) are **read/index-only** — no write CRUD.
- The write-capable headless options are young MCP/HTTP sidecars that **own
  the vault** (their own index + git auto-commit), which would **fight the
  consumers' existing syncers** — exactly the external-writer race class the
  projects already battle.
- **None** respects the consumers' invariants: per-persona allowlist +
  symlink-escape guard, atomic + mtime-guarded writes, isolation.

Conclusion: **build the CRUD + index core** (where the value is precisely the
invariants nobody else honours). `graphology` (graph algorithms) and `qmd`
(semantic search) are adopted **later, behind seams**, when needed. This
mirrors the `telegram-agent-kit` extraction precedent.

## Scope (v1)

### In scope

1. `VaultIo` — path resolution + **per-access allowlist enforcement** +
   symlink-escape (realpath) guard.
2. `locked-file` — atomic write + per-file lock + mtime-guard + bounded
   retry, with `allowCreate` and an `afterWrite` **write-seam** hook.
3. `frontmatter` — parse (total / never-throws) + **multi-field
   body-preserving edit** via the YAML Document/CST API (comment- and
   format-preserving) + flat-frontmatter validation.
4. `links` — link extraction + **pluggable resolution** (wikilink |
   relative) to canonical paths.
5. `notes` — CRUD primitives (read / create / update{edit-by-match | append}
   / delete / edit-frontmatter); all **writes** write-through to the index.
6. `index` — `bun:sqlite` (notes / note_tags / note_links / external-content
   FTS5) with `indexNote` / `dropNote` / `reconcile` / `reconcilePaths` /
   `rebuild`.
7. `query` — collection queries (frontmatter / tags / folder), backlinks +
   outbound links, keyword full-text (sanitized FTS5). All list/search APIs
   carry `limit` / `offset` and a defined default order.
8. Reconcile model (write-through + lazy stat-sweep + boot build + explicit
   rebuild).
9. A **composition root** (`createVault(...)`) owning the SQLite handle and a
   **typed error model** with stable codes.

### Out of scope (v1 — YAGNI)

- The three deferred pieces above (graph algorithms, search-backend
  interface, Node driver).
- **Persona / policy logic** (deny-prefixes, read-only personas,
  main-vs-subagent gating) — lives in the consuming projects.
- **The sync layer** (`ob`, git-sync) — lives in the projects; the library
  exposes the `afterWrite` seam + reconcile primitives the projects drive.
- **Inline `#hashtags`** in note bodies — v1 reads tags from frontmatter only.
- **Wikilink-integrity on rename/move** (rewriting inbound `[[links]]`).
- **HTTP / MCP transport** — consumers wire their own.
- **Typed frontmatter schemas (zod)** — the library returns raw parsed
  frontmatter; per-note-type zod schemas remain a project concern.
- **A file watcher** — a latency optimisation, not correctness; deferred.

## Architecture — two layers

| Concern | `mdvault` (library) | Consuming project |
|---|---|---|
| Path resolve + **per-access allowlist enforcement** | ✅ mechanism (`createVaultIo({ root, prefixes })`) | supplies the `{ read, write }` prefixes |
| Atomic write + lock + mtime-retry + `afterWrite` seam | ✅ | hooks `afterWrite` (e.g. git commit) |
| Frontmatter parse / edit (format-preserving) | ✅ | per-note-type zod schemas; demote-on-edit policy |
| Link extraction + resolution (wikilink/relative) | ✅ mechanism | picks the resolver |
| CRUD primitives | ✅ | binds them into model-facing **tools** |
| Index + query + reconcile primitives | ✅ | drives targeted `reconcilePaths`; may disable lazy reconcile |
| Keyword search (FTS5) | ✅ | (semantic/qmd → v1.1) |
| **Deny-policy / persona isolation** | ❌ | ✅ |
| **Sync (ob / git) + commit-before-return** | ❌ (provides the seam) | ✅ |
| **MCP / HTTP transport, Russian user messages** | ❌ (emits codes) | ✅ (maps codes → messages) |

The **allowlist enforcement is in the library** (parameterised by prefixes);
only the **policy** (which prefixes, deny rules, persona) is in the project.

## Composition root & lifecycle

A single factory owns the SQLite handle and wires the modules:

```
createVault({
  root: string,                      // vault root abs path
  prefixes: { read: string[]; write: string[] },
  indexPath: string,                 // bun:sqlite db path in DATA_DIR (NOT in vault)
  linkResolution?: 'wikilink' | 'relative' | LinkResolver,  // default 'wikilink'
  lazyReconcile?: boolean,           // default true; selgeo sets false
  reconcileTtlMs?: number,           // default 2000
  afterWrite?: (rel: string, content: string) => void | Promise<void>,
  ignore?: string[],                 // extra ignore globs beyond defaults
}) => {
  io, notes, query,
  reconcile, reconcilePaths, rebuild,
  close(),                           // releases the bun:sqlite handle (tests/shutdown)
}
```

- Opens the `bun:sqlite` `Database` **once**; the single handle is shared by
  the write-through path (`notes`) and reads (`query`).
- On open: `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=<reconcileTtlMs or
  default>;` — the index is in local `DATA_DIR` (not the synced vault), so
  WAL's `-wal`/`-shm` sidecars are safe.
- On open: a one-time **FTS5 capability probe** (try `CREATE VIRTUAL TABLE …
  fts5` in a savepoint); fail fast with a clear message pointing at
  `Database.setCustomSQLite()` if the platform `libsqlite3` lacks FTS5.
- `engines` pins a minimum Bun version (FTS5/json1 come from the platform
  `libsqlite3`, which `bun:sqlite` links on macOS — version-dependent).

## Core modules (public surface)

Dependency direction: `vault-io`, `locked-file`, `frontmatter`, `links` are
**leaf** modules (independently testable). `notes` depends on `index`
(write-through + backlinks); `query` depends on `index`.

### `vault-io`

`createVaultIo({ root, prefixes })` →
`{ resolveVaultPath, toVaultRelative, can, readVaultFile, writeVaultFile, rewriteIfUnchanged, stat, listMarkdown }`

- `prefixes: { read: string[]; write: string[] }`. machine-spirit passes
  `read === write ===` its single allowlist; selgeo passes
  `read: ['']` (whole vault) and `write:` its direct∪PR write set (the
  direct-vs-PR routing is selgeo sync policy, layered above).
- `resolveVaultPath(rel, access = 'read')` and `can(rel, access)` — reject
  absolute paths, `..` escapes, out-of-allowlist prefixes (per access), and
  symlink escapes (realpath containment). Non-`.md` targets are rejected at
  this chokepoint (single home for the `.md`-only guard).
- `toVaultRelative(rel)` → the **canonical** vault-relative form used as the
  lock key. Canonicalization: strip leading `./`, collapse `.` segments and
  duplicate slashes, force `/` separators, **NFC** Unicode normalization,
  **case-preserving** (documented caveat: on case-insensitive FS,
  `Note.md`/`note.md` are the same file but distinct keys — consumers should
  use consistent casing; v1 does not case-fold).
- `rewriteIfUnchanged(rel, content, mtime)` — mtime-guarded write, exposed so
  the consumer's sync decorator (selgeo) has a stable seam to wrap.
- `listMarkdown(dir?)` — **recursive** over the allowlisted tree; skips
  dotfolders (`.obsidian`, `.trash`, `.git`), non-`.md` files, and the
  configured `ignore` globs. The machine-spirit `_`/`0`-prefix skip is **not
  a default**; it is expressible via `ignore`.

### `locked-file`

`withFileTransform(fullPath, lockKey, transform, opts)` — locked
read → decide → `rewriteIfUnchanged` with **read-consistency double-stat**
(stat → read → stat; re-read on change, bounded retries) + linear-backoff
retry (`maxRetries = 3`, `50ms × (attempt+1)`).

- `opts.allowCreate` (default `false`): false → a transform returning content
  for a missing file throws `REFUSE_CREATE`; true → create via `atomicWrite`
  (mkdir -p parent).
- `opts.afterWrite(rel, content)` — runs **inside the lock**, after the write
  and the in-lock index update, before lock release. selgeo hooks git
  add+commit here (commit-before-return); machine-spirit no-ops.

### `frontmatter`

- `parseFrontmatter(content)` → `{ frontmatter, tags, body, valid }`
  (`valid: 'flat' | 'present-but-invalid' | 'none'`). YAML read,
  `uniqueKeys: false`, **never throws**; degrades to `{}`/`none` on garbage.
- `editFrontmatter(content, mutate)` → `{ content, outcome:
  'edited' | 'unchanged' | 'unverifiable' }`. **Multi-field, body-preserving**,
  via the YAML **Document/CST API** (`parseDocument` → mutate nodes →
  `String(doc)`), which preserves comments, key order, numeric literals
  (`1.0`), and empty values (`aliases:`). Fail-**closed** (`unverifiable`,
  no write) on non-flat / malformed frontmatter. This subsumes selgeo's
  `editFrontmatter` (e.g. its `demoteApprovedOnEdit` mutates 4 fields at once;
  the demote *policy* stays in selgeo).
- `assertFlatFrontmatter(fields)` — flat = **top-level keys only; values are
  scalar or array-of-scalar**; nested maps are rejected (→ `unverifiable`).
- `tags` derivation (pinned): read frontmatter `tags` (and `tag`); coerce
  scalar | comma/space-string | YAML list → `string[]`; strip a leading `#`;
  **case-preserving**; dedup. Inline `#hashtags` in the body are **out of
  scope** in v1. The identical normalization is applied to query-side tag
  input.

### `links`

- `extractLinks(content)` → `{ wikilinks, embeds, mdLinks }` (raw targets).
- **Resolution** (`linkResolution`) maps a raw target → canonical `dst` path,
  pluggable per consumer:
  - `'wikilink'` (machine-spirit): strip `#heading` / `#^block` / `|alias`;
    match by exact vault-relative path, else by **basename, case-insensitive**;
    `.md` optional; tie-break **same-folder first, then shortest path, then
    lexical**; **dangling** target → row stored with `dst = raw target`
    (sentinel-prefixed, never resolves as a real note).
  - `'relative'` (selgeo, Wikilinks OFF): resolve `mdLinks` against the source
    file's directory; must end in `.md`; out-of-vault → dropped.
  - A custom `LinkResolver(target, srcDir) => string | null` is accepted.
- `note_links.dst` stores **resolved canonical paths** (or the dangling
  sentinel).

### `notes` (CRUD)

All return typed results / throw typed errors (see Error model). All **writes**
run inside `withFileTransform` keyed by `toVaultRelative`, perform the index
update **in the same lock and the same SQLite transaction**, then call
`afterWrite`.

- `readNote(path, { withLinks? })` → `{ frontmatter, tags, body, valid }`;
  with `withLinks`, also `{ outbound, backlinks }` (from the index). Missing
  file → throws `NOT_FOUND`. *(Renamed from `withGraph` to avoid implying the
  deferred graph adapter.)*
- `createNote(path, { frontmatter?, body })` — `allowCreate`; **errors
  `ALREADY_EXISTS`** if the path exists (no clobber). Performs a full index
  INSERT (all four tables) in-lock.
- `updateNote(path, op)` — exactly one of:
  - `{ editByMatch: { old, new } }` — **literal substring** match; counts
    **non-overlapping** occurrences over exact bytes; error `NO_MATCH` (0) or
    `AMBIGUOUS_MATCH` (>1); existing-file only.
  - `{ append: string }` — append-to-end, create-if-missing (full index
    INSERT on create); newline rule: insert one `\n` before the appended text
    iff existing non-empty content lacks a trailing newline.
- `editFrontmatter(path, mutate)` — multi-field body-preserving edit (above);
  re-derives tags/index in-lock.
- `deleteNote(path)` — removes the file + all index rows; missing → **no-op**
  (idempotent).
- **No full-overwrite mode** (the model must not truncate a whole note).

### `index` (`bun:sqlite`)

Schema:

```sql
notes(
  id          INTEGER PRIMARY KEY,        -- stable rowid for FTS addressing
  path        TEXT UNIQUE NOT NULL,       -- canonical vault-relative
  mtime_ms    INTEGER NOT NULL,           -- integer ms, exact-equality compare
  size        INTEGER NOT NULL,
  title       TEXT NOT NULL,              -- derivation below (never NULL)
  frontmatter TEXT NOT NULL               -- JSON
);
note_tags(path TEXT, tag TEXT);           -- index on (tag), (path)
note_links(src TEXT, dst TEXT);           -- index on (dst) AND (src)
-- external-content FTS5 keyed by notes.id (O(1) per-note update/delete):
notes_fts USING fts5(body, content='notes', content_rowid='id');
meta(key TEXT PRIMARY KEY, value TEXT);   -- schema_version, last_reconcile_ms
```

- **`title`** (pinned precedence): frontmatter `title` → first `# H1` →
  filename without extension. Never NULL.
- **External-content FTS5** (`content_rowid='id'`) so a single note's FTS row
  is addressed by rowid — avoids the O(N) virtual-table scan a standalone FTS
  table pays on every per-note update/delete.
- `indexNote` / `dropNote` each run in **one synchronous SQLite transaction**
  (`db.transaction(...)()`, no awaits between BEGIN/COMMIT). `SQLITE_BUSY` is
  absorbed by `busy_timeout`; the in-process per-file lock plus
  single-statement transactions keep cross-note index writes consistent
  (sqlite serializes writers; the per-file lock does **not** span the index).
- **Multi-process topology is supported** (machine-spirit's CLI and `serve`
  daemon both open the same `vault-index.db`): WAL + `busy_timeout` + small
  transactions. Each process keeps its **own** lazy-reconcile TTL clock
  (in-memory); there is no cross-process cache invalidation in v1 (a process
  may serve a ≤TTL-stale view of the *other* process's writes until its next
  reconcile — documented, acceptable).

### `query`

- `queryNotes({ tag?, where?, folder?, orderBy?, limit?, offset? })`:
  - `where` = **equality map** `Record<string, string | number | boolean>`
    over top-level frontmatter keys (`json_extract`), all conditions plus
    `tag`/`folder` **AND**ed; missing key = no match. Operators are deferred.
  - `folder` = **recursive** prefix match on the normalized boundary
    `folder + '/'` (matches nested subfolders).
  - Default order **`mtime_ms DESC, path ASC`**; default `limit` capped
    (documented, e.g. 100) so unbounded sets never reach a model context.
  - Note: frontmatter `where` is a table scan (opaque JSON); fine at low
    thousands. Hot fields can later get expression indexes
    (`CREATE INDEX … json_extract(frontmatter,'$.x')`) — a documented scaling
    lever, not v1 work.
- `backlinks(path, { limit?, offset? })` / `outboundLinks(path, …)` —
  indexed on `(dst)` / `(src)`; default order `src/dst ASC`; paginated.
- `searchText(q, { tag?, folder?, limit?, offset? })` — FTS5 keyword.
  **Input is sanitized**: tokenize and re-emit each term double-quoted (so
  raw model text like `C++ vs Rust:` or a trailing `AND` cannot throw an
  FTS5 syntax error); malformed input yields empty results, never a raw
  SQLite throw. Default order FTS `rank`; paginated.

## Indexing & reconciliation

Two branches keep the index consistent with the files. **The library owns the
correctness schedule; the project may add a targeted fast-path.**

### ① Internal writes — write-through (in-lock, same transaction)

CRUD writes go through the library, so it updates the affected index rows
inside the same per-file lock, in **one SQLite transaction**, using the
already-parsed content. **Not claimed atomic across the two files**: the
`.md` and the index DB are separate. Ordering & recovery: write the file
first; **only advance the stored `(mtime, size)` if the index transaction
commits** — so if the index write fails (busy/crash), the stored signature
stays behind and the next reconcile re-syncs that note. The file is the
source of truth; cross-file durability is the reconcile backstop, not a
two-phase commit.

### ② External writes — reconcile (the human via Obsidian / the syncer)

Edits arriving through the syncer bypass the library. Detected by comparing
on-disk `(mtime_ms, size)` against stored values.

- **`reconcile()`** — full sweep over the allowlisted tree (recursive, ignore
  rules per `listMarkdown`), **parallel/batched `stat`** (sequential
  `await stat` is ~10ms/1000 notes; `Promise.all` ~1ms/1000 — the latency
  claim depends on batching). For each changed file, apply the **same
  stat→read→stat read-consistency** as writes (re-read if it changed mid-read)
  so the stored signature always matches the parsed content. Re-parse changed,
  insert new, drop vanished.
- **`reconcilePaths(paths)`** — targeted reindex of a known changeset.
- **`rebuild()`** — public: drop all rows, enumerate via `listMarkdown`,
  reindex from scratch. Used for first build, corruption, schema-version bump,
  or after an out-of-band bulk edit / a normalization-logic fix.

**Who drives it:**
- machine-spirit (opaque `ob`/Obsidian-Sync): relies on the library's
  **lazy reconcile** (`lazyReconcile: true`).
- selgeo (git-sync): sets `lazyReconcile: false` and, after each `git pull`,
  calls `reconcilePaths(git diff --name-only …)` from **inside its git
  mutex** (avoids a query-triggered sweep reading a file mid-checkout).

### Composition (v1)

1. **Write-through** on every internal CRUD write (in-lock, transactional).
2. **Lazy reconcile before queries**, gated by a per-instance TTL
   (`reconcileTtlMs`, default 2000), **opt-out** via `lazyReconcile: false`.
   Triggering entry points: `queryNotes`, `backlinks`, `outboundLinks`,
   `searchText`, and `readNote({ withLinks })`. Runs outside any consumer
   write mutex (relies on never-throws parse + next reconcile for torn reads).
3. **Boot build-if-missing** — on `createVault`, if the index is absent /
   corrupt (`PRAGMA integrity_check` on open / version mismatch in `meta`),
   `rebuild()`. Cold build parses the whole vault (seconds on large vaults) —
   documented latency budget; an async/background build mode is a future
   option.
4. **Watcher (chokidar): out of scope v1** — an optimisation, not correctness
   (syncer atomic-renames / bulk checkouts defeat watchers; a sweep is
   required regardless).

### Edge cases

- **Delete:** drops `notes` + `note_tags` + `note_links` + `notes_fts` rows.
- **Rename/move:** delete + add to the sweep (correct). Inbound
  `[[wikilink]]` integrity is **out of scope** (future).
- **Detection precision:** `mtime_ms` stored as integer ms, **exact-equality**
  compare, plus `size`. A same-`(mtime, size)` content edit is undetectable;
  a `content_hash` column is the documented upgrade. **Assumption to verify
  before relying on it:** `ob`/Obsidian-Sync **bumps** mtime on synced writes
  (some sync tools preserve source mtime across devices). If empirically it
  preserves mtime, promote `content_hash` into v1 for machine-spirit.
- **Golden invariant** (testing): a full `rebuild()` equals the incrementally
  maintained index **at quiescence, given every change bumps `(mtime, size)`** —
  the property test exercises mtime/size-bumping changes only; the
  mtime-preserving case is the documented gap.

## Search (v1)

Concrete `searchText` over the external-content FTS5 table (above), with input
sanitization and `tag`/`folder` filters joined on `note_tags` / `path`-prefix.
Semantic search (a `qmd` adapter) and the `SearchBackend` interface that would
abstract them are **v1.1** (extract-on-second-implementation). A semantic
engine is **not** a substitute for the structured index — collection/tag
queries (exact `WHERE`) and content search (fuzzy/semantic) are different
tiers, both needed.

## Error model

The library **throws typed errors** (`MdVaultError` subclasses), each with a
stable machine-readable `code`. The library emits **English messages + codes**;
consumers map codes → their own (Russian) user-facing messages. Codes:

`ALLOWLIST_VIOLATION`, `NOT_MARKDOWN`, `NOT_FOUND`, `ALREADY_EXISTS`,
`NO_MATCH`, `AMBIGUOUS_MATCH`, `MTIME_CONFLICT`, `REFUSE_CREATE`,
`FRONTMATTER_INVALID` (edit fail-closed), `SEARCH_SYNTAX` (should be
unreachable post-sanitization), `INDEX_UNAVAILABLE` (FTS5 probe failed / open
error).

## Runtime & packaging

- **Bun-first.** `bun:sqlite` (built-in), `Bun.file` I/O. ESM,
  `"type": "module"`, `exports` + bundled `.d.ts`. No `bin` (library). MIT.
  Package `mdvault`. `engines` pins a minimum Bun version.
- **Dependencies:** runtime — `yaml` only (Document/CST API for
  format-preserving frontmatter edits). No native addons. `graphology` etc.
  arrive only with the v1.1 graph module (optional peer).
- **Consumers must gitignore** the index DB **and** its `-wal` / `-shm`
  sidecars.
- **Conventions** (match both consuming repos): Biome single-quote / 2-space /
  grouped imports; `type` not `interface`; lazy config; tests in `__tests__/`
  using `spyOn` (**never** `mock.module`); blank line before `return`;
  module-folder split when a file outgrows ~3 exports or one read.

## How the two projects consume it (follow-up, separate specs)

Each repo migrates **separately**, after `mdvault` v1 exists:

- **machine-spirit:** replace `src/runtime/vault-io.ts`,
  `domain/section-edit.ts`, `runtime/frontmatter-schema.ts`,
  `runtime/markdown.ts` with `mdvault`. `linkResolution: 'wikilink'`,
  `lazyReconcile: true`, no `afterWrite`. The in-flight `read_note` /
  `update_note` cross-agent tools bind `mdvault` CRUD with the persona
  allowlist + `denyPrefixes` policy; add `query_notes` + `search_notes`
  tools. Frontmatter becomes writable (`editFrontmatter`).
- **selgeo-brain:** replace its ported `vault-io` / `frontmatter` /
  `markdown` with `mdvault`. `linkResolution: 'relative'`,
  `lazyReconcile: false`; pass `afterWrite` = git add+commit (its existing
  commit-before-return), and drive `reconcilePaths` from the pull changeset
  inside its git mutex. `demoteApprovedOnEdit` / provenance stay as selgeo
  policy layered over `editFrontmatter`.

## Testing strategy

- **Security:** allowlist escape (`..`, absolute, symlink-to-outside) per
  access; `.md`-only guard at `resolveVaultPath`; canonical lock-key
  coincidence (`a/./b.md`); NFC normalization.
- **Concurrency:** `withFileTransform` mtime-retry + stat→read→stat under a
  simulated external writer; two concurrent appends → no lost update (mirrors
  machine-spirit's `h-create` race test); `allowCreate` branches; `afterWrite`
  runs in-lock after write.
- **CRUD:** edit-by-match literal 0/1/>1; append newline rule (both);
  create-if-missing full index insert; `editFrontmatter` preserves comments /
  order / `1.0` / empty `aliases:` / unknown keys, fail-closed on nested;
  create-clobber refusal; delete idempotent.
- **Index/reconcile:** write-through in one transaction; stored mtime not
  advanced if index write fails; `reconcile()` detects external add/modify/
  delete with read-consistency; `reconcilePaths` targets; `rebuild()` from
  empty; WAL + `busy_timeout` set; **golden invariant** at quiescence.
- **Query:** tag / frontmatter-`where` (AND, missing-key) / folder (recursive)
  / backlinks / outbound / FTS5 keyword with **adversarial input** (`+`, `-`,
  `:`, `*`, trailing `AND`, unbalanced quote → empty, never throw); default
  order + limit/offset determinism; index lives in `DATA_DIR`, not the vault.
- **Cross-process:** two handles on one index DB don't deadlock (WAL +
  busy_timeout).

## Open source & licensing

MIT, generic-only (domain schemas, personas, sync stay in the consuming
repos). Same model as `telegram-agent-kit` (the user's published package that
`selgeo-brain` already depends on), so a personal OSS package consumed by a
work repo is established precedent. Repo home:
`/Users/ivan_kalinichenko/Dev/Personal/mdvault`.

## Resolved by the adversarial review (was "open")

- **Reconcile ownership:** library owns lazy + boot; project adds targeted
  `reconcilePaths`; `lazyReconcile` is opt-out.
- **vault-io signature:** per-access `{ read, write }` prefixes (covers both
  repos); finer access classes are project policy.
- **Link resolution:** pluggable `'wikilink' | 'relative' | LinkResolver`.
- **Tags:** frontmatter-only in v1; `note_tags` join table (chosen over
  `json_each`).
- **Graph adapter, SearchBackend interface, Node driver:** deferred to v1.1+.

## Open questions (remaining)

1. **`ob`/Obsidian-Sync mtime semantics** — empirically confirm it bumps
   mtime; if it preserves source mtime, `content_hash` moves into v1 for
   machine-spirit. (Action during machine-spirit migration.)
2. **qmd adapter location** (v1.1) — project-owned wiring vs a sibling
   `mdvault-qmd` package.
3. **Default `limit` value** for queries — pick the cap during implementation
   (start ~100).
