---
layout: home
hero:
  name: VaultMD
  text: Query a folder of markdown like a database
  tagline: A headless data layer for Bun apps that read and write .md notes — CRUD, collection queries, backlinks and full-text search over files you still own. No Obsidian, no Electron, no daemon.
  actions:
    - theme: brand
      text: Quick start
      link: /guide/quick-start
    - theme: alt
      text: What is VaultMD?
      link: /guide/introduction
    - theme: alt
      text: API Reference
      link: /api/
features:
  - icon: 📝
    title: CRUD over markdown
    details: Create, read, update, delete .md notes with flat YAML frontmatter. Nested blocks written by other tools are read and indexed.
    link: /guide/concepts#the-vault-and-its-derived-index
    linkText: How the vault works
  - icon: 🗃️
    title: Derived SQLite index
    details: A rebuildable cache, never the source of truth. Delete the database and it rebuilds from disk; every write updates it inside the same lock as the file.
    link: /guide/concepts#write-through-indexing
    linkText: Write-through indexing
  - icon: 🔎
    title: Queries & full-text search
    details: Filter by tag, frontmatter field or folder, order and paginate — plus FTS5 keyword search with highlighted snippets.
    link: /guide/recipes#query-notes-by-tag-and-frontmatter
    linkText: Query recipes
  - icon: 🔗
    title: Links & backlinks
    details: Resolve [[wikilinks]] or relative links, walk backlinks and outbound links, and sweep the vault for links that resolve to nothing.
    link: /guide/concepts#links
    linkText: The link graph
  - icon: 🔐
    title: Scoped access
    details: Per-instance read/write allowlists, path canonicalization and symlink containment behind one chokepoint — safe to hand a subtree to a subsystem.
    link: /guide/concepts#scoped-access
    linkText: Scoped access
  - icon: 🧩
    title: TypeScript-first
    details: A small frozen public surface, full types, stable error codes, and lower-level primitives exported for advanced use.
    link: /api/
    linkText: Browse the API
---

## Install

```bash
bun add vaultmd
```

Requires [Bun](https://bun.sh) ≥ 1.3.14 — VaultMD uses `bun:sqlite` and other
Bun built-ins, so it does **not** run under Node.

## First use

```ts
import { createVault } from 'vaultmd';

const vault = await createVault({
  root: '/path/to/vault',
  // Read everything, but only write under Notes/.
  prefixes: { read: [''], write: ['Notes/'] },
  // Keep the index db outside the synced vault.
  indexPath: './data/vault-index.db',
});

await vault.notes.createNote('Notes/ideas/first.md', {
  frontmatter: { tags: ['idea'] },
  body: '# First\n\nLinking to [[Notes/ideas/second]].',
});

const hits = vault.query.queryNotes({ tag: 'idea' });
console.log(hits.map((h) => h.path)); // ['Notes/ideas/first.md']

vault.close();
```

The `.md` file on disk is the source of truth. The SQLite index is derived from
it, and is rebuilt from disk whenever it goes missing or stale.

## Where to next

- **New here?** [Introduction](/guide/introduction) says what VaultMD is for,
  then [Quick start](/guide/quick-start) gets a vault open.
- **Building something?** [Concepts](/guide/concepts) covers indexing, links,
  scopes and reconcile; [Recipes](/guide/recipes) has copy-pasteable answers.
- **Looking up a signature?** The [API Reference](/api/) is generated from the
  source — start at [`createVault`](/api/functions/createVault).
