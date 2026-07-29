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

Attachment embeds (`![[diagram.png]]`) are excluded — they can never resolve to
a `.md` note, so they are not breakage.

## Create a note only if it is not there yet

```ts
if (await vault.notes.exists('Notes/today.md')) {
  await vault.notes.updateNote('Notes/today.md', { append: '\n- another entry' });
} else {
  await vault.notes.createNote('Notes/today.md', { body: '# Today\n' });
}
```

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
