# Concepts

## The vault and its derived index

`createVault` wires four layers: the **IO chokepoint** (`vault.io`), the derived
**SQLite index**, the **query** surface, and the **notes** CRUD surface. The
index is a cache — delete the database file and it rebuilds from the `.md` files.

## Write-through indexing

Every mutation updates the index inside the **same per-file lock** as the file
write, so a note and its index row never drift. Concurrency is guarded by an
in-process mutex plus optional cross-process lockfiles.

## Links

Links are extracted as `[[wikilink]]` or relative links and resolved
asymmetrically via `linkResolution: 'wikilink' | 'relative'`. `vault.query`
exposes `backlinks` (who points here), `outboundLinks` (where this points, each
with its resolved target or `null`), and `danglingLinks` (the vault-wide sweep
for links that resolve to nothing).

`outboundLinks` reports **raw** resolution: a link to an attachment such as
`[[diagram.png]]` comes back `resolved: null`, because nothing outside `.md` is
indexed. That is not breakage, so `danglingLinks` filters those out — read
`resolved: null` as "not a note in this vault", not as "broken".

## Scoped access

Each vault instance carries read/write path allowlists (`prefixes.read` /
`prefixes.write`, where `''` means the whole vault). Queries return only notes
the instance is allowed to read, and writes outside the write scope throw
`ALLOWLIST_VIOLATION`. This is the security chokepoint — all path
canonicalization, `..`-escape rejection, and symlink containment live behind it.

## Lazy reconcile

Reads stay synchronous. The first read — and the first after each
`reconcileTtlMs` window — fires one background sweep that picks up out-of-band
edits (files you changed in your editor while the process was running). Its
result is visible to the *next* read, and a failed sweep never breaks a read.
Need it now instead? Call `vault.reconcile()`, `vault.reconcilePaths([...])`, or
`vault.rebuild()` to drop and rebuild the index from disk.

## Index location

The index `.db` and its `-wal` / `-shm` sidecars must live in a data directory
**outside** the synced vault, and stay gitignored. Never let the cache get
synced as if it were content — it is derived state, rebuildable at any time.

## Errors

Every failure throws an `MdVaultError` carrying a stable `code`. Branch on
`err.code`, never on the message:

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

See the [API Reference](/api/) for exact signatures.
