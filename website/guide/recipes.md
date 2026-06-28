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

## Walk backlinks and outbound links

```ts
const back = vault.query.backlinks('ideas/second.md');
const out = vault.query.outboundLinks('ideas/first.md');
```

## Full-text search

```ts
const results = vault.query.searchText('sqlite index', { limit: 10 });
for (const r of results) console.log(r.path, r.snippet);
```

## Read a note with its links resolved

```ts
const note = await vault.notes.readNote('ideas/first.md', { withLinks: true });
console.log(note.frontmatter, note.tags, note.backlinks);
```
