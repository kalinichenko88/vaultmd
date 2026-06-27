# mdvault — foundation design

**Date:** 2026-06-27
**Status:** draft — revised after two review rounds (pending user review)
**Package:** `mdvault` (npm, MIT)
**Repo home:** `/Users/ivan_kalinichenko/Dev/Personal/mdvault`

## What this is

`mdvault` is a **headless, framework-agnostic TypeScript/Bun library** that
provides a generic data layer over a folder of Markdown notes (an
Obsidian-*compatible* vault, but **not** Obsidian-*coupled* — no running
Obsidian, no plugin, no Electron). It gives consumers:

- **CRUD primitives** over `.md` files (read / create / update / delete /
  append / edit-by-match / edit-frontmatter), with atomic-write +
  per-file-lock + mtime-guard discipline that **tolerates** an external
  concurrent writer (a vault syncer rewriting the same files) on a
  **best-effort** basis — see §Concurrency model for the honest limits.
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

- **Graph algorithms** (`graphology`: pagerank / communities / shortest-path).
  Degree-1 links + backlinks are served by SQL in v1.
- **A pluggable `SearchBackend` interface** (and any semantic / `qmd`
  backend). v1 ships one concrete keyword search (`searchText`, FTS5);
  the interface is extracted on the second implementation.
- **Node runtime support** / a SQLite-driver abstraction. v1 targets
  `bun:sqlite`; both consumers are Bun.

## Concurrency model (the honest contract)

This is load-bearing, so it is stated plainly:

- **There is no portable atomic compare-and-swap on a file.** Writes use
  **detect-and-retry**: read the file's `(mtime, size)` signature, decide the
  new content, then write via `temp-file + fsync + rename` **only if a final
  re-stat shows the signature unchanged**; otherwise retry (bounded) or raise
  `MTIME_CONFLICT`.
- This closes the **common** race (an external write that lands before our
  final stat is detected → retry). It does **not** close the residual
  **TOCTOU window** between the final stat and the `rename`: an external write
  landing in that microsecond window is silently clobbered. Against an
  **uncooperative** syncer (`ob` / Obsidian-Sync, which does not take our
  locks) this window is **irreducible**. The reconcile backstop re-syncs the
  *index* afterward, but a *file* edit lost in that window is genuinely lost.
- **In-process** coordination: a per-file in-memory lock (keyed by the
  canonical path key, §vault-io) serializes mdvault's writers **within one
  process**.
- **Cross-process** coordination (multiple mdvault *writer processes* on the
  same vault — e.g. machine-spirit's CLI and `serve` daemon): an **optional**
  advisory file lock (`crossProcessWriterLock`, default `false`) serializes
  them via an `O_EXCL` lockfile with stale-lock recovery. It does **nothing**
  for the external syncer.
- **Claim:** mdvault *tolerates* an external concurrent writer (best-effort
  detect-and-retry + eventual index reconcile); it does **not** *prevent*
  lost updates against an uncooperative syncer. Consumers needing a hard
  guarantee must coordinate the syncer (out of scope).

## Scope (v1)

### In scope

1. `VaultIo` — path resolution + **per-access, boundary-aware allowlist
   enforcement** + symlink-escape (realpath) guard.
2. `locked-file` — atomic write + per-file lock + mtime-guard + bounded
   retry, with `allowCreate`, an `onCommit` **op-typed seam**, and a
   CAS-like delete.
3. `frontmatter` — parse (total / never-throws) + **multi-field
   body-preserving edit** via the YAML Document/CST API + flat validation.
4. `links` — extraction + **pluggable resolution** (wikilink resolved at
   query time; relative resolved in place).
5. `notes` — CRUD primitives; all mutations write-through to the index
   in-lock.
6. `index` — `bun:sqlite` (notes / note_tags / note_links / standalone FTS5
   keyed by rowid) with `indexNote` / `dropNote` / `reconcile` /
   `reconcilePaths` / `rebuild`, all constrained (PKs) and transactional.
7. `query` — collection queries (frontmatter / tags / folder), backlinks +
   outbound, keyword full-text (sanitized FTS5), with **typed `orderBy`
   allowlist**, bound parameters, and `limit` / `offset`.
8. Reconcile model (write-through + lazy stat-sweep + boot build + rebuild).
9. An **async composition root** (`createVault(...)`) owning the SQLite
   handle, plus a **typed error model** with stable codes.

### Out of scope (v1 — YAGNI)

- The three deferred pieces above.
- **Persona / policy logic** (deny-prefixes, read-only personas, gating) —
  consuming projects.
- **The sync layer** (`ob`, git-sync) — projects; the library exposes the
  `onCommit` seam + reconcile primitives.
- **Inline `#hashtags`** in bodies — v1 reads tags from frontmatter only.
- **Wikilink-integrity on rename/move** (rewriting inbound `[[links]]`).
- **HTTP / MCP transport.**
- **Typed frontmatter schemas (zod)** — projects layer their own.
- **A file watcher.**

## Architecture — two layers

| Concern | `mdvault` (library) | Consuming project |
|---|---|---|
| Path resolve + **per-access boundary-aware allowlist** | ✅ mechanism (`createVaultIo({ root, prefixes })`) | supplies `{ read, write }` prefixes |
| Atomic write + lock + mtime-guard + `onCommit` seam + CAS delete | ✅ | hooks `onCommit` (e.g. git commit) |
| Frontmatter parse / edit (format-preserving) | ✅ | zod schemas; demote-on-edit policy |
| Link extraction + resolution | ✅ mechanism | picks the resolver |
| CRUD primitives | ✅ | binds into model-facing **tools** |
| Index + query + reconcile primitives | ✅ | drives targeted `reconcilePaths`; may disable lazy reconcile |
| Keyword search (FTS5) | ✅ | (semantic/qmd → v1.1) |
| **Deny-policy / persona isolation** | ❌ | ✅ |
| **Sync + commit-before-return** | ❌ (provides the seam) | ✅ |
| **MCP / HTTP, Russian user messages** | ❌ (emits codes) | ✅ (maps codes → messages) |

## Composition root & lifecycle

```
async createVault({
  root: string,                      // vault root abs path
  prefixes: { read: string[]; write: string[] },
  indexPath: string,                 // bun:sqlite db in DATA_DIR (NOT in vault)
  linkResolution?: 'wikilink' | 'relative' | LinkResolver,  // default 'wikilink'
  lazyReconcile?: boolean,           // default true; selgeo sets false
  reconcileTtlMs?: number,           // default 2000 — lazy-reconcile throttle
  sqliteBusyTimeoutMs?: number,      // default 5000 — SQLite contention (independent knob)
  caseSensitive?: boolean,           // default: auto-detect the volume
  crossProcessWriterLock?: boolean,  // default false (see Concurrency model)
  onCommit?: (e: CommitEvent) => void | Promise<void>,
  ignore?: string[],
}): Promise<Vault>

// Vault = { io, notes, query, reconcile, reconcilePaths, rebuild, close }
```

- **Async** because it opens the DB, runs capability probes, and may
  `rebuild()` by traversing the whole vault. `close()` releases the handle
  (test isolation / shutdown).
- Opens `bun:sqlite` **once**; the single handle is shared by write-through
  (`notes`) and reads (`query`).
- On open: `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=<sqliteBusyTimeoutMs>;`
  (index is in local `DATA_DIR`, so WAL `-wal`/`-shm` sidecars are safe).
- On open: a **capability probe covering BOTH FTS5 and JSON1** (the `where`
  predicate needs `json_extract`); fail fast with a message pointing at
  `Database.setCustomSQLite()` if the platform `libsqlite3` lacks either.
- `engines` pins a minimum Bun version.

`CommitEvent` (the write-seam, covers delete):
```
type CommitEvent =
  | { op: 'create' | 'update'; path: string; content: string }
  | { op: 'delete'; path: string }
```
Runs **inside the per-file lock**, after the fs mutation + the in-lock index
update, before lock release. selgeo hooks git add/rm + commit here
(commit-before-return); machine-spirit no-ops.

## Core modules (public surface)

Leaf (independently testable): `vault-io`, `locked-file`, `frontmatter`,
`links`. `notes`/`query` depend on `index`.

### `vault-io`

`createVaultIo({ root, prefixes })` →
`{ resolveVaultPath, toVaultRelative, toKey, can, readVaultFile, writeVaultFile, rewriteIfUnchanged, unlinkIfUnchanged, stat, listMarkdown }`

- `prefixes: { read: string[]; write: string[] }`. machine-spirit passes
  `read === write ===` its allowlist; selgeo passes `read: ['']` and `write:`
  its direct∪PR set (direct-vs-PR routing is selgeo policy, layered above).
- **Boundary-aware prefix matching (security boundary, pinned):** prefix `P`
  matches path `X` iff `X === P` (exact file) **or** `X` starts with
  `(P with exactly one trailing '/')` (folder containment). `''` matches all.
  Prefixes are canonicalized like paths (NFC, `/`-separated, trailing `/`
  normalized). **`foo` does NOT match `foobar.md`.**
- `resolveVaultPath(rel, access = 'read')` / `can(rel, access)` — reject
  absolute paths, `..` escapes, out-of-allowlist (per access), symlink
  escapes (realpath containment), and non-`.md` targets (the single `.md`
  guard lives here).
- `toVaultRelative(rel)` → canonical display path: strip leading `./`,
  collapse `.`/dup-slashes, force `/`, **NFC**, **case-preserving**.
- `toKey(rel)` → the **lock + index key**. On a **case-insensitive** volume
  (`caseSensitive === false`, default auto-detected) this is the **case-folded**
  (NFC + lowercased) form, so `Note.md` and `note.md` map to **one** lock key
  and **one** index row; the real-cased `toVaultRelative` is kept for IO and
  display. On case-sensitive volumes `toKey === toVaultRelative`.
- `rewriteIfUnchanged(rel, content, sig)` / `unlinkIfUnchanged(rel, sig)` —
  mtime-guarded write / delete, exposed so the consumer's sync decorator has a
  stable seam.
- `listMarkdown(dir?)` — **recursive**; skips dotfolders (`.obsidian`,
  `.trash`, `.git`), non-`.md`, and configured `ignore` globs. The
  machine-spirit `_`/`0`-prefix skip is expressible via `ignore`, not a
  default.

### `locked-file`

`withFileTransform(fullPath, lockKey, transform, opts)` — locked
read → decide → `rewriteIfUnchanged` with **stat→read→stat read-consistency**
+ linear-backoff retry (`maxRetries = 3`, `50ms × (attempt+1)`).

- `opts.allowCreate` (default `false`): false → content for a missing file
  throws `REFUSE_CREATE`; true → create via `atomicWrite` (mkdir -p parent).
- `opts.onCommit(e)` — runs in-lock after write + index update.
- **CAS-like delete** (`withFileDelete(fullPath, lockKey, opts)`): under the
  lock, stat the signature, `unlinkIfUnchanged`; signature mismatch (external
  writer modified/recreated the file) → `MTIME_CONFLICT` (consumer decides);
  missing file → no-op. Index rows dropped in the same lock/transaction;
  `onCommit({op:'delete'})` after.
- If `crossProcessWriterLock`, the in-process lock is wrapped by an `O_EXCL`
  advisory lockfile (per key) with stale-lock recovery.

### `frontmatter`

- `parseFrontmatter(content)` → `{ frontmatter, tags, body, valid }`
  (`valid: 'flat' | 'present-but-invalid' | 'none'`). `uniqueKeys:false`,
  **never throws**.
- `editFrontmatter(content, mutate)` → `{ content, outcome:
  'edited' | 'unchanged' | 'unverifiable' }`. **Multi-field, body-preserving**
  via the YAML **Document/CST API** (`parseDocument` → mutate nodes →
  `String(doc)`) — preserves comments, key order, numeric literals (`1.0`),
  empty values (`aliases:`). Fail-**closed** (`unverifiable`, no write) on
  non-flat / malformed. Subsumes selgeo's `editFrontmatter`; the
  `demoteApprovedOnEdit` *policy* stays in selgeo.
- `assertFlatFrontmatter(fields)` — flat = top-level keys; values scalar or
  array-of-scalar; nested maps rejected.
- `tags` derivation (pinned): frontmatter `tags` (and `tag`); coerce
  scalar | comma/space-string | list → `string[]`; strip leading `#`;
  case-preserving; dedup. Inline `#hashtags` out of scope v1. Same
  normalization applied to query-side tag input.

### `links`

- `extractLinks(content)` → `{ wikilinks, embeds, mdLinks }` (raw targets).
- **Resolution is asymmetric** (the key correctness point):
  - **`'relative'`** (selgeo, Wikilinks OFF): resolve `mdLinks` against the
    source dir → a path. **Stable** — depends only on `(srcDir, target)`, not
    on other notes — so `note_links` stores the **resolved** path.
  - **`'wikilink'`** (machine-spirit): strip `#heading`/`#^block`/`|alias`;
    `note_links` stores the **normalized target** (basename, case-folded),
    **not** a resolved path. Resolution to a concrete note happens **at query
    time** (§query), because it depends on vault state + the tie-break — so a
    target appearing/disappearing/renamed **self-heals** with no need to
    reindex unrelated source notes.
  - Custom `LinkResolver(target, srcDir, kind) => { stored: string }`.

### `notes` (CRUD)

Typed results / typed errors. All **mutations** run inside `withFileTransform`
/ `withFileDelete` keyed by `toKey`, update the index **in the same lock and
SQLite transaction**, then call `onCommit`.

- `readNote(path, { withLinks? })` → `{ frontmatter, tags, body, valid }`;
  `withLinks` adds `{ outbound, backlinks }` (from the index). Missing →
  `NOT_FOUND`.
- `createNote(path, { frontmatter?, body })` — `allowCreate`; **`ALREADY_EXISTS`**
  if present (no clobber); full index INSERT in-lock.
- `updateNote(path, op)` — exactly one of:
  - `{ editByMatch: { old, new } }` — **literal substring**, **non-overlapping**
    count over exact bytes; `NO_MATCH` (0) / `AMBIGUOUS_MATCH` (>1);
    existing-file only.
  - `{ append: string }` — append, create-if-missing (full index INSERT on
    create); newline rule: insert one `\n` before the text iff existing
    non-empty content lacks a trailing newline.
- `editFrontmatter(path, mutate)` — multi-field body-preserving; re-derives
  tags/index in-lock.
- `deleteNote(path)` — **CAS-like** (`withFileDelete`): mtime-guarded unlink +
  index-row drop in one lock/transaction; `MTIME_CONFLICT` if the file changed
  under us; missing → idempotent no-op (no `onCommit`).
- **No full-overwrite mode.**

### `index` (`bun:sqlite`)

```sql
notes(
  id          INTEGER PRIMARY KEY,        -- stable rowid; FTS docid
  path        TEXT NOT NULL,              -- canonical display path (toVaultRelative)
  path_key    TEXT NOT NULL UNIQUE,       -- toKey: case-folded on case-insensitive vols
  mtime_ms    INTEGER NOT NULL,           -- integer ms, exact-equality compare
  size        INTEGER NOT NULL,
  title       TEXT NOT NULL,              -- frontmatter.title → first # H1 → filename
  frontmatter TEXT NOT NULL               -- JSON
);
note_tags(
  path_key TEXT NOT NULL, tag TEXT NOT NULL,
  PRIMARY KEY (path_key, tag)             -- dedup tags per note
);                                        -- index on (tag)
note_links(
  src_key TEXT NOT NULL,                  -- source note key
  target  TEXT NOT NULL,                  -- relative: resolved path_key; wikilink: normalized basename
  kind    TEXT NOT NULL,                  -- 'wikilink' | 'embed' | 'mdlink'
  PRIMARY KEY (src_key, target, kind)     -- distinct edges (no multiplicity)
);                                        -- index on (target) for backlinks
-- standalone FTS5 (stores its own body copy); row addressed by rowid = notes.id:
notes_fts USING fts5(body);               -- INSERT(rowid,body) / DELETE WHERE rowid=? / update=delete+insert
meta(key TEXT PRIMARY KEY, value TEXT);   -- schema_version, last_reconcile_ms
```

- **Standalone FTS5 keyed by `rowid = notes.id`** (not external-content, which
  as previously drafted referenced a `notes.body` column that does not exist).
  A standalone FTS5 table keeps its own copy of `body`, so per-note
  update/delete is `DELETE FROM notes_fts WHERE rowid = ?` (O(1) by docid) —
  no full-table scan, no content-table coupling. Storage grows by ~vault text
  size (acceptable at personal scale).
- `indexNote` / `dropNote` each run in **one synchronous transaction**
  (`db.transaction(...)()`, no awaits inside). Cross-note consistency comes
  from SQLite write-serialization + `busy_timeout`; the per-file lock does not
  span the index.
- **Multi-process** supported (CLI + daemon on one DB): WAL + `busy_timeout` +
  small transactions. Each process keeps its **own** lazy-reconcile TTL clock;
  no cross-process cache invalidation in v1 (a process may serve a ≤TTL-stale
  view of the *other* process's writes — documented, acceptable).

### `query`

- `queryNotes({ tag?, where?, folder?, orderBy?, limit?, offset? })`:
  - `where` = equality map `Record<string, string|number|boolean>`; **values
    always bound (`?`)**; **keys validated** to `[A-Za-z0-9_.-]` and emitted as
    a quoted JSON path `$."key"` (reject/skip invalid keys). All conditions
    plus `tag`/`folder` are AND-ed; missing key = no match. Operators deferred.
    (Frontmatter `where` is an opaque-JSON table scan — fine at low thousands;
    hot fields can get an expression index later.)
  - `folder` = recursive prefix match on `folder + '/'`.
  - `orderBy` = **typed allowlist** `{ field: 'mtime_ms' | 'path' | 'title',
    dir: 'asc' | 'desc' }` (never raw SQL). Default `{ mtime_ms, desc }` then
    `path asc`. Default `limit` capped (documented, ~100).
- `backlinks(path, { limit?, offset? })`:
  - **wikilink mode** — resolve at query time: candidates = `note_links` rows
    whose `target = basename(path)`; a candidate's source is a backlink iff
    `path` is the **tie-break winner** for that basename among existing notes
    (same-folder-as-source first, then shortest path, then lexical). Dangling
    links naturally yield no backlink and **self-heal** when the target note
    appears.
  - **relative mode** — `note_links WHERE target = path_key` (already
    resolved).
- `outboundLinks(path, …)` — `note_links WHERE src_key = ?`; targets resolved
  for display (wikilink: resolve basename→note or mark dangling).
- `searchText(q, { tag?, folder?, limit?, offset? })` — FTS5 keyword. **Input
  sanitized**: tokenize and re-emit each term double-quoted, so raw model text
  (`C++ vs Rust:`, trailing `AND`, unbalanced quote) cannot throw an FTS5
  syntax error — malformed input → empty results, never a raw SQLite throw.
  Default order FTS `rank`; paginated.

## Indexing & reconciliation

The library **owns the correctness schedule**; the project may add a targeted
fast-path.

### ① Internal writes — write-through (in-lock, one transaction)

Updates the affected index rows inside the per-file lock, in one SQLite
transaction, from the already-parsed content. **Not atomic across the two
files** (`.md` + index DB). Ordering & recovery: write the file first; **only
advance the stored `(mtime, size)` if the index transaction commits** — so on
index-write failure the stored signature stays behind and the next reconcile
re-syncs that note. File is source of truth; durability across the two
resources is the reconcile backstop, not a two-phase commit.

### ② External writes — reconcile

Detected by comparing on-disk `(mtime_ms, size)` against stored values.

- **`reconcile()`** — recursive sweep, **parallel/batched `stat`**
  (sequential `await stat` is ~10ms/1000 notes; `Promise.all` ~1ms/1000 — the
  latency claim needs batching). Per changed file, **stat→read→stat**
  read-consistency so the stored signature always matches parsed content.
- **`reconcilePaths(paths)`** — targeted reindex of a known changeset.
- **`rebuild()`** — public: drop all rows, enumerate via `listMarkdown`,
  reindex. First build, corruption, version bump, or post-bulk-edit.

Because **wikilink links are resolved at query time**, adding/removing/renaming
a *target* note does **not** require reindexing the *source* notes that point
at it — only the changed file itself is reindexed, and backlinks re-resolve on
the next query. (Relative-mode targets store resolved paths; a renamed target
leaves the stored link pointing at the old path — that is link-rot in the
source content, correctly reflected, not an index bug.)

**Who drives it:** machine-spirit (opaque `ob`-sync) relies on **lazy
reconcile** (`lazyReconcile:true`). selgeo (git-sync) sets `lazyReconcile:false`
and calls `reconcilePaths(git diff --name-only …)` from **inside its git mutex**
(avoids a sweep reading a file mid-checkout).

### Composition (v1)

1. Write-through on every mutation (in-lock, transactional).
2. **Lazy reconcile before queries**, per-instance TTL (`reconcileTtlMs`),
   **opt-out** via `lazyReconcile:false`. Triggers: `queryNotes`, `backlinks`,
   `outboundLinks`, `searchText`, `readNote({withLinks})`. Runs outside any
   consumer write mutex (relies on never-throws parse + next reconcile for
   torn reads).
3. **Boot build-if-missing** — on `createVault`, if absent / corrupt
   (`integrity_check` / version mismatch) → `rebuild()`. Cold build parses the
   whole vault (seconds on large vaults) — documented; async build is a
   future option.
4. **Watcher: out of scope v1.**

### Edge cases

- **Delete:** drops `notes` + `note_tags` + `note_links` + the FTS row.
- **Rename/move:** delete + add to the sweep.
- **Detection precision:** `mtime_ms` integer, **exact-equality** + `size`. A
  same-`(mtime,size)` content edit is undetectable; a `content_hash` column is
  the documented upgrade. **Assumption to verify:** `ob`/Obsidian-Sync **bumps**
  mtime on synced writes; if it preserves source mtime, promote `content_hash`
  into v1 for machine-spirit.
- **Golden invariant** (testing): a full `rebuild()` equals the incremental
  index **at quiescence, given every change bumps `(mtime, size)`**; the
  mtime-preserving case is the documented gap.

## Error model

The library **throws typed errors** (`MdVaultError` subclasses) with stable
`code`s and English messages; consumers map codes → Russian. Codes:
`ALLOWLIST_VIOLATION`, `NOT_MARKDOWN`, `NOT_FOUND`, `ALREADY_EXISTS`,
`NO_MATCH`, `AMBIGUOUS_MATCH`, `MTIME_CONFLICT`, `REFUSE_CREATE`,
`FRONTMATTER_INVALID`, `INDEX_UNAVAILABLE` (FTS5/JSON1 probe / open failure).

## Runtime & packaging

- **Bun-first.** `bun:sqlite`, `Bun.file`. ESM, `"type":"module"`, `exports` +
  `.d.ts`. No `bin`. MIT. Package `mdvault`. `engines` min Bun.
- **Dependencies:** runtime — `yaml` only. No native addons.
- **Consumers must gitignore** the index DB **and** its `-wal`/`-shm` sidecars.
- **Conventions** (match both repos): Biome single-quote/2-space/grouped
  imports; `type` not `interface`; lazy config; tests in `__tests__/` with
  `spyOn` (**never** `mock.module`); blank line before `return`; module-folder
  split past ~3 exports / one read.

## How the two projects consume it (follow-up, separate specs)

- **machine-spirit:** replace `runtime/vault-io.ts`, `domain/section-edit.ts`,
  `runtime/frontmatter-schema.ts`, `runtime/markdown.ts`. `linkResolution:
  'wikilink'`, `lazyReconcile:true`, no `onCommit`. The in-flight `read_note`/
  `update_note` tools bind `mdvault` CRUD with the persona allowlist +
  `denyPrefixes`; add `query_notes` + `search_notes`. Frontmatter becomes
  writable.
- **selgeo-brain:** replace its ported `vault-io`/`frontmatter`/`markdown`.
  `linkResolution:'relative'`, `lazyReconcile:false`; `onCommit` = git
  add/rm + commit (commit-before-return, now covering delete); drive
  `reconcilePaths` from the pull changeset inside its git mutex. Provenance /
  demote-on-edit stay as selgeo policy over `editFrontmatter`.

## Testing strategy

- **Security:** per-access allowlist escape (`..`, absolute, symlink-out);
  **boundary-aware prefix** (`foo` must NOT match `foobar.md`; `''` matches
  all; exact-file vs folder); `.md`-guard at `resolveVaultPath`; canonical
  key coincidence (`a/./b.md`); NFC; **case-fold key** on a case-insensitive
  volume (`Note.md`/`note.md` → one lock + one row).
- **Concurrency:** mtime-retry + stat→read→stat under a simulated external
  writer; two concurrent appends → no lost update; `allowCreate` branches;
  `onCommit` in-lock for create/update/**delete**; **delete CAS** raises
  `MTIME_CONFLICT` when the file changed under us; cross-process lock (when
  enabled) serializes two processes.
- **CRUD:** edit-by-match literal 0/1/>1; append newline rule; create-clobber
  refusal; `editFrontmatter` preserves comments/order/`1.0`/empty
  `aliases:`/unknown keys, fail-closed on nested; delete idempotent on
  missing.
- **Index/reconcile:** write-through one transaction; stored mtime not
  advanced on index-write failure; `reconcile()` detects add/modify/delete
  with read-consistency; **wikilink self-heal** (dangling `[[Foo]]` resolves
  when `Foo.md` is added, with **no** source reindex); FTS5 delete/update by
  rowid; PK dedup on note_tags/note_links; `rebuild()` from empty; golden
  invariant at quiescence; WAL + `busy_timeout` set; **FTS5 + JSON1 probe**.
- **Query:** tag / `where` (AND, missing-key, **key validation + bound
  values**) / folder (recursive) / backlinks (wikilink tie-break + dangling) /
  outbound / FTS5 with **adversarial input** (`+ - : *`, trailing `AND`,
  unbalanced quote → empty, never throw); **`orderBy` allowlist** rejects
  unknown fields; default order + limit/offset determinism; index in
  `DATA_DIR`, not vault.

## Open source & licensing

MIT, generic-only (domain schemas, personas, sync stay in consuming repos).
Same model as `telegram-agent-kit` (the user's published package that
`selgeo-brain` already depends on). Repo home:
`/Users/ivan_kalinichenko/Dev/Personal/mdvault`.

## Resolved by review (was "open")

- Reconcile ownership; per-access `{read,write}` prefixes; pluggable link
  resolution; tags frontmatter-only + `note_tags` join with PK; graph /
  SearchBackend / Node driver deferred.
- **2nd round:** external-writer claim softened (no file CAS) + optional
  cross-process writer lock; standalone FTS5 keyed by rowid (external-content
  schema was broken); wikilink links stored raw + resolved at query time
  (incremental staleness fix); `onCommit` op-typed (covers delete); delete
  CAS-like; `createVault` async; case-folded key on case-insensitive volumes;
  boundary-aware prefix semantics; `orderBy` allowlist + bound `where`;
  `sqliteBusyTimeoutMs` split from TTL; probe FTS5 **and** JSON1; PKs on
  `note_tags`/`note_links`.

## Open questions (remaining)

1. **`ob`/Obsidian-Sync mtime semantics** — confirm it bumps mtime; if it
   preserves source mtime, `content_hash` moves into v1 for machine-spirit.
2. **qmd adapter location** (v1.1) — project-owned vs sibling `mdvault-qmd`.
3. **Default query `limit`** — pick during implementation (~100).
