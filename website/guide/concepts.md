# Concepts

How VaultMD behaves, and why. Signatures for everything named here live in the
[API Reference](/api/).

## The vault and its derived index

[`createVault`](/api/functions/createVault) wires four layers: the **IO
chokepoint** (`vault.io`), the derived **SQLite index**, the **query** surface,
and the **notes** CRUD surface. The index is a cache — delete the database file
and it rebuilds from the `.md` files. What it hands back is a
[`Vault`](/api/type-aliases/Vault); what it takes is a
[`CreateVaultConfig`](/api/type-aliases/CreateVaultConfig).

## Write-through indexing

Every mutation updates the index inside the **same per-file lock** as the file
write, so a note and its index row never drift. Concurrency is guarded by an
in-process mutex plus optional cross-process lockfiles. The mutating calls are
on [`NotesApi`](/api/type-aliases/NotesApi).

## Links

Links are extracted as `[[wikilink]]` or relative links and resolved
asymmetrically via `linkResolution: 'wikilink' | 'relative'` — see
[`LinkResolution`](/api/type-aliases/LinkResolution).
[`vault.query`](/api/type-aliases/QueryApi) exposes `backlinks` (who points
here), `outboundLinks` (where this points, each with its resolved target or
`null`), and `danglingLinks` (the vault-wide sweep for links that resolve to
nothing).

`outboundLinks` reports **raw** resolution: a link to an attachment such as
`[[diagram.png]]` comes back `resolved: null`, because nothing outside `.md` is
indexed. That is not breakage, so `danglingLinks` filters those out — read
`resolved: null` as "not a note in this vault", not as "broken".

### The rest of the graph

Three more views cover what links alone cannot say. `orphanNotes` finds notes
with no place in the graph — by default notes with no links in either
direction, Obsidian's graph "Orphans" filter, or with `mode: 'unreferenced'`
the wider set of notes nothing links *to*. `unlinkedMentions` and
`outboundMentions` are the prose counterparts of `backlinks` and
`outboundLinks`: notes that name each other without linking. A note answers to
its filename, an explicitly authored frontmatter `title`, and its `aliases`;
one that already links is reported as a link, never as a mention.

Mention matching is case-insensitive and needs a word boundary, so `cat` is
never found inside `catalogue`. That boundary is also the limit: a name
embedded in **unsegmented text — Chinese and Japanese prose, written without
spaces — is not found**, only occurrences delimited by spaces or punctuation.
Obsidian does find those; matching them here needs a different FTS tokenizer,
which is a change to the index schema rather than to these methods.

## Scoped access

Each vault instance carries read/write path allowlists
([`prefixes.read` / `prefixes.write`](/api/type-aliases/VaultPrefixes), where
`''` means the whole vault). Queries return only notes the instance is allowed
to read, and writes outside the write scope throw
`ALLOWLIST_VIOLATION`. This is the security chokepoint — all path
canonicalization, `..`-escape rejection, and symlink containment live behind it.

The scope covers enumeration too — `vault.io.listMarkdown` and
`vault.io.listFolders` ([`VaultIo`](/api/type-aliases/VaultIo)) walk the vault
and report only what this instance may read, minus dot-folders and anything the
`ignore` globs match.

## Lazy reconcile

Reads stay synchronous. The first read — and the first after each
`reconcileTtlMs` window — fires one background sweep that picks up out-of-band
edits (files you changed in your editor while the process was running). Its
result is visible to the *next* read, and a failed sweep never breaks a read.
Need it now instead? Call `vault.reconcile()`, `vault.reconcilePaths([...])`, or
`vault.rebuild()` to drop and rebuild the index from disk.

Reconcile is how those edits arrive, and it is the *only* way they arrive: there
is no watcher and no daemon. The `onCommit` hook is not a change feed — it
reports writes made through this vault instance, so an edit from your editor,
`git checkout`, or a sync client updates the index silently, with no event.

What `reconcile()` returns is the substitute for that event. It reports every
path that changed since your last call, so a live view polls one call instead of
diffing query results:

```ts
const { added, updated, removed } = await vault.reconcile();
```

See [`ReconcileResult`](/api/type-aliases/ReconcileResult) for the exact shape.

All three are sorted vault-relative paths, and all three are empty when nothing
has changed. *Since your last call* is the important part: background sweeps
fired by reads change the index too, and their findings are buffered until you
drain them, so a change is never lost to whichever sweep happened to reach it
first. Writes made through `notes` are indexed write-through, so they never show
up here — they already fired `onCommit`.

## Index location

The index `.db` and its `-wal` / `-shm` sidecars must live in a data directory
**outside** the synced vault, and stay gitignored. Never let the cache get
synced as if it were content — it is derived state, rebuildable at any time.

## Errors

Every failure throws an [`MdVaultError`](/api/classes/MdVaultError) carrying a
stable [`code`](/api/type-aliases/MdVaultCode). Branch on
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
