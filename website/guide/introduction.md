# Introduction

`vaultmd` gives your Bun app a programmatic data layer over a folder of markdown
notes. Your `.md` files on disk stay the **single source of truth**; vaultmd
maintains a rebuildable `bun:sqlite` index alongside them so you can query notes
by tag or frontmatter, walk backlinks, and run keyword search — all without an
editor, sync engine, or background daemon.

It's the engine, not the app: generic vault mechanics only. Personas, domain
schemas, and sync logic live in whatever you build on top.

## When to use it

- You want a queryable layer over plain markdown without adopting Obsidian.
- You need backlinks / outbound-link resolution and full-text search over notes.
- You're on [Bun](https://bun.sh) (≥ 1.1.0) — vaultmd uses `bun:sqlite` and does
  not run under Node.

Next: [Quick start](./quick-start).
