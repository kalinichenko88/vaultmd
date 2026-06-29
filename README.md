# vaultmd

> A headless markdown-vault data layer for [Bun](https://bun.sh) — CRUD over `.md` notes plus a derived SQLite index for collection queries, backlinks, and full-text search. No Obsidian, no Electron, no plugin.

[![npm](https://img.shields.io/badge/npm-vaultmd-cb3837?logo=npm)](https://www.npmjs.com/package/vaultmd)
[![runtime: Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.1-f9f1e1?logo=bun)](https://bun.sh)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![status: published](https://img.shields.io/badge/status-published-brightgreen.svg)](#status)
[![docs](https://img.shields.io/badge/docs-vaultmd-3451b2.svg)](https://kalinichenko88.github.io/vaultmd/)

📖 **[Documentation & API reference](https://kalinichenko88.github.io/vaultmd/)**

`vaultmd` is an npm package that gives your Bun app a programmatic data layer
over a folder of markdown notes. Your `.md` files on disk stay the **single
source of truth**; vaultmd maintains a rebuildable `bun:sqlite` index alongside
them so you can query notes by tag or frontmatter, walk backlinks, and run
keyword search — all without an editor, sync engine, or background daemon.

It's the engine, not the app: generic vault mechanics only. Personas, domain
schemas, and sync logic live in whatever you build on top.

## Status

Released (`0.1.0`) — the first published version is live on npm. The public API
is frozen and tested, and the package ships as a bundled `dist/` (ESM + types).
Being `0.x`, the surface may still evolve before `1.0`; see
[CHANGELOG.md](./CHANGELOG.md) for what changed.

## Features

- **CRUD over markdown** — create, read, update, delete `.md` notes with flat
  YAML frontmatter.
- **Derived SQLite index** — a rebuildable cache, never the source of truth.
  Delete it and it rebuilds from disk.
- **Collection queries** — filter notes by tag, frontmatter field, or folder;
  order and paginate.
- **Backlinks & outbound links** — `[[wikilink]]` or relative-link resolution.
- **Full-text search** — keyword search over note bodies (SQLite FTS5) with
  highlighted snippets.
- **Write-through indexing** — every mutation updates the index inside the same
  per-file lock as the file write; the two never drift.
- **Concurrency-safe** — in-process mutex plus optional cross-process lockfiles
  guard concurrent writers.
- **Scoped access** — per-instance read/write path allowlists make it safe to
  hand different parts of the vault to different consumers.
- **TypeScript-first** — full types, a small frozen public surface, and lower
  level primitives exported for advanced use.

## Requirements

- **[Bun](https://bun.sh) ≥ 1.1.0.** vaultmd uses `bun:sqlite`, `Bun.file`, and
  other Bun built-ins — it does **not** run under Node.

## Install

```bash
bun add vaultmd
```

## Quick start

```ts
import { createVault } from 'vaultmd';

const vault = await createVault({
  root: '/path/to/vault',
  // Read everything, but only write under Notes/.
  prefixes: { read: [''], write: ['Notes/'] },
  // The index db lives in a DATA dir, NOT inside the synced vault.
  indexPath: './data/vault-index.db',
});

// Create a note with frontmatter + body.
await vault.notes.createNote('Notes/today.md', {
  frontmatter: { tags: ['project', 'daily'], status: 'open' },
  body: '# Today\n\nSee [[roadmap]] for context.\n',
});

// Query the collection.
const open = vault.query.queryNotes({
  tag: 'project',
  where: { status: 'open' },
  orderBy: { field: 'mtime_ms', dir: 'desc' },
  limit: 20,
});

// Walk the link graph.
const incoming = vault.query.backlinks('Notes/roadmap.md');

// Full-text search.
const hits = vault.query.searchText('context');

// Append to a note (atomic, write-through indexed).
await vault.notes.updateNote('Notes/today.md', { append: '\n- shipped readme' });

vault.close();
```

## Concepts

**Files are the source of truth; the index is a cache.** Every note is a plain
`.md` file you can edit by hand, sync with git or Dropbox, or open in any editor.
The SQLite index is derived from those files and can be rebuilt at any time
(`vault.rebuild()`), so it never has to be backed up or trusted over disk.

**Read/write scopes.** `prefixes.read` and `prefixes.write` are path-prefix
allowlists. An empty string (`''`) means "the whole vault". Queries only ever
return notes the instance is allowed to read; writes are rejected outside the
write scope. This is the security chokepoint — all path canonicalization and
containment checks live behind it.

**Write-through indexing.** `createNote`, `updateNote`, `editFrontmatter`,
`transformNote`, and `deleteNote` update the index *inside the same per-file
lock* as the file write.
The file and its index row are never updated in separate transactions, so a
crash can't leave them disagreeing.

**Lazy reconcile.** Reads stay synchronous. The first read (and the first after
each TTL window) fires a single background sweep that picks up any out-of-band
edits — files you changed in your editor while the process was running. The
result is visible to the *next* read; a failed sweep never breaks a read.

**Index location.** The `.db` file and its `-wal` / `-shm` sidecars must live in
a data directory **outside** the synced vault, and stay gitignored (`*.db*`).
Never let the cache get synced as if it were content.

## API

The only public entry point is `createVault`. Everything below hangs off the
`Vault` it returns.

### `createVault(config): Promise<Vault>`

| Option                   | Type                                   | Default      | Description                                                                 |
| ------------------------ | -------------------------------------- | ------------ | --------------------------------------------------------------------------- |
| `root`                   | `string`                               | *(required)* | Absolute path to the vault directory.                                       |
| `prefixes`               | `{ read: string[]; write: string[] }`  | *(required)* | Read/write path-prefix allowlists (`''` = whole vault).                     |
| `indexPath`              | `string`                               | *(required)* | Where the SQLite index lives. Keep it **out** of the vault.                 |
| `caseSensitive`          | `boolean`                              | *(auto)*     | Override filesystem case sensitivity detection.                             |
| `ignore`                 | `string[]`                             | `[]`         | Glob patterns to exclude from indexing.                                     |
| `linkResolution`         | `'wikilink' \| 'relative'`             | `'wikilink'` | How links are extracted and resolved.                                       |
| `lazyReconcile`          | `boolean`                              | `true`       | Fire background reconcile sweeps on read.                                   |
| `reconcileTtlMs`         | `number`                               | `2000`       | Minimum gap between lazy sweeps.                                            |
| `sqliteBusyTimeoutMs`    | `number`                               | `5000`       | SQLite busy timeout / cross-process lock wait.                              |
| `crossProcessWriterLock` | `boolean`                              | `true`       | Guard writes with cross-process lockfiles.                                  |
| `onCommit`               | `(e: CommitEvent) => void \| Promise`  | —            | Hook fired after each committed mutation (e.g. to mirror changes upstream). |

### `vault.notes`

```ts
// Read a note; pass { withLinks: true } to include outbound + backlinks.
readNote(path, opts?: { withLinks?: boolean }): Promise<ReadNoteResult>

// Create a note. Throws ALREADY_EXISTS rather than clobbering.
createNote(path, input: { frontmatter?: Record<string, unknown>; body: string }): Promise<void>

// Mutate body: append text, or replace an exact, unambiguous match.
updateNote(path, op: { append: string } | { editByMatch: { old: string; new: string } }): Promise<void>

// Edit flat frontmatter via a mutator callback. Returns 'edited' | 'unchanged' | 'unverifiable'.
editFrontmatter(path, mutate: (fm: Record<string, unknown>) => void): Promise<EditOutcome>

// Transform a note's FULL content atomically. Return new content, or null for a
// no-op. Never creates a missing file (throws REFUSE_CREATE). The callback must
// be pure — it is re-invoked on write contention. Returns 'edited' | 'unchanged'.
transformNote(path, transform: (current: string | null) => string | null): Promise<TransformOutcome>

// Delete a note. Returns whether a file was actually removed.
deleteNote(path): Promise<boolean>
```

`ReadNoteResult` is `{ frontmatter, tags, body, valid, outbound?, backlinks? }`,
where `valid` is `'flat' | 'present-but-invalid' | 'none'`.

### `vault.query`

```ts
// Filter the collection. Returns NoteHit[] = { path, title, frontmatter, tags }[].
queryNotes(opts?: {
  tag?: string;
  where?: Record<string, string | number | boolean>; // frontmatter equality
  folder?: string;
  orderBy?: { field: 'mtime_ms' | 'path' | 'title'; dir: 'asc' | 'desc' };
  limit?: number;
  offset?: number;
}): NoteHit[]

// Notes linking TO this path. Returns { from: string }[].
backlinks(path, opts?: { limit?: number; offset?: number }): Backlink[]

// Links FROM this path. Returns { target, resolved }[] (resolved is null if dangling).
outboundLinks(path, opts?: { limit?: number; offset?: number }): OutboundLink[]

// Full-text keyword search over bodies. Returns { path, title, snippet? }[].
searchText(q, opts?: { tag?: string; folder?: string; limit?: number; offset?: number }): SearchHit[]
```

### Lifecycle

```ts
vault.reconcile(): Promise<void>            // full sweep now (vs. lazy)
vault.reconcilePaths(rels: string[]): Promise<void>  // reconcile specific paths
vault.rebuild(): Promise<void>              // drop & rebuild the index from disk
vault.close(): void                         // close the db handle
```

### Lower-level primitives

For advanced use, the package also exports the building blocks `createVault`
assembles — the IO chokepoint, atomic locked-file transforms, and the pure
frontmatter / link parsers:

```ts
import {
  createVaultIo,           // path → safe-IO security layer
  withFileTransform,       // atomic compare-and-swap file edit
  withFileDelete,          // atomic delete with commit hook
  parseFrontmatter,        // pure flat-YAML frontmatter parser
  editFrontmatter,         // pure frontmatter editor
  isFlatFrontmatter,
  deriveTags,
  extractLinks,            // pull wikilinks / relative links from text
  storedLinksFor,
} from 'vaultmd';
```

### Error handling

Every failure throws an `MdVaultError` carrying a stable `code`. Catch and
switch on `err.code`, never on the message:

```ts
import { MdVaultError } from 'vaultmd';

try {
  await vault.notes.createNote('Notes/today.md', { body: '...' });
} catch (err) {
  if (err instanceof MdVaultError && err.code === 'ALREADY_EXISTS') {
    // handle the clash
  } else {
    throw err;
  }
}
```

Codes: `ALLOWLIST_VIOLATION`, `NOT_MARKDOWN`, `NOT_FOUND`, `ALREADY_EXISTS`,
`NO_MATCH`, `AMBIGUOUS_MATCH`, `MTIME_CONFLICT`, `REFUSE_CREATE`,
`FRONTMATTER_INVALID`, `VALIDATION_ERROR`, `COMMIT_FAILED`, `INDEX_UNAVAILABLE`.

## Development

```bash
bun install
bun test            # full suite
bun run check       # biome check . && tsc --noEmit — the authoritative gate
bun run format      # biome format --write .
```

Run `bun run check` before sending a change; it's green/red, not advisory.

## License

[MIT](./LICENSE) © Ivan Kalinichenko
