# mdvault — foundation design

**Date:** 2026-06-27
**Status:** draft — revised after six review rounds (pending user review)
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
- **Custom `LinkResolver`** (a third link-resolution strategy). v1 ships the
  two built-ins (`'wikilink'`, `'relative'`).

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
  same vault — e.g. machine-spirit's CLI and `serve` daemon): an advisory file
  lock (`crossProcessWriterLock`, **default `true`** — the named CLI+daemon
  topology can have two writers, so safe-by-default) serializes them via an
  `O_EXCL` lockfile. A single-writer deployment may set it `false` to skip the
  per-write lockfile. It does **nothing** for the external syncer
  (uncooperative). **Stale-lock recovery (conservative):** the lockfile records
  `{ pid, host, created_at }`; a held lock is reclaimed **only** when it is
  **same-host and the PID is dead** (`kill(pid, 0)` → `ESRCH`). Otherwise (live
  PID, or a different host) a contender **waits up to `sqliteBusyTimeoutMs`**
  then throws `MTIME_CONFLICT` — it never breaks a lock it cannot prove dead.
  **Location:** lockfiles live beside `indexPath` (in `DATA_DIR`), named by a
  hash of the canonical key — **never inside the vault** (they must not be
  synced by `ob`/git).
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
  linkResolution?: 'wikilink' | 'relative',  // default 'wikilink' (custom resolver: v1.1)
  lazyReconcile?: boolean,           // default true; selgeo sets false
  reconcileTtlMs?: number,           // default 2000 — lazy-reconcile throttle
  sqliteBusyTimeoutMs?: number,      // default 5000 — SQLite contention (independent knob)
  caseSensitive?: boolean,           // default: auto-detect the volume
  crossProcessWriterLock?: boolean,  // default true (Concurrency model); set false only if single writer process
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
- On open: compare **`meta.config_fingerprint`** — a hash of the
  **row-semantics-affecting** config (`linkResolution`, `caseSensitive`, the
  normalized `ignore` set, and the link/tag **parser version**), **not**
  `prefixes` (those are per-scope). On mismatch (or `schema_version`
  mismatch): if this instance owns the whole index (its read scope covers it —
  the recommended per-scope `indexPath`) → `rebuild()`; otherwise (a shared
  index it does not own) → fail fast with `INDEX_UNAVAILABLE` (config
  mismatch).
- `engines` pins a minimum Bun version.

`CommitEvent` (the write-seam, covers delete):
```
type CommitEvent =
  | { op: 'create' | 'update'; path: string; content: string }
  | { op: 'delete'; path: string }
```
Runs **inside the per-file lock**, after the fs mutation + the in-lock index
update, before lock release. selgeo hooks git add/rm + commit here
(commit-before-return); machine-spirit no-ops. **Failure semantics (pinned):**
if `onCommit` throws (e.g. git commit fails), the error is **wrapped as
`COMMIT_FAILED`** (original as `cause`, preserving the typed `MdVaultError`
contract) and **propagates** to the CRUD caller; **no rollback is attempted**
— the file write and the index update already happened and **stay**. The consumer surfaces/recovers; this is
safe by construction because the change is on disk and the consumer's next
sync/reconcile (e.g. selgeo's working-tree recovery on the next
`syncOnce`/boot) picks up the still-uncommitted change. `onCommit` should
therefore be retry-safe.

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
  guard lives here). **Create paths:** the target does not yet exist, so its
  own realpath cannot be checked; instead realpath the **nearest existing
  ancestor** and require **its** containment before allowing the write — this
  closes the symlinked-parent escape (`link/` → outside the vault, then
  creating `link/new.md`).
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
  `.trash`, `.git`), non-`.md`, and configured `ignore` globs. **Does not
  follow symlinked directories that escape the vault root** (realpath-check
  each dir before recursing), and **every discovered `.md` passes
  `resolveVaultPath`** (realpath-containment) before indexing — so a
  symlink-dir-to-outside can never enter the index via `reconcile`/`rebuild`
  and leak through query/search. The machine-spirit `_`/`0`-prefix skip is
  expressible via `ignore`, not a default.

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
  empty values (`aliases:`). **Absent frontmatter** (`valid:'none'`) → a new
  YAML block is **created** at the top of the note (outcome `edited`).
  **Present-but-invalid** (`valid:'present-but-invalid'`) or any non-flat
  result → fail-**closed** (`unverifiable`, no write). Subsumes selgeo's
  `editFrontmatter`; the `demoteApprovedOnEdit` *policy* stays in selgeo.
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
    on other notes — so `note_links` stores the **resolved** path. **Only
    vault-internal `.md` targets are indexed**; dropped: external URLs
    (`http(s):`, `mailto:`, …), bare `#anchor`-only links, images / non-`.md`
    files, absolute paths, and `../` targets that escape the vault root.
  - **`'wikilink'`** (machine-spirit): strip `#heading`/`#^block`/`|alias`;
    `note_links` stores the **normalized raw target** (path-qualification
    preserved — `[[Folder/Foo]]` stays `Folder/Foo`, **not** collapsed to
    `Foo`) **plus** a derived case-folded `base` (basename). It does **not**
    store a resolved path. Resolution happens **at query time** (§query): a
    **path-like** target (contains `/`) resolves directly (exact / relative
    path match); a **bare** target falls back to the basename tie-break. This
    preserves Obsidian's explicit path disambiguation **and** lets a target
    appearing/disappearing/renamed **self-heal** with no reindex of unrelated
    source notes.
  - A **custom `LinkResolver` is deferred to v1.1.** After the move to
    query-time wikilink resolution, a third resolver must participate in both
    *storage* and *query-time backlink/outbound resolution* — a larger
    interface than `{ stored }`. v1 ships only the two fully-implemented
    built-ins (`'wikilink'`, `'relative'`), which cover both consumers.

### `notes` (CRUD)

Typed results / typed errors. All **mutations** run inside `withFileTransform`
/ `withFileDelete` keyed by `toKey`, update the index **in the same lock and
SQLite transaction**, then call `onCommit`.

- `readNote(path, { withLinks? })` → `{ frontmatter, tags, body, valid }`;
  `withLinks` adds `{ outbound, backlinks }` (from the index). Missing →
  `NOT_FOUND`.
- `createNote(path, { frontmatter?, body })` — **exclusive create** for a
  **true** no-clobber guarantee: write a temp file, then `link()` it onto the
  target (atomic; fails `EEXIST` if the target exists) and unlink the temp —
  so an external writer creating the file between check and commit yields
  **`ALREADY_EXISTS`**, never a clobber. (This is the one write that *can* be
  made race-free, unlike update/delete.) Full index INSERT in-lock.
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
  target  TEXT NOT NULL,                  -- relative: resolved path_key; wikilink: normalized raw target (path-qualified or bare)
  base    TEXT,                           -- wikilink bare/tie-break basename (case-folded); NULL for relative
  kind    TEXT NOT NULL,                  -- 'wikilink' | 'embed' | 'mdlink'
  PRIMARY KEY (src_key, target, kind)     -- distinct edges (no multiplicity)
);                                        -- index on (target) AND (base) for backlinks
-- standalone FTS5 (stores its own body copy); row addressed by rowid = notes.id:
notes_fts USING fts5(body);               -- INSERT(rowid,body) / DELETE WHERE rowid=? / update=delete+insert
meta(key TEXT PRIMARY KEY, value TEXT);   -- schema_version, config_fingerprint, last_reconcile_ms
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
- **`indexNote` keeps `notes.id` (the FTS docid) STABLE** — **never**
  `INSERT OR REPLACE` on `notes` (it reassigns `id` and orphans the FTS row).
  Algorithm: `SELECT id FROM notes WHERE path_key=?`; if present →
  `UPDATE notes … WHERE id=?` (in place) + `DELETE FROM notes_fts WHERE
  rowid=id` + `INSERT INTO notes_fts(rowid, body)`; if absent → `INSERT INTO
  notes …` (new id) + FTS insert with that id. `note_tags` / `note_links` for
  the note are replaced by delete-by-key + insert in the same transaction.
- **Multi-process** supported (CLI + daemon on one DB): WAL + `busy_timeout` +
  small transactions. Each process keeps its **own** lazy-reconcile TTL clock;
  no cross-process cache invalidation in v1 (a process may serve a ≤TTL-stale
  view of the *other* process's writes — documented, acceptable).

### `query`

**Read-scope invariant (security boundary).** Every public read/query —
`queryNotes`, `searchText`, `backlinks` (its **source** notes),
`outboundLinks` (its **resolved target** notes), and `readNote` — returns
**only** rows whose `path_key` is inside the Vault's current `prefixes.read`
(boundary-aware `can(_, 'read')`). The library **guarantees** no result
outside the read allowlist, even if the index DB was built with broader
prefixes or is shared across Vault instances / personas. Implementation: a
SQL prefix-range filter on `path_key` (efficient) with `can()` as the
post-filter backstop.

**Pagination contract (pinned, all list/search APIs).** `limit` / `offset`
must be **non-negative integers** — otherwise `VALIDATION_ERROR` (non-integer,
negative, NaN). `limit` omitted → a configured **default** (`~100`); `limit`
above a configured **hard max** (`~1000`) is **clamped** to the max
(documented, not an error). These bounds protect a model-facing surface from
unbounded result sets.

- `queryNotes({ tag?, where?, folder?, orderBy?, limit?, offset? })`:
  - `where` = equality map `Record<string, string|number|boolean>`; **values
    always bound (`?`)**; **keys validated** to `[A-Za-z0-9_.-]` and emitted as
    a quoted JSON path `$."key"`. An invalid key (or unknown `orderBy` field,
    or any malformed query shape) **throws `VALIDATION_ERROR`** — it is
    **never** silently skipped, because dropping a filter would broaden a
    model-facing result set. All conditions plus `tag`/`folder` are AND-ed;
    missing key = no match. Operators deferred.
    (Frontmatter `where` is an opaque-JSON table scan — fine at low thousands;
    hot fields can get an expression index later.)
  - `folder` = recursive prefix match on `folder + '/'`.
  - `orderBy` = **typed allowlist** `{ field: 'mtime_ms' | 'path' | 'title',
    dir: 'asc' | 'desc' }` (never raw SQL). Default `{ mtime_ms, desc }` then
    `path asc`. Default `limit` capped (documented, ~100).
- `backlinks(path, { limit?, offset? })`:
  - **wikilink mode** — resolve at query time, honoring path-qualification
    first: (a) **path-like** links (`target` contains `/`) are a backlink iff
    that target resolves to `path` (exact / relative match); (b) **bare**
    links (`base = basename(path)`) are a backlink iff `path` is the
    **tie-break winner** for that basename among existing notes
    (same-folder-as-source first, then shortest path, then lexical). Dangling
    links yield no backlink and **self-heal** when the target appears.
  - **Read-scoped resolution (security):** the `path` argument and **every
    candidate target** in the tie-break are restricted to `prefixes.read`, so
    an out-of-scope note neither appears as a backlink target nor influences
    an in-scope tie-break (no existence leak; deterministic within scope).
  - **relative mode** — `note_links WHERE target = path_key` (already
    resolved).
- `outboundLinks(path, …)` — `note_links WHERE src_key = ?`; targets resolved
  for display **within `prefixes.read`**: a target resolving to an
  out-of-read-scope note is **not revealed** (shown as dangling/unresolved,
  never as `Secret/Foo.md`). `path` must be in read scope.
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

**Scope-bounding (security).** All destructive index ops are bounded to the
instance's `prefixes.read`: `reconcile()` only inspects / drops rows whose
`path_key` is inside the read scope, and `rebuild()` deletes only rows within
the read scope before reinserting. A restricted Vault instance therefore can
**never** delete another scope's rows, so a shared index DB stays consistent
across multiple scoped instances. **Recommended default:** give each
allowlist-scope its **own** `indexPath` (simplest — destructive ops then own
the whole DB); share one index only when you want a single cross-persona
store, where the scope-bounding above is what keeps it safe.

- **`reconcile()`** — recursive sweep, **parallel/batched `stat`**
  (sequential `await stat` is ~10ms/1000 notes; `Promise.all` ~1ms/1000 — the
  latency claim needs batching). Per changed file, **stat→read→stat**
  read-consistency so the stored signature always matches parsed content.
- **`reconcilePaths(paths)`** — targeted reindex of a known changeset
  (selgeo's git-pull fast-path). For each path **within the read scope**: if it
  exists on disk → `indexNote` (realpath-guarded); if it is **gone**
  (deleted / renamed-away — cannot be realpath'd) → `dropNote` by its
  **syntactic canonical key** (`toKey`) under a boundary-aware `can(_, 'read')`
  check (a drop needs no realpath). Paths outside the read scope are ignored.
- **`rebuild()`** — public: **parse all files first** (enumerate via
  `listMarkdown`, no DB writes yet), then apply `DELETE` **within the read
  scope** + bulk-`INSERT` in **one SQLite transaction**, so WAL readers (same
  or other process) keep
  seeing the **pre-rebuild snapshot** until COMMIT and **never observe an
  empty / partial index**. (Large-vault alternative: build a replacement DB
  file and atomically rename it under a maintenance flag in `meta`.) Used for
  first build, corruption, version bump, or post-bulk-edit.

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
`FRONTMATTER_INVALID`, `VALIDATION_ERROR` (bad query shape / `where` key /
`orderBy` field), `COMMIT_FAILED` (wraps an `onCommit` throw, original as
`cause`), `INDEX_UNAVAILABLE` (FTS5/JSON1 probe / config-fingerprint / open
failure).

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
  **symlinked-parent on create** (`link/` → outside; creating `link/new.md`
  is rejected via nearest-existing-ancestor realpath); **symlinked-dir in
  enumeration** (a vault subdir symlinked outside is **not** followed by
  `listMarkdown`, so its `.md` never enter the index); **boundary-aware
  prefix** (`foo` must NOT match `foobar.md`; `''` matches all; exact-file vs
  folder); **read-scope filter** — `queryNotes`/`searchText`/`backlinks`
  sources/`outboundLinks` targets never return a row outside `prefixes.read`,
  even with an over-broad / shared index; **read-scoped wikilink resolution**
  (an in-scope `[[Foo]]` never resolves to an out-of-scope `Secret/Foo.md`,
  and an out-of-scope note never alters an in-scope tie-break); `.md`-guard at
  `resolveVaultPath`;
  canonical key coincidence (`a/./b.md`); NFC; **case-fold key** on a
  case-insensitive volume (`Note.md`/`note.md` → one lock + one row).
- **Concurrency:** mtime-retry + stat→read→stat under a simulated external
  writer; two concurrent appends → no lost update; `allowCreate` branches;
  `onCommit` in-lock for create/update/**delete**; **`onCommit` throw →
  `COMMIT_FAILED` with `cause`**; **delete CAS** raises `MTIME_CONFLICT` when
  the file changed under us; cross-process lock serializes two processes and
  **reclaims only a dead same-host PID** (live/foreign PID → wait then
  `MTIME_CONFLICT`); **lockfiles live in `DATA_DIR`, never in the vault**.
- **CRUD:** edit-by-match literal 0/1/>1; append newline rule; **`createNote`
  exclusive create** (concurrent external create → `ALREADY_EXISTS`, no
  clobber); `editFrontmatter` preserves comments/order/`1.0`/empty
  `aliases:`/unknown keys, **creates a block when frontmatter absent**,
  fail-closed on present-but-invalid/nested; delete idempotent on missing.
- **Index/reconcile:** write-through one transaction; stored mtime not
  advanced on index-write failure; `reconcile()` detects add/modify/delete
  with read-consistency; **wikilink self-heal** (dangling `[[Foo]]` resolves
  when `Foo.md` is added, with **no** source reindex); **path-qualified
  wikilink** (`[[Folder/Foo]]` resolves to `Folder/Foo`, not a basename
  tie-break); **relative-mode link filtering** (external URLs / bare
  `#anchor` / images / non-`.md` / absolute / `..`-escape dropped); FTS5
  delete/update by rowid; **`notes.id` stable across re-index** (no
  `INSERT OR REPLACE`; FTS not orphaned after update); **`reconcilePaths`
  drops a deleted in-scope path** by syntactic key; PK dedup on
  note_tags/note_links;
  **`rebuild()` never exposes a partial index** to a concurrent reader
  (single-transaction swap); **`onCommit` throw propagates, file+index stay
  changed, no rollback**; `rebuild()` from empty; golden invariant at
  quiescence; **scope-bounded destructive ops** (a restricted instance's
  `reconcile()`/`rebuild()` never drops another scope's rows); **config
  fingerprint mismatch** (different `linkResolution`/`caseSensitive`/parser
  version) → owner rebuilds, shared non-owner fails `INDEX_UNAVAILABLE`; WAL +
  `busy_timeout` set; **FTS5 + JSON1 probe**.
- **Query:** tag / `where` (AND, missing-key, **invalid key throws
  `VALIDATION_ERROR`**, bound values) / folder (recursive) / backlinks
  (wikilink tie-break + dangling) / outbound / FTS5 with **adversarial input**
  (`+ - : *`, trailing `AND`, unbalanced quote → empty, never throw);
  **`orderBy` allowlist** rejects unknown fields (`VALIDATION_ERROR`);
  **pagination bounds** (negative / non-integer `limit`/`offset` →
  `VALIDATION_ERROR`; oversized `limit` clamped to hard max); default order +
  limit/offset determinism; index in `DATA_DIR`, not vault.

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
- **3rd round:** read-scope invariant on all queries / backlink-sources /
  outbound-targets (no cross-persona leak from an over-broad/shared index);
  symlinked-parent escape closed on create (nearest-existing-ancestor
  realpath); path-qualified wikilinks preserved (raw target + derived
  `base`); `rebuild()` atomic single-transaction swap (no partial-index
  reads); `onCommit` failure pinned (propagate, no rollback, consumer
  recovers).
- **4th round:** destructive ops (`reconcile`/`rebuild`) **scope-bounded** to
  `prefixes.read` (a restricted instance can't drop another scope's rows) +
  per-scope `indexPath` recommended; `createNote` exclusive (`link()`-based)
  true no-clobber; `crossProcessWriterLock` **defaults `true`**; invalid query
  shape **throws `VALIDATION_ERROR`** (no silent broadening); custom
  `LinkResolver` deferred to v1.1; `editFrontmatter` on absent frontmatter
  creates a block.
- **5th round:** `meta.config_fingerprint` (linkResolution / caseSensitive /
  ignore / parser version, **not** prefixes) → rebuild-or-fail on mismatch;
  query-time wikilink resolution **read-scoped** (no resolve to / tie-break by
  out-of-scope notes); `onCommit` throw wrapped as `COMMIT_FAILED` (typed,
  with `cause`); relative-mode link filtering pinned (URLs / anchors / images
  / non-`.md` / absolute / `..`-escape dropped); conservative cross-process
  stale-lock criteria (reclaim only a dead same-host PID).
- **6th round:** `listMarkdown` won't follow vault-escaping symlinked dirs +
  every enumerated `.md` realpath-guarded; `reconcilePaths` deleted-path
  handling (drop by syntactic key within read scope); FTS docid-stability
  algorithm pinned (no `INSERT OR REPLACE`; select-id → update-in-place → FTS
  delete+insert by same rowid); lockfiles in `DATA_DIR` not the vault;
  pagination bounds (default + hard-max clamp; invalid → `VALIDATION_ERROR`).

## Open questions (remaining)

1. **`ob`/Obsidian-Sync mtime semantics** — confirm it bumps mtime; if it
   preserves source mtime, `content_hash` moves into v1 for machine-spirit.
2. **qmd adapter location** (v1.1) — project-owned vs sibling `mdvault-qmd`.
3. **Default query `limit`** — pick during implementation (~100).
