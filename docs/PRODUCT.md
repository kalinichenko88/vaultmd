# vaultmd: product decisions

vaultmd is a headless data layer for Bun over a folder of markdown notes: CRUD,
a SQLite index, queries. Its users today are AI agents that read and write
notes through its API.

## What it will not do

- Follow a symlink inside the vault ([PDR 0001](pdr/0001-no-symlinks-in-the-vault.md)).

## Decisions

- [0001 One file has one path: no symlinks inside the vault](pdr/0001-no-symlinks-in-the-vault.md) — accepted; revisit when: a user needs a folder outside the vault, linked into it, to be read or written
- [0002 An update stays atomic; the mode and the owner carry over, extended attributes and hard links do not](pdr/0002-atomic-updates-keep-the-mode.md) — accepted; revisit when: a user needs extended attributes or hard links to survive an update
- [0003 A writer's lock is stale by its age alone](pdr/0003-a-lock-is-stale-by-its-age-alone.md) — accepted; revisit when: a user reports that the 33-second block after a crash costs them work
