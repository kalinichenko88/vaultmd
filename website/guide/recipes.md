# Recipes

## Query notes by tag and frontmatter

```ts
const recent = vault.query.queryNotes({
  tag: 'project',
  where: { status: 'active' },
  orderBy: { field: 'mtime_ms', dir: 'desc' },
  limit: 20,
});
```

## Filter on ranges, sets and missing fields

A `where` value is an equality test when it is a scalar, and an operator object
otherwise. Everything given — across keys and within one key — is AND-ed.

```ts
const overdue = vault.query.queryNotes({
  where: {
    due: { lt: '2026-08-01' },        // ranges: lt / lte / gt / gte
    kind: { in: ['task', 'bug'] },    // set membership
    status: { ne: 'done' },           // negation
    archived: { exists: false },      // no such frontmatter field
  },
});
```

Comparisons run over the indexed frontmatter JSON and follow SQLite's type
ordering, so compare strings with strings and numbers with numbers — ISO dates
sort correctly as strings. This matters most for `ne`: SQLite holds values of
differing types to be never equal, so `{ ne: '5' }` against a numeric field
excludes nothing and quietly returns everything.

`ne` also matches notes that never set the field at all, since "unset" is not
the value. Require the field alongside it: `{ ne: 'done', exists: true }`.

A malformed filter throws `VALIDATION_ERROR` rather than degrading into a
wrong-but-plausible result — a non-scalar operand, a non-boolean `exists`, a
non-array tag list, or an operator object with nothing left to apply (`{}`, or
`{ lt: cutoff }` where `cutoff` came in `undefined`, which would otherwise drop
the filter and return the whole vault). To match nothing on purpose, use
`{ in: [] }`.

## Match several tags at once

`tag` is the one-tag shorthand; `tags` takes a set. `all` requires every tag,
`any` requires at least one, and both may be combined.

```ts
// tagged #project AND #active, and at least one of #q3 / #q4
const active = vault.query.queryNotes({
  tags: { all: ['project', 'active'], any: ['q3', 'q4'] },
});
```

`tag`, `tags`, `where` and `folder` make up `NoteFilter`, which every note
reader accepts — so the same filter narrows a keyword search:

```ts
const hits = vault.query.searchText('deadline', {
  tags: { all: ['project'] },
  where: { status: { ne: 'done' } },
});
```

## Paginate a collection

`queryNotes` returns one page; `countNotes` takes the same filters and returns
the uncapped total, so the page count is exact.

```ts
const filters = { tag: 'project', where: { status: 'active' } };
const pageSize = 20;

const page = vault.query.queryNotes({ ...filters, limit: pageSize, offset: 40 });
const pages = Math.ceil(vault.query.countNotes(filters) / pageSize);
```

`countSearch(q, opts)` does the same job for `searchText`.

## Show when a note last changed

Every `NoteHit` carries the `mtime_ms` and `size` recorded in the index — the
same `mtime_ms` that `orderBy` sorts on, so no extra `stat` per row.

```ts
for (const hit of vault.query.queryNotes({ limit: 10 })) {
  console.log(hit.path, new Date(hit.mtime_ms).toISOString(), hit.size);
}
```

## Find links that resolve to nothing

`moveNote` relocates a note byte-for-byte and never rewrites inbound links, so
renaming a note can leave `[[Old Name]]` pointing at nothing. `danglingLinks`
is the vault-wide sweep for that — run it after a rename, or on a schedule.

```ts
await vault.notes.moveNote('Notes/old-name.md', 'Notes/new-name.md');

for (const { from, target } of vault.query.danglingLinks()) {
  console.log(`${from} → [[${target}]] resolves to nothing`);
}
```

Links naming an attachment file type — `[[diagram.png]]`, `![[notes.pdf]]`,
embedded or not — are excluded: they can never resolve to a `.md` note, so they
are not breakage. Note this makes `danglingLinks` stricter than
`outboundLinks`, which reports raw resolution and returns `resolved: null` for
those same links.

## Reconnect the notes nothing points at

A note nobody links to is invisible to the graph, but it is rarely unrelated to
anything — usually someone wrote its name in prose and never made it a link.
`orphanNotes` finds the first half, `unlinkedMentions` the second.

```ts
for (const note of vault.query.orphanNotes()) {
  const mentions = vault.query.unlinkedMentions(note.path);
  if (mentions.length === 0) {
    console.log(`${note.path} — nothing references it, in links or prose`);
    continue;
  }
  for (const { path, snippet } of mentions) {
    console.log(`${note.path} ← named in ${path}: ${snippet}`);
  }
}
```

The default `orphanNotes()` is Obsidian's graph "Orphans" filter — notes with
no links in either direction. Pass `mode: 'unreferenced'` for the wider set of
notes nothing links *to*, however many links they make themselves; that is the
one you want when hunting for pages that dropped out of navigation.

Going the other way, `outboundMentions` reads one note and reports the notes it
names without linking — the write-up pass after drafting:

```ts
for (const { path, snippet } of vault.query.outboundMentions('Journal/today.md')) {
  console.log(`could link ${path}: ${snippet}`);
}
```

Neither method rewrites anything. Turning a mention into a link is a
`notes.updateNote` call you make deliberately, because only you know whether
the sentence meant that note.

## Create a note only if it is not there yet

```ts
if (await vault.notes.exists('Notes/today.md')) {
  await vault.notes.updateNote('Notes/today.md', { append: '\n- another entry' });
} else {
  await vault.notes.createNote('Notes/today.md', { body: '# Today\n' });
}
```

## Import a few thousand notes

Every mutator locks on the note's own path, so writes to *different* notes never
contend — a bulk import is bound by filesystem syscalls, not by the lock. A
serial `for await` loop leaves that on the table; a bounded pool over the same
`createNote` roughly halves the wall-clock.

```ts
async function importAll(
  entries: Array<{ path: string; body: string }>,
  concurrency = 32,
) {
  const queue = [...entries];
  const failed: Array<{ path: string; error: unknown }> = [];

  const worker = async () => {
    for (let entry = queue.pop(); entry; entry = queue.pop()) {
      try {
        await vault.notes.createNote(entry.path, { body: entry.body });
      } catch (error) {
        // One unwritable note must not sink the other 4999.
        failed.push({ path: entry.path, error });
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  return failed;
}
```

Keep the pool bounded. An unbounded `Promise.all` over a few thousand entries
holds a file descriptor per in-flight write and will hit `EMFILE`.

If the importing process is the only writer on the machine, opening the vault
with `crossProcessWriterLock: false` drops a lockfile create + unlink from every
note as well. Turn it back on for normal operation — it is what keeps a second
process from writing the same note underneath you.

## Reuse existing tags instead of inventing new ones

`tags()` returns every tag on readable notes with its use count, most-used
first. `prefix` navigates a hierarchy (case-sensitive), `contains` is an ASCII
case-insensitive substring search. Unlike the paginated queries it has no
default cap — pass `limit` for a top-N.

```ts
const top = vault.query.tags({ limit: 10 });
const projects = vault.query.tags({ prefix: 'project/' });
```

## Rename a tag across the vault

There is no `retag(from, to)` — it is `queryNotes({ tag })` plus one
`editFrontmatter` per note. Reuse `deriveTags` for the read side so the
tokenising rules stay the package's, not yours: it reads whichever of `tags` /
`tag` the note uses, splits strings on whitespace and commas, and strips leading
`#`.

```ts
import { deriveTags } from 'vaultmd';

async function renameTag(from: string, to: string) {
  // Collect first. Each rename drops the note out of `tag: from`, so walking
  // the offsets while mutating would step over half the matches.
  const paths: string[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = vault.query.queryNotes({ tag: from, limit: 100, offset });
    paths.push(...page.map((hit) => hit.path));
    if (page.length < 100) {
      break;
    }
  }

  const skipped: string[] = [];
  for (const path of paths) {
    const outcome = await vault.notes.editFrontmatter(path, (fm) => {
      const tags = deriveTags(fm);
      if (!tags.includes(from)) {
        return; // index was stale — leave the note alone
      }
      fm[fm.tags !== undefined ? 'tags' : 'tag'] = tags.map((t) =>
        t === from ? to : t,
      );
    });
    if (outcome === 'unverifiable') {
      skipped.push(path);
    }
  }

  return skipped;
}
```

Two things this does on purpose. Writing `deriveTags` output back **normalises**
the note's tag formatting — `tags: "work, #inbox"` becomes a two-element list —
which makes the operation idempotent but is a visible diff on notes you did not
otherwise touch. And `'unverifiable'` notes are collected rather than forced:
their frontmatter can't round-trip safely — a `Date`, a non-finite number, or a
shared container reference — so `editFrontmatter` refuses instead of risking
data loss. Rewrite those by hand.

## Edit frontmatter and body in one atomic commit

`transformNote` runs a whole-note transform inside the per-file lock, so a
combined frontmatter + body change lands as a single write and a single index
update. Return `null` for a no-op. The callback is **re-invoked** on write
contention, so keep it pure — and it never creates a missing note
(`REFUSE_CREATE`).

```ts
const outcome = await vault.notes.transformNote('Notes/today.md', (current) => {
  if (current === null || current.includes('status: done')) {
    return null; // 'unchanged'
  }

  return current.replace('status: open', 'status: done') + '\n- closed out\n';
});
```

## Mirror every committed change

`onCommit` fires after each committed mutation — `{ op: 'create' | 'update',
path, content }` or `{ op: 'delete', path }` (a `moveNote` emits `delete` then
`create`). Anything it throws surfaces as `COMMIT_FAILED` *after* the file write
has already landed, so treat it as best-effort mirroring, not a veto. It mirrors
only this instance's own writes — out-of-band edits reach the index through
[lazy reconcile](./concepts#lazy-reconcile), without firing the hook.

```ts
const vault = await createVault({
  root: '/path/to/vault',
  prefixes: { read: [''], write: ['Notes/'] },
  indexPath: './data/vault-index.db',
  onCommit: (e) => {
    console.log(e.op, e.path);
  },
});
```

## Poll for edits made outside the vault

`reconcile()` returns every path that changed since your last call, which makes
it a watcher-free change feed for edits VaultMD did not make — your editor,
`git checkout`, a sync client. Empty arrays mean nothing has changed. Reads fire
their own background sweeps, but those buffer their findings rather than
consuming them, so polling works with lazy reconcile left on.

```ts
setInterval(async () => {
  const { added, updated, removed } = await vault.reconcile();
  if (added.length || updated.length || removed.length) {
    console.log('vault changed', { added, updated, removed });
  }
}, 5_000);
```

Notes written through `vault.notes` are indexed write-through, so they never
appear here — use `onCommit` for those.

## Rewrite a body, keep the frontmatter

`setBody` replaces everything after the frontmatter block and leaves the block
itself untouched; `prepend` inserts at the top of the body, never above the
frontmatter.

```ts
await vault.notes.updateNote('Notes/today.md', { prepend: '- newest first\n' });
await vault.notes.updateNote('Notes/draft.md', { setBody: '# Rewritten\n' });
```

## Walk backlinks and outbound links

```ts
const back = vault.query.backlinks('Notes/ideas/second.md');
const out = vault.query.outboundLinks('Notes/ideas/first.md');
```

## Full-text search

```ts
const results = vault.query.searchText('sqlite index', { limit: 10 });
for (const r of results) console.log(r.path, r.snippet);
```

## Read a note with its links resolved

```ts
const note = await vault.notes.readNote('Notes/ideas/first.md', { withLinks: true });
console.log(note.frontmatter, note.tags, note.backlinks);
```

## List the folders in a vault

`vault.io.listMarkdown` enumerates notes; `vault.io.listFolders` enumerates the
directories they live in. Both walk the same tree under the same rules, so a
folder outside the read scope, hidden behind a dot, or matched by `ignore` never
shows up. Pass a subdirectory to enumerate only what is under it.

```ts
await vault.io.listFolders();        // ['Archive', 'Archive/2024', 'Notes', 'Notes/ideas']
await vault.io.listFolders('Notes'); // ['Notes/ideas']
```

**Empty folders are included.** A directory with no markdown anywhere beneath it
is still a real directory on disk, so it is listed — the same call Obsidian
makes with `Vault.getAllFolders`. This is the one place the package looks past
`.md` files. The vault root itself is never in the list; it is `''`.

## Build a folder tree

`listFolders` returns a flat sorted list rather than a nested structure, because
sorted paths are already everything a tree needs — a parent always sorts before
its children, so one pass builds it:

```ts
type Folder = { path: string; children: Folder[] };

const roots: Folder[] = [];
const byPath = new Map<string, Folder>();

for (const path of await vault.io.listFolders()) {
  const node: Folder = { path, children: [] };
  byPath.set(path, node);
  const cut = path.lastIndexOf('/');
  const parent = cut === -1 ? undefined : byPath.get(path.slice(0, cut));
  (parent ? parent.children : roots).push(node);
}
```

Keep the fallback to `roots` when the parent lookup misses. A parent genuinely
can be absent: with `prefixes.read: ['Notes/ideas']`, `Notes` is outside the
scope and is never listed, so `Notes/ideas` arrives as a root with a path that
looks nested. Treat a missing parent as an implied one, not as a bug.

One thing to know about `ignore` here: the globs match the folder's own path, so
`'Drafts'` prunes the folder and everything under it, while `'Drafts/**'` hides
only the contents and still lists `Drafts` itself. Write the first form if you
want the folder gone from the tree.
