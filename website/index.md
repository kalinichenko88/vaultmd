---
layout: home
hero:
  name: vaultmd
  text: Headless markdown-vault data layer for Bun
  tagline: CRUD over .md notes plus a derived SQLite index for queries, backlinks, and full-text search. No Obsidian, no Electron, no plugin.
  actions:
    - theme: brand
      text: Get started
      link: /guide/quick-start
    - theme: alt
      text: API Reference
      link: /api/
features:
  - title: CRUD over markdown
    details: Create, read, update, delete .md notes with flat YAML frontmatter.
  - title: Derived SQLite index
    details: A rebuildable cache, never the source of truth. Delete it and it rebuilds from disk.
  - title: Links & full-text search
    details: Walk [[wikilink]] backlinks and run FTS5 keyword search with highlighted snippets.
---
