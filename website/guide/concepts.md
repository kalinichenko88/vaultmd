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
exposes both `backlinks` (who points here) and `outboundLinks` (where this
points, each with its resolved target or `null` if it dangles).

## Scoped access

Each vault instance carries read/write path allowlists, so queries return only
notes the instance is allowed to read.

See the [API Reference](/api/) for exact signatures.
