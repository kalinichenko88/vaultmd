# Introduction

VaultMD (`vaultmd` on npm) gives your Bun app a programmatic data layer over a
folder of markdown notes. Your `.md` files on disk stay the **single source of
truth**; VaultMD maintains a rebuildable `bun:sqlite` index alongside them so
you can query notes by tag or frontmatter, walk backlinks, and run keyword
search — all without an editor, sync engine, or background daemon.

It's the engine, not the app: generic vault mechanics only. Personas, domain
schemas, and sync logic live in whatever you build on top.

## When to use it

- You want a queryable layer over plain markdown without adopting Obsidian.
- You need backlinks / outbound-link resolution and full-text search over notes.
- You're on [Bun](https://bun.sh) (≥ 1.3.14) — VaultMD uses `bun:sqlite` and does
  not run under Node.

## Where to go next

- [Quick start](./quick-start) — install, open a vault, write and query a note.
- [Concepts](./concepts) — the derived index, links, scopes, and reconcile.
- [Recipes](./recipes) — task-shaped snippets to paste into your own code.
- [API Reference](/api/) — every exported name, generated from the source; start
  at [`createVault`](/api/functions/createVault).
