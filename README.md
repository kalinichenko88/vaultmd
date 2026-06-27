# mdvault

Headless markdown-vault data layer for Bun — CRUD over `.md` notes plus a
derived SQLite index (collection queries, backlinks, keyword search). No
Obsidian, no plugin, no Electron. The `.md` files on disk are the source of
truth; the index is a rebuildable cache.

**Status:** Plan 1 (foundation primitives) — `errors`, `fs-atomic`,
`vault-io`, `locked-file`, `frontmatter`, `links`. The SQLite index, queries,
note CRUD, and the `createVault` composition root land in Plan 2.

Design: `docs/superpowers/specs/2026-06-27-mdvault-foundation-design.md`.

## Install

```bash
bun add mdvault
```

## License

MIT — generic vault mechanics only; domain/persona/sync logic lives in the
consuming applications.
